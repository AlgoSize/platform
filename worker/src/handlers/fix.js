// POST /api/fix — generate a concrete remediation for ONE finding.
//
// Thin HTTP shell over analyzers/fixgen.js; auth and rate limiting are the
// router's job (requireAuth + analyzeRateLimit — see index.js for why quota
// is deliberately not applied here).

import { validateFixInput, generateFix } from "../analyzers/fixgen.js";
import { runFixPipeline } from "../fix/orchestrate.js";
import { validateProposal } from "../fix/validate.js";
import { MAX_FIX_FILE_BYTES, SCHEMAS } from "../fix/schemas.js";
import { writeAudit, AUDIT_ACTIONS } from "../audit.js";
import { ruleById } from "../analyzers/sast/registry.js";
import { fromSarif } from "../analyzers/sarif.js";
import { summarizeFindings } from "../analyzers/sast/schema.js";
import { prioritizeFindings } from "../fix/schemas.js";
import { LANGUAGES, TIER_LABEL, languageOfPath } from "../analyzers/sast/languages.js";
import { captureException } from "../observability.js";

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

export async function generateFixHandler(request, env, ctx) {
  let body;
  try { body = await request.json(); }
  catch { return json({ error: "invalid_json", message: "request body must be valid JSON" }, 400); }

  const v = validateFixInput(body);
  if (!v.ok) return json({ error: v.error, message: v.message }, 400);

  let result;
  try {
    result = await generateFix(v.value, env);
  } catch (err) {
    await captureException(env, ctx, err, {
      request,
      userId: request.user && request.user.userId,
      tags: { source: "analyzer", analyzer: "fix", kind: v.value.kind },
    });
    return json({ error: "fix_generation_failed", message: "could not generate a fix" }, 500);
  }

  if (!result.ok) {
    return json({ error: result.error, message: result.message }, result.status);
  }
  return json({ kind: v.value.kind, fix: result.fix }, 200);
}


// ---------------------------------------------------------------------------
// POST /api/fix/propose — the structured fix pipeline
// ---------------------------------------------------------------------------
//
// The successor to /api/fix for SOURCE findings: instead of advisory prose,
// it returns a FixProposal (full corrected files), the static ValidationResult
// that judged it, and a git-applyable patch. /api/fix stays as-is — the
// advisory panel's version-bump generator is a different product with a
// different output shape, and the two coexist.
//
// Two input modes:
//
//   { finding, files: [{path, content}] }   the caller holds the source — an
//                                           MCP client with a local checkout,
//                                           the CLI, a test
//   { finding, repoUrl }                    the dashboard's repo path: the
//                                           Worker refetches JUST the file
//                                           the finding names, scoped to one
//                                           raw fetch — never a re-crawl
//
// Nothing is persisted except the AgentExecutionRecord in the audit log:
// proposals contain the customer's source and the platform does not store
// customer source, full stop.

const RAW_TIMEOUT_PATHS = /(^|\/)\.\.(\/|$)/;

async function fetchFindingFile(repoUrl, path, env) {
  const m = /^https?:\/\/(?:www\.)?github\.com\/([^\/\s]+)\/([^\/\s#?]+)/.exec(String(repoUrl || ""));
  if (!m) return { error: "invalid_repo_url", message: "repoUrl must be a public GitHub repository URL" };
  if (typeof path !== "string" || !path || RAW_TIMEOUT_PATHS.test(path) || path.startsWith("/")) {
    return { error: "invalid_path", message: "finding.path must be a repository-relative path" };
  }
  const fetchImpl = (env && env.FETCH) || fetch;
  for (const branch of ["main", "master"]) {
    let res;
    try {
      res = await fetchImpl(`https://raw.githubusercontent.com/${m[1]}/${m[2].replace(/\.git$/, "")}/${branch}/${encodeURI(path)}`);
    } catch { continue; }
    if (!res.ok) continue;
    const content = await res.text();
    if (content.length > MAX_FIX_FILE_BYTES) {
      return { error: "file_too_large_for_fix",
        message: `${path} is ${Math.round(content.length / 1024)}KB; the fix context cap is ${Math.round(MAX_FIX_FILE_BYTES / 1024)}KB.` };
    }
    return { file: { path, content } };
  }
  return { error: "file_unreachable", message: `${path} could not be fetched from the repository.` };
}

export async function proposeFixHandler(request, env, ctx) {
  let body;
  try { body = await request.json(); }
  catch { return json({ error: "invalid_json", message: "request body must be valid JSON" }, 400); }

  const finding = body && body.finding;
  if (!finding || typeof finding !== "object") {
    return json({ error: "invalid_payload", message: "`finding` (a normalized source finding) is required" }, 400);
  }

  let files = Array.isArray(body.files) ? body.files : null;
  if (!files && typeof body.repoUrl === "string") {
    const fetched = await fetchFindingFile(body.repoUrl, finding.path, env);
    if (fetched.error) return json({ error: fetched.error, message: fetched.message }, 400);
    files = [fetched.file];
  }
  if (!files || !files.length) {
    return json({ error: "invalid_payload",
      message: "provide `files` [{path, content}] or `repoUrl` for the Worker to fetch the finding's file" }, 400);
  }

  let result;
  try {
    result = await runFixPipeline({
      finding,
      files,
      frameworks: Array.isArray(body.frameworks) ? body.frameworks.slice(0, 8) : [],
      provider: typeof body.provider === "string" ? body.provider : null,
      env,
    });
  } catch (err) {
    await captureException(env, ctx, err, {
      request, userId: request.user && request.user.userId,
      tags: { source: "fix", phase: "pipeline" },
    });
    return json({ error: "fix_pipeline_failed", message: "The fix pipeline errored. Try again." }, 500);
  }

  // The audit row is written on every execution, success or not — "who asked
  // an agent to rewrite what" is precisely the record that must not depend on
  // the agent doing well. Failure to write it must not cost the response.
  if (result.record) {
    const actor = (request.user && request.user.email) || (request.org && `org:${request.org.orgId}`) || "unknown";
    try {
      await writeAudit(env, ctx, {
        actor,
        actorUserId: (request.user && request.user.userId) || null,
        orgId: (request.org && request.org.orgId) || null,
        action: AUDIT_ACTIONS.FIX_PROPOSED,
        targetType: "finding",
        targetId: result.record.finding ? result.record.finding.fingerprint : null,
        metadata: result.record,
      });
    } catch { /* auditing is diagnostic, never load-bearing */ }
  }

  if (!result.ok) {
    const status = result.error === "no_provider_configured" || result.error === "provider_not_configured" ? 503
      : result.stage === "task" ? 400 : 502;
    return json({
      error: result.error || result.reason || "fix_failed",
      message: result.message,
      stage: result.stage,
      ...(result.task ? { taskId: result.task.id } : {}),
    }, status);
  }

  return json({
    schema: "algosize.fix-response/1",
    taskId: result.task.id,
    proposal: result.proposal,
    validation: result.validation,
    patch: result.patch,
    applyable: result.applyable,
    retried: result.retried,
  }, 200);
}

// ---------------------------------------------------------------------------
// POST /api/fix/validate — validate a fix the CALLER wrote
// ---------------------------------------------------------------------------
//
// The interop half. An MCP client (Claude Code editing its own checkout, some
// other agent, a human with a patch) sends the original file, its fixed
// version, and the finding it claims to fix — and gets the same static
// verdict our own proposals get. Symmetric validation is the point: a fix is
// judged by what it does to the code, not by who wrote it.

export async function validateFixHandler(request, env, ctx) {
  let body;
  try { body = await request.json(); }
  catch { return json({ error: "invalid_json", message: "request body must be valid JSON" }, 400); }

  const { finding, original, fixed } = body || {};
  if (!finding || typeof finding.fingerprint !== "string" || typeof finding.ruleId !== "string") {
    return json({ error: "invalid_payload", message: "`finding` with ruleId and fingerprint is required" }, 400);
  }
  const okFile = (f) => f && typeof f.path === "string" && typeof f.content === "string";
  if (!okFile(original) || !okFile(fixed) || original.path !== fixed.path) {
    return json({ error: "invalid_payload", message: "`original` and `fixed` must be {path, content} for the same path" }, 400);
  }
  if (original.content.length > MAX_FIX_FILE_BYTES || fixed.content.length > MAX_FIX_FILE_BYTES * 2) {
    return json({ error: "file_too_large_for_fix", message: "content exceeds the validation cap" }, 413);
  }

  // A synthetic task/proposal pair through the SAME validator the pipeline
  // uses — one implementation, so an external fix and an internal one can
  // never be graded by different rules.
  const task = {
    schema: SCHEMAS.FIX_TASK, id: "fixt_external",
    finding: { ruleId: finding.ruleId, fingerprint: finding.fingerprint, path: original.path, line: finding.line || 0 },
    files: [{ path: original.path, content: original.content }],
    acceptance: { targetFingerprint: finding.fingerprint },
  };
  const proposal = {
    schema: SCHEMAS.FIX_PROPOSAL, id: "fixp_external", taskId: task.id,
    provider: "external", model: null,
    files: [{ path: fixed.path, content: fixed.content }],
    explanation: "", riskNotes: "",
  };

  try {
    const v = validateProposal(task, proposal);
    return json({ validation: v.result, patch: v.patch, applyable: v.result.verdict === "passed_static" }, 200);
  } catch (err) {
    await captureException(env, ctx, err, {
      request, userId: request.user && request.user.userId,
      tags: { source: "fix", phase: "validate_external" },
    });
    return json({ error: "validation_failed", message: "The validator errored on this input." }, 500);
  }
}

// ---------------------------------------------------------------------------
// GET /api/fix/rule?id=...&path=... — registry metadata for one rule
// ---------------------------------------------------------------------------
//
// Exists so the MCP explain tool has a ROUTE to call rather than importing
// the registry directly: the purity guard on mcp/tools/ is absolute (every
// tool goes through a chain, so logging and metering can never be bypassed),
// and an endpoint this cheap is a fair price for keeping that guard without
// exceptions. Free and static — it reads the registry, not a model.

export function explainRuleHandler(request) {
  const url = new URL(request.url);
  const id = url.searchParams.get("id") || "";
  const path = url.searchParams.get("path") || "";

  const rule = ruleById(id);
  if (!rule) {
    return json({ error: "unknown_rule",
      message: `No rule named ${id.slice(0, 120) || "(empty)"} in the registry. Rule ids come from a scan's findings.` }, 404);
  }
  let pathInfo = null;
  if (path) {
    const lang = languageOfPath(path);
    if (lang && LANGUAGES[lang]) {
      pathInfo = { language: LANGUAGES[lang].label, tier: LANGUAGES[lang].tier, tierLabel: TIER_LABEL[LANGUAGES[lang].tier] };
    }
  }
  return json({ rule: { id, ...rule }, pathInfo }, 200);
}

// ---------------------------------------------------------------------------
// POST /api/import/sarif — external scanner results, normalized
// ---------------------------------------------------------------------------
//
// A SARIF log in, the platform's own finding shape out — summarized,
// prioritized, and carrying the mapping back to the source tool's rule ids.
// A VIEW, not a stored run: an imported result is another tool's measurement,
// and filing it as an Algosize run would let a foreign scanner's verdict
// masquerade in the runs feed as one of ours. The caller (UI, CLI, MCP
// client) holds the normalized output and feeds whichever findings it wants
// into the fix pipeline.

const MAX_SARIF_BYTES = 4 * 1024 * 1024;

export async function importSarifHandler(request, env, ctx) {
  let text;
  try { text = await request.text(); }
  catch { return json({ error: "invalid_payload", message: "could not read the request body" }, 400); }
  if (!text || text.length > MAX_SARIF_BYTES) {
    return json({ error: "payload_too_large",
      message: `SARIF documents up to ${MAX_SARIF_BYTES / 1024 / 1024} MB are accepted` }, text ? 413 : 400);
  }

  let parsed;
  try {
    parsed = fromSarif(text);
  } catch (err) {
    await captureException(env, ctx, err, {
      request, userId: request.user && request.user.userId,
      tags: { source: "fix", phase: "sarif_import" },
    });
    return json({ error: "import_failed", message: "The importer errored on this document." }, 500);
  }
  if (!parsed.ok) return json({ error: parsed.error, message: parsed.message }, 400);

  return json({
    schema: "algosize.sarif-import/1",
    findings: parsed.findings,
    summary: summarizeFindings(parsed.findings),
    priorities: prioritizeFindings(parsed.findings).slice(0, 50)
      .map((p) => ({ fingerprint: p.finding.fingerprint, score: p.priority.score })),
    coverage: {
      resultsInDocument: parsed.total,
      imported: parsed.findings.length,
      skipped: parsed.skipped,
      tools: parsed.toolNames,
    },
  }, 200);
}