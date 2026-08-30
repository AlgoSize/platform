# AI usage metering plan

A per-org / per-user meter for AI consumption. **Greenfield** — §4 of
[CLOUDFLARE-CAPABILITIES-AUDIT.md](./CLOUDFLARE-CAPABILITIES-AUDIT.md)
establishes that nothing today records tokens, cost, or model per call. This is
a plan, not an implementation.

The design follows the platform's standing rules: **every SQL read filters
`org_id` first**; **customer source is never persisted** (a meter records
*that* a call happened and *how much*, never the prompt or the code); and an
**unmeasured cost is never rendered as zero** — a call whose token count the
provider did not return is recorded as `tokens: null`, not `0`.

---

## 1. Where the data has to be captured

Every LLM call resolves through one of two functions. Both must be
instrumented, and neither reads usage today:

| Path | Function | Returns usage? |
| --- | --- | --- |
| generic | `llmChat` (`analyzers/llm.js:104`) | no — extractors read content only (`llm.js:219`, `:192`) |
| direct Anthropic | `chatAnthropic` (`fix/providers.js:154`) | **discards `body.usage`** at `providers.js:187` |

The fix: extend each success shape to carry `usage` and `model`, read from the
provider response the code already has in hand. Anthropic returns
`usage.input_tokens` / `usage.output_tokens`; Workers AI and OpenAI return a
`usage` block on the same response object the extractors already parse. **No new
network call** — the data is already in the response, thrown away.

Workers AI **via a gateway** additionally exposes usage in AI Gateway
analytics, which is the Cloudflare-native half (§4).

---

## 2. What to record, per call

| Field | Source | Notes |
| --- | --- | --- |
| `org_id` | request context | filter key; NOT NULL |
| `user_id` | request context | nullable for system/cron calls |
| `feature` | call site | one of the enum in §3 |
| `provider` | `llmChat` result | `workers-ai` / `openai` / `claude` |
| `model` | provider response | `body.model` (`providers.js:187`) or resolved model |
| `input_tokens` | `usage` block | **null** if provider did not return it |
| `output_tokens` | `usage` block | **null** if absent |
| `estimated_cost_usd` | derived (§5) | **null** when tokens are null |
| `duration_ms` | `Date.now()` delta | wall time — already computed for `AgentExecutionRecord` |
| `status` | call result | `ok` / `error` / `fallback` |
| `fallback_from` | `llmChat` chain | provider that failed before this one succeeded, or null |
| `scan_id` / `fix_task_id` | call context | correlation, nullable |
| `created_at` | now | INTEGER epoch, matching `mcp_tool_calls` |

This mirrors `mcp_tool_calls` (`migrations/0019_mcp.sql:49`) deliberately — same
`org_id` + `created_at` + `duration_ms` + `status` spine — so the two tables
read alike and an operator learns one shape.

---

## 3. The `feature` dimension — the real call sites

Not invented — these are the four AI call sites the audit found. The enum is
exactly this set:

| `feature` value | Call site | Job |
| --- | --- | --- |
| `optimizer_refactor` | `analyzers/llm.js:270` ← `optimizer.js:163` | rewrite a slow function (flagged `ENABLE_REFACTOR_SUGGESTIONS`) |
| `advisory_fix` | `analyzers/fixgen.js:98` ← `handlers/fix.js:35` | `/api/fix` prose+snippet, kinds `vuln` / `arch` |
| `fix_proposal` | `fix/providers.js:151`/`:164` ← `orchestrate.js:133` | structured `/api/fix/propose` pipeline |
| `fix_explain` / `fix_risk` / `fix_compare` | `providers.js:223`/`:236`/`:293` | explanation, risk summary, multi-provider comparison |

If a fifth AI feature is added later, it adds an enum value here — the meter is
call-site-complete by construction, not a guess at what might use AI.

---

## 4. Cloudflare-native vs. Algosize-owned — the split

| Concern | Owner | Why |
| --- | --- | --- |
| Durable per-org/user ledger, queryable as spend | **Algosize** (`ai_usage` D1 table) | the platform already owns org-scoped billing data; a meter that lives only in a vendor dashboard cannot drive `/api/me` quota UI or invoices |
| Real-time analytics dashboard (volume, latency, error rate) | **Cloudflare** (AI Gateway) | free, no code, once a gateway exists |
| Rate limiting / spend caps at the edge | **Cloudflare** (AI Gateway) | stops abuse before it costs a token — but see the boundary |
| Per-request attribution metadata | **both** | Algosize writes the row; the gateway tags the request so its analytics can slice the same way |

> **Confirmed capabilities — TO BE FILLED IN.** The Cloudflare half assumes AI
> Gateway supports per-metadata rate limiting, spend limits, and custom metadata
> dimensions. That is a **control-plane fact not verifiable from the checkout**
> (see [REPLIT-CLOUDFLARE-EXECUTION-MAP.md](./REPLIT-CLOUDFLARE-EXECUTION-MAP.md)
> Task A4). Until an operator confirms it against current Cloudflare docs, the
> Algosize-owned `ai_usage` table is the **authoritative** meter and the
> gateway is a convenience, not a dependency. Do not build enforcement that
> only works if the gateway does something unconfirmed.

If the gateway is used, attach metadata dimensions `org`, `user`, `repo`,
`feature`, `scan_id`, `fix_task_id` to each request so gateway analytics slice
the same way the D1 table does.

---

## 5. Estimated cost

Cost is **estimated**, never claimed as billed truth — the label everywhere is
`estimated_cost_usd`. Derived from `input_tokens`/`output_tokens` × a static
per-model price table maintained in the repo (a constant, not a live feed;
updated when a vendor changes pricing, same discipline as any pinned dependency).
When tokens are null, cost is null — an unmeasured call does not read as free.

---

## 6. Budget model

- **Per-org monthly budget** and optional **per-user** sub-budget, stored beside
  the plan/entitlement data, enforced the way `quota.js` enforces run counts
  (reserve → run → settle), reusing the `USAGE` Durable Object pattern for
  atomicity where a race matters.
- **Threshold events** (`budget_80pct`, `budget_exceeded`) recorded as rows and
  surfaced through the existing alert path (`quotaWarning`,
  `email/templates.js`) — no new alerting subsystem.
- **Enforcement is degrade, not crash:** over budget, AI features return a clear
  `ai_budget_exceeded` (like `quota_exceeded` today), while the deterministic
  scanners — which need no model — keep working. A security scan must never stop
  because an AI budget ran out.

---

## 7. Suggested shape (illustrative, not final schema)

```sql
CREATE TABLE IF NOT EXISTS ai_usage (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id             TEXT    NOT NULL,
  user_id            TEXT,
  feature            TEXT    NOT NULL,   -- enum from §3
  provider           TEXT    NOT NULL,   -- workers-ai | openai | claude
  model              TEXT,
  input_tokens       INTEGER,            -- NULL when provider omits usage
  output_tokens      INTEGER,
  estimated_cost_usd REAL,               -- NULL when tokens are NULL
  duration_ms        INTEGER,
  status             TEXT    NOT NULL,   -- ok | error | fallback
  fallback_from      TEXT,
  scan_id            TEXT,
  fix_task_id        TEXT,
  created_at         INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ai_usage_org ON ai_usage(org_id, created_at);
```

Nullable token/cost columns are the schema-level expression of "unmeasured is
not zero." Reads always begin `WHERE org_id = ?`.

---

## 8. Build order (all repo-only until the gateway)

1. Instrument `llmChat` + `chatAnthropic` to carry `usage`/`model` back.
2. Add the `ai_usage` migration + org-scoped write path, called from the two
   entrypoints.
3. Add the per-model price table + `estimated_cost_usd` derivation.
4. Add the budget model + degrade-not-crash enforcement.
5. Surface per-org usage in the admin panel and `/api/me`.
6. **Then**, once Task A1 stands up a gateway, wire request metadata and adopt
   gateway analytics as the real-time view — after Task A4 confirms its feature
   set.
