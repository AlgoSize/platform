# MCP-PLAN.md — Algosize Model Context Protocol server

Status: **in progress.** Steps 1–5 and 8–10 are built and tested; step 6
(OAuth 2.1) is scaffolded but not finished. What follows describes what is
actually in the branch, not what was intended — where the original plan was
wrong, the correction is recorded rather than the plan quietly edited.

Branch: `feat/mcp-server`. Nothing here is live: the whole surface is behind a
flag that defaults off, and the last deliverable is a runbook a human executes.

Protocol revision: **`2025-06-18`** (Streamable HTTP, single endpoint), with
`2025-03-26` and `2024-11-05` accepted on request.

---

## 0. Corrections to the earlier plan

Recorded first, because several of them were load-bearing.

**The "already written" foundation did not run.** The prior commit's modules
could not be imported at all: `handlers/mcp.js` imported `registry.js`,
`resources.js` and `prompts.js`, none of which existed; `dispatch.js` called a
`handleRequest` export `index.js` does not have; `mcp/auth.js` queried a table
called `orgs` (it is `organisations`) and imported `sha256Hex`/`randomHex`
from `auth.js`, which exports neither. Nothing was registered in `index.js`, so
none of it had ever executed. All of it has been rewritten and every module is
now verified by import, not by reading.

**Two routes are not metered.** The tool matrix marked `algosize_generate_fix`
and `algosize_run_monitor_now` as consuming a run. Reading `index.js`:
`/api/fix` is registered as `analyzeRateLimit, requireAuth,
generateFixHandler` and `/api/monitors/:id/run` behind `requireAuth` alone —
neither carries `enforceQuota`. Both tools now report `metered: false`, and a
test asserts the flags match the chains.

**The purity rule contradicted its own example.** The build contract requires
`test-mcp-purity.mjs` to fail if a tools/ file imports `enforceQuota`, while
its worked example imports `enforceQuota` into a tool. Resolved by moving every
route→chain mapping into `src/mcp/chains.js`, one module outside `tools/`.
Tools import neither handlers nor `enforceQuota`, the guard stays absolute, and
`enforceQuota` still cannot be dropped from a metered route.

**Kimi K3 is not a slug swap.** See §9.

**22 tools, not 20.** The extra two are `algosize_get_monitor_result` and
`algosize_get_ci_snippet`, both read-only and free.

---

## 1. The one rule

Every tool is an adapter over an existing route handler, reached through
`callHandler` and nothing else. No tool contains analyzer logic, validation,
quota accounting, entitlement resolution, or SQL.

Enforced structurally by `scripts/test-mcp-purity.mjs`, which fails the build
if any file under `src/mcp/tools/` imports an analyzer, a handler,
`enforceQuota`, `entitlement.js`, or touches a binding. The guard was verified
by deliberately breaking it and confirming it fires.

The failure it prevents is invisible: a tool importing an analyzer directly
would pass every functional test and simply never charge a run.

---

## 2. Auth

Two credential types today, a third scaffolded.

| | API keys (shipped) | MCP OAuth tokens (scaffolded) |
|---|---|---|
| Format | `ask_live_…` (unchanged) | `ask_mcp_…` |
| Identity | org only | org + the consenting user |
| Scopes | all three | exactly what was consented to |
| Audience | Claude Code, Cursor, CI, the bridge | Claude.ai remote connectors |

API-key auth is the supported path for v1. `requireAuth` already resolves a
key to an org, rate-limits per org, and `enforceQuota` meters per org — so an
API-key MCP session inherits correct billing with zero new trust surface.

`mcpAuth` composes **after** `requireAuth` rather than replacing it, so the
most security-sensitive function in the codebase has exactly one
implementation. `requireAuthSoft` lets an unauthenticated request through to
`mcpAuth`, which answers with the `WWW-Authenticate` header that starts the
OAuth flow — `requireAuth`'s own 401 carries no such header, and a host that
hit it would have nowhere to go.

Scopes and what they do **not** grant: see `worker/MCP.md`. Key creation,
billing, member management and `/api/admin` have no tool and no chain entry —
absent, not gated.

---

## 3. Transport and sessions

One endpoint: `POST` / `GET` / `DELETE /api/mcp`, plus `OPTIONS`.

`Mcp-Session-Id` in the existing `SESSIONS` KV under `mcp:sess:<id>`, 24-hour
TTL, no new namespace. The record holds negotiated protocol state and **no
credential material**; the client re-presents its bearer every request.
`assertSessionOwner` refuses a session id presented by a different org, and
reports it as *not found* rather than forbidden.

`GET` currently answers **405**: every tool is request/response, and holding an
idle stream open would consume a subrequest for the session's life to deliver
nothing. It becomes a real stream when progress notifications for long
architecture scans land.

Origin checking, and why a missing Origin is allowed while a present-but-wrong
one is refused: `worker/MCP.md`.

---

## 4. Tools

22 tools in four groups. `metered` is derived from `chains.js`, so it cannot
disagree with reality.

**Analysis** — `algosize_analyze_vulnerabilities`, `algosize_analyze_cost`,
`algosize_analyze_complexity`, `algosize_analyze_architecture`,
`algosize_estimate_infrastructure` (all metered);
`algosize_list_cost_providers`, `algosize_generate_fix` (free).

**Runs & Reports** — `algosize_list_runs`, `algosize_get_run`,
`algosize_get_run_report`, `algosize_share_run`.

**Posture** — `algosize_get_scorecard`, `algosize_list_arch_snapshots`,
`algosize_diff_architecture`, `algosize_get_ci_snippet`, `algosize_whoami`.

**Monitors** — `algosize_list_monitors`, `algosize_create_monitor`,
`algosize_update_monitor`, `algosize_delete_monitor`,
`algosize_run_monitor_now`, `algosize_get_monitor_result`.

Descriptions are written for a model: what the tool does, what it costs, and
when *not* to use it. Every metered tool says `CONSUMES ONE RUN` and points at
`algosize_list_runs` first — a test asserts that the ones that say it are
exactly the ones that do.

Every input schema is `additionalProperties: false`. A model handed a loose
schema sends plausible garbage, the handler 400s, and on a metered route that
400 has already cost a run.

`algosize_share_run` is the only `openWorldHint: true` tool — it mints a link
anyone can open, says so in its first sentence, and must never be
auto-approved.

Resources (`algosize://scorecard`, `runs/recent`, `monitors`, plus templated
`runs/{runId}`, `runs/{runId}/report`, `arch/snapshots/{snapshotId}`) resolve
to the same tools through the same adapters — a different affordance over the
same data, never a second way in.

Prompts: `audit_repository`, `explain_findings`, `pre_release_check`. They
return messages; no server-side model call happens, which is what keeps the
privacy claim true.

---

## 5. Database — `migrations/0019_mcp.sql`

`mcp_clients`, `mcp_authorizations`, `mcp_tokens`, `mcp_tool_calls`, plus
`runs.credential_kind` and `runs.credential_id`. Verified to apply cleanly by
running it, not by reading it. Registered in the `MIGRATIONS` manifest so
`GET /api/admin/schema-check` asserts it like the rest.

`mcp_tool_calls` has no column for arguments or results, deliberately.

### §1.10 — the API-key run persistence gap (fixed)

`maybePersist` required `request.user.userId` and returned early without it. An
API key sets `request.org` and no `request.user`, so every key-authenticated
analyzer call was analysed, metered, **billed** — and then produced no run row,
no R2 report, and no architecture snapshot. All MCP traffic is key- or
token-authenticated, so every MCP analysis would have vanished the same way.

`maybePersist` is now org-first, and runs carry provenance surfaced in
`GET /api/runs`.

---

## 6. Still to do

- **OAuth 2.1** (`oauth.js`): DCR, PKCE S256-only authorize/token/revoke,
  consent screen with an explicit org picker, refresh rotation with
  chain revocation on replay. `tokens.js` and `metadata.js` are built and
  tested; the endpoints are not.
- **Dashboard `#/mcp` view** — the design brief is written; no UI yet.
- **Admin panel MCP adoption** section reading `mcp_tool_calls`.
- **`GET /api/mcp` as a real SSE stream**, once progress notifications exist.
- **Rate limits** beyond the 120/min envelope limit — a tighter one on metered
  `tools/call`.

---

## 7. Kimi K3

`moonshotai/kimi-k3` — **no `@cf/` prefix**, because Cloudflare lists it as a
third-party catalog entry rather than a first-party Workers AI model. Three
consequences, each of which fails quietly:

1. Third-party models require an AI Gateway and Unified Billing.
2. The REST leg must use the OpenAI-compatible
   `/ai/v1/chat/completions` with the model in the **body**;
   `/ai/run/<model>` 404s on a third-party slug.
3. Those two routes nest the payload differently — `/ai/run` wraps it in
   `result` — so reading the wrong one reports "empty reply" for a call that
   worked. K3 also replaces K2.x's `thinking` with `reasoning_effort`, which a
   K2.x model rejects as an unknown key.

The default is therefore **conditional**: K3 when `AI_GATEWAY_ID` is set, K2.6
otherwise, so an account with no gateway keeps working rather than silently
degrading refactor suggestions to a stub. `WORKERS_AI_MODEL` overrides either
way. All four paths are pinned by `test-llm-routing.mjs`.

**This needs an operator decision** — see `DEPLOY-mcp.md`. Until an AI Gateway
exists on the account, nothing changes and K2.6 continues to serve.

---

## 8. Claude Code integration

- **Remote**: `claude mcp add --transport http algosize
  https://algosize.com/api/mcp --header "Authorization: Bearer ask_live_…"`.
  Preferred — no install, and new tools appear the moment they ship.
- **Local**: `@algosize/mcp`, a zero-dependency stdio bridge. A dumb pipe on
  purpose: it knows no tool names and caches nothing, or the catalog would
  have two sources of truth and the installed copy would be the stale one.
- **This repo**: `.mcp.json` declares the server; export `ALGOSIZE_API_KEY`.

---

## 9. Testing

`test-mcp-purity.mjs` (structural), `test-mcp-protocol.mjs` (61 assertions
driven through `worker.fetch`, not through handler calls, because the likely
bugs are in the wiring), `test-llm-routing.mjs`, and `mcp/test/smoke.test.mjs`.

`.github/workflows/mcp.yml` runs them on **pull requests** — `worker.yml` only
runs on push to main, so without this the MCP suite's first CI exposure would
be at merge time, when a failure fails a production deploy.

Full worker suite: 58 scripts, green.

---

## 10. Definition of done

No test in the chain fails. No tool bypasses `enforceQuota` on a metered
route. No SQL read in new code omits an `org_id` filter. No secret appears in
a log line, an audit row, an `mcp_tool_calls` row, or a tool result — tool
output is scrubbed for `ask_live_`/`ask_mcp_` on the way out as a last line of
defence. The surface is off by default and fails shut, so merging changes
nothing until the runbook flips it.
