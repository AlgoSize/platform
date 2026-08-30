// The multi-model fix pipeline — a relay, not a single call.
//
//   Stage 1  deterministic detection      (SAST — already done; input here)
//   Stage 2  fast triage / FP filter       triage.js       cheap model
//   Stage 3  deep validation (+ ensemble)  deepvalidate.js reasoning model(s)
//   Stage 4  fix generation                orchestrate.js  coding model
//   Stage 5  cross-model verification      verify.js       DIFFERENT model
//
// The shape of the thing is a COST FUNNEL: every finding pays for cheap
// triage, ~15% survive to reasoning validation, ~10% reach a coding model,
// and the same ~10% are verified. So the cheapest stage runs on the most
// findings and the dearest on the fewest — the opposite of routing everything
// through one expensive model.
//
// Two disciplines run the whole length of it:
//   • Each model is chosen by the recommendation engine via routing.js, never
//     a hardcoded slug, and remapped onto models we actually price.
//   • Unmeasured never becomes clean. A finding triage could not reach, a
//     validation the models split on, a fix a verifier could not read — none
//     of these resolve to "safe"/"done". They resolve to escalate/needs_human,
//     because the fix-side cost of a false "resolved" is a shipped
//     vulnerability with a green badge.
//
// Budget funnel: the pipeline gates on the CUSTOMER-billed spend (algosize
// price, incl. margin), passed in by the caller from the ai_usage rollup:
//   • under 80%  → run all five stages.
//   • 80–100%    → run detection→validation (validation is a safety stage and
//     always runs), but QUEUE fix generation/verification instead of spending
//     coding-model budget. Findings come back as "fix_queued".
//   • at/over 100% → run detection only; findings come back "budget_blocked",
//     surfaced WITHOUT AI enrichment and flagged "pending AI analysis — budget
//     limit reached". Never silently dropped.

import { prioritizeFindings } from "./schemas.js";
import { triageFinding } from "./triage.js";
import { deepValidateFinding } from "./deepvalidate.js";
import { verifyFix } from "./verify.js";
import { runFixPipeline } from "./orchestrate.js";
import { retrieveSimilarFixes } from "../ai/retrieval.js";
import { resolveStageModel } from "../ai/routing.js";
import { recordAiUsage } from "../ai/usage.js";
import { budgetStatus, BUDGET_STATE } from "../ai/aggregate.js";

export const PIPELINE_OUTCOMES = Object.freeze([
  "fix_ready",        // passed static validation AND cross-model verification
  "needs_human",      // reached a stage that requires a person (escalate/reject)
  "fix_queued",       // validated but fix deferred by the budget funnel
  "waiting_for_agent",// validated, then handed to an external MCP agent (route-to-MCP)
  "suppressed_fp",    // triage judged it a false positive (confidently)
  "not_exploitable",  // deep validation (or ensemble) found it not exploitable
  "budget_blocked",   // over budget: detected only, no AI enrichment
  "ineligible",       // cannot become a fix task (dependency, file too large…)
  "error",            // a stage failed in a way that is not a verdict
]);

/**
 * Run the full pipeline over a set of findings.
 *
 * args:
 *   findings   normalized SAST findings (Stage 1 output).
 *   files      [{path, content}] — the source the findings live in.
 *   env        Worker env (AI binding, DB, VECTORIZE…).
 *   meter      metering attribution { orgId, userId, repositoryId, scanId,
 *              marginRate, marginVersion, isInternal, metadata }.
 *   budget     { spendUsd, limitUsd } — customer-billed spend so far + limit.
 *   options    { frameworks, language, provider, retrieval, ensembleSize,
 *                voteThreshold, maxVerifyRetries, budgetSoftPct }.
 *
 * Returns { summary, results } — results is one record per finding, summary is
 * the funnel counts. Never throws: a stage failure becomes an outcome, not an
 * exception, because a pipeline over N findings must not lose the other N-1 to
 * one bad call.
 */
export async function runFullPipeline({ findings, files, env, meter = {}, budget = {}, options = {} }) {
  const {
    frameworks = [], language = null, provider = null,
    retrieval = true, ensembleSize = 3, voteThreshold = 0.5,
    maxVerifyRetries = 2, budgetSoftPct = 0.8,
    // Stage ids whose work is handed to an external MCP agent instead of run on
    // Workers AI. Routing "fix" (the expensive stage) parks validated findings
    // as waiting_for_agent — Algosize is billed for Stages 1-3 only, and the
    // customer's own Claude Code / Kimi session does Fix + Verify at zero
    // Workers AI token cost. This is the lever that cuts the bulk of pipeline
    // spend, which sits in Stages 4-5.
    routeToMcp = [],
  } = options;
  const parkFix = routeToMcp.includes("fix");

  const gate = budgetStatus(budget.spendUsd ?? null, budget.limitUsd ?? 0, { softPct: budgetSoftPct });
  // HARD → detection only. SOFT → through validation, queue the fix.
  const blockAll = gate.state === BUDGET_STATE.HARD;
  const queueFixes = gate.state === BUDGET_STATE.SOFT;

  const ranked = prioritizeFindings(findings || []);
  const results = [];

  for (const { finding, priority } of ranked) {
    const base = { finding: fingerprintView(finding), priority: priority.score };

    // Over budget: detect only, enrich nothing, and say so.
    if (blockAll) {
      results.push({ ...base, outcome: "budget_blocked", stage: "detection",
        note: "pending AI analysis — budget limit reached" });
      continue;
    }

    // ---- Stage 2: triage ---------------------------------------------------
    const window = codeWindow(finding, files);
    const triage = await triageFinding(finding, window, env, {
      language, budget: queueFixes, meter,
    });
    if (triage.verdict === "fp") {
      results.push({ ...base, outcome: "suppressed_fp", stage: "triage",
        triage: slimTriage(triage) });
      continue;
    }
    // "escalate" survives to validation (deeper look), same as "tp".

    // ---- Stage 3: deep validation (+ ensemble for critical) ---------------
    const context = validationContext(finding, files, frameworks);
    const validation = await deepValidateFinding(finding, context, env, {
      language, ensembleSize, voteThreshold, budget: queueFixes, meter,
    });
    if (validation.decision === "drop") {
      results.push({ ...base, outcome: "not_exploitable", stage: "validation",
        triage: slimTriage(triage), validation: slimValidation(validation) });
      continue;
    }
    if (validation.decision === "escalate" || validation.decision === "unmeasured") {
      results.push({ ...base, outcome: "needs_human", stage: "validation",
        reason: validation.decision === "unmeasured" ? "validation unmeasured — not confirmed safe" : "models split on exploitability",
        triage: slimTriage(triage), validation: slimValidation(validation) });
      continue;
    }
    // decision === "proceed" → this finding is worth a fix.

    // Route-to-MCP: validated, then handed to the customer's own agent instead
    // of spending coding-model budget here. The finding is real and worth
    // fixing — an agent will do it — so this is a distinct outcome from queued
    // (budget) or needs_human (unresolved), and costs zero Workers AI tokens.
    if (parkFix) {
      results.push({ ...base, outcome: "waiting_for_agent", stage: "validation",
        note: "validated; fix routed to an external MCP agent — use algosize_get_scan_findings to pick it up",
        triage: slimTriage(triage), validation: slimValidation(validation) });
      continue;
    }

    // Budget funnel: validated, but defer the expensive coding/verify stages.
    if (queueFixes) {
      results.push({ ...base, outcome: "fix_queued", stage: "validation",
        note: "validated; fix generation deferred — approaching budget limit",
        triage: slimTriage(triage), validation: slimValidation(validation) });
      continue;
    }

    // ---- Stage 4 + 5: fix, then cross-model verify ------------------------
    const fixed = await generateAndVerify(finding, files, env, {
      frameworks, language, provider, retrieval, maxVerifyRetries, meter, budget: queueFixes,
    });
    results.push({ ...base, ...fixed,
      triage: slimTriage(triage), validation: slimValidation(validation) });
  }

  return { summary: summarize(results, gate), results };
}

/**
 * Stage 4 (fix) + Stage 5 (cross-model verify), with up to N verify-driven
 * retries. Returns { outcome, stage, ... }.
 */
async function generateAndVerify(finding, files, env, opts) {
  const { frameworks, language, provider, retrieval, maxVerifyRetries, meter, budget } = opts;

  // Route Stage 4's coding model by complexity (single vs multi-file). The
  // pipeline currently scopes a fix task to the finding's own file, so it is
  // single-file; multi-file remains available for callers that supply more.
  const complexity = (files || []).length > 1 ? "multi_file" : "single_file";
  const fixRoute = await resolveStageModel(env, {
    stage: "fix", cweFamily: finding.category || null, language, complexity, budget,
  });
  const fixModel = fixRoute.model;

  // Prior art (best-effort; [] when Vectorize is not provisioned).
  let priorArt = [];
  if (retrieval) {
    const r = await retrieveSimilarFixes(env, finding, 5, { meter });
    priorArt = r.matches || [];
  }

  // Stage 4 runs through the sanctioned fix orchestrator (task → provider →
  // static validation → one constrained retry). We route its model by scoping
  // env.WORKERS_AI_MODEL to the chosen coder — the same override llmChat
  // already honours — so no change to the orchestrator's provider selection.
  const fixEnv = fixModel ? { ...env, WORKERS_AI_MODEL: fixModel } : env;

  let run = await runFixPipeline({ finding, files, frameworks, provider: provider || "kimi", env: fixEnv });
  meterFix(env, run, meter, "fix_proposal");

  if (!run.ok) {
    if (run.stage === "task") return { outcome: "ineligible", stage: "task", reason: run.reason, message: run.message };
    return { outcome: "error", stage: run.stage || "proposal", reason: run.error, message: run.message };
  }
  // Static validation is measured ground truth; if it failed, the fix is not
  // ready no matter what a verifier would say. Straight to a human.
  if (!run.applyable) {
    return { outcome: "needs_human", stage: "static_validation",
      reason: "fix did not pass static validation", validationVerdict: run.validation.verdict,
      blastRadius: run.validation.blastRadius, patch: run.patch || null,
      fixModel: (run.proposal && run.proposal.model) || fixModel };
  }

  // ---- Stage 5: cross-model verification, with retries ------------------
  const originalCode = (files.find((f) => f.path === finding.path) || {}).content || "";
  let attempt = 0, verify;
  let currentRun = run;
  while (attempt <= maxVerifyRetries) {
    verify = await verifyFix(finding, originalCode, currentRun.proposal, env, {
      language, excludeModel: (currentRun.proposal && currentRun.proposal.model) || fixModel, meter,
    });
    if (verify.outcome === "approved") {
      return { outcome: "fix_ready", stage: "verify", patch: currentRun.patch,
        fixModel: (currentRun.proposal && currentRun.proposal.model) || fixModel,
        verifyModel: verify.model, retries: attempt };
    }
    if (verify.outcome === "escalate" || !verify.measured) break; // unreachable verifier → human
    // rejected → one more fix attempt, folding the reviewer's issues in.
    attempt++;
    if (attempt > maxVerifyRetries) break;
    const reRun = await runFixPipeline({
      finding, files, frameworks, provider: provider || "kimi",
      env: fixModel ? { ...env, WORKERS_AI_MODEL: fixModel } : env,
    });
    meterFix(env, reRun, meter, "fix_proposal");
    if (!reRun.ok || !reRun.applyable) {
      return { outcome: "needs_human", stage: "verify",
        reason: "verifier rejected the fix and the retry did not pass static validation",
        verifyIssues: verify.issues, fixModel, verifyModel: verify.model, retries: attempt };
    }
    currentRun = reRun;
  }

  return { outcome: "needs_human", stage: "verify",
    reason: verify && verify.outcome === "escalate" ? "verifier could not decide" : "verifier rejected the fix",
    verifyIssues: (verify && verify.issues) || [], fixModel,
    verifyModel: verify && verify.model, retries: attempt };
}

/** Meter a Stage-4 fix call through ai_usage with its real token usage. */
function meterFix(env, run, meter, feature) {
  if (!run || !run.proposal) return;
  // best-effort; recordAiUsage never throws.
  recordAiUsage(env, {
    ok: true, provider: "workers-ai",
    model: run.proposal.model || null,
    usage: run.modelUsage || {},
  }, { ...meter, feature, model: run.proposal.model || null, fixTaskId: run.task && run.task.id });
}

// ---------------------------------------------------------------------------
// Context builders + view slimmers
// ---------------------------------------------------------------------------

/** ~30 lines of code around the finding, for triage. */
function codeWindow(finding, files, radius = 15) {
  const file = (files || []).find((f) => f && f.path === (finding && finding.path));
  if (!file || typeof file.content !== "string") return finding && finding.snippet || "";
  const lines = file.content.split("\n");
  const at = Math.max(0, ((finding && finding.line) || 1) - 1);
  return lines.slice(Math.max(0, at - radius), at + radius).join("\n");
}

/** The richer packet Stage 3 gets: the full file + framework context. */
function validationContext(finding, files, frameworks) {
  const file = (files || []).find((f) => f && f.path === (finding && finding.path));
  return {
    functionSource: file ? file.content : (finding && finding.snippet) || "",
    frameworks: (frameworks || []).map((f) => (typeof f === "string" ? f : f.name)).filter(Boolean),
    taintPath: finding && finding.evidence && finding.evidence.source
      ? `${finding.evidence.source} → ${finding.evidence.sink || "?"}` : null,
  };
}

function fingerprintView(f) {
  return f ? { ruleId: f.ruleId, fingerprint: f.fingerprint, severity: f.severity, category: f.category, path: f.path, line: f.line } : null;
}
function slimTriage(t) { return { verdict: t.verdict, confidence: t.confidence, model: t.model, measured: t.measured }; }
function slimValidation(v) {
  return { mode: v.mode, decision: v.decision, exploitable: v.exploitable ?? null, severity: v.severity ?? null,
    measured: v.measured, tally: v.tally || null };
}

function summarize(results, gate) {
  const by = {};
  for (const o of PIPELINE_OUTCOMES) by[o] = 0;
  for (const r of results) by[r.outcome] = (by[r.outcome] || 0) + 1;
  return {
    total: results.length,
    budgetState: gate.state,
    funnel: by,
    // The one honest headline: how many fixes are ready to apply, and how many
    // need a person. "fix_ready" is the only outcome that means "done".
    fixReady: by.fix_ready,
    needsHuman: by.needs_human,
  };
}
