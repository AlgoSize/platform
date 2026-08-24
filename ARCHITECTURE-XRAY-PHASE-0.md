# Architecture X-ray — Phase 0: repo & infra inventory

Derived by reading this repository on `main` at `00ad83c`. Everything below is
grounded in a file you can open. Where something is absent I say absent rather
than proposing a placeholder, because the first job of this feature is to not
invent architecture and the inventory has to hold itself to that rule.

**Read the two findings in §7 before the rest.** One is a scope collision — a
large part of Phases 1–3 already exists — and one is a hard conflict between
Phase 2 and a product invariant this codebase enforces in tests.

---

## 1 · Deployable units

Three, all Cloudflare Workers. No containers, no VMs, no Kubernetes, no
Terraform, no Pulumi — I searched for `Dockerfile*`, `docker-compose*`, `*.tf`,
`*.tfvars`, `Pulumi.*`, `*.bicep`, `serverless.yml` and found none outside
`node_modules`.

| Unit | Config | Entry | Deployed by |
| --- | --- | --- | --- |
| `algosize` — the API Worker | `worker/wrangler.toml` | `worker/src/index.js` | `.github/workflows/worker.yml` |
| `algosize-sandbox` — isolate for user-supplied code | `worker-sandbox/wrangler.toml` | `worker-sandbox/src/index.js` | `worker.yml`, same job, deployed **first** |
| `algosize-site` — static assets | `wrangler.jsonc` (repo root) | none (assets-only) | `.github/workflows/site-worker.yml` |

Environments: `production` and `staging` for the API Worker and the sandbox;
the site Worker has no named environments and routes both hostnames from one
deploy.

**Route map** (this is the real request topology, from the `routes` arrays):

```
algosize.com/api/*          → algosize            (worker/wrangler.toml, env.production)
algosize.com/*              → algosize-site       (wrangler.jsonc)
staging.algosize.com/api/*  → algosize-staging    (worker/wrangler.toml, env.staging)
staging.algosize.com/*      → algosize-site       (wrangler.jsonc)
```

More-specific patterns win, which is what keeps `/api/*` reaching the API
Worker despite the site Worker's catch-all. GitHub Pages is still live but no
longer receives production traffic — routed requests terminate at the edge.

There is a fourth thing that is *not* a deployable unit and must not be modelled
as one: `dev-proxy.js` at the repo root, a local-only convenience.

---

## 2 · Stateful resources and bindings

From `worker/wrangler.toml`. Ids differ per environment; production ids shown.

| Binding | Kind | Resource | Notes |
| --- | --- | --- | --- |
| `DB` | D1 | `algosize` (`cfe388b1-…`) | 17 migrations applied; 15 live tables |
| `SESSIONS` | KV | `2a67b8b8…` | session JWT index |
| `USERS` | KV | `b321f8ee…` | user records + monthly quota counters |
| `REPORTS` | R2 | `algosize-reports` | rendered client-facing reports |
| `SCAN_QUEUE` | Queue (producer) | `algosize-scans` | monitor sweep dispatch |
| — | Queue (consumer) | `algosize-scans` | batch 10, 3 retries, DLQ `algosize-scans-dlq` |
| `SANDBOX` | Service binding | `algosize-sandbox` | Worker-to-Worker, not over the internet |
| `USAGE` | Durable Object | class `UsageCounter` | **production and staging only** — absent from the default env |
| `AI` | Workers AI | — | bound in all three envs |

D1 tables: `users`, `organisations`, `memberships`, `api_keys`, `runs`,
`monitors`, `audit_log`, `webhook_deliveries`, `email_sends`, `feature_flags`,
`email_changes`, `notification_prefs`, `referral_codes`, `referrals`,
`credit_events`. (`runs_v2` appears in migration 0007 as a rename staging table
and is not a live table.)

**Unconfirmed / worth flagging:**

- The `USAGE` Durable Object is bound in `production` and `staging` but **not**
  in the top-level default environment. `quota.js` handles a missing binding by
  falling back to KV, so this is intentional — but a graph built from the
  default env alone would omit a node that exists in production. Any collector
  must read all three environment blocks, not just the top level.
- `algosize-scans-dlq` is referenced as a `dead_letter_queue` but is never
  declared as a producer or consumer anywhere. It is a real resource that
  nothing in this repo reads. That is a legitimate node with an unconfirmed
  consumer, and precisely the kind of thing this feature should surface.

---

## 3 · External dependencies

Confirmed by call site, not by string match — several hosts in the source are
documentation links in comments and are excluded.

| Host | Reached from | Purpose | Data crossing |
| --- | --- | --- | --- |
| `api.stripe.com` | `stripe.js` | billing, subscriptions, invoices | customer id, email, amounts |
| `api.osv.dev` | `analyzers/osv.js` | vulnerability advisories | **package names + versions only** |
| `raw.githubusercontent.com` | `monitors/analyzers.js` | reads committed repo files | public repo contents |
| `api.github.com` / `github.com` | `handlers/monitors.js` | repo + lockfile fetch | public repo contents |
| `gmail.googleapis.com`, `oauth2.googleapis.com`, `www.googleapis.com` | `email/google.js` | transactional email via Workspace | recipient address, message body |
| `accounts.google.com`, `openidconnect.googleapis.com` | `handlers/auth_google.js` | OAuth sign-in | OIDC claims, email |
| `plausible.io` | `handlers/pageview.js` | analytics | pageview events, no cookies |
| `api.cloudflare.com`, `api.openai.com` | `analyzers/llm.js` | optional refactor suggestions | submitted code snippets |
| `cloudflare-dns.com` | `domains.js` | DoH CNAME verification for custom report domains | hostname only |
| Sentry ingest (host from `SENTRY_DSN`) | `observability.js` | error events | stack traces, tags |
| Slack incoming webhooks (`hooks.slack.com`) | `slack.js` | monitor alerts | repo name, finding counts |

The internal hostnames `sandbox.internal` and `usage.internal` appear in
`fetch()` calls — these are service-binding / DO stub addresses, **not**
external egress, and must be modelled as internal edges.

---

## 4 · CI/CD pipelines

Eight workflows. Four are the platform's own delivery; four are the product's
own gates, dogfooded on this repo.

**Delivery**

| Workflow | Trigger | Path filter | Deploys |
| --- | --- | --- | --- |
| `worker.yml` | push, workflow_dispatch | `worker/**`, `worker-sandbox/**`, `shared/**` | sandbox then API Worker, then smoke-tests `/api/me` |
| `site-worker.yml` | push, workflow_dispatch | `site/**`, `wrangler.jsonc` | `algosize-site` |
| `jekyll.yml` | push, workflow_dispatch | `site/**` | GitHub Pages (legacy, still live) |
| `e2e.yml` | push, pull_request | `site/**`, `worker/**`, `tests/e2e/**` | nothing — Playwright only |

**Product gates** (`algosize-audit.yml`, `algorithm-optimizer.yml`,
`algosize-estimate.yml`, `algosize-architecture.yml`) all run on
`pull_request`, all read one repository secret `ALGOSIZE_API_KEY`, and all skip
themselves with a notice when it is unset. Confirmed by log inspection on
PR #48: `estimate` and `architecture` both took the skip path in 4–5s.

**Deploy-event data available for ingestion:** the GitHub Actions REST API
gives run history, per-run commit SHA, conclusion, and timing. `worker.yml`'s
path filter is what maps *a commit touched these files* to *this service was
redeployed* — that mapping is derivable and is the honest basis for a
`deploys-to` edge. Nothing currently records deploy events into D1.

---

## 5 · Observability — what exists, what does not

**Exists:**

- `observability.js` — structured JSON to console always; optional POST to a
  Sentry envelope endpoint when `SENTRY_DSN` is set. Deliberately hand-rolled,
  no SDK, for Worker bundle size.
- `audit_log`, `webhook_deliveries`, `email_sends` D1 tables — durable records
  of security-relevant actions, Stripe webhook deliveries, and mail outcomes.
- `runs` table — every analyzer run with duration (`ms`), source (`ci` /
  `manual`), and result.
- `monitors.last_status` / `last_attempt_at` / `last_error` (migration 0017) —
  per-monitor sweep health.
- `adminSettingsHandler` → `bindingState()` — reports whether each binding is
  *present*, by truthiness. Not a health check; it never calls the resource.

**Does not exist — and Phase 2 assumes several of these:**

| Missing | Consequence for this feature |
| --- | --- |
| `observability = { enabled = true }` on the **API Worker** | It is set on `algosize-site` only. Without it, Workers Logs retention for the API Worker is not enabled, so there is no queryable log backend to read runtime signals from. **One line in `worker/wrangler.toml`.** |
| Any distributed tracing | No `traceparent`, no OpenTelemetry, no span propagation anywhere. Per-request service-to-service causality cannot be reconstructed. |
| Any uptime/synthetic check | No `/api/health` or equivalent. `worker.yml` smoke-tests `/api/me` once at deploy and never again. |
| Any metrics pipeline | No Analytics Engine binding, no Cloudflare GraphQL Analytics API calls anywhere in `worker/src/`. |
| Latency/error-rate persistence | `runs.ms` is per-analyzer-run, not per-edge. No p50/p95, no error rate by dependency. |

---

## 6 · Frontend constraints for Phase 4

`site/` has **no `package.json`, no bundler, no build step for JS**. Every
dashboard module is a vanilla ES5 IIFE registering on `window.Dash*`, loaded by
ordered `<script defer>` tags. The house rules are enforced by tests: no
`innerHTML` anywhere, DOM built via `core.el` + `textContent`.

**React Flow, Cytoscape.js and D3 are therefore all out of the box** — none is
present, and adding any of them means introducing a build pipeline to a
codebase that has deliberately avoided one, or shipping a large vendored
bundle into a Worker with a 1 MB compressed ceiling.

The existing X-ray already renders a graph without a library: `dash-arch.js`
(1,476 lines) hand-builds SVG via `createElementNS`, with L0/L1/L2 zoom, a
breadcrumb, full keyboard navigation, and PNG export via
`serializeToString` → `<img>` → canvas. Explicit `fill`/`stroke` attributes
rather than CSS classes, specifically so the PNG export is faithful.

My recommendation is to extend that renderer rather than introduce a library,
and I'd want your agreement before Phase 4 since your brief named three
libraries.

---

## 7 · Two things to decide before Phase 1

### 7.1 · Much of Phases 1–3 already exists

`worker/src/analyzers/architecture/` is 1,711 lines and already does static
graph extraction with a rules engine.

**Already built:**

- Parsers for `wrangler.toml`, `docker-compose`, `Dockerfile`, Kubernetes
  manifests, Terraform, Jekyll config, and source imports/`fetch` calls
  (`graph.js:164–583`).
- Node kinds: `worker`, `service`, `compose_service`, `database`, `kv`,
  `bucket`, `queue`, `durable_object`, `cron`, `external_api`, `static_site`.
- 16 rules with severity, evidence and remediation, including
  `datastore_shared_across_services`, `cross_cluster_bypasses_gateway`,
  `public_without_auth_marker`, `sync_chain_depth`, `shared_external_dependency`.
- Findings-level drift, in `monitors/analyzers.js` → `diffArchFindings()`,
  with the null-vs-empty baseline discipline already correct.
- The whole Phase 4 renderer, minus the new view modes.

**Genuinely absent, and what your brief actually adds:**

| Your ask | Status |
| --- | --- |
| Versioned graph **snapshots** | Absent. Only the current finding-key set is stored, on the monitor row. There is no graph history and no schema for one. |
| SPOF detection | Absent. Zero matches for `spof`, `single point`, `redundan`. |
| Blast-radius scoring | Absent as a computation. The word appears twice, in prose inside two rules' remediation text. |
| Trust boundaries as first-class | Absent. `boundary` today means *cluster* boundary in the layout sense; there is no trust zone, no crossing detection, no encryption/auth assertion on edges. |
| Data classification (PII/financial/KYC) | **Entirely absent.** Zero matches for `pii` or `data classification`. |
| CI/CD metadata as graph input | Absent. No workflow parsing, no deploy events. |
| Runtime signal reconciliation | Absent, and largely blocked — see §7.2. |
| Node metadata: owner, region, replica count, criticality, last deploy | Absent. `replica` matches only compose `deploy.replicas` parsing in the estimator. |

So this is an **extension**, not a greenfield build. That changes the plan
shape considerably and I want you to see it before I propose a schema that
either duplicates or rewrites working, tested code.

### 7.2 · Phase 2's runtime signals conflict with a product invariant

Your Phase 2 asks for *"Runtime signals if available (Cloudflare Workers
analytics/logs, request traces, error rates, latency percentiles) to validate
the static graph against what's actually happening in production."*

This platform enforces the opposite as a product promise. Every scheduled
analyzer reads **only committed repository files**. `monitors/_store.js` states
it as the reason those analyzers may run at all. The estimator's boundary is
enforced structurally: `test-estimate-history.mjs` asserts `estimate.js`
contains *no persistence reach at all*, and `test-ci-gates.mjs` denies fourteen
named credential mechanisms by name — `configure-aws-credentials`,
`azure/login`, `id-token: write`, `KUBECONFIG` among them.

Reading a customer's Cloudflare account analytics requires storing a scoped
Cloudflare API token per customer. **That is a cloud-account connector with
credential storage** — the exact thing those tests exist to prevent.

Three ways forward, and I need you to pick:

**(a) Self-only runtime signals.** The graph reads runtime data for *our own*
infrastructure using our own credentials, and customer graphs stay
static-only. Honest, ships, no invariant broken — but customers get no
runtime validation, so "declared but never called" is answerable only for us.

**(b) Customer-supplied telemetry, pushed not pulled.** The CI gate posts what
the customer's own pipeline already has — Actions run metadata, deploy events,
optionally an exported metrics file they choose to include. We never hold a
credential; they hand us a payload. Preserves the invariant, and covers the
CI/CD half of Phase 2 fully. The Workers-analytics half stays out.

**(c) Break the invariant deliberately.** Build the connector, store scoped
tokens, and update the promise, the Privacy Policy §data-we-hold, and those
tests. Defensible as a product decision. Not something I will do as an
implementation detail inside an architecture feature.

My recommendation is **(b), plus (a) for our own dogfooding**, because it gets
real deploy-event and drift data without touching the thing the product's
security posture is built on. But it is your call, and (c) is a legitimate
choice if runtime validation is the point of the feature.

---

## 8 · Proposed graph schema

Presented for review. Deliberately a **superset of the existing in-memory
graph** so `graph.js` can keep producing it with additive changes rather than a
rewrite, and so the existing 16 rules keep running unmodified.

### 8.1 · Storage

New D1 tables — migration `0018`. Snapshots are the new capability; everything
else already has a home.

```sql
-- One row per graph capture. The unit of drift comparison.
CREATE TABLE arch_snapshots (
  snapshot_id   TEXT PRIMARY KEY,
  org_id        TEXT NOT NULL,
  repo_url      TEXT,
  branch        TEXT,
  commit_sha    TEXT,              -- null for a manual upload
  source        TEXT NOT NULL,     -- 'manual' | 'ci' | 'monitor'
  captured_at   INTEGER NOT NULL,
  -- Full graph, gzipped JSON. Kept whole rather than normalised into
  -- node/edge tables: a snapshot is read as a unit, written once, never
  -- queried by column, and a 2000-file graph is a handful of KB. Splitting
  -- it would buy query flexibility nobody has asked for and cost a join
  -- per render.
  graph_json    TEXT NOT NULL,
  node_count    INTEGER NOT NULL,
  edge_count    INTEGER NOT NULL,
  -- Denormalised for the drift query, which is "the one before this one for
  -- the same repo+branch" and would otherwise scan.
  prev_snapshot_id TEXT
);
CREATE INDEX idx_arch_snap_org ON arch_snapshots (org_id, repo_url, branch, captured_at DESC);
```

Retention follows the existing 90-day run policy. I'd want to confirm that
rather than assume it.

### 8.2 · Node

```jsonc
{
  "id": "worker:algosize",              // stable across snapshots — this is what drift diffs on
  "kind": "worker",                     // existing closed set, extended below
  "name": "algosize",
  "cluster": "api",                     // existing: deployment grouping, used by the layout

  "confidence": "confirmed",            // confirmed | unconfirmed
  "evidence": [                         // every node cites its source file+line, or it is unconfirmed
    { "file": "worker/wrangler.toml", "line": 1, "what": "name" }
  ],

  "meta": {                             // every field nullable; null means NOT MEASURED, never a default
    "owner":        null,               // no CODEOWNERS in this repo — would be null here today
    "region":       null,               // Workers are edge-global; null is the honest value
    "replicas":     null,               // integer where declared (compose deploy.replicas), else null
    "criticality":  null,               // 'tier1'|'tier2'|'tier3', author-set, never inferred
    "lastDeployAt": null,               // from CI metadata when available
    "health":       null                // 'ok'|'degraded'|'failing', only from a real signal
  },

  "analysis": {                         // computed by Phase 3, never persisted as input
    "spof":        null,                // null until the detector has run
    "blastRadius": null,                // integer count of reachable downstream nodes
    "trustZone":   null                 // 'public'|'authenticated'|'internal'|'thirdParty'
  }
}
```

Node kinds: the eleven that exist, plus `ci_pipeline` and `environment` for
Phase 2. I'd keep the set closed and validated — an unrecognised kind should be
rejected at the boundary, matching how `normalizeAnalyzers` handles its set.

### 8.3 · Edge

```jsonc
{
  "id": "worker:algosize->d1:algosize",
  "from": "worker:algosize",
  "to": "d1:algosize",
  "kind": "reads_writes",               // calls | reads_writes | publishes | subscribes | deploys_to | depends_on

  "confidence": "confirmed",            // confirmed | unconfirmed
  "origin": "static",                   // static | runtime | both  ← the reconciliation field
  "evidence": [ { "file": "worker/wrangler.toml", "line": 12, "what": "d1_databases binding" } ],

  "meta": {
    "protocol":       "d1",             // http | https | d1 | kv | r2 | queue | service | do
    "async":          false,
    "dataClass":      null,             // null = NOT CLASSIFIED. never assume 'public'.
    "encryptedInTransit": null,         // null = unknown; true only where provable
    "authenticated":  null,
    "retry":          null,             // { max, backoff } where declared
    "observedLatencyMs": null,          // p50/p95 when a runtime source exists
    "observedErrorRate": null
  }
}
```

**Two design points I want reviewed:**

1. **`origin` is what makes reconciliation expressible.** `static` = declared,
   never observed. `runtime` = observed, never declared — a shadow dependency.
   `both` = agreed. Under option (b) from §7.2 this field is only ever
   populated for edges the customer's own CI reports, and it stays `static` for
   everyone else. It must not default to `both`.

2. **`null` means not measured, everywhere.** The same rule the scorecard
   already enforces. A `dataClass` of `null` renders as *unclassified*, never
   as *public* — the whole point of a trust-boundary view is that unclassified
   data crossing a boundary is a finding, not a pass.

### 8.4 · Finding

Unchanged from the existing rules-engine shape, so the 16 current rules emit
without modification:

```jsonc
{
  "rule": "spof_no_redundant_path",
  "severity": "high",
  "target": "d1:algosize",
  "affects": ["worker:algosize", "queue:algosize-scans"],
  "why": "…",
  "fix": "…",
  "evidence": [ { "file": "…", "line": 0 } ]
}
```

---

## 9 · What I need from you before Phase 1

1. **Does the inventory match your understanding?** Particularly: three
   Workers, no containers, no Terraform, and the `algosize-scans-dlq` queue
   that nothing consumes.
2. **§7.2 — pick (a), (b), or (c).** This shapes Phase 2 entirely and I will
   not choose it for you.
3. **§7.1 — extend the existing analyzer, or build parallel?** My strong
   recommendation is extend; it is tested, it already parses six config
   formats, and its 16 rules are good.
4. **§6 — accept the existing hand-rolled SVG renderer for Phase 4**, or do
   you want a library badly enough to add a JS build step to `site/`?
5. **Should `observability = { enabled = true }` be added to the API Worker
   now?** One line, unblocks any future self-runtime work, and is worth doing
   regardless of what you decide about §7.2.

No implementation code has been written. Nothing in this document changes any
existing behaviour.
