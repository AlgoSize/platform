// Stage 3 — deep validation (context-aware exploitability reasoning).
//
// Only findings that survived triage reach here. This stage gives a stronger
// reasoning model MORE context than triage had — the full function, the taint
// path the scanner traced, imports and framework — and asks the harder
// question triage could not: is this actually EXPLOITABLE, and how bad is it?
// Its output (exploitable / taint path / severity) is what a fix task is
// scoped against and what a reviewer reads first.
//
// ENSEMBLE FOR CRITICAL. For a critical finding, one model's opinion is not
// enough to spend flagship-coder budget on, nor to wave through. So critical
// findings go to a vote: N distinct models judge exploitability independently,
// and a majority (default 2 of 3) is required to proceed to a fix. A split
// vote does not resolve to the cheaper answer — it ESCALATES to a human,
// because a finding the models disagree on is exactly the one a person should
// see. Unanimous agreement fast-tracks it with high confidence.
//
// DISCIPLINE. A model's exploitability verdict is an AI opinion, not a proof.
// It enriches and routes a finding; it is never persisted as the durable truth
// of whether the code is vulnerable (the same rule fix proposals follow — an
// AI guess must not masquerade as a measured record). Unmeasured stays
// unmeasured: if the models could not be reached, the result is flagged
// unmeasured, never a confident "not exploitable".

import { callModel } from "../ai/call.js";
import { resolveStageModel, ensembleModels } from "../ai/routing.js";

export const SEVERITIES = Object.freeze(["critical", "high", "medium", "low", "info"]);

const VALIDATE_SYSTEM =
  "You are a senior application-security engineer. You are given a static " +
  "finding, the full function it lives in, and any traced taint path. Judge " +
  "whether it is EXPLOITABLE as written, describe the data path from input " +
  "to sink, and assign a severity. Reply with ONLY a JSON object: " +
  '{"exploitable":true|false,"taint_path":"short description",' +
  '"severity":"critical"|"high"|"medium"|"low"|"info",' +
  '"confidence":0.0-1.0,"reason":"one or two sentences"}. No prose outside the JSON.';

/**
 * Build the deep-validation prompt. PURE. `context` carries the richer packet:
 * { functionSource, imports, frameworks, taintPath } — more than triage saw.
 */
export function buildValidatePrompt(finding, context = {}) {
  const f = finding || {};
  const cwe = Array.isArray(f.cwe) ? f.cwe.join(", ") : (f.cwe || "");
  const frameworks = Array.isArray(context.frameworks) ? context.frameworks.join(", ") : "";
  const user =
    `Finding: ${f.title || f.ruleId || "unknown"}\n` +
    `Rule: ${f.ruleId || "?"}  Category: ${f.category || "?"}  ` +
    `Reported severity: ${f.severity || "?"}` + (cwe ? `  CWE: ${cwe}` : "") + "\n" +
    `Location: ${f.path || "?"}:${f.line || "?"}\n` +
    (context.taintPath || (f.evidence && f.evidence.source)
      ? `Taint path: ${context.taintPath || `${f.evidence.source} → ${f.evidence.sink || "?"}`}\n`
      : "") +
    (frameworks ? `Frameworks: ${frameworks}\n` : "") +
    (context.imports ? `Imports: ${String(context.imports).slice(0, 500)}\n` : "") +
    `\nFunction:\n${String(context.functionSource || f.snippet || "").slice(0, 8000)}\n`;
  return { system: VALIDATE_SYSTEM, user };
}

/** Parse one validation reply. PURE. Unparseable → not a confident verdict. */
export function parseValidateReply(text) {
  const obj = extractJson(text);
  if (!obj) return { exploitable: null, taintPath: "", severity: null, confidence: 0, reason: "unparseable validation reply", parsed: false };
  let severity = String(obj.severity || "").toLowerCase();
  if (!SEVERITIES.includes(severity)) severity = null;
  let confidence = Number(obj.confidence);
  if (!Number.isFinite(confidence) || confidence < 0) confidence = 0;
  if (confidence > 1) confidence = 1;
  return {
    exploitable: typeof obj.exploitable === "boolean" ? obj.exploitable : null,
    taintPath: typeof obj.taint_path === "string" ? obj.taint_path.slice(0, 500) : "",
    severity,
    confidence,
    reason: typeof obj.reason === "string" ? obj.reason.slice(0, 400) : "",
    parsed: true,
  };
}

/**
 * Tally an ensemble of exploitability judgments into a decision. PURE.
 *
 * `votes` — array of parsed validation results (each with .exploitable).
 * `threshold` — fraction of the measured votes that must say "exploitable"
 *   to PROCEED (default 0.5 → a 2/3 majority).
 *
 * Returns { decision: "proceed"|"escalate"|"drop"|"unmeasured", exploitYes,
 *   exploitNo, measured, unanimous }.
 *   proceed   — a clear majority found it exploitable → fix it.
 *   drop      — a clear majority found it NOT exploitable (unanimous no).
 *   escalate  — the vote is split, or short of a clear majority either way →
 *               a human decides.
 *   unmeasured— no model produced a usable verdict → not "safe", unknown.
 */
export function tallyVotes(votes, threshold = 0.5) {
  const measured = (votes || []).filter((v) => v && typeof v.exploitable === "boolean");
  if (measured.length === 0) return { decision: "unmeasured", exploitYes: 0, exploitNo: 0, measured: 0, unanimous: false };
  const exploitYes = measured.filter((v) => v.exploitable === true).length;
  const exploitNo = measured.length - exploitYes;
  const yesFrac = exploitYes / measured.length;
  const unanimous = exploitYes === measured.length || exploitNo === measured.length;

  let decision;
  if (yesFrac > threshold) decision = "proceed";
  else if (exploitNo === measured.length) decision = "drop";      // unanimous "not exploitable"
  else decision = "escalate";                                     // split, or short of majority
  return { decision, exploitYes, exploitNo, measured: measured.length, unanimous };
}

/**
 * Deep-validate one finding. For critical findings, runs the ensemble vote;
 * for everything else, a single reasoning model. Returns the enriched verdict
 * plus, for the ensemble path, the vote tally and per-model results.
 */
export async function deepValidateFinding(finding, context, env, ctx = {}) {
  const isCritical = (finding && finding.severity) === "critical";
  const language = ctx.language || null;
  const cweFamily = (finding && finding.category) || null;

  if (isCritical) {
    const models = ensembleModels(ctx.ensembleSize || 3, { budget: ctx.budget === true });
    if (models.length === 0) {
      return { mode: "ensemble", decision: "unmeasured", measured: false, votes: [], reason: "no validation models available" };
    }
    const { system, user } = buildValidatePrompt(finding, context);
    const votes = [];
    for (const model of models) {
      const r = await callModel(env, { model, system, user, maxTokens: 500, temperature: 0 }, {
        ...ctx.meter, feature: "fix_ensemble", model,
      });
      votes.push(r.ok ? { model, ...parseValidateReply(r.reply) } : { model, exploitable: null, parsed: false, reason: r.reason });
    }
    const tally = tallyVotes(votes, ctx.voteThreshold ?? 0.5);
    // Severity from the votes that named one; keep the finding's own as the floor.
    const severity = pickSeverity(votes) || finding.severity || null;
    return {
      mode: "ensemble",
      decision: tally.decision,
      exploitable: tally.decision === "proceed" ? true : tally.decision === "drop" ? false : null,
      severity,
      tally,
      votes,
      measured: tally.measured > 0,
    };
  }

  // Non-critical: a single reasoning model.
  const routed = await resolveStageModel(env, { stage: "validate", cweFamily, language, budget: ctx.budget === true });
  if (!routed.model) {
    return { mode: "single", decision: "unmeasured", measured: false, reason: "no validation model available" };
  }
  const { system, user } = buildValidatePrompt(finding, context);
  const r = await callModel(env, { model: routed.model, system, user, maxTokens: 500, temperature: 0 }, {
    ...ctx.meter, feature: "fix_validate", model: routed.model,
  });
  if (!r.ok) {
    return { mode: "single", decision: "unmeasured", measured: false, model: routed.model, reason: r.reason };
  }
  const v = parseValidateReply(r.reply);
  // A single model that could not decide exploitability escalates rather than
  // resolving to "drop" — unknown is not safe.
  const decision = v.exploitable === true ? "proceed" : v.exploitable === false ? "drop" : "escalate";
  return { mode: "single", decision, exploitable: v.exploitable, severity: v.severity || finding.severity || null, confidence: v.confidence, taintPath: v.taintPath, reason: v.reason, model: r.model || routed.model, measured: true };
}

function pickSeverity(votes) {
  // The highest severity any measured voter assigned — a security decision
  // rounds toward caution, not the median.
  const order = { critical: 4, high: 3, medium: 2, low: 1, info: 0 };
  let best = null, bestRank = -1;
  for (const v of votes || []) {
    if (v && v.severity && order[v.severity] > bestRank) { best = v.severity; bestRank = order[v.severity]; }
  }
  return best;
}

function extractJson(text) {
  if (typeof text !== "string") return null;
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try { return JSON.parse(text.slice(start, end + 1)); } catch { return null; }
}
