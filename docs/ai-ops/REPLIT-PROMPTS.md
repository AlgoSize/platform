# Replit prompts — the Cloudflare-access parts only

Everything in the Workers AI metering + margin system that can be built as
worker code **is already built and merged** (pricing engine, model
recommendation, usage record, aggregation, the 25% platform margin layer). This
document is *only* for the pieces that need something the worker's sandbox
cannot reach from CI:

- the **live Cloudflare pricing page**, which the sandbox egress proxy blocks
  (`developers.cloudflare.com` is not allow-listed), so prices in
  `worker/src/ai/pricing.js` are relayed, not fetched;
- the **Cloudflare Billable Usage / GraphQL Analytics API**, which needs a
  Cloudflare API token the worker code must never carry into a repo;
- **AI Gateway** provisioning, a Cloudflare dashboard/API operation.

Replit is the execution environment for these three, because it can hold the
Cloudflare credential and reach Cloudflare directly. Each prompt below is
self-contained — hand it to Claude in Replit as-is. Nothing here changes the
worker's billing math; these jobs **feed** it (fresh prices) and **check** it
(reconciliation), and stand up the gateway it can route through.

> **Guardrail for all three.** These jobs touch billing truth. Hold every one to
> the platform's standing rule: *never render unmeasured as clean.* A price that
> could not be fetched is stale, not current; a reconciliation that could not run
> is unknown, not "matches"; a gateway that is not confirmed bound is absent, not
> assumed. Write NULL / "unverified", never a fabricated success.

---

## Prompt 1 — Pricing auto-fetch (keep `pricing.js` honest against the live page)

```
You are operating in Replit, which CAN reach developers.cloudflare.com (the
AlgoSize worker's CI sandbox cannot — that is why this job lives here).

GOAL
Fetch Cloudflare's current Workers AI model prices and produce a diff against
the prices committed in the AlgoSize/platform repo at
worker/src/ai/pricing.js, so an operator can reconcile before billing.

DO
1. Fetch the Workers AI models/pricing pages:
   - https://developers.cloudflare.com/workers-ai/models/
   - https://developers.cloudflare.com/workers-ai/platform/pricing/
   Parse, for each model AlgoSize prices (the PRICING array in pricing.js):
   the $/1M input, $/1M output, cached-input price where shown, and the
   Neuron-per-1000 USD rate (NEURON_PRICE).
2. Read the committed prices from pricing.js in the repo (the PRICING rows and
   NEURON_PRICE). Match by the @cf/... model id.
3. Emit a reconciliation report (markdown + JSON):
   - one row per model: committed price, live price, delta, and a status of
     MATCH | CHANGED | MODEL_GONE | NEW_MODEL;
   - the Neuron rate: committed vs live;
   - a "fetched_at" timestamp and the source URL for every number.
4. If ANY price CHANGED or a model is GONE, mark the report
   reconcile_required: true and list the exact pricing.js edits a human would
   make (new effective-window rows — NEVER mutate an existing row; the registry
   is versioned so history reprices correctly).

DO NOT
- Do NOT edit pricing.js or open a PR automatically. This job REPORTS; a human
  applies the change as a new versioned row after eyeballing the diff.
- Do NOT emit a MATCH for a model you could not fetch. A model whose live price
  did not parse is status FETCH_FAILED, not MATCH. Unmeasured is not "matches".
- Do NOT invent a Neuron rate. If the pricing page's Neuron figure did not
  parse, say so; billing math depends on it.

OUTPUT
Write reconciliation-<date>.md and reconciliation-<date>.json. Print the
summary line: "<n> changed, <n> gone, <n> new, <n> fetch-failed —
reconcile_required: <bool>".

CADENCE
Wire this as a weekly Replit scheduled job. Prices drift; a weekly diff means a
stale price is caught in days, not discovered in an invoice.
```

**Why this can't be worker code:** the CI sandbox proxy blocks
`developers.cloudflare.com`, so the worker literally cannot fetch the page. The
prices in `pricing.js` are marked `verified: true` meaning *"has a real source"*,
not *"confirmed against the live page today"* — this job closes that gap.

---

## Prompt 2 — Billable Usage reconciliation (worker cost vs Cloudflare invoice)

```
You are operating in Replit and hold the Cloudflare API token
(CLOUDFLARE_API_TOKEN, account-scoped, Workers AI + Analytics read). The
AlgoSize worker must NEVER carry this token, which is why reconciliation runs
here, not in the worker.

GOAL
Reconcile what the AlgoSize meter THINKS a period cost (sum of ai_usage.total_cost,
the RAW Cloudflare cost — NOT algosize_price, which includes the platform
margin) against what Cloudflare actually billed for Workers AI (Neurons), and
flag any drift.

DO
1. Query Cloudflare's GraphQL Analytics API for Workers AI Neuron consumption
   for the account over a period (day and month grain). Endpoint:
   https://api.cloudflare.com/client/v4/graphql with the account token.
   Pull the billable Neuron totals.
2. Get the meter's view for the same period. Two options — use whichever the
   operator wires:
   (a) an admin, org-scoped read of SUM(neurons_consumed) and SUM(total_cost)
       from ai_usage grouped by day/month; or
   (b) an exported CSV the operator drops in.
   IMPORTANT: total_cost is RAW Cloudflare cost. algosize_price = raw + 25%
   platform margin and is what the CUSTOMER pays — it must NOT be compared to
   the Cloudflare invoice. Compare Neurons to Neurons, raw USD to raw USD.
3. Produce a reconciliation report:
   - Cloudflare billed Neurons vs meter neurons_consumed (sum), and the delta;
   - implied USD (Neurons x the committed rate) vs meter SUM(total_cost);
   - a per-day table so a spike is locatable;
   - a drift_pct and a status: RECONCILED (<1% drift) | DRIFT | UNMEASURED.
4. Call out the two structural gaps the meter already knows about:
   - rows with neurons_source = 'estimated' (cost-derived, not Cloudflare-
     reported) — these are the expected source of small drift;
   - rows with total_cost NULL (unpriced model) — these are UNMEASURED and must
     be reported as a count, never folded into the sum as 0.

DO NOT
- Do NOT report RECONCILED if any period had NULL/unmeasured meter cost. An
  unmeasured period is status UNMEASURED, not "matches" — same rule the whole
  platform runs on.
- Do NOT compare algosize_price to the Cloudflare invoice. That would make the
  25% margin look like a billing error.
- Do NOT write the Cloudflare token into any repo, report, or log line.

OUTPUT
reconciliation-usage-<period>.md + .json, with the drift table and a one-line
verdict. If status is DRIFT, include the top 3 days by delta.

CADENCE
Monthly, just after Cloudflare closes the billing period, before AlgoSize bills
customers on algosize_price.
```

**Why this can't be worker code:** it needs the account-scoped Cloudflare API
token, which must not live in the worker or the repo, and it reads Cloudflare's
billing API directly. The worker meters; Replit reconciles the meter against the
invoice.

---

## Prompt 3 — AI Gateway provisioning (the routing/observability front door)

```
You are operating in Replit and hold the Cloudflare API token
(CLOUDFLARE_API_TOKEN with AI Gateway edit). This is a Cloudflare dashboard/API
provisioning job, not worker code.

GOAL
Stand up a Cloudflare AI Gateway for AlgoSize's Workers AI traffic so calls get
caching, rate-limiting, and per-request logging/analytics, and hand back the
exact binding values the worker needs.

DO
1. Create (or confirm) an AI Gateway named "algosize" on the account via the
   Cloudflare API. Enable request logging and analytics.
2. Configure sane defaults: caching on for idempotent calls, a rate limit that
   matches AlgoSize's expected AI volume (start conservative), and log
   retention per the account's privacy posture — logs must hold correlation
   metadata only, NOT prompt/response content, to match the worker's rule that
   ai_usage.request_metadata never stores content.
3. Return the operator handoff:
   - the gateway id / slug and the account id;
   - the Workers AI binding change (the gateway option passed to env.AI.run,
     i.e. { gateway: { id: "algosize" } }) that routes worker calls through it;
   - which provider value the meter should record for gatewayed calls
     ("workers-ai-gateway", already an allowed provider in ai_usage) so gateway
     traffic is distinguishable from direct traffic in the meter.
4. Verify: make one test call through the gateway and confirm it appears in the
   gateway's analytics AND that the response still carries usage so the meter
   can price it. Report both as PASS/FAIL — a gateway that swallows the usage
   field would blind the meter.

DO NOT
- Do NOT enable content logging. Prompt/response bodies must not be retained;
  the platform stores correlation keys only.
- Do NOT report the gateway as "bound" just because it was created. Bound means
  a worker call was confirmed to route through it AND still return usage. An
  unconfirmed binding is ABSENT, not assumed.
- Do NOT write the Cloudflare token into the repo or the handoff doc.

OUTPUT
gateway-handoff.md with the id/slug, the exact env.AI.run gateway option, the
provider value to record, and the two verification results (routes-through:
PASS/FAIL, usage-preserved: PASS/FAIL).
```

**Why this can't be worker code:** creating a gateway is a Cloudflare
provisioning call needing the API token; the worker only *uses* the gateway once
it exists. The meter already recognises `workers-ai-gateway` as a provider, so
gatewayed traffic is billable and distinguishable the moment the binding lands.

---

## Prompt 4 — Vectorize index for the fix pipeline's retrieval layer

```
You are operating in Replit and hold the Cloudflare API token
(CLOUDFLARE_API_TOKEN with Vectorize edit). This is a Cloudflare provisioning
job — the AlgoSize worker uses the index once it exists but cannot create it.

GOAL
Create a Cloudflare Vectorize index so the multi-model fix pipeline's support
layer (worker/src/ai/retrieval.js) can embed findings and retrieve similar
prior fixes as context for fix generation. Without the index, retrieval
degrades to "no prior art" — the pipeline still runs, this only enriches it.

DO
1. Create a Vectorize index named "algosize-fixes". Dimensions MUST match the
   embedding model the worker routes to (recommend("embeddings") → bge-m3,
   which outputs 1024-dim vectors — confirm the current dimension against the
   model card before creating; a dimension mismatch makes every query fail).
   Metric: cosine.
2. Bind it to the worker as env.VECTORIZE (the binding name retrieval.js
   checks). Return the exact wrangler.toml [[vectorize]] block to add.
3. Confirm the metadata fields retrieval.js writes are indexable: ruleId,
   category, fingerprint, summary. Enable metadata indexing on category and
   ruleId so filtered queries work.
4. Verify: insert one test vector with the descriptor metadata, run one query,
   confirm a match comes back. Report PASS/FAIL.

DO NOT
- Do NOT store file content in the index. retrieval.js writes a source-free
  descriptor (rule/category/fingerprint/hashes) only; keep it that way — the
  index must never become a second copy of customer source.
- Do NOT report the binding as ready until a query has actually returned a
  match AND the dimension matches the live embedding model.
- Do NOT write the Cloudflare token into the repo or the handoff doc.

OUTPUT
vectorize-handoff.md with the index name, the [[vectorize]] binding block, the
confirmed dimension + metric, and the insert/query verification result.
```

**Why this can't be worker code:** creating a Vectorize index is a Cloudflare
provisioning call needing the API token; the worker only reads/writes the index
once the `env.VECTORIZE` binding exists. `retrieval.js` already degrades
gracefully when the binding is absent, so the pipeline ships and works before
this lands — the index only turns on the "similar prior fixes" context.

---

## What stays with the operator (not Replit, not the worker)

Four decisions are human calls, listed here so nothing falls between the seams:

1. **Pre-billing price sign-off.** Prompt 1 reports drift; a human applies the
   new versioned pricing row and confirms the Neuron rate before the next
   customer bill. The code will bill on whatever `pricing.js` says — keeping it
   true is an operational duty, not an automated one.
2. **The margin rate itself.** Shipped at 25% (`margin_config.mc_default_v1`).
   Changing it is a DB operation — close the active row (`effective_to = now`),
   insert a new one — never an edit, so history keeps its billed rate. Internal
   orgs get `organisations.is_internal = 1` to bill at raw cost.
3. **The AI spend budget limit.** `AI_BUDGET_USD` on the Worker is the only
   knob behind the admin AI-spend panel's budget pills, and it is optional:
   unset means spend is tracked but never capped, and the panel says exactly
   that rather than showing a reassuring green pill. Setting it is a Worker
   var, not a Cloudflare provisioning step — see
   [ADMIN-AI-SPEND.md](./ADMIN-AI-SPEND.md).
4. **Free-allocation policy.** Cloudflare's daily free Neuron allocation is
   per-account; how AlgoSize sub-allocates it across orgs (and whether the
   margin applies once an org crosses into paid Neurons) is a product decision
   the meter records but does not decide.
