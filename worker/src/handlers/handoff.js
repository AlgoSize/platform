// MCP agent handoff — hand a scan finding to an external coding agent, and
// record the patch it applies back.
//
// This is the server side of the "route to MCP" story: Algosize runs the cheap
// deterministic + triage + validation stages, then hands the expensive fix work
// to the customer's own Claude Code / Kimi / MCP-host session, which does the
// edit in its own checkout at zero Workers AI token cost. Two endpoints back the
// two MCP tools:
//
//   GET  /api/fix/handoff   → the finding(s) + a ready-to-paste agent prompt
//   POST /api/fix/patch     → record that an agent applied a patch (provenance)
//
// Both are org-scoped through runScopeFor (tenant rule) and carry no secret.
// Neither stores customer source: the handoff returns findings the run already
// holds, and the patch record keeps a content HASH + short summary, never the
// diff (see migration 0027 and worker/src/fix/schemas.js).

import { getRun, runScopeFor } from "./runs.js";
import { ruleById } from "../analyzers/sast/registry.js";
import { contentHash } from "../fix/schemas.js";
import { retrieveSimilarFixes } from "../ai/retrieval.js";
import { writeAudit, AUDIT_ACTIONS } from "../audit.js";

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

// Which agents we render a tailored prompt preamble for. A value we do not
// recognise falls back to the generic MCP-host framing rather than erroring —
// the prompt is guidance, not a gate.
const AGENTS = Object.freeze({
  claude_code: "Claude Code",
  kimi: "Kimi (k2.7 / k3)",
  mcp: "your MCP host",
});

/**
 * GET /api/fix/handoff?runId=&fingerprint=&agent=&retrieval=
 *
 * Returns the finding(s) from a stored scan run plus a ready-to-paste prompt
 * document the agent can act on. `fingerprint` narrows to one finding; absent,
 * the whole source-finding set (capped) is returned. `retrieval=1` attaches
 * best-effort bge-m3 similar-prior-fix chunks when a Vectorize index exists.
 */
export async function handoffFindingsHandler(request, env, ctx) {
  const scope = await runScopeFor(request, env);
  if (!scope) return json({ error: "unauthorized" }, 401);

  const url = new URL(request.url);
  const runId = url.searchParams.get("runId");
  if (!runId) return json({ error: "missing_run", message: "runId is required" }, 400);
  const fingerprint = url.searchParams.get("fingerprint");
  const agent = url.searchParams.get("agent") || "mcp";
  const wantRetrieval = url.searchParams.get("retrieval") === "1";

  const run = await getRun(env, scope, runId);
  if (!run) return json({ error: "not_found", message: "no such run" }, 404);

  const findings = ((run.result && run.result.source && run.result.source.findings) || [])
    .filter((f) => f && typeof f.fingerprint === "string");
  const selected = fingerprint ? findings.filter((f) => f.fingerprint === fingerprint) : findings.slice(0, 50);
  if (fingerprint && selected.length === 0) {
    return json({ error: "not_found", message: "no finding with that fingerprint in this run" }, 404);
  }

  // Best-effort prior-fix context for the first finding (retrieval degrades to
  // [] when Vectorize is not provisioned — see ai/retrieval.js).
  let chunks = [];
  if (wantRetrieval && selected.length) {
    try {
      const r = await retrieveSimilarFixes(env, selected[0], 5, { meter: meterCtx(request, scope, runId) });
      chunks = (r.matches || []).map((m) => ({
        ruleId: m.metadata && m.metadata.ruleId, category: m.metadata && m.metadata.category,
        summary: m.metadata && m.metadata.summary,
      }));
    } catch { /* retrieval is enrichment, never load-bearing */ }
  }

  const prompt = buildAgentPrompt(selected, { agent, chunks, runId });
  return json({
    schema: "algosize.handoff/1",
    runId,
    agent: AGENTS[agent] ? agent : "mcp",
    findings: selected.map(slimFinding),
    retrieval: { available: wantRetrieval && chunks.length > 0, chunks },
    prompt,
    // Tell the agent exactly how to report back.
    writeBack: { tool: "algosize_record_patch", requires: ["runId", "fingerprint", "summary"] },
  }, 200);
}

/**
 * POST /api/fix/patch — record that an agent applied a patch. Provenance only.
 *
 * Body: { runId?, fingerprint, ruleId?, filePath?, patch? | patchHash?,
 *         summary?, status?, source? }
 * The raw `patch`, if supplied, is HASHED and discarded — never stored. The
 * row records who applied a fix for which finding, its hash, and a short
 * summary, so a later re-scan can be reconciled without the DB holding source.
 */
export async function applyPatchHandler(request, env, ctx) {
  const scope = await runScopeFor(request, env);
  if (!scope) return json({ error: "unauthorized" }, 401);
  const orgId = scope.orgId;
  if (!orgId) return json({ error: "no_org", message: "an organisation context is required to record a patch" }, 400);

  let body;
  try { body = await request.json(); }
  catch { return json({ error: "invalid_json", message: "request body must be valid JSON" }, 400); }

  const fingerprint = body && typeof body.fingerprint === "string" ? body.fingerprint : null;
  if (!fingerprint) return json({ error: "invalid_payload", message: "`fingerprint` (the finding) is required" }, 400);

  // Hash the diff if provided; NEVER persist it. A caller may instead pass a
  // precomputed patchHash. Either way the row holds a hash, not source.
  const patchHash = typeof body.patch === "string" && body.patch
    ? contentHash(body.patch)
    : (typeof body.patchHash === "string" ? body.patchHash.slice(0, 128) : null);

  const source = ["mcp_agent", "platform", "cli"].includes(body.source) ? body.source : "mcp_agent";
  const status = ["applied", "proposed"].includes(body.status) ? body.status : "applied";
  const appliedBy = (request.user && request.user.email)
    || (request.mcpScopes ? "mcp_agent" : null)
    || (orgId ? `org:${orgId}` : "unknown");

  const id = "patch_" + crypto.randomUUID().replace(/-/g, "").slice(0, 24);
  const now = Math.floor(Date.now() / 1000);

  try {
    await env.DB.prepare(
      `INSERT INTO scan_patches
        (id, org_id, run_id, fingerprint, rule_id, file_path, patch_hash, summary, source, applied_by, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      id, orgId,
      typeof body.runId === "string" ? body.runId : null,
      fingerprint,
      typeof body.ruleId === "string" ? body.ruleId.slice(0, 120) : null,
      typeof body.filePath === "string" ? body.filePath.slice(0, 400) : null,
      patchHash,
      typeof body.summary === "string" ? body.summary.slice(0, 500) : null,
      source, appliedBy, status, now,
    ).run();
  } catch (err) {
    return json({ error: "patch_record_failed", message: "could not record the patch" }, 500);
  }

  // Audit: "an agent applied a fix for finding X". Best-effort.
  try {
    await writeAudit(env, ctx, {
      actor: appliedBy, actorUserId: (request.user && request.user.userId) || null, orgId,
      action: AUDIT_ACTIONS.FIX_PROPOSED, targetType: "finding", targetId: fingerprint,
      metadata: { patchId: id, source, status, ruleId: body.ruleId || null, via: "mcp_handoff" },
    });
  } catch { /* diagnostic only */ }

  return json({ schema: "algosize.patch-record/1", patchId: id, source, status, recorded: true }, 200);
}

// ---------------------------------------------------------------------------
// Prompt assembly (pure)
// ---------------------------------------------------------------------------

/** A ready-to-paste instruction document for the agent. Carries no secret. */
export function buildAgentPrompt(findings, { agent = "mcp", chunks = [], runId = null } = {}) {
  const who = AGENTS[agent] || AGENTS.mcp;
  const lines = [];
  lines.push(`# Fix ${findings.length} Algosize finding${findings.length === 1 ? "" : "s"} — for ${who}`);
  lines.push("");
  lines.push("You are fixing security findings from an Algosize scan. For each finding below:");
  lines.push("1. Open the named file at the named line and read the surrounding code.");
  lines.push("2. Make the MINIMAL change that removes the issue; preserve behaviour, names and formatting.");
  lines.push("3. Validate your fix with the `algosize_validate_fix` MCP tool (original + fixed file).");
  lines.push("4. When it passes, report it back with `algosize_record_patch` (runId + the finding's fingerprint + a one-line summary).");
  lines.push("");
  findings.forEach((f, i) => {
    const rule = ruleById(f.ruleId);
    const remediation = f.recommendation || (rule && rule.remediation) || null;
    lines.push(`## ${i + 1}. ${f.title || (rule && rule.title) || f.ruleId}`);
    lines.push(`- **File**: \`${f.path}\`${f.line ? ` (line ${f.line})` : ""}`);
    lines.push(`- **Rule**: ${f.ruleId}  ·  **Severity**: ${f.severity || "?"}  ·  **Fingerprint**: \`${f.fingerprint}\``);
    if (Array.isArray(f.cwe) && f.cwe.length) lines.push(`- **CWE**: ${f.cwe.join(", ")}`);
    if (f.evidence && f.evidence.source) lines.push(`- **Taint**: \`${f.evidence.source}\` → \`${f.evidence.sink || "?"}\``);
    if (remediation) lines.push(`- **How to fix**: ${remediation}`);
    lines.push("");
  });
  if (chunks.length) {
    lines.push("## Similar fixes previously applied in this codebase");
    chunks.forEach((c) => lines.push(`- ${c.ruleId || "?"} (${c.category || "?"}): ${c.summary || "prior fix"}`));
    lines.push("");
  }
  if (runId) lines.push(`_Run: ${runId}_`);
  return lines.join("\n");
}

function slimFinding(f) {
  return {
    ruleId: f.ruleId, fingerprint: f.fingerprint, title: f.title || null,
    severity: f.severity || null, category: f.category || null,
    path: f.path || null, line: f.line || null,
    cwe: Array.isArray(f.cwe) ? f.cwe : [],
    recommendation: f.recommendation || null,
  };
}

function meterCtx(request, scope, runId) {
  return {
    orgId: scope.orgId || null,
    userId: (request.user && request.user.userId) || null,
    feature: "fix_handoff_retrieval",
    scanId: runId || null,
  };
}
