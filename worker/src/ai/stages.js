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

// Each selectable pipeline stage, its recommendation task family, and the hard
// capability a model MUST have to be valid for it.
export const STAGES = Object.freeze([
  { id: "triage",   label: "Triage (FP filter)",     family: "triage",              requires: "tools",     stage: 2 },
  { id: "validate", label: "Deep validation",         family: "vuln_classification", requires: "reasoning", stage: 3 },
  { id: "fix",      label: "Fix generation",          family: "multifile_fix",       requires: "coding",    stage: 4 },
  { id: "verify",   label: "Cross-model verification", family: "vuln_classification", requires: "reasoning", stage: 5, distinctFrom: "fix" },
]);

export const STAGE_IDS = Object.freeze(STAGES.map((s) => s.id));

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

/** The full per-stage option set for the UI (dropdowns), plus the defaults. */
export function stageOptions() {
  return STAGES.map((s) => {
    const options = validModelsForStage(s.id);
    return {
      id: s.id, label: s.label, stage: s.stage, family: s.family,
      requires: s.requires, distinctFrom: s.distinctFrom || null,
      options, default: options[0] ? options[0].model : null,
    };
  });
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
 * Returns per-stage priced rows + a total, with the platform margin applied so
 * the number shown is the CUSTOMER price (algosize_price), consistent with the
 * meter. An unpriced model yields null for that stage (never $0), and the total
 * is flagged `partial` — unmeasured is never folded in as zero.
 */
export function estimatePipelineCost(config = {}, { tokens = DEFAULT_STAGE_TOKENS, marginRate = DEFAULT_MARGIN_RATE, routeToMcp = [] } = {}) {
  const perStage = {};
  let rawTotal = 0, priced = 0, counted = 0;
  for (const s of STAGES) {
    const model = config[s.id];
    // A stage routed to an external agent costs the platform no Workers AI.
    if (routeToMcp.includes(s.id)) {
      perStage[s.id] = { model: model || null, routedToMcp: true, rawCostUsd: 0, algosizePrice: 0 };
      continue;
    }
    if (!model) { perStage[s.id] = { model: null, rawCostUsd: null, algosizePrice: null }; continue; }
    const vol = tokens[s.id] || {};
    const c = costOf(model, vol);
    counted++;
    if (c.priced) {
      const margin = computeMargin(c.totalCostUsd, marginRate, false);
      perStage[s.id] = { model, rawCostUsd: c.totalCostUsd, algosizePrice: margin.algosizePrice, verified: c.verified };
      rawTotal += c.totalCostUsd; priced++;
    } else {
      perStage[s.id] = { model, rawCostUsd: null, algosizePrice: null, reason: c.reason };
    }
  }
  const rawMarginedTotal = computeMargin(priced > 0 ? rawTotal : null, marginRate, false);
  return {
    perStage,
    perFinding: {
      rawCostUsd: priced > 0 ? rawTotal : null,
      algosizePrice: rawMarginedTotal.algosizePrice,
      partial: priced < counted, // some selected stage could not be priced
    },
  };
}

/**
 * Validate a stage-model config server-side. PURE. This is the enforcement the
 * client CANNOT be trusted to do: Stage 5 must differ from Stage 4, and every
 * chosen model must be valid for its stage's role. Returns { ok, errors:[] }.
 */
export function validateStageConfig(config = {}) {
  const errors = [];
  for (const s of STAGES) {
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
    const a = config[s.id], b = config[s.distinctFrom];
    if (a && b && a === b) {
      errors.push({ stage: s.id, code: "must_differ",
        message: `${s.label} must use a different model than ${STAGES.find((x) => x.id === s.distinctFrom).label} — a fix cannot grade its own author.` });
    }
  }
  return { ok: errors.length === 0, errors };
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
