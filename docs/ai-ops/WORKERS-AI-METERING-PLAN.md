# Workers AI metering plan

The billing foundation: how a Workers AI call becomes a priced, attributable,
reconcilable row. Extends [AI-USAGE-METERING-PLAN.md](./AI-USAGE-METERING-PLAN.md)
(the greenfield plan from #81) with the Neuron pricing model and the modules
now implemented.

## Units — Neurons are the truth, tokens are the view

Cloudflare bills Workers AI in **Neurons** ($0.011 / 1,000 above a daily free
allocation). The model table publishes **token prices** for text models, which
is what a user understands. So:

- **token prices** ($/1M input, $/1M output, cached input where offered) are the
  product-facing quantity and drive the USD number;
- **Neurons** are the reconciliation axis: `reportedNeurons` when Cloudflare
  returns them (billing truth), else derived from cost so every row carries one
  reconcilable Neuron figure.

Both travel together on every `ai_usage` row (`neurons_consumed`, `total_cost`)
so neither is ever silently dropped.

## The record — `ai_usage` (migration 0025)

One row per LLM call, keyed on `org_id` first (tenant rule), correlation-only
metadata (never prompt/response content). Token and cost columns are
**nullable**: an unpriced or unverified-model call stores NULL, never 0 — the
schema-level form of "unmeasured is not free."

Built by `buildUsageRecord` (pure) and written by `recordAiUsage` (best-effort,
never throws into the caller). Both in `worker/src/ai/usage.js`.

## The pricing engine — `worker/src/ai/pricing.js`

- **Versioned registry.** Each `(model, effective window)` is a row;
  `effectiveFrom`/`effectiveTo` version a price change without mutating history.
- **`costOf(model, usage, when)`** computes USD from token prices, reconciles
  Neurons, and returns `priced: false` + null cost for an unknown/deprecated
  model — never a fabricated zero.
- **Deprecation.** A deprecated row prices HISTORICAL usage (`allowDeprecated`)
  but is refused for a NEW call — a deprecated model must not bill as if live.
- **`verified` flag** rides on every result so a UI can badge "estimated ·
  unverified pricing" honestly.

## Aggregation & budgets — `worker/src/ai/aggregate.js`

Pure rollups the dashboard and a test share one implementation of:

- `aggregateBy(rows, dimension)` — org / user / repository / feature / model /
  date. Sums Neurons and cost; flags a group whose cost was only partly
  measured as `partial`, never rounds it up to a confident number.
- `costTrend(rows, "day"|"month")` — graph-ready ascending trend.
- `topExpensive(rows, n)` — the "top expensive tasks" panel.
- `budgetStatus(spend, limit)` → `ok` / `soft` (≥80%) / `hard` (≥100%) /
  **`unmeasured`** — spend that could not be measured is never "under budget".

## Free-tier allocation

Cloudflare's free Neurons are per **account**, not per org. Algosize
sub-allocates: the plan is to reserve the account's daily free Neurons against
org usage in `created_at`-day order, so the first orgs to spend each day draw
the free pool and the rest price from Neuron 1. `FREE_NEURONS_PER_DAY` holds the
allocation, flagged `verified: false` until confirmed.

## Keeping pricing current — the refresh procedure

Pricing lives in ONE file (`pricing.js`), so an update is one reviewed diff:

1. Open the Cloudflare Workers AI models page.
2. For each model in `PRICING`, compare `inputPer1M` / `outputPer1M` /
   `cachedInputPer1M`.
3. **A changed price is a NEW row**, not an edit: set the old row's
   `effectiveTo` to the change date and add a new row with `effectiveFrom` that
   date. History reprices correctly; the current window bills correctly.
4. A removed model → set `deprecated: true` (keep the row for historical
   repricing).
5. Update `NEURON_PRICE.usdPer1000` and `FREE_NEURONS_PER_DAY` if they moved;
   flip `verified: true` only after confirming against the live page.
6. Run `node scripts/test-ai-metering.mjs`.

Because the sandbox egress proxy blocks `developers.cloudflare.com`, step 1 is
an **operator or Replit** task — this code cannot fetch the page itself.

## What runs where

| Piece | Where | Access |
| --- | --- | --- |
| Pricing / aggregation / recommendation | repo | none |
| `ai_usage` table + capture | repo | none |
| Wiring `recordAiUsage` into call sites | repo | none (follow-up) |
| Pre-billing price reconciliation | Cloudflare docs | operator / Replit |
| AI Gateway (K3, native analytics) | Cloudflare | operator / Replit |
