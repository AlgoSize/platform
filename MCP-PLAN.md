# MCP-PLAN.md — Algosize Model Context Protocol server

Status: **plan**, written before implementation, as required by the build brief.
Branch: `feat/mcp-server`. Nothing here deploys to production; the last
deliverable is a runbook a human executes.

Protocol revision targeted: **`2025-06-18`** (Streamable HTTP, single endpoint,
optional SSE upgrade, no legacy `/sse` + `/messages` split).

---

## 0. The one rule this plan is organised around

Every MCP tool is an **adapter over an existing route handler**. No tool
contains analyzer logic, validation, quota accounting, entitlement resolution,
or SQL that does not already exist in `worker/src/`. Concretely: a tool builds a
synthetic `Request`, sets the identity fields `requireAuth` would have set, and
runs it through the *same middleware chain the HTTP route uses* — rate limit →
`enforceQuota` → handler. If a tool needs behaviour the HTTP API does not have,
the HTTP API gets it first and the tool calls that.

This is enforced structurally, not by care: `worker/src/mcp/dispatch.js` exports
the only function tools may use to produce a result (`callHandler`), and a test
(`scripts/test-mcp-purity.mjs`) asserts that no file under `worker/src/mcp/tools/`
imports `enforceQuota`, `resolveEntitlement`, `env.DB`, or any analyzer module
directly.

---

## 1. Auth decision

**Two credential types, one authorisation surface.**

| | Existing API keys | New MCP OAuth tokens |
|---|---|---|
| Format | `ask_live_<43 base64url>` (unchanged) | `ask_mcp_<43 base64url>` |
| Created by | `POST /api/keys` (unchanged) | OAuth 2.1 authorization-code + PKCE |
| Storage | `api_keys.key_hash` = sha256 hex | `mcp_tokens.token_hash` = sha256 hex |
| Identity | org only (`request.org`) | org + the user who consented |
| Scopes | implicit: all three | explicit, subset of the three |
| Audience | CI, scripts, power users | Claude Desktop / Claude.ai / any MCP client |

**Decision: ship API-key auth first and treat it as the supported path for
v1; ship OAuth in the same branch but behind the same `mcp.enabled` flag with
Dynamic Client Registration open only to the two first-party redirect hosts
until it has been exercised.**

Rationale. `requireAuth` already resolves an `ask_live_` key to an org, already
rate-limits it per org, and `enforceQuota` already meters per org — so an
API-key MCP session inherits correct billing on day one with zero new trust
surface. OAuth is what a consumer MCP client wants (no key paste), but it
introduces DCR, a consent screen, refresh rotation and a public
`.well-known` surface; gating it lets the endpoint be usable while that
hardens.

### Scopes

| Scope | Grants |
|---|---|
| `algosize:read` | read run history, reports, scorecard, monitors, arch snapshots, estimate catalog |
| `algosize:analyze` | start analyzer runs and estimates (metered — consumes quota) |
| `algosize:manage` | create/pause/resume/delete monitors, mint share links |

`algosize:manage` does **not** grant key creation, billing changes, member
management, org deletion, or anything under `/api/admin/*`. Those stay
browser-session-only. An MCP client can never escalate itself.

### Middleware: `mcpAuth`

New middleware in `worker/src/mcp/auth.js`, composed *after* `requireAuth`
rather than replacing it:

1. `requireAuth` runs first and handles `ask_live_` and cookie/JWT exactly as
   today. If it authenticated, `mcpAuth` grants all three scopes for an
   `ask_live_` key, and all three for a cookie session (so the dashboard's own
   MCP inspector works).
2. If `requireAuth` returned 401 **and** the bearer starts with `ask_mcp_`,
   `mcpAuth` resolves it against `mcp_tokens`, checks `expires_at` and
   `revoked_at`, and sets `request.org`, `request.user` (the consenting user),
   `request.authMethod = "mcp_oauth"`, `request.mcpScopes`, `request.mcpTokenId`.
3. Otherwise → `401` with a `WWW-Authenticate: Bearer resource_metadata="…"`
   header, which is what makes a spec-compliant MCP client start the OAuth
   dance instead of just failing.

Per-tool scope enforcement happens in one place — the `tools/call` branch of
`handlers/mcp.js` — never inside a tool.

---

## 2. `.well-known` routing decision

The zone route is `algosize.com/api/*`; everything else on the apex is GitHub
Pages. OAuth 2.1 discovery documents must live at
`/.well-known/oauth-authorization-server` and
`/.well-known/oauth-protected-resource`, which are **outside that route**.

Three options were considered:

1. **Add zone routes** `algosize.com/.well-known/oauth-authorization-server`
   and `…/oauth-protected-resource` to `worker/wrangler.toml`.
2. Serve static JSON from the Jekyll site.
3. Proxy from the separate `algosize-site` Worker.

**Decision: option 1.** Two exact-path routes, no wildcard, so nothing else on
the apex moves off Pages. Option 2 cannot work because the metadata must change
with `env` (staging vs prod issuer) and would be a second source of truth for
the supported scopes. Option 3 couples two Workers for two static documents.

Additionally the protected-resource document is *also* served from
`/api/.well-known/oauth-protected-resource` so the endpoint is fully
discoverable before the new zone routes propagate, and so `wrangler dev` (which
has no zone routes at all) can exercise the whole flow. The
`WWW-Authenticate` header advertises the apex path; the `/api/` copy is a
compatibility alias. Both are documented in `worker/MCP.md`.

**Consequence for the runbook:** the new routes must be added in the Cloudflare
dashboard or via `wrangler deploy` from `worker/` with `--config wrangler.toml`,
and take ~2 min to propagate (see `.agents/memory/algosize-infra.md`) — a bare
404 immediately after deploy is expected, not a failure.

---

## 3. Transport & session decisions

- **One endpoint:** `POST /api/mcp` (JSON-RPC in, JSON or SSE out),
  `GET /api/mcp` (SSE stream for server→client notifications),
  `DELETE /api/mcp` (explicit session teardown).
- **Session id** returned in `Mcp-Session-Id` on the `initialize` response and
  required on every subsequent request. Stored in the **existing `SESSIONS` KV**
  under `mcp:sess:<id>` with a 24 h TTL. No new KV namespace — the binding
  already exists in every environment, and a new one would be a new thing to
  provision in `DEPLOY.md`.
- Session record holds: protocol version, client info, negotiated capabilities,
  org id, user id (nullable), auth method, granted scopes, created/last-seen.
  **No credential material, ever.** The client re-presents its bearer on every
  request; the session is not an auth token.
- `Mcp-Protocol-Version` request header is validated; an unsupported revision
  gets `-32000` with the supported list rather than a silent downgrade.
- **Origin check** on every `/api/mcp` request (DNS-rebinding defence the spec
  calls for): allow `env.SITE_ORIGIN`, allow `https://claude.ai` and
  `https://*.anthropic.com`, allow requests with **no** `Origin` (native clients
  and curl do not send one). A present-but-unlisted origin gets 403.
- SSE is offered but the default response to `POST` is a single JSON body.
  Streaming buys nothing for request/response tools and costs a held
  subrequest; the `GET` stream exists for progress notifications on long
  architecture scans.

---

## 4. Tool → endpoint → scope → plan matrix

20 tools. `metered` means the underlying route is wrapped in `enforceQuota`, so
the call can return `402 quota_exceeded` — surfaced to the model as an
`isError` result with the upgrade URL, never as a transport error.

| # | Tool | Existing endpoint / handler | Scope | Min plan | Metered | Read-only |
|---|---|---|---|---|---|---|
| 1 | `algosize_analyze_cost` | `POST /api/analyze/cost` → `analyzeCostHandler` | `analyze` | free | ✅ | ✗ |
| 2 | `algosize_analyze_vulnerabilities` | `POST /api/analyze/vuln` → `analyzeVulnHandler` | `analyze` | free | ✅ | ✗ |
| 3 | `algosize_analyze_complexity` | `POST /api/analyze/algo` → `analyzeAlgoHandler` | `analyze` | free | ✅ | ✗ |
| 4 | `algosize_analyze_architecture` | `POST /api/analyze/architecture` → `analyzeArchitectureHandler` | `analyze` | free | ✅ | ✗ |
| 5 | `algosize_generate_fix` | `POST /api/fix` → `generateFixHandler` | `analyze` | free | ✗ | ✗ |
| 6 | `algosize_estimate_infrastructure` | `POST /api/estimate` → `withEstimateHistory(estimateHandler)` | `analyze` | free | ✅ | ✗ |
| 7 | `algosize_list_estimate_providers` | `GET /api/estimate/providers` | `read` | free | ✗ | ✅ |
| 8 | `algosize_list_runs` | `GET /api/runs` → `listRunsHandler` | `read` | free | ✗ | ✅ |
| 9 | `algosize_get_run` | `GET /api/runs/:id` → `getRunHandler` | `read` | free | ✗ | ✅ |
| 10 | `algosize_get_run_report` | `GET /api/runs/:id/report` → `getRunReportHandler` | `read` | free | ✗ | ✅ |
| 11 | `algosize_share_run` | `POST /api/runs/:id/share` → `createRunShareHandler` | `manage` | paid | ✗ | ✗ |
| 12 | `algosize_get_scorecard` | `GET /api/scorecard` | `read` | free | ✗ | ✅ |
| 13 | `algosize_list_monitors` | `GET /api/monitors` | `read` | free | ✗ | ✅ |
| 14 | `algosize_create_monitor` | `POST /api/monitors` | `manage` | paid | ✗ | ✗ |
| 15 | `algosize_update_monitor` | `PATCH /api/monitors/:id` | `manage` | paid | ✗ | ✗ |
| 16 | `algosize_delete_monitor` | `DELETE /api/monitors/:id` | `manage` | paid | ✗ | ✗ |
| 17 | `algosize_run_monitor_now` | `POST /api/monitors/:id/run` | `manage` | paid | ✅ | ✗ |
| 18 | `algosize_list_arch_snapshots` | `GET /api/arch/snapshots` | `read` | free | ✗ | ✅ |
| 19 | `algosize_diff_arch_snapshots` | `GET /api/arch/diff` | `read` | free | ✗ | ✅ |
| 20 | `algosize_whoami` | `GET /api/me` → `meHandler` | `read` | free | ✗ | ✅ |

Route paths and handler names above are the ones registered in
`worker/src/index.js` and will be re-read against that file at implementation
time; any mismatch is resolved in favour of the file, not this table.

Deliberately **absent**: `/api/keys*`, `/api/billing/*`, `/api/account/*`,
`/api/org*`, `/api/admin/*`, `/api/checkout`, `/api/auth/*`, `/api/_test/seed`.
An MCP client must not be able to mint credentials, move money, or change who
has access.

### Resources

| URI | Backed by |
|---|---|
| `algosize://runs/recent` | `listRuns` (org scope, limit 20) |
| `algosize://runs/{runId}` | `getRun` |
| `algosize://runs/{runId}/report` | R2 report via `getRunReportHandler` |
| `algosize://scorecard` | `/api/scorecard` |
| `algosize://monitors` | `/api/monitors` |
| `algosize://arch/snapshots/{id}` | `/api/arch/snapshots/:id` |

Templates use RFC 6570 so a client can complete them. Reads go through the same
`callHandler` path and the same scope check as tools.

### Prompts

`audit_repository`, `triage_vulnerabilities`, `cost_review`,
`architecture_review`, `pre_deploy_check` — argument-parameterised prompt
templates that chain the tools above. No server-side model calls.

---

## 5. Database — `migrations/0019_mcp.sql`

Next migration number confirmed against `worker/migrations/` (latest is
`0018_arch_snapshots.sql`).

- `mcp_clients` — DCR registrations: `client_id`, `client_secret_hash`
  (nullable; public clients use PKCE only), `client_name`, `redirect_uris`
  (JSON), `grant_types`, `scope`, `created_at`, `disabled_at`.
- `mcp_authorizations` — short-lived authorization codes: `code_hash`,
  `client_id`, `org_id`, `user_id`, `scope`, `code_challenge`,
  `code_challenge_method`, `redirect_uri`, `expires_at`, `consumed_at`.
- `mcp_tokens` — access + refresh tokens: `token_id`, `token_hash`,
  `token_type`, `client_id`, `org_id`, `user_id`, `scope`, `expires_at`,
  `revoked_at`, `last_used_at`, `parent_token_id` (refresh rotation chain).
- `mcp_tool_calls` — one row per `tools/call`: `org_id`, `tool_name`,
  `auth_method`, `scope_used`, `status`, `duration_ms`, `run_id` (nullable FK to
  `runs`), `error_code`, `created_at`. **No arguments, no results** — a tool
  argument is customer source code.
- Plus, for §1.10 below: `runs.credential_kind` and `runs.credential_id`.

Every index is `(org_id, …)` first. Every read in new code filters on `org_id`.

## 5b. §1.10 — the API-key run persistence gap

`maybePersist` in `worker/src/handlers/analyze.js` early-returns unless
`request.user.userId` exists, so an API-key run is analysed, metered and
billed but produces **no run row, no R2 report, no arch snapshot**. `persistRun`
already accepts an org-only owner (`if (!userId && !orgId) return null`), so the
gap is entirely in the caller.

Fix: make `maybePersist` org-first — resolve the org from `request.org.orgId`
when there is no session user, keep the existing user path unchanged, record
provenance (`credential_kind` ∈ `session` | `api_key` | `mcp_oauth`,
`credential_id` = the key/token id), and let `GET /api/runs` return it so the
dashboard can label a row "via MCP". Regression test asserts an `ask_live_` run
produces a row, a report, and (for `arch`) a snapshot.

---

## 6. File list

New under `worker/src/mcp/`:
`protocol.js` (JSON-RPC framing, error codes, capability negotiation),
`session.js` (KV-backed session lifecycle), `transport.js` (Streamable HTTP,
origin check, SSE), `dispatch.js` (`callHandler` — the only bridge to existing
handlers), `auth.js` (`mcpAuth`, scope checks), `registry.js` (tool/resource/
prompt lookup + tier & scope filtering), `oauth.js` (DCR, authorize, token,
revoke, metadata), `tools/*.js` (the 20 adapters, grouped by domain),
`resources.js`, `prompts.js`, `audit.js` additions.

New elsewhere: `worker/src/handlers/mcp.js` (route entry),
`worker/migrations/0019_mcp.sql`, `mcp/` (the `@algosize/mcp` stdio bridge:
`package.json`, `bin/algosize-mcp.mjs`, `src/bridge.mjs`, `README.md`),
`site/assets/js/dash-mcp.js`, `.github/workflows/mcp.yml`, `worker/MCP.md`,
`DEPLOY-mcp.md`.

Modified: `worker/src/index.js` (routes), `worker/wrangler.toml`
(`.well-known` routes), `worker/src/audit.js` (new actions),
`worker/src/handlers/analyze.js` (§1.10), `worker/src/handlers/runs.js`
(provenance in list output), `worker/src/handlers/admin_panel.js` (MCP panel),
`worker/package.json` (test chain), `site/dashboard.html`,
`site/assets/js/dash-router.js`, `README.md`, `replit.md`,
`.agents/memory/mcp-server.md`.

New tests in `worker/scripts/`: `test-mcp-protocol.mjs`, `test-mcp-session.mjs`,
`test-mcp-auth.mjs`, `test-mcp-tools.mjs`, `test-mcp-scopes.mjs`,
`test-mcp-oauth.mjs`, `test-mcp-resources.mjs`, `test-mcp-purity.mjs`,
`test-mcp-audit.mjs`, `test-run-provenance.mjs`, plus `mcp/scripts/test-bridge.mjs`.

---

## 7. Order of work

1. This plan.
2. `0019_mcp.sql` + `_seed.js`/schema-check wiring + §1.10 fix + provenance test.
3. `protocol.js` → `session.js` → `dispatch.js` → `transport.js` → `auth.js` →
   `handlers/mcp.js`, wired into `index.js` behind flag `mcp.enabled`.
4. `registry.js` + the 20 tool adapters.
5. `resources.js` + `prompts.js`.
6. `oauth.js` + consent screen + `.well-known` routes.
7. Rate limits, audit actions, observability, `GET /api/mcp/usage`.
8. `@algosize/mcp` stdio bridge.
9. Dashboard `#/mcp` view + admin panel.
10. CI workflow + docs + full `npm test`.
11. Deploy runbook.

## 8. Definition of done

No test in `worker/package.json`'s `test` chain fails. No tool bypasses
`enforceQuota` on a metered route. No SQL read in new code omits an `org_id`
filter. No secret — key, token, client secret, code verifier — appears in a log
line, an audit row, an `mcp_tool_calls` row, or a tool result. `mcp.enabled` is
off by default so merging changes nothing until the runbook flips it.
