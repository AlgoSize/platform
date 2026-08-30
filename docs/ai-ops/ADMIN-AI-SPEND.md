# Admin → AI spend & margin

The operator-side view of the metering system: what every AI call cost
Cloudflare, what Algosize marked it up by, and what the customer is billed —
for a window, grouped by account, model, or feature.

Route: `GET /api/admin/ai-usage`, behind `requireAdmin` (the `ADMIN_EMAILS`
allowlist). Screen: `site/admin.html#aiusage`, rendered by
`renderAiUsage()` in `site/assets/js/admin.js`.

---

## The rule this surface exists to obey

**Never render unmeasured as clean.** An AI call whose model has no verified
price produces `total_cost = NULL` in `ai_usage` — not `0`. Everything
downstream has to carry that through:

| Fact | How it reaches the screen | What it must never look like |
| --- | --- | --- |
| No row could be priced in a group | `totalCostUsd: null`, `measured: "none"` | `$0.00` |
| Some rows could | `partial: true`, `measured: "partial"` | a confident total |
| Nothing has ever been recorded | `emptyState.reason: "no_rows_ever"` | "no spend this month" |
| Rows exist, none in this window | `emptyState.reason: "no_rows_in_window"` | the same empty table |
| Spend can't be measured against a budget | `budget.state: "unmeasured"` | "within budget" |

Two tests enforce this end to end: `worker/scripts/test-admin-ai-usage.mjs`
(the endpoint's numbers) and `worker/scripts/test-admin-aiusage-frontend.mjs`
(what actually lands in the DOM — a source-text assertion cannot tell
`fmtUsd(null)` from `fmtUsd(0)`).

---

## Request

| Param | Values | Default |
| --- | --- | --- |
| `window` | `7d`, `30d`, `period` (calendar month to date) | `30d` |
| `groupBy` | `org`, `model`, `feature` | `org` |
| `sort` | `name`, `requests`, `neurons`, `cost`, `margin`, `revenue` | `cost` |
| `dir` | `asc`, `desc` | `desc` |

Anything else is a `400` with a named error (`invalid_window`,
`invalid_group`, `invalid_sort`, `invalid_dir`) — never a silently
substituted default.

**Sorting is server-side on purpose.** On a money or Neuron scale an unpriced
group has no rank at all; sorting it as `0` puts it at the bottom ascending
(reads as "cheapest") and at the top descending (reads as "biggest spender"),
and both are false. `sortGroups()` in `worker/src/ai/aggregate.js` removes
those groups from the comparison and appends them after it in **both**
directions, ordered among themselves by request count. Only the server still
holds the nulls, so only the server can apply that rule.

## Response

```jsonc
{
  "generatedAt": 1756512000,
  "window": "30d", "groupBy": "org", "sort": "cost", "dir": "desc",
  "range": { "startAt": 1753920000000, "endAt": 1756512000000 },

  "summary": {
    "requests": 40, "measuredRequests": 31,
    "neurons": 1200000,
    "totalCostUsd": 13.2,        // raw Cloudflare cost — cost of goods
    "platformMarginUsd": 3.3,    // the 25% markup, stored at write time
    "algosizePriceUsd": 16.5,    // what the customer is billed
    "marginPct": 20,             // margin as a share of REVENUE (25% markup = 20%)
    "partial": true              // totals are a lower bound
  },

  "coverage": {                  // the denominator under every figure above
    "requests": 40, "measuredRequests": 31, "unmeasuredRequests": 9,
    "measuredPct": 77.5,
    "state": "full" | "partial" | "none" | "empty"
  },

  "emptyState": null,            // or { reason, lastRowAt } when nothing is in range
  "lastRowAt": 1756511000000,    // newest recorded call for a known tenant, ever

  "groups": [{
    "key": "org_9b44", "label": "Beacon",
    "requests": 31, "measuredRequests": 31, "measured": "full",
    "neurons": 1200000, "totalCostUsd": 13.2,
    "platformMarginUsd": 3.3, "algosizePriceUsd": 16.5, "marginPct": 20,
    "partial": false, "errors": 0,
    "budget": { "state": "ok", "spendUsd": 16.5, "limitUsd": null, "pct": null }
  }],

  "trend": [{ "date": "2026-08-29", "neurons": …, "totalCostUsd": …,
              "platformMarginUsd": …, "algosizePriceUsd": …,
              "requests": 12, "measuredRequests": 10, "partial": true }],

  "topExpensive": [{
    "id": 1, "orgId": "org_9b44", "orgName": "Beacon",
    "feature": "verify", "model": "gpt-oss-20b", "provider": "workers-ai",
    "totalCostUsd": 0.33, "platformMarginUsd": 0.082, "algosizePriceUsd": 0.412,
    "neurons": 30000,
    "inputTokens": 177000, "outputTokens": 21000, "totalTokens": 198000,
    "scanId": null, "fixTaskId": null, "status": "ok", "createdAt": 1756511000000
  }],

  "budget": { "limitUsd": null, "note": "…" }
}
```

Notes that matter:

- **The price boundary holds here too.** `totalCostUsd` and
  `platformMarginUsd` are admin-only figures. Customer-facing surfaces show
  `algosizePriceUsd` alone.
- **`marginPct` is a share of revenue, not of cost.** A 25% markup on cost is
  20% of what the customer pays. It is `null` unless both sides are measured
  and revenue is greater than zero — a ratio built on an unmeasured half is
  not a small margin, it is no margin figure.
- **`request_metadata` is never returned.** Prompts and responses stay out of
  this endpoint entirely; a test asserts it.
- **Tenant reads are explicit.** Usage is read per organisation with an
  `org_id = ?` binding over the enumerated `organisations` rows, so a row with
  an unknown `org_id` (a malformed database) cannot enter a total. `lastRowAt`
  is queried the same way for the same reason.
- **Tokens explain a cost.** "$0.41" is a number; "198k tokens through a
  reasoning model" is a cause. Absent when the provider returned no usage
  block — never `0`.

---

## The one operator knob: `AI_BUDGET_USD`

A single optional environment variable on the Worker. It is the spend limit
that `budgetStatus()` classifies against, and it applies **per group** in this
view (per account when grouped by account).

| State | Meaning |
| --- | --- |
| `ok` | Under 80% of the limit — or no limit set, in which case spend is *tracked but never capped*. |
| `soft` | At or past 80%. An alerting threshold, not an enforcement one. |
| `hard` | At or past 100%. |
| `unmeasured` | Spend could not be computed. Explicitly **not** "under budget". |

**Unset is a safe, honest default.** With no `AI_BUDGET_USD`, the endpoint
returns `limitUsd: null` and says so in `budget.note`: *"No AI_BUDGET_USD
limit is configured; spend is tracked but not capped."* The panel renders a
"no cap" pill rather than a green "within budget" one, because there is no
budget to be within.

This endpoint **classifies only — it does not enforce.** Nothing in the
request path reads it to block a call. Wiring `hard` to actual refusal is a
separate product decision (the fix pipeline's stage funnel is the natural
place), deliberately not made here.

To set it:

```
wrangler secret put AI_BUDGET_USD          # or a plain [vars] entry — it is not a secret
```

A non-numeric or non-positive value is treated as unset, not as zero.

---

## Cloudflare-side work required: none

Everything on this page reads D1 (`ai_usage`, `organisations`) through the
already-deployed Worker. There is no new binding, queue, KV namespace,
Durable Object, or dashboard operation behind it, and nothing to provision
before it works.

The only Cloudflare-touching items remain the ones already tracked in
[REPLIT-PROMPTS.md](./REPLIT-PROMPTS.md) — live price reconciliation,
Billable Usage reconciliation, AI Gateway, and the optional Vectorize index —
and none of them is a prerequisite for this panel. They make the *numbers*
truer against a Cloudflare invoice; this panel renders whatever the meter
recorded, and says plainly when it recorded nothing.
