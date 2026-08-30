# Cloudflare implementation matrix

One row per Cloudflare capability. The **execution mode** column is the point
of this document: it says *where* a change to that capability can be made —
purely in the repo, in the repo but needing Replit's direct Cloudflare access
to take effect, on the Cloudflare dashboard by an operator, or unknown until
someone with the account confirms.

Execution modes:

- **repo-only** — a code or config change, merged and deployed by CI, is
  sufficient. No control-plane action.
- **repo + Replit** — the repo change is necessary but inert until a Cloudflare
  API/dashboard action provisions the resource or sets the secret. Replit holds
  that access (see [REPLIT-CLOUDFLARE-EXECUTION-MAP.md](./REPLIT-CLOUDFLARE-EXECUTION-MAP.md)).
- **dashboard/manual** — only an operator in the Cloudflare dashboard (or with
  account credentials) can do it; no repo change applies.
- **unclear** — cannot be classified from the checkout; needs account-level
  confirmation.

---

## Existing bindings — maintenance / change modes

| Capability | Current state | Change execution mode | Notes |
| --- | --- | --- | --- |
| D1 `DB` | live (`wrangler.toml:307`) | **repo + Replit** | schema changes are repo (`migrations/`); creating a new DB or rotating the id is a Cloudflare action |
| KV `SESSIONS` / `USERS` | live | **repo + Replit** | namespace creation is a Cloudflare action; use is repo |
| R2 `REPORTS` | live | **repo + Replit** | bucket creation is a Cloudflare action |
| Service `SANDBOX` | live | **repo + Replit** | the sibling Worker deploys from `worker-sandbox/`; binding resolves only after both deploy |
| Workers AI `AI` | live (K2.6) | **repo-only** | keyless binding; already declared, nothing to provision |
| Durable Object `USAGE` | live | **repo + Replit** | class is repo; the namespace + migration tag is account state (`wrangler.toml:151`) |
| Queue `SCAN_QUEUE` + DLQ | live | **repo + Replit** | queue creation is a Cloudflare action; producer/consumer wiring is repo |
| Cron trigger | live | **repo-only** | `crons = [...]` in `wrangler.toml`, applied on deploy |

---

## AI capabilities — enablement modes

| Capability | Current state | To enable | Execution mode |
| --- | --- | --- | --- |
| Kimi K2.6 (binding) | ✅ live | — | **repo-only** (done) |
| Kimi K3 (via gateway) | ❌ gateway unset | create AI Gateway, set `AI_GATEWAY_ID` secret | **repo + Replit** |
| AI Gateway analytics / cache / spend | ❌ absent | create + configure gateway | **dashboard/manual** to create; **repo + Replit** to bind |
| Workers AI REST fallback (CI) | ❌ token unset | set `CLOUDFLARE_ACCOUNT_ID` + `CLOUDFLARE_AI_TOKEN` | **repo + Replit** (secrets) |
| OpenAI provider | ❌ key unset | set `OPENAI_API_KEY` | **repo + Replit** (secret) |
| Anthropic `claude` fix provider | ❌ key unset | set `ANTHROPIC_API_KEY` | **repo + Replit** (secret) |
| AI usage meter (tokens/cost/model) | ❌ greenfield | new migration + instrument `llmChat` | **repo-only** for the Algosize-owned half; **unclear** for the Cloudflare-native half |
| Per-user AI budget enforcement | ❌ none | quota logic + optional gateway rate-limit | **repo-only** (Algosize-side); **unclear** (gateway-side) |

---

## What is repo-only and can start today

These need no Cloudflare access and can be built, tested, and merged as
ordinary PRs:

1. **Instrument `llmChat` to capture usage.** Read the `usage` block the
   providers already return (`llm.js` extractors ignore it today;
   `chatAnthropic` discards `body.usage` at `providers.js:187`), thread it back
   through the success shape. Pure code.
2. **A `ai_usage` D1 table + write path.** New migration beside
   `mcp_tool_calls`; every SQL read filters `org_id` first, matching the
   platform rule. Pure code.
3. **Estimated-cost derivation** from a static per-model price table in the
   repo. Pure code; the price table is a maintained constant, not a live feed.
4. **A per-org/per-user budget model** enforced in `quota.js`-style logic
   against the new table. Pure code.

## What genuinely needs Replit / the dashboard

1. Creating an **AI Gateway** and setting `AI_GATEWAY_ID` — unlocks K3 and the
   Cloudflare-native analytics half.
2. Setting any AI **secret** (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`,
   `CLOUDFLARE_AI_TOKEN`) — `wrangler secret put`, which Replit runs.
3. Confirming the gateway's **feature set** (budgets, spend limits, metadata
   dimensions) — dashboard/manual, and marked **unclear** until confirmed.

The exact operator prompts for each of these are in
[REPLIT-CLOUDFLARE-EXECUTION-MAP.md](./REPLIT-CLOUDFLARE-EXECUTION-MAP.md).
