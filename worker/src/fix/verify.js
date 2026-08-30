// Stage 5 — cross-model fix verification.
//
// The model that wrote a fix is the worst judge of it: it will defend its own
// patch, and a bug it failed to see writing the fix it will fail to see
// reviewing it. So a DIFFERENT model reads the generated patch against the
// original finding and code, and answers a narrow question — does this patch
// actually remove the issue without introducing a new one? This catches the
// two failure modes deterministic static validation cannot: a fix that
// "works" but re-introduces a vulnerability of a different shape, and a fix
// that addresses the symptom while missing the root cause.
//
// This runs ALONGSIDE the deterministic static validation the fix orchestrator
// already does (parse + full re-scan + blast radius in fix/validate.js), not
// instead of it. Static validation is measured ground truth about the patched
// bytes; this is a second model's judgement. A fix is strongest when both
// agree; the pipeline treats a static-validation FAILURE as authoritative
// (measured beats opinion) and uses this stage to gate the fixes static
// validation PASSED.
//
// HARD INVARIANT. The verifier model MUST differ from the fixer model. A
// self-review is not a cross-check; the pipeline passes the fixer's slug as
// `excludeModel`, and this module refuses to run if routing can only offer
// that same model back.

import { callModel } from "../ai/call.js";
import { resolveStageModel } from "../ai/routing.js";

export const VERIFY_OUTCOMES = Object.freeze(["approved", "rejected", "escalate"]);

const VERIFY_SYSTEM =
  "You are a security code reviewer checking someone ELSE's patch. You are " +
  "given a vulnerability finding, the original code, and a proposed fix. " +
  "Decide whether the fix genuinely resolves the finding WITHOUT introducing " +
  "a new vulnerability or breaking behaviour. Be skeptical. Reply with ONLY a " +
  'JSON object: {"approved":true|false,"issues":["..."],' +
  '"introduces_new_issue":true|false,"recommendation":"one sentence"}. ' +
  "No prose outside the JSON.";

/**
 * Build the verification prompt. PURE. Carries the finding, the original file,
 * and the proposed replacement so the reviewer sees exactly what changed.
 */
export function buildVerifyPrompt(finding, originalCode, proposedCode) {
  const f = finding || {};
  const user =
    `Finding: ${f.title || f.ruleId || "unknown"} (${f.category || "?"}, ${f.severity || "?"})\n` +
    `Location: ${f.path || "?"}:${f.line || "?"}\n\n` +
    `ORIGINAL:\n${String(originalCode || "").slice(0, 8000)}\n\n` +
    `PROPOSED FIX:\n${String(proposedCode || "").slice(0, 8000)}\n`;
  return { system: VERIFY_SYSTEM, user };
}

/**
 * Parse a verification reply. PURE. Unparseable → "escalate", never a silent
 * "approved": a reviewer whose answer we cannot read has not approved anything.
 */
export function parseVerifyReply(text) {
  const obj = extractJson(text);
  if (!obj) return { outcome: "escalate", approved: false, issues: [], introducesNewIssue: null, recommendation: "unparseable verify reply", parsed: false };
  const approved = obj.approved === true;
  const introducesNewIssue = typeof obj.introduces_new_issue === "boolean" ? obj.introduces_new_issue : null;
  const issues = Array.isArray(obj.issues) ? obj.issues.map((s) => String(s).slice(0, 300)).slice(0, 20) : [];
  // A patch flagged as introducing a new issue is never "approved", whatever
  // the approved flag said — the two are contradictory and caution wins.
  const outcome = approved && introducesNewIssue !== true ? "approved" : "rejected";
  return {
    outcome,
    approved: outcome === "approved",
    issues,
    introducesNewIssue,
    recommendation: typeof obj.recommendation === "string" ? obj.recommendation.slice(0, 400) : "",
    parsed: true,
  };
}

/**
 * Verify a proposal with a model different from the one that wrote it.
 *
 * `excludeModel` is the fixer's slug — the invariant this stage exists to
 * enforce. Returns the outcome plus the reviewing model; if routing cannot
 * offer a different model, returns outcome "escalate" with reason
 * "no_distinct_verifier" rather than falling back to a self-review.
 */
export async function verifyFix(finding, originalCode, proposal, env, ctx = {}) {
  const excludeModel = ctx.excludeModel || (proposal && proposal.model) || null;
  const routed = await resolveStageModel(env, {
    stage: "verify",
    cweFamily: (finding && finding.category) || null,
    language: ctx.language || null,
    budget: ctx.budget === true,
    exclude: excludeModel ? [excludeModel] : [],
  });
  if (!routed.model) {
    return { outcome: "escalate", approved: false, issues: [], model: null, measured: false, reason: "no_distinct_verifier" };
  }
  if (excludeModel && routed.model === excludeModel) {
    // Defensive: routing should have excluded it, but never self-review.
    return { outcome: "escalate", approved: false, issues: [], model: null, measured: false, reason: "no_distinct_verifier" };
  }

  // The proposal carries one file per allowlist entry; verify the file the
  // finding lives in.
  const proposed = (proposal && proposal.files || []).find((x) => x.path === (finding && finding.path)) || (proposal && proposal.files || [])[0];
  const { system, user } = buildVerifyPrompt(finding, originalCode, proposed && proposed.content);
  const r = await callModel(env, { model: routed.model, system, user, maxTokens: 600, temperature: 0 }, {
    ...ctx.meter, feature: "fix_verify", model: routed.model,
  });
  if (!r.ok) {
    return { outcome: "escalate", approved: false, issues: [], model: routed.model, measured: false, reason: `verifier unreachable: ${r.reason}` };
  }
  const parsed = parseVerifyReply(r.reply);
  return { ...parsed, model: r.model || routed.model, measured: true };
}

function extractJson(text) {
  if (typeof text !== "string") return null;
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try { return JSON.parse(text.slice(start, end + 1)); } catch { return null; }
}
