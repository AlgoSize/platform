// Pipeline stage → valid-model rules + cost estimate, in one pure module.
//
// The stage model selector (the "Perplexity switcher") only offers models that
// can actually do a stage's job: triage needs function calling for structured
// output, validation and verification need reasoning, fix needs a code
// specialist, and — the load-bearing rule — Stage 5 (verify) must be a
// DIFFERENT model than Stage 4 (fix), so a fix is never graded by its own
// author. This module is the single source of truth for all of that, consumed
// by the API endpoint (client dropdowns + live cost), the config validator
// (server-side enforcement), and the tests. It never hardcodes a slug: valid
// models come from the recommendation registry (ai/models.js), priced by
// ai/pricing.js.

import { MODELS, recommend } from "./models.js";
import { costOf } from "./pricing.js";
import { computeMargin, DEFAULT_MARGIN_RATE } from "./margin.js";

// THE FUNNEL. Not every finding reaches every stage, and that is the whole
// economics of the pipeline: triage sees everything because it is cheap, and
// the expensive coding model sees a tenth of it because triage and validation
// have already thrown the rest away. These shares are the same ones the
// orchestrator actually applies (see fix/pipeline.js) — roughly 15% of raw
// findings survive triage into deep validation, and about 10% reach a patch.
//
// They exist here because a per-finding price that charges every stage at full
// volume is not a conservative estimate, it is a WRONG one: it quotes ~4x the
// real blended cost and would make the platform look uncompetitive against its
// own bill. A stage's contribution is its model price × the share of findings
// that reach it.
export const FUNNEL_SHARE = Object.freeze({
  detect: 1.0, triage: 1.0, validate: 0.15, fix: 0.10, verify: 0.10,
});

// Stage 1 is an anchor, not a choice: deterministic SAST rules, secret
// patterns and dependency manifests. It is listed so the UI can show the whole
// chain and so the cost breakdown has an honest $0 line rather than starting
// at Stage 2 and leaving a reader to wonder what happened to detection.
export const DETECT_STAGE = Object.freeze({
  id: "detect", label: "Detection", stage: 1, selectable: false,
  share: FUNNEL_SHARE.detect,
  description: "Deterministic SAST rules, secret patterns and dependency manifests.",
  note: "Exhaustive and free — there is no model to choose.",
});

// Each selectable pipeline stage, its recommendation task family, and the hard
// capability a model MUST have to be valid for it.
export const STAGES = Object.freeze([
  { id: "triage",   label: "Triage (FP filter)",     family: "triage",              requires: "tools",     stage: 2,
    description: "A cheap model reads each finding with a short code window and calls it true, false, or escalate.",
    note: "Suppresses most raw SAST noise before anything expensive runs." },
  { id: "validate", label: "Deep validation",         family: "vuln_classification", requires: "reasoning", stage: 3,
    description: "A reasoning model gets the full function, callers, imports and config, and judges exploitability.",
    note: "Critical findings run as an ensemble — a split vote goes to a human, never to a guess." },
  { id: "fix",      label: "Fix generation",          family: "multifile_fix",       requires: "coding",    stage: 4,
    description: "A code-specialist model writes the patch, with similar prior fixes from your history as context.",
    note: "" },
  { id: "verify",   label: "Cross-model verification", family: "vuln_classification", requires: "reasoning", stage: 5, distinctFrom: "fix",
    description: "A different model checks the patch: target removed, nothing new introduced, still parses, blast radius in bounds.",
    note: "" },
]);

export const STAGE_IDS = Object.freeze(STAGES.map((s) => s.id));

/**
 * Expand a route-to-agent selection to the stages it actually implies.
 *
 * Routing Stage 4 parks Stage 5 with it. The agent that writes a patch in its
 * own checkout is the only party holding that patch, so there is nothing here
 * for a verification model to read — an "S4 routed, S5 in-house" pipeline
 * would be verifying a patch it never received. Coupling them in one place
 * means the estimate, the validator and the orchestrator cannot disagree about
 * which stages the platform is paying for.
 *
 * (The VERDICT is still Algosize's: a patch handed back through
 * algosize_record_patch goes through the same static validation as an
 * in-house one. What moves to the agent is the model work, not the judgement.)
 */
export function expandRouting(routeToMcp = []) {
  const set = new Set((routeToMcp || []).filter((id) => STAGE_IDS.includes(id)));
  if (set.has("fix")) set.add("verify");
  // Deliberately NOT frozen. The array is built fresh on every call, so a
  // freeze protects no shared state — it only turns an ordinary
  // `routeToMcp.sort()` in a caller into a runtime TypeError.
  return [...set];
}

// A model is "code capable" for the fix stage if it scores well on coding.
const CODING_FLOOR = 70;

function meetsRequirement(model, requires) {
  if (requires === "tools") return model.tools === true;
  if (requires === "reasoning") return model.reasoning === true;
  if (requires === "coding") return (model.coding || 0) >= CODING_FLOOR;
  return true;
}

/**
 * The valid models for a stage, best-first, each with its capability flags and
 * price. PURE. `exclude` drops slugs (used to enforce Stage 5 ≠ Stage 4 when a
 * Stage 4 choice is already known). Deprecated/avoid models never appear
 * (recommend() filters them).
 */
export function validModelsForStage(stageId, { exclude = [] } = {}) {
  const stage = STAGES.find((s) => s.id === stageId);
  if (!stage) return [];
  const recs = recommend(stage.family);
  return recs
    .filter((r) => !exclude.includes(r.model))
    .map((r) => ({ ...r, model: r.model }))
    .filter((r) => {
      const m = MODELS.find((x) => x.model === r.model);
      return m && meetsRequirement(m, stage.requires);
    })
    .map((r) => ({
      model: r.model, label: r.label, tier: r.tier,
      capability: r.capability, coding: r.coding, costScore: r.costScore,
      reasoning: r.reasoning, tools: r.tools, contextWindow: r.contextWindow,
      priceHint: priceHint(r.model),
    }));
}

/**
 * The full per-stage option set for the UI (dropdowns), plus the defaults.
 *
 * Stage 1 leads the list as a non-selectable anchor (`selectable: false`,
 * `options: []`) so a client renders the whole five-stage chain from one
 * response instead of hardcoding the detection row itself — the one place a
 * frontend would otherwise have to know something about the pipeline that the
 * server did not tell it.
 */
export function stageOptions() {
  const detect = {
    id: DETECT_STAGE.id, label: DETECT_STAGE.label, stage: DETECT_STAGE.stage,
    family: null, requires: null, distinctFrom: null,
    description: DETECT_STAGE.description, note: DETECT_STAGE.note,
    share: DETECT_STAGE.share, selectable: false,
    options: [], default: null,
  };
  return [detect].concat(STAGES.map((s) => {
    const options = validModelsForStage(s.id);
    return {
      id: s.id, label: s.label, stage: s.stage, family: s.family,
      requires: s.requires, distinctFrom: s.distinctFrom || null,
      description: s.description || "", note: s.note || "",
      share: FUNNEL_SHARE[s.id] ?? 1, selectable: true,
      options, default: options[0] ? options[0].model : null,
    };
  }));
}

// Approximate token volumes per stage for a single finding, so the UI can show
// a live per-finding cost as models change. Triage is cheap+short; validation
// reads a function; fix reads + rewrites a file; verify reads both.
export const DEFAULT_STAGE_TOKENS = Object.freeze({
  triage:   { inputTokens: 700,  outputTokens: 120 },
  validate: { inputTokens: 2500, outputTokens: 300 },
  fix:      { inputTokens: 4000, outputTokens: 1500 },
  verify:   { inputTokens: 4500, outputTokens: 400 },
});

/**
 * Estimate the per-finding cost of a stage-model selection. PURE.
 *
 * `config` — { triage, validate, fix, verify } model slugs (any may be null).
 *
 * The number returned is BLENDED ACROSS THE FUNNEL: each stage contributes its
 * price at that stage's token load multiplied by the share of findings that
 * actually reach it. Charging every stage at 100% would quote roughly four
 * times the real cost, because the coding model — by far the most expensive
 * one — sees about a tenth of what detection produces. `perStage` therefore
 * reports both figures: `algosizePricePerRun` (what one finding costs IF it
 * reaches this stage) and `algosizePrice` (that figure at this stage's share,
 * which is what sums to the total).
 *
 * The platform margin is applied so the number shown is the CUSTOMER price,
 * consistent with the meter.
 *
 * UNPRICED IS NOT ZERO, AND HERE IT IS NOT A TOTAL EITHER. If any selected
 * stage has no published rate, `algosizePrice` on the total comes back null
 * with `partial: true` and the unpriced stages named. A quote is not a rollup:
 * an admin dashboard can honestly show a lower bound and label it, but a price
 * a customer might act on cannot be a number we are unable to stand behind.
 * The priced stages are still itemised so the gap is visible rather than
 * hidden behind one dash.
 */
export function estimatePipelineCost(config = {}, { tokens = DEFAULT_STAGE_TOKENS, marginRate = DEFAULT_MARGIN_RATE, routeToMcp = [] } = {}) {
  const routed = expandRouting(routeToMcp);
  const perStage = {};
  const unpriced = [];
  let rawTotal = 0, priced = 0, counted = 0;

  // Stage 1 is always in the breakdown and always free — deterministic rules
  // run on every finding and call no model.
  perStage.detect = {
    model: null, share: FUNNEL_SHARE.detect, selectable: false,
    rawCostUsd: 0, algosizePrice: 0, algosizePricePerRun: 0,
  };

  for (const s of STAGES) {
    const model = config[s.id];
    const share = FUNNEL_SHARE[s.id] ?? 1;
    // A stage routed to an external agent costs the platform no Workers AI.
    // That is a real, measured zero — the agent spends its own tokens — not an
    // unmeasured value dressed up as free.
    if (routed.includes(s.id)) {
      perStage[s.id] = { model: model || null, share, routedToMcp: true,
        rawCostUsd: 0, algosizePrice: 0, algosizePricePerRun: 0 };
      continue;
    }
    if (!model) {
      perStage[s.id] = { model: null, share, rawCostUsd: null, algosizePrice: null, algosizePricePerRun: null };
      continue;
    }
    const vol = tokens[s.id] || {};
    const c = costOf(model, vol);
    counted++;
    if (c.priced) {
      const atShare = c.totalCostUsd * share;
      const margin = computeMargin(atShare, marginRate, false);
      const perRun = computeMargin(c.totalCostUsd, marginRate, false);
      perStage[s.id] = { model, share, rawCostUsd: atShare,
        algosizePrice: margin.algosizePrice,
        algosizePricePerRun: perRun.algosizePrice, verified: c.verified };
      rawTotal += atShare; priced++;
    } else {
      perStage[s.id] = { model, share, rawCostUsd: null, algosizePrice: null,
        algosizePricePerRun: null, reason: c.reason };
      unpriced.push(s.id);
    }
  }

  const partial = priced < counted;
  // A partial estimate has no headline number at all — see the note above.
  const total = computeMargin(partial || priced === 0 ? null : rawTotal, marginRate, false);
  return {
    perStage,
    routeToMcp: routed,
    perFinding: {
      rawCostUsd: partial || priced === 0 ? null : rawTotal,
      algosizePrice: total.algosizePrice,
      // The same figure at the scale people actually reason about. Null for
      // exactly the same reason the per-finding price is.
      per100Findings: total.algosizePrice === null ? null : total.algosizePrice * 100,
      partial,
      unpricedStages: unpriced,
    },
  };
}

/**
 * Validate a stage-model config server-side. PURE. This is the enforcement the
 * client CANNOT be trusted to do: Stage 5 must differ from Stage 4, and every
 * chosen model must be valid for its stage's role. Returns { ok, errors:[] }.
 *
 * `routeToMcp` narrows what is checked to what the platform will actually run.
 * A stage handed to an external agent has no Algosize-side model, so holding a
 * leftover dropdown value against it would reject a configuration that is
 * fine — and, worse, would train someone to clear a field to get past an error
 * that was never about their pipeline. Routing is expanded first, so parking
 * the fix stage also stops S5 being graded.
 */
export function validateStageConfig(config = {}, { routeToMcp = [] } = {}) {
  const routed = expandRouting(routeToMcp);
  const errors = [];
  for (const s of STAGES) {
    if (routed.includes(s.id)) continue;
    const model = config[s.id];
    if (!model) continue; // a stage left on "auto" (recommend default) is fine
    const valid = validModelsForStage(s.id).some((o) => o.model === model);
    if (!valid) {
      errors.push({ stage: s.id, code: "invalid_for_stage",
        message: `${model} is not a valid model for ${s.label} (needs ${s.requires}).` });
    }
  }
  // The distinct-model invariant, enforced here rather than only in the UI.
  for (const s of STAGES) {
    if (!s.distinctFrom) continue;
    // Only meaningful when Algosize runs BOTH sides of the pair: if the agent
    // writes the patch and checks it, there is no in-house grader to conflict.
    if (routed.includes(s.id) || routed.includes(s.distinctFrom)) continue;
    const a = config[s.id], b = config[s.distinctFrom];
    if (a && b && a === b) {
      errors.push({ stage: s.id, code: "must_differ",
        message: `${s.label} must use a different model than ${STAGES.find((x) => x.id === s.distinctFrom).label} — a fix cannot grade its own author.` });
    }
  }
  return { ok: errors.length === 0, errors, routeToMcp: routed };
}

function priceHint(model) {
  const c = costOf(model, { inputTokens: 1_000_000, outputTokens: 0 });
  const out = costOf(model, { inputTokens: 0, outputTokens: 1_000_000 });
  return {
    inputPer1M: c.priced ? round(c.totalCostUsd) : null,
    outputPer1M: out.priced ? round(out.totalCostUsd) : null,
    verified: c.priced ? c.verified : false,
  };
}
function round(n) { return typeof n === "number" ? Math.round(n * 1e6) / 1e6 : null; }
