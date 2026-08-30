# AI usage audit

Answers the brief's audit questions against the real code, then states what
this work added. Builds on the earlier
[CLOUDFLARE-CAPABILITIES-AUDIT.md](./CLOUDFLARE-CAPABILITIES-AUDIT.md) (merged in
#81); this one is the billing-specific view.

## Audit questions — answered from code

| Question | Before this work | Evidence |
| --- | --- | --- |
| Usage/billing tables for AI? | **No** | `mcp_tool_calls` (0019) logs tool calls, no model/token/cost; `quota.js` counts runs |
| Per-request AI usage persisted? | **No** | `llm.js` extractors read reply only; `chatAnthropic` discarded `body.usage` |
| Model/provider abstraction? | **Yes** | `analyzers/llm.js` (`llmChat`, 4 legs), `fix/providers.js` (kimi/claude/openai) |
| Route through AI Gateway? | **Wired, unconfigured** | `resolveModel` reads `AI_GATEWAY_ID`; the var is absent from `wrangler.toml` |
| Org/user attribution for AI? | **No** | request context has org/user, but no AI record carried it |
| Costs/tokens/quotas stored? | **No AI** | quota is run counts; the only cost code is the AWS CUR analyzer, unrelated |
| Feature gating / plan limits? | **Yes, for runs** | `quota.js` (5/month free), `entitlement.js` (plan/active) |

## What this work added

A registry-driven metering + recommendation foundation under `worker/src/ai/`,
all tested (`scripts/test-ai-metering.mjs`), all repo-only:

- **`pricing.js`** — versioned pricing registry (token prices from the
  Cloudflare models page, Neurons for reconciliation), `costOf()`,
  effective-date windows, deprecation handling.
- **`models.js`** — the curated model recommendation registry, `recommend()`,
  and graph-ready datasets.
- **`aggregate.js`** — pure rollups (by org/user/repo/feature/model/date),
  cost trends, top-expensive, and budget classification.
- **`usage.js`** — `buildUsageRecord` (pure: call → priced row) and
  `recordAiUsage` (best-effort, never throws into the hot path).
- **`migrations/0025_ai_usage.sql`** — the `ai_usage` table.
- **`analyzers/llm.js`** — now returns the `usage` + `model` it used to discard.

## What is deliberately NOT done yet (follow-up phases)

- **Wiring `recordAiUsage` into every call site.** The helper exists and is
  tested; threading it through the four AI entrypoints with org context is a
  contained follow-up, kept out of this PR so the foundation lands pure and
  green.
- **Budget enforcement in the request path** — `budgetStatus` classifies;
  wiring it into `quota.js`-style reserve/settle is next.
- **Admin dashboard + graph endpoints** — the data selectors exist
  (`aggregate.js`, `models.graphData`); the HTTP routes and UI are the next
  phase.
- **AI Gateway** — needs Cloudflare access (see
  [REPLIT-CLOUDFLARE-EXECUTION-MAP.md](./REPLIT-CLOUDFLARE-EXECUTION-MAP.md)).

## Uncertainties flagged

- **Pricing provenance.** Per-model prices were relayed from the Cloudflare
  models page, not fetched by this code — the sandbox egress proxy blocks
  `developers.cloudflare.com`. `pricing.js` marks them sourced-but-reconcile.
  An operator or Replit must diff against the live page before billing.
- **Free Neuron allocation** not re-confirmed — `FREE_NEURONS_PER_DAY.verified`
  is `false`.
- **Capability/latency scores** in `models.js` are engineering estimates
  (`scored: false`); only `costScore` is anchored to the sourced prices.
