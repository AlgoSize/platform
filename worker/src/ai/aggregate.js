// AI usage aggregation + budget logic — pure functions over usage rows.
//
// No IO. These take an array of records (whatever shape the ai_usage table
// returns) and roll them up. Kept pure so the aggregation the admin dashboard
// shows and the aggregation a test asserts are the same function — a reporting
// number and a billing number must never be computed two different ways.
//
// Every rollup preserves BOTH axes the brief asks for: `neurons` (Cloudflare's
// reconciliation unit) and `totalCostUsd` (the derived money). Neurons are the
// truth for reconciliation against a Cloudflare invoice; USD is the product
// view. They travel together so neither is ever silently dropped.

/** Sum a field, treating null/undefined as "unmeasured" — NOT as zero. */
function sumMeasured(rows, key) {
  let sum = 0, measured = 0, total = rows.length;
  for (const r of rows) {
    const v = r[key];
    if (typeof v === "number" && Number.isFinite(v)) { sum += v; measured++; }
  }
  // If nothing was measured, the sum is null (unknown), not 0 (free). If some
  // rows were measured, the sum stands but `partial` flags that it is a lower
  // bound — the same discipline the scanner uses for partial coverage.
  return { sum: measured === 0 ? null : sum, measured, total, partial: measured < total };
}

/**
 * Group usage rows by a dimension and sum neurons + cost per group.
 *
 * `dimension` is a field name: org_id, user_id, repository_id, feature_name,
 * model, or a date bucket you have already added to the rows.
 */
export function aggregateBy(rows, dimension) {
  const groups = new Map();
  for (const r of rows) {
    const k = r[dimension] ?? "(none)";
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  return [...groups.entries()]
    .map(([key, group]) => {
      const neurons = sumMeasured(group, "neurons_consumed");
      const cost = sumMeasured(group, "total_cost");
      return {
        [dimension]: key,
        requests: group.length,
        neurons: neurons.sum,
        totalCostUsd: cost.sum,
        // A group whose cost could not be fully measured is flagged, never
        // rounded up to a confident number.
        partial: neurons.partial || cost.partial,
        errors: group.filter((r) => r.status === "error").length,
      };
    })
    .sort((a, b) => (b.totalCostUsd || 0) - (a.totalCostUsd || 0));
}

/** A YYYY-MM-DD (daily) or YYYY-MM (monthly) bucket from an epoch-ms row. */
export function withDateBucket(rows, granularity = "day") {
  return rows.map((r) => {
    const d = new Date(typeof r.created_at === "number" ? r.created_at : Date.parse(r.created_at));
    const iso = d.toISOString();
    const bucket = granularity === "month" ? iso.slice(0, 7) : iso.slice(0, 10);
    return { ...r, date_bucket: bucket };
  });
}

/** Daily or monthly cost trend, ascending by bucket — graph-ready. */
export function costTrend(rows, granularity = "day") {
  const bucketed = withDateBucket(rows, granularity);
  return aggregateBy(bucketed, "date_bucket")
    .sort((a, b) => String(a.date_bucket).localeCompare(String(b.date_bucket)))
    .map((g) => ({ date: g.date_bucket, neurons: g.neurons, totalCostUsd: g.totalCostUsd, requests: g.requests, partial: g.partial }));
}

/** The N most expensive individual tasks (rows), for the "top expensive" panel. */
export function topExpensive(rows, n = 10) {
  return [...rows]
    .filter((r) => typeof r.total_cost === "number")
    .sort((a, b) => b.total_cost - a.total_cost)
    .slice(0, n);
}

// ---------------------------------------------------------------------------
// Budgets
// ---------------------------------------------------------------------------

export const BUDGET_STATE = Object.freeze({ OK: "ok", SOFT: "soft", HARD: "hard", UNMEASURED: "unmeasured" });

/**
 * Where an org (or user, or feature) stands against a budget.
 *
 * `spendUsd` may be null — meaning cost could not be measured, e.g. every call
 * hit an unverified/unpriced model. That is NOT "under budget"; it returns
 * state `unmeasured`, because a spend you cannot measure must not read as safe.
 *
 * `softPct` (default 0.8) is the alert threshold; at or above the limit is
 * `hard`. Enforcement (block vs. warn) is the caller's; this only classifies.
 */
export function budgetStatus(spendUsd, limitUsd, { softPct = 0.8 } = {}) {
  if (spendUsd === null || spendUsd === undefined) {
    return { state: BUDGET_STATE.UNMEASURED, spendUsd: null, limitUsd, pct: null };
  }
  if (!(limitUsd > 0)) {
    // No limit set — usage is tracked but never blocked.
    return { state: BUDGET_STATE.OK, spendUsd, limitUsd: null, pct: null };
  }
  const pct = spendUsd / limitUsd;
  const state = pct >= 1 ? BUDGET_STATE.HARD : pct >= softPct ? BUDGET_STATE.SOFT : BUDGET_STATE.OK;
  return { state, spendUsd, limitUsd, pct };
}
