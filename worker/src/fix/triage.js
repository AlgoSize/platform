// Stage 2 — fast triage / false-positive filter.
//
// Deterministic SAST is tuned for RECALL: it flags everything that matches a
// pattern or a taint shape, which means a real share of its hits are false
// positives (an unanchored keyword, a literal that looks like a credential in
// a test fixture, a sink that is not actually reachable). Stage 2 reads each
// finding with a cheap, fast model and the code around it, and returns one of
// three verdicts — true positive, false positive, or escalate — so the
// expensive stages downstream only ever see findings worth their cost.
//
// DISCIPLINE. A false-positive verdict SUPPRESSES a finding from the fix
// funnel; it does NOT delete it or mark it clean. The scanner's finding still
// stands as reported — triage only decides what is worth a fix task. And a
// low-confidence "fp" is never trusted: below a confidence floor the verdict
// is forced to "escalate", because a cheap model unsure a finding is fake is
// exactly the case a human (or a stronger model) should see. Suppressing a
// real vulnerability because a cheap model waved it off is the fix-side
// version of rendering unmeasured code as clean.

import { callModel } from "../ai/call.js";
import { resolveStageModel } from "../ai/routing.js";

export const TRIAGE_VERDICTS = Object.freeze(["tp", "fp", "escalate"]);

// Below this confidence, a "fp" is not trusted — it becomes "escalate". A
// cheap model must clear a real bar before it is allowed to drop a finding.
export const FP_CONFIDENCE_FLOOR = 0.7;

const TRIAGE_SYSTEM =
  "You are a security triage assistant. You are given ONE static-analysis " +
  "finding and the surrounding code. Decide whether it is a real issue " +
  "(true positive), a false alarm (false positive), or unclear (escalate). " +
  "Be conservative: if you are not sure it is a false positive, do NOT say " +
  "it is one. Reply with ONLY a JSON object: " +
  '{"verdict":"tp"|"fp"|"escalate","confidence":0.0-1.0,"reason":"one sentence"}. ' +
  "No prose outside the JSON.";

/**
 * Build the triage prompt for one finding + a code window. PURE.
 *
 * The window is the lines around the finding (the caller slices it); triage
 * deliberately does NOT get the whole file — that context belongs to Stage 3.
 * Snippets were already secret-masked by the scanner before the finding
 * existed, so no credential text reaches the model here.
 */
export function buildTriagePrompt(finding, codeWindow) {
  const f = finding || {};
  const cwe = Array.isArray(f.cwe) ? f.cwe.join(", ") : (f.cwe || "");
  const user =
    `Finding: ${f.title || f.ruleId || "unknown"}\n` +
    `Rule: ${f.ruleId || "?"}  Category: ${f.category || "?"}  ` +
    `Severity: ${f.severity || "?"}  Confidence: ${f.confidence || "?"}` +
    (cwe ? `  CWE: ${cwe}` : "") + "\n" +
    `Location: ${f.path || "?"}:${f.line || "?"}\n` +
    (f.evidence && f.evidence.source
      ? `Taint: source "${String(f.evidence.source).slice(0, 120)}" → sink "${String(f.evidence.sink || "").slice(0, 120)}"\n`
      : "") +
    `\nCode:\n${String(codeWindow || f.snippet || "").slice(0, 4000)}\n`;
  return { system: TRIAGE_SYSTEM, user };
}

/**
 * Parse a triage reply into a normalized verdict. PURE. Refuses rather than
 * guesses: an unparseable reply is "escalate" (never silently "fp"), because
 * a filter that fails open on garbage would drop real findings.
 */
export function parseTriageReply(text) {
  const obj = extractJson(text);
  if (!obj) return { verdict: "escalate", confidence: 0, reason: "unparseable triage reply", parsed: false };

  let verdict = String(obj.verdict || "").toLowerCase();
  if (!TRIAGE_VERDICTS.includes(verdict)) verdict = "escalate";
  let confidence = Number(obj.confidence);
  if (!Number.isFinite(confidence) || confidence < 0) confidence = 0;
  if (confidence > 1) confidence = 1;
  const reason = typeof obj.reason === "string" ? obj.reason.slice(0, 300) : "";

  // The confidence floor: an under-confident "fp" is not allowed to suppress.
  if (verdict === "fp" && confidence < FP_CONFIDENCE_FLOOR) {
    return { verdict: "escalate", confidence, reason: reason || "fp below confidence floor", parsed: true, forced: true };
  }
  return { verdict, confidence, reason, parsed: true };
}

/**
 * Triage one finding through a cheap model. Returns the verdict plus the model
 * that decided and whether the call was measured. On a provider failure the
 * verdict is "escalate" (fail safe — an unreachable filter never drops a
 * finding), flagged unmeasured so the caller can see triage did not actually
 * run.
 */
export async function triageFinding(finding, codeWindow, env, ctx = {}) {
  const routed = await resolveStageModel(env, {
    stage: "triage",
    cweFamily: familyOf(finding),
    language: ctx.language || null,
    budget: ctx.budget === true,
  });
  if (!routed.model) {
    return { verdict: "escalate", confidence: 0, reason: "no triage model available", model: null, measured: false };
  }

  const { system, user } = buildTriagePrompt(finding, codeWindow);
  const r = await callModel(env, { model: routed.model, system, user, maxTokens: 300, temperature: 0 }, {
    ...ctx.meter, feature: "fix_triage", model: routed.model,
  });
  if (!r.ok) {
    return { verdict: "escalate", confidence: 0, reason: `triage model unreachable: ${r.reason}`, model: routed.model, measured: false };
  }
  const parsed = parseTriageReply(r.reply);
  return { ...parsed, model: r.model || routed.model, measured: true };
}

function familyOf(finding) {
  // The routing key is the finding's category; a null category is the wildcard.
  return (finding && finding.category) || null;
}

function extractJson(text) {
  if (typeof text !== "string") return null;
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try { return JSON.parse(text.slice(start, end + 1)); } catch { return null; }
}
