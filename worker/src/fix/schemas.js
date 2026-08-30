// Fix-orchestration schemas — the contracts every module in worker/src/fix/
// speaks, and nothing else.
//
// ---------------------------------------------------------------------------
// WHY SCHEMAS COME FIRST
// ---------------------------------------------------------------------------
//
// The fix pipeline crosses four trust boundaries: a finding produced by our
// scanner, a task sent to a model vendor we do not control, a proposal that
// vendor wrote, and a verdict our validator attaches. Every one of those
// hand-offs is a place where a loosely-shaped object lets one module's
// assumption become another module's bug — the exact drift the SAST registry
// exists to prevent between detectors and metadata.
//
// So each object carries a `schema` tag (name/major-version), and each has a
// validator that REFUSES rather than repairs. A proposal with a file outside
// the task's allowlist is not "a proposal with an extra file"; it is a model
// writing somewhere it was not asked to, and the only safe reading of that is
// rejection.
//
// Versioning: bump the major when a reader of the old shape would misread the
// new one. Additive optional fields do not bump it.
//
// ---------------------------------------------------------------------------
// WHAT IS DELIBERATELY NOT STORED
// ---------------------------------------------------------------------------
//
// FixProposal objects contain file CONTENT — the customer's source, plus the
// model's rewrite of it. The platform's standing rule ("paths and identities
// only, never fetched file contents") applies to proposals exactly as it does
// to scans, and fixgen.js already established the second half of the
// argument: a generated suggestion is neither measured nor deterministic, so
// persisting it lets a stale AI guess masquerade as a record.
//
// The durable record is the AgentExecutionRecord: who asked, which finding,
// which provider and model, content HASHES, the validation verdict, and the
// blast radius. Enough to audit every action; nothing that copies source into
// a database.

import { fingerprintOf } from "../analyzers/sast/schema.js";

export const SCHEMAS = Object.freeze({
  FIX_TASK:        "algosize.fix-task/1",
  FIX_PROPOSAL:    "algosize.fix-proposal/1",
  VALIDATION:      "algosize.validation-result/1",
  REMEDIATION:     "algosize.remediation-action/1",
  AGENT_EXECUTION: "algosize.agent-execution/1",
  // Already-shipped shapes, named here so one constant table describes the
  // whole platform's data model. Their canonical producers live elsewhere
  // (sast/profile.js, sast/schema.js); these tags are how a consumer asserts
  // which version it was written against.
  REPOSITORY_PROFILE: "algosize.repository-profile/1",
  SCAN_PLAN:          "algosize.scan-plan/1",
  FINDING:            "algosize.finding/1",
});

// ---------------------------------------------------------------------------
// Caps
// ---------------------------------------------------------------------------

// The largest file a fix task will carry to a model. Scanned files cap at
// 200KB; a fix prompt carrying that much would spend most of the context
// window on code the model must echo back. A file over this is not "fixed
// with less context" — it is reported ineligible, because a model rewriting
// a file it cannot fully see is how fixes delete code they never read.
export const MAX_FIX_FILE_BYTES = 48 * 1024;
export const MAX_SNIPPET_LINES = 60;
export const MAX_CONSTRAINTS = 8;

// ---------------------------------------------------------------------------
// Prioritization
// ---------------------------------------------------------------------------
//
// The scanner ranks findings by severity for display. Triage needs a second
// axis: among four "high" findings, which one first? The score below is a
// deliberate, documented heuristic — not a CVSS reimplementation — and every
// term is explainable to the person reading the queue:
//
//   severity     the analyzer's own claim of impact
//   confidence   how sure the analyzer is it is real (a low-confidence
//                critical below a high-confidence high: chasing likely-real
//                issues beats chasing scary maybes)
//   category     exploitability prior: a reachable injection or a live
//                credential outranks a weak hash in dead code, and taint
//                findings carry runtime evidence that pattern hits do not
//
// Returned as a number so the queue can sort, plus the term breakdown so the
// UI can answer "why is this first?" without re-deriving.

const SEVERITY_SCORE   = { critical: 400, high: 300, medium: 200, low: 100, info: 40 };
const CONFIDENCE_SCORE = { high: 1.0, medium: 0.7, low: 0.4 };

/** Categories with a higher prior of being exploitable as found. */
const CATEGORY_BOOST = Object.freeze({
  injection: 1.3, secrets: 1.3, deserialization: 1.25, ssrf: 1.2,
  traversal: 1.2, xss: 1.15, "access-control": 1.15, auth: 1.1,
  redirect: 1.05, crypto: 1.0, "data-exposure": 1.0,
  configuration: 0.9, "supply-chain": 0.9, resource: 0.85, dependency: 0.9,
});

export function priorityOf(finding) {
  const severity   = SEVERITY_SCORE[finding && finding.severity] || 40;
  const confidence = CONFIDENCE_SCORE[finding && finding.confidence] || 0.4;
  const category   = CATEGORY_BOOST[finding && finding.category] ?? 1.0;
  // Taint findings carry a traced source→sink path — evidence a line-match
  // cannot have — and their true-positive rate reflects it.
  const evidence = finding && finding.evidence && finding.evidence.source ? 1.1 : 1.0;
  const score = Math.round(severity * confidence * category * evidence);
  return {
    score,
    terms: { severity, confidence, category, evidence },
  };
}

/** Sort findings for a triage queue: priority desc, then stable by location. */
export function prioritizeFindings(findings) {
  return [...(findings || [])]
    .map((f) => ({ finding: f, priority: priorityOf(f) }))
    .sort((a, b) =>
      b.priority.score - a.priority.score ||
      String(a.finding.path).localeCompare(String(b.finding.path)) ||
      (a.finding.line || 0) - (b.finding.line || 0));
}

// ---------------------------------------------------------------------------
// FixTask
// ---------------------------------------------------------------------------

export function newFixTaskId() {
  return "fixt_" + crypto.randomUUID().replace(/-/g, "").slice(0, 20);
}

/**
 * Validate a FixTask. Returns { ok, value | error, message }.
 *
 * The allowlist (`files`) is the load-bearing field: it is the complete set
 * of paths a proposal may touch, and the validator enforces it. Everything a
 * provider adapter needs is IN the task — adapters never reach back into
 * platform state, which is what keeps them free of business logic.
 */
export function validateFixTask(task) {
  const fail = (message) => ({ ok: false, error: "invalid_fix_task", message });
  if (!task || typeof task !== "object") return fail("task must be an object");
  if (task.schema !== SCHEMAS.FIX_TASK) return fail(`task.schema must be ${SCHEMAS.FIX_TASK}`);
  if (typeof task.id !== "string" || !task.id.startsWith("fixt_")) return fail("task.id missing");
  const f = task.finding;
  if (!f || typeof f.ruleId !== "string" || typeof f.fingerprint !== "string") {
    return fail("task.finding must carry ruleId and fingerprint");
  }
  if (!Array.isArray(task.files) || task.files.length === 0) {
    return fail("task.files must name at least one file");
  }
  for (const file of task.files) {
    if (!file || typeof file.path !== "string" || typeof file.content !== "string") {
      return fail("each task file needs path and content");
    }
    if (file.content.length > MAX_FIX_FILE_BYTES) {
      return fail(`${file.path} exceeds the ${Math.round(MAX_FIX_FILE_BYTES / 1024)}KB fix-context cap`);
    }
  }
  if (!task.acceptance || typeof task.acceptance.targetFingerprint !== "string") {
    return fail("task.acceptance.targetFingerprint is required — a fix task with no measurable goal cannot be validated");
  }
  return { ok: true, value: task };
}

// ---------------------------------------------------------------------------
// FixProposal
// ---------------------------------------------------------------------------

/**
 * Normalize + validate a provider's raw reply into a FixProposal.
 *
 * Providers return { files: [{path, content}], explanation, riskNotes } from
 * the model. This is where the allowlist bites: a path the task did not name
 * is refused outright. Full-content files rather than diffs, deliberately —
 * a model-authored diff mis-anchors silently, whereas a full file either is
 * or is not what the model meant, and WE compute the diff from ground truth.
 */
export function toFixProposal(raw, task, meta = {}) {
  const fail = (error, message) => ({ ok: false, error, message });
  if (!raw || typeof raw !== "object") return fail("invalid_proposal", "provider reply is not an object");
  const files = Array.isArray(raw.files) ? raw.files : [];
  if (!files.length) return fail("invalid_proposal", "proposal contains no files");

  const allowed = new Set((task.files || []).map((f) => f.path));
  const out = [];
  for (const f of files) {
    if (!f || typeof f.path !== "string" || typeof f.content !== "string") {
      return fail("invalid_proposal", "each proposal file needs path and content");
    }
    if (!allowed.has(f.path)) {
      // Not trimmed to the allowed subset: a model that writes outside its
      // brief has misunderstood the brief, and the rest of its output does
      // not become trustworthy by deleting the overreach.
      return fail("proposal_outside_allowlist",
        `proposal touches ${f.path}, which the task did not offer`);
    }
    if (f.content.length > MAX_FIX_FILE_BYTES * 2) {
      return fail("invalid_proposal", `${f.path} in the proposal is implausibly large`);
    }
    out.push({ path: f.path, content: f.content });
  }

  return {
    ok: true,
    value: {
      schema: SCHEMAS.FIX_PROPOSAL,
      id: "fixp_" + crypto.randomUUID().replace(/-/g, "").slice(0, 20),
      taskId: task.id,
      provider: meta.provider || "unknown",
      model: meta.model || null,
      files: out,
      explanation: typeof raw.explanation === "string" ? raw.explanation.slice(0, 4000) : "",
      riskNotes: typeof raw.riskNotes === "string" ? raw.riskNotes.slice(0, 2000) : "",
      createdAt: Math.floor(Date.now() / 1000),
    },
  };
}

// ---------------------------------------------------------------------------
// ValidationResult
// ---------------------------------------------------------------------------

/**
 * The checks a Cloudflare Worker structurally cannot run, spelled out on
 * every result. This platform's one non-negotiable reporting rule is that
 * unmeasured never renders as clean; for fixes the equivalent claim is
 * "validated", and a result that omitted what was NOT checked would let
 * "parses and scans clean" be read as "tested". `verdict` is therefore at
 * best `passed_static` — the word "passed" alone does not exist here.
 */
export const CHECKS_A_WORKER_CANNOT_RUN = Object.freeze([
  { check: "tests",    why: "running the project's tests means executing its code, which a Worker cannot do — run them in CI or locally before merging" },
  { check: "build",    why: "same constraint: a build executes toolchain code" },
  { check: "linters",  why: "project linters are npm packages the Worker does not install" },
]);

export function makeValidationResult({ proposalId, verdict, checks, checksNotRun, findingDelta, blastRadius, reasons }) {
  return {
    schema: SCHEMAS.VALIDATION,
    proposalId,
    // "passed_static" | "failed"
    verdict,
    checks,                      // [{check, ok, detail}]
    checksNotRun: checksNotRun || CHECKS_A_WORKER_CANNOT_RUN,
    findingDelta,                // {targetRemoved, newFindings:[...], resolvedCount, newBySeverity}
    blastRadius,                 // {files, linesAdded, linesRemoved, hunks}
    reasons: reasons || [],      // human sentences for a failed verdict
    validatedAt: Math.floor(Date.now() / 1000),
  };
}

// ---------------------------------------------------------------------------
// RemediationAction
// ---------------------------------------------------------------------------
//
// What can be DONE with a validated proposal. The Worker deliberately holds
// no repository write credential — an API key that could push code is a far
// larger secret than any it currently keeps — so `patch` is the terminal
// server-side action, and branch/PR/commit are performed where a writable
// checkout and a credential already exist: the CLI, a CI job, or an MCP
// client like Claude Code applying the patch locally. The action object
// records WHERE that is expected to happen so the audit trail is complete
// even though the Worker did not do it.

export const REMEDIATION_KINDS = Object.freeze(["patch", "report", "client_branch", "client_pr"]);

export function makeRemediationAction({ proposalId, kind, patch, appliedBy = null, note = null }) {
  if (!REMEDIATION_KINDS.includes(kind)) {
    return { ok: false, error: "invalid_remediation", message: `kind must be one of ${REMEDIATION_KINDS.join(", ")}` };
  }
  return {
    ok: true,
    value: {
      schema: SCHEMAS.REMEDIATION,
      proposalId,
      kind,
      patch: typeof patch === "string" ? patch : null,
      appliedBy,               // "cli" | "mcp-client" | "ci" | null (not applied)
      note,
      createdAt: Math.floor(Date.now() / 1000),
    },
  };
}

// ---------------------------------------------------------------------------
// AgentExecutionRecord
// ---------------------------------------------------------------------------

/** FNV-backed content hash, reusing the scanner's stable fingerprint. */
export function contentHash(text) {
  return fingerprintOf({ ruleId: "content", path: "-", snippet: String(text || "") });
}

/**
 * The durable, source-free record of one agent execution. This is what goes
 * to the audit log: enough to answer "who generated what, with which model,
 * against which finding, and did it validate" — with content reduced to
 * hashes so the log never becomes a second copy of anyone's source code.
 */
export function makeAgentExecutionRecord({ task, proposal, validation, provider, model, ok, errorCode = null, durationMs = null }) {
  return {
    schema: SCHEMAS.AGENT_EXECUTION,
    taskId: task ? task.id : null,
    finding: task ? {
      ruleId: task.finding.ruleId,
      fingerprint: task.finding.fingerprint,
      severity: task.finding.severity || null,
      path: task.finding.path || null,
    } : null,
    provider: provider || null,
    model: model || null,
    ok: Boolean(ok),
    errorCode,
    proposalId: proposal ? proposal.id : null,
    inputHashes: task ? task.files.map((f) => ({ path: f.path, hash: contentHash(f.content) })) : [],
    outputHashes: proposal ? proposal.files.map((f) => ({ path: f.path, hash: contentHash(f.content) })) : [],
    verdict: validation ? validation.verdict : null,
    blastRadius: validation ? validation.blastRadius : null,
    durationMs,
    at: Math.floor(Date.now() / 1000),
  };
}
