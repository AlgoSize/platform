// AI pricing engine — token prices for the product, Neurons for reconciliation.
//
// ---------------------------------------------------------------------------
// THE TWO UNITS, AND WHICH IS THE TRUTH
// ---------------------------------------------------------------------------
//
// Cloudflare bills Workers AI in **Neurons** ($0.011 per 1,000 Neurons above a
// daily free allocation), but its model table publishes **token prices**
// ($/1M input, $/1M output) for text models — and token prices are what a user
// understands. So this registry stores token prices as the product-facing
// quantity and treats Neurons as the reconciliation axis: cost is computed from
// tokens, and Neurons are either what Cloudflare reported (billing truth) or
// derived from cost for a single reconcilable number.
//
// ---------------------------------------------------------------------------
// PROVENANCE — read before billing a customer on these
// ---------------------------------------------------------------------------
//
// The per-model prices below were RELAYED from Cloudflare's Workers AI models
// page (developers.cloudflare.com/workers-ai/models) during this session — not
// fetched by this code (the sandbox egress proxy blocks developers.cloudflare.com,
// so an operator or Replit must do the pre-billing reconciliation). They are real,
// sourced numbers, good enough to meter, rank, and graph — NOT a substitute for a
// pre-billing reconciliation against the live page, which changes over time.
// Billing a stale price as current is the same failure as a scan reporting
// unmeasured code as clean. `verified: true` here means "has a real source",
// not "confirmed against the live page today".
// The refresh procedure is docs/ai-ops/WORKERS-AI-METERING-PLAN.md.

// USD per 1,000 Neurons, above the free daily allocation. Sourced.
export const NEURON_PRICE = Object.freeze({
  usdPer1000: 0.011,
  currency: "USD",
  verified: true,
  source: "Cloudflare Workers AI pricing (relayed 2026-08); re-confirm before billing",
});

// Free Neurons per account per day. Cloudflare bills the ACCOUNT; Algosize
// sub-allocates to orgs (see the metering plan's free-tier section).
export const FREE_NEURONS_PER_DAY = Object.freeze({
  neurons: 10000,
  verified: false, // allocation not re-confirmed this session
  source: "confirm current daily free allocation against Cloudflare pricing",
});

// ---------------------------------------------------------------------------
// Pricing registry — token prices in USD per 1,000,000 tokens.
// ---------------------------------------------------------------------------
//
//   inputPer1M / outputPer1M   — USD per 1M tokens; outputPer1M is 0 for
//                                embeddings/rerankers (no generated tokens).
//   cachedInputPer1M           — null unless the model prices cached input.
//   unit                       — "token" (text) | "embedding" (input-only)
//   effectiveFrom / effectiveTo — non-overlapping windows version a price
//                                 change without mutating history; To=null is
//                                 current.
//   deprecated                 — kept for repricing old rows; refused for a new
//                                 call by pickPrice (a deprecated model must not
//                                 bill silently as if live).
//
// Prices relayed from the Cloudflare models page, 2026-08. Curated to the
// Algosize shortlist, not a full catalog dump.
export const PRICING = Object.freeze([
  // ---- embeddings / reranking (input-only) ----
  row("@cf/baai/bge-m3",                    "workers-ai", "embedding", 0.012, 0, null),
  row("@cf/qwen/qwen3-embedding-0.6b",      "workers-ai", "embedding", 0.012, 0, null),
  row("@cf/baai/bge-reranker-base",         "workers-ai", "embedding", 0.003, 0, null),
  // ---- cheap helper / general text ----
  row("@cf/ibm-granite/granite-4.0-h-micro","workers-ai", "token", 0.017, 0.112, null),
  row("@cf/zai-org/glm-4.7-flash",          "workers-ai", "token", 0.060, 0.400, null),
  // ---- reasoning ----
  row("@cf/qwen/qwen3-30b-a3b-fp8",         "workers-ai", "token", 0.051, 0.335, null),
  row("@cf/openai/gpt-oss-20b",             "workers-ai", "token", 0.200, 0.300, null),
  row("@cf/deepseek-ai/deepseek-v4-flash-0731","workers-ai","token",0.440, 1.320, 0.044),
  // ---- premium coding / remediation ----
  row("@cf/zai-org/glm-5.3-flash",          "workers-ai", "token", 0.150, 0.500, null),
  row("@cf/zai-org/glm-5.3",                "workers-ai", "token", 1.400, 4.400, null),
  row("@cf/moonshotai/kimi-k2.7-code",      "workers-ai", "token", 0.950, 4.000, null),
  // ---- vision ----
  row("@cf/google/gemma-4-26b-a4b-it",      "workers-ai", "token", 0.100, 0.300, null),
  // ---- currently wired default (kept so live traffic prices) ----
  row("@cf/moonshotai/kimi-k2.6",           "workers-ai", "token", 0.060, 0.180, null),
  // ---- deprecated: kept for historical repricing, refused for new calls ----
  { ...row("@cf/moonshotai/kimi-k2.5", "workers-ai", "token", 0.060, 0.180, null), deprecated: true },
  { ...row("@cf/facebook/bart-large-cnn", "workers-ai", "token", 0.030, 0.100, null), deprecated: true },
]);

function row(model, provider, unit, inputPer1M, outputPer1M, cachedInputPer1M) {
  return {
    model, provider, unit,
    inputPer1M, outputPer1M, cachedInputPer1M,
    effectiveFrom: "2026-01-01", effectiveTo: null, deprecated: false,
    verified: true,
    source: "Cloudflare Workers AI models page (relayed 2026-08)",
  };
}

const asTime = (d) => (d ? Date.parse(d) : null);
const numOrNull = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** The pricing row in effect for a model at an instant, or null. */
export function pickPrice(model, when = Date.now(), { allowDeprecated = false } = {}) {
  const t = typeof when === "number" ? when : asTime(when) ?? Date.now();
  const candidates = PRICING.filter((p) => {
    if (p.model !== model) return false;
    const from = asTime(p.effectiveFrom), to = asTime(p.effectiveTo);
    if (from !== null && t < from) return false;
    if (to !== null && t >= to) return false;
    return allowDeprecated || !p.deprecated;
  });
  candidates.sort((a, b) => (asTime(b.effectiveFrom) || 0) - (asTime(a.effectiveFrom) || 0));
  return candidates[0] || null;
}

/**
 * Cost of one usage record. Token prices drive USD; Neurons reconcile.
 *
 * `usage`: { inputTokens, outputTokens, cachedInputTokens, units, reportedNeurons }
 *
 * - Unknown or deprecated model with no reported Neurons → `priced: false`,
 *   null cost. NEVER zero — an unpriced call is not a free call.
 * - Cached input tokens are billed at `cachedInputPer1M` when the model prices
 *   them, else at the normal input rate (conservative — never free unless the
 *   model actually discounts cache).
 * - Neurons: `reportedNeurons` when Cloudflare returned them (billing truth,
 *   `neuronsSource: "reported"`), else derived from cost ÷ Neuron rate
 *   (`"estimated"`) so every row still carries one reconcilable Neuron number.
 */
export function costOf(model, usage = {}, when = Date.now()) {
  const price = pickPrice(model, when);
  const reported = numOrNull(usage.reportedNeurons);

  if (!price) {
    const deprecated = Boolean(pickPrice(model, when, { allowDeprecated: true }));
    return {
      priced: false,
      reason: deprecated ? "model_deprecated" : "model_not_priced",
      model, neurons: reported, neuronsSource: reported !== null ? "reported" : "none",
      totalCostUsd: null, unitCostPer1000Neurons: NEURON_PRICE.usdPer1000,
      currency: NEURON_PRICE.currency,
      inputTokens: numOrNull(usage.inputTokens), outputTokens: numOrNull(usage.outputTokens),
      verified: false,
    };
  }

  const inTok = usage.inputTokens || 0;
  const outTok = usage.outputTokens || 0;
  const cachedTok = Math.min(usage.cachedInputTokens || 0, inTok);
  const freshInTok = inTok - cachedTok;

  const cachedRate = price.cachedInputPer1M != null ? price.cachedInputPer1M : price.inputPer1M;
  const totalCostUsd =
      (freshInTok / 1e6) * price.inputPer1M
    + (cachedTok  / 1e6) * cachedRate
    + (outTok     / 1e6) * price.outputPer1M;

  let neurons, neuronsSource;
  if (reported !== null) {
    neurons = reported; neuronsSource = "reported";
  } else {
    neurons = totalCostUsd / (NEURON_PRICE.usdPer1000 / 1000);
    neuronsSource = "estimated";
  }

  return {
    priced: true,
    model, neurons, neuronsSource,
    totalCostUsd, unitCostPer1000Neurons: NEURON_PRICE.usdPer1000, currency: NEURON_PRICE.currency,
    inputTokens: numOrNull(usage.inputTokens), outputTokens: numOrNull(usage.outputTokens),
    cachedInputTokens: numOrNull(usage.cachedInputTokens),
    verified: Boolean(price.verified) && NEURON_PRICE.verified,
  };
}
