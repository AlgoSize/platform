# Cloudflare capabilities audit

What the deployed Worker actually uses, what is code-ready but unconfigured,
and what is absent. Grounded against the repo at the time of writing —
every claim carries a `file:line`. This is an audit, not a plan; the plan is
[CLOUDFLARE-BEST-FIT-ROADMAP.md](./CLOUDFLARE-BEST-FIT-ROADMAP.md).

The governing rule from the rest of the platform applies here too: **an
unmeasured thing is never reported as clean.** Where this audit could only
read the checkout and not the live control plane, it says so.

---

## 1. Bindings in production (`worker/wrangler.toml` `[env.production]`)

| Binding | Type | Declared | Purpose |
| --- | --- | --- | --- |
| `DB` | D1 | `wrangler.toml:307` | users, run history, MCP/OAuth tables (0019), monitors |
| `SESSIONS` | KV | `wrangler.toml:296` | session JWTs + Stripe-event dedup |
| `USERS` | KV | `wrangler.toml:300` | monthly quota counters `quota:<userId>:<YYYY-MM>` |
| `REPORTS` | R2 | `wrangler.toml:314` | rendered HTML reports, `reports/<orgId>/<runId>.html` |
| `SANDBOX` | Service | `wrangler.toml:318` | runs customer JS in a sibling Worker for the optimizer |
| `AI` | Workers AI | `wrangler.toml:323` | optimizer refactor prose + `/api/fix` — the keyless LLM leg |
| `USAGE` | Durable Object | `wrangler.toml:326` | atomic monthly run counter (`UsageCounter`) |
| `SCAN_QUEUE` | Queue | `wrangler.toml:364` | nightly monitor sweep — one message per due monitor |
| — | Cron | `wrangler.toml:361` | hourly tick (`0 * * * *`); handler decides which monitors are due |

Every one of these is wired and in use. None is a placeholder in production
(the placeholder ids live only in `[env.staging]` — see the deploy
preflight `worker/scripts/check-bindings.mjs`).

---

## 2. The AI path — one working leg, three code-ready but unconfigured

All LLM traffic funnels through `llmChat` (`worker/src/analyzers/llm.js:104`)
or the parallel direct-Anthropic path (`worker/src/fix/providers.js:154`).
`llmChat` tries four legs, first-configured-wins:

| # | Leg | Gate | Credential | Configured in prod? |
| --- | --- | --- | --- | --- |
| 1 | Workers AI **binding** | `env.AI` present | keyless (the `[ai]` binding) | **✅ yes** |
| 2 | Workers AI **REST** | `CLOUDFLARE_ACCOUNT_ID` + `CLOUDFLARE_AI_TOKEN` | bearer token | ❌ code-ready, unset |
| 3 | OpenAI | `OPENAI_API_KEY` | bearer token | ❌ code-ready, unset |
| 4 | none configured | — | — | returns `configured:false` |

`resolveModel` (`llm.js:64`) picks the model:

```js
const gateway  = env.AI_GATEWAY_ID || null;
const explicit = env.WORKERS_AI_MODEL;
const model    = explicit || (gateway ? KIMI_K3 : DEFAULT_WORKERS_AI_MODEL);
```

`KIMI_K3 = "moonshotai/kimi-k3"` (third-party; `llm.js:48`) is reachable
**only through an AI Gateway** — the gateway option is passed for third-party
models only (`llm.js:129`). `DEFAULT_WORKERS_AI_MODEL = "@cf/moonshotai/kimi-k2.6"`
(`llm.js:49`) is the first-party default.

**The net effect on the deployed Worker:** `AI_GATEWAY_ID` is **not present
anywhere in `wrangler.toml`** — not a var, not in the required-secrets block
(`wrangler.toml:487`). So `gateway` is null in production, `resolveModel`
returns K2.6, and the sole working AI path is the **keyless `[ai]` binding on
Kimi K2.6**. K3-via-gateway, the REST fallback, OpenAI, and Anthropic are all
implemented and tested but unconfigured here.

`ANTHROPIC_API_KEY` (the `claude` fix provider, `providers.js:51`) is likewise
absent from `wrangler.toml` — so the fix pipeline's default provider order
`["kimi", "claude", "openai"]` (`providers.js:253`) resolves to **kimi** in
production, because it is the only leg with credentials.

---

## 3. AI Gateway — the load-bearing absence

The code is gateway-aware (`llm.js:65`, `providers.js:143`) but **no gateway
is configured**, which means the platform today has:

- no AI request analytics (Cloudflare-side),
- no AI-layer caching, retries, or spend limits,
- no per-request metadata attribution,
- no path to Kimi K3 (only K2.6 via the binding).

This is the single highest-leverage gap. Standing up an AI Gateway and setting
`AI_GATEWAY_ID` unlocks both K3 and the Cloudflare-native half of any usage
meter — see [AI-USAGE-METERING-PLAN.md](./AI-USAGE-METERING-PLAN.md).

> **Verification boundary.** Whether an AI Gateway *exists* on the account and
> what its current feature set is (per-user budgets, spend limits, the
> metadata dimensions it accepts) could **not** be verified from the checkout.
> Those are control-plane facts. The metering plan's Cloudflare-native half
> rests on that capability and must be confirmed against current Cloudflare
> docs before it is built on. Treat it as `unclear / needs confirmation`.

---

## 4. AI usage metering — absent by construction

No call site reads the `usage` / token block the providers return:

- `llm.js` reply extractors (`llm.js:219`, `:192`) read only message content —
  never `usage`, `prompt_tokens`, `completion_tokens`.
- `chatAnthropic` reads `body.model` but **discards `body.usage`**, which
  Anthropic does return (`providers.js:187`).

The two durable metering surfaces cover other things:

- **`mcp_tool_calls`** (`migrations/0019_mcp.sql:49`) — `org_id`, `tool_name`,
  `auth_method`, `scope_used`, `status`, `duration_ms`, `run_id`, `error_code`,
  `session_ref`, `created_at`. No model, token, or cost column.
- **quota counter** (`quota.js`) — one integer per user per month in `USERS`
  KV, authoritative copy in the `USAGE` Durable Object. A bare run tally; no
  model/token/cost/latency dimension.

The richest AI record, `AgentExecutionRecord` (`fix/schemas.js:302`), holds
`provider`, `model`, and `durationMs` — but no tokens and no cost — and lands
only in the **audit log as opaque metadata** (`handlers/fix.js:145`), not a
queryable meter.

**Conclusion:** a per-org / per-user AI consumption meter is **greenfield**. It
must be built beside these surfaces, not on them. Detailed in
[AI-USAGE-METERING-PLAN.md](./AI-USAGE-METERING-PLAN.md).

---

## 5. What must stay deterministic

Two things are LLM-free today and must remain so:

- **Vulnerability detection** — the scanners (`analyzers/vuln.js`,
  `analyzers/sast/`) are pattern + AST, no model.
- **Fix validation** — `fix/validate.js:48` is pure: "content in, verdict out.
  No IO, no model calls." Its verdict (`passed_static`/`failed`) is the
  platform's trust anchor. Its checks — `structural`, `blast_radius`, `parse`,
  `target_removed`, `no_new_severe` — are all measured, not judged.

Any AI plan that routes ranking, triage, or validation through a model would
undermine the one guarantee the platform sells. The model-map doc
([WORKERS-AI-USE-CASE-MAP.md](./WORKERS-AI-USE-CASE-MAP.md)) names these as
never-LLM explicitly.

---

## 6. Summary

| Capability | State |
| --- | --- |
| Workers AI (Kimi K2.6, keyless binding) | ✅ live |
| Kimi K3 via AI Gateway | ❌ gateway unset |
| Workers AI REST fallback (CI/Node) | ❌ token unset |
| OpenAI provider | ❌ key unset |
| Anthropic `claude` fix provider | ❌ key unset |
| AI Gateway (analytics / spend / cache) | ❌ absent — highest-leverage gap |
| AI usage metering (tokens / cost / model) | ❌ greenfield |
| Deterministic scan + validation | ✅ live, must stay LLM-free |
