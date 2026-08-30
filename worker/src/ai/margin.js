// Algosize platform margin on Workers AI consumption.
//
// Algosize bills the customer the raw Cloudflare cost PLUS a platform margin
// (25% by default). This module is the one place that computes it, so the
// number the meter stores, the number a budget checks, and the number a test
// asserts all come from one function.
//
// ---------------------------------------------------------------------------
// INVARIANTS
// ---------------------------------------------------------------------------
//
// - Margin is computed at WRITE time (in buildUsageRecord), never at query
//   time — so a later rate change cannot reprice history.
// - Every ai_usage row records the margin_config.id it used
//   (`margin_version`). The active rate is a row in `margin_config` with
//   effective_to IS NULL; changing it is non-destructive (close the old row,
//   insert a new one). Old rows keep their billed rate.
// - Internal Algosize orgs pay raw cost: rate 0, no margin.
// - Unmeasured stays unmeasured THROUGH the margin: if the raw cost is null
//   (unpriced model), margin and algosize_price are null too — never 0. An
//   uncosted call is not a free call, and a 25% markup on an unknown cost is
//   not a knowable price.
// - Free-tier is different from unmeasured: raw cost 0 (a real, measured zero)
//   yields margin 0 and algosize_price 0 — correctly free.

export const DEFAULT_MARGIN_RATE = 0.25;
export const DEFAULT_MARGIN_VERSION = "mc_default_v1";

/**
 * Compute the margin split for one raw cost.
 *
 * `rawCostUsd` — the Cloudflare cost (ai_usage.total_cost). May be null.
 * `rate`       — the margin rate in effect (0..1).
 * `isInternal` — internal orgs are exempt (rate forced to 0).
 *
 * Returns { marginRate, platformMarginCost, algosizePrice } — all null when
 * rawCostUsd is null.
 */
export function computeMargin(rawCostUsd, rate = DEFAULT_MARGIN_RATE, isInternal = false) {
  const effectiveRate = isInternal ? 0 : clampRate(rate);
  if (rawCostUsd === null || rawCostUsd === undefined || !Number.isFinite(rawCostUsd)) {
    return { marginRate: effectiveRate, platformMarginCost: null, algosizePrice: null };
  }
  const platformMarginCost = rawCostUsd * effectiveRate;
  return {
    marginRate: effectiveRate,
    platformMarginCost,
    algosizePrice: rawCostUsd + platformMarginCost,
  };
}

function clampRate(r) {
  const n = Number(r);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_MARGIN_RATE;
  // A margin over 100% is almost certainly a typo (e.g. 25 instead of 0.25);
  // refuse it rather than bill a 2500% markup.
  if (n > 1) return DEFAULT_MARGIN_RATE;
  return n;
}

/**
 * Resolve the margin context for an org, best-effort.
 *
 * Reads the active `margin_config` row and the org's `is_internal` flag.
 * Falls back to the code defaults if the DB is unavailable or the tables are
 * not yet migrated — metering must not break because the margin table is
 * missing. Returns { rate, version, isInternal }.
 */
export async function resolveMargin(env, orgId, appliesTo = "workers_ai") {
  const out = { rate: DEFAULT_MARGIN_RATE, version: DEFAULT_MARGIN_VERSION, isInternal: false };
  try {
    if (!env || !env.DB) return out;
    const cfg = await env.DB.prepare(
      `SELECT id, margin_rate FROM margin_config
        WHERE applies_to IN (?, 'all') AND effective_to IS NULL
        ORDER BY effective_from DESC LIMIT 1`
    ).bind(appliesTo).first();
    if (cfg) { out.rate = cfg.margin_rate; out.version = cfg.id; }
    if (orgId) {
      const org = await env.DB.prepare(
        `SELECT is_internal FROM organisations WHERE org_id = ?`
      ).bind(orgId).first();
      if (org && org.is_internal) out.isInternal = true;
    }
  } catch {
    // Fall back to defaults — never throw into the caller's hot path.
  }
  return out;
}
