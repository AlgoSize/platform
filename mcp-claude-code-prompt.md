# Claude Code Prompt — Algosize MCP Server (build + wire everything)

Paste this whole file into Claude Code from the repo root of `AlgoSize/platform`
(local: `/Users/guillaumelauzier/Documents/Github/Algosize/website`).

---

## Role and ground rules

You are a Principal Platform Engineer working inside the existing `AlgoSize/platform`
monorepo. You are adding a **Model Context Protocol (MCP) server** to the product so
that MCP clients (Claude Code, Claude Desktop, Claude.ai, Cursor, and any other MCP
host) can drive Algosize's analyzers, runs, monitors, and reports as first-class tools.

Non-negotiable rules for this task:

1. **Read before you write.** Start by reading, in this order:
   `.agents/memory/MEMORY.md`, `.agents/memory/algosize-infra.md`,
   `worker/src/index.js`, `worker/src/auth.js`, `worker/src/handlers/_api_keys.js`,
   `worker/src/handlers/keys.js`, `worker/src/quota.js`, `worker/src/entitlement.js`,
   `worker/src/audit.js`, `worker/src/middleware/rate-limit.js`,
   `worker/src/handlers/analyze.js`, `worker/src/handlers/runs.js`,
   `worker/src/handlers/monitors.js`, `worker/src/handlers/scorecard.js`,
   `worker/src/handlers/estimate.js`, `worker/src/handlers/ci.js`,
   `worker/migrations/0005_api_keys.sql`, and the highest-numbered migration in
   `worker/migrations/`. Do not guess at any signature you have not read.
2. **Reuse, never fork.** Every MCP tool must call the *existing* handler or the
   existing service module behind it. If an MCP tool re-implements analyzer logic,
   validation, quota accounting, or entitlement checks, the change is wrong. There
   must be exactly one code path per capability, reachable from both HTTP and MCP.
3. **Match house style.** ESM, no TypeScript, `itty-router`, no new runtime
   dependencies in `worker/` unless unavoidable. Comments in this repo explain *why*
   a decision was made, not what the line does — write comments in that voice.
4. **Every new behavior gets a Node test script** in `worker/scripts/`, wired into the
   `test` chain in `worker/package.json`, in the same style as
   `worker/scripts/test-api-keys.mjs` and `worker/scripts/test-orgs.mjs`.
5. **Never break the existing API Worker.** All wrangler commands for the API Worker
   run from `worker/` with `--config wrangler.toml` — the root `wrangler.jsonc`
   targets the separate `algosize-site` Worker and will shadow it otherwise.
6. Work in a branch `feat/mcp-server`. Do not deploy to production. End by printing a
   deploy runbook a human executes.

---

## What already exists (do not re-derive this — verify it)

- **API Worker**: `worker/src/index.js`, script name `algosize`, route
  `algosize.com/api/*`, plus `staging.algosize.com/api/*`. Bindings: `DB` (D1
  `algosize`), `SESSIONS` + `USERS` (KV), `REPORTS` (R2), `SANDBOX` (service binding
  to `algosize-sandbox`), `AI` (Workers AI), `SCAN_QUEUE` (Queues producer +
  consumer `algosize-scans`), `USAGE` (Durable Object `UsageCounter`, production),
  cron `0 * * * *`.
- **Auth** (`worker/src/auth.js`, `requireAuth`): two credential types.
  - `Authorization: Bearer ask_live_…` → API key, verified against
    `api_keys.key_hash` (sha256 hex). Sets `request.org = { orgId }`,
    `request.authMethod = "api_key"`, `request.apiKeyId`. **No `request.user`.**
  - JWT bearer or `algosize_session` cookie → sets `request.user =
    { userId, email, subStatus }`, `request.authMethod = "session"`.
- **Quota/entitlement**: `enforceQuota(handler)` in `worker/src/quota.js` already
  meters per-user for sessions and **per-org for API keys**, resolving entitlement via
  `resolveEntitlement` / `resolveEntitlementForOrg`. Free tier is
  `FREE_MONTHLY_LIMIT` runs/month; over-limit returns HTTP 402 `quota_exceeded`.
- **Rate limiting**: `makeRateLimit` and `makeApiKeyRateLimit` in
  `worker/src/middleware/rate-limit.js`.
- **Audit log**: `writeAudit` / `auditFromRequest` / `AUDIT_ACTIONS` in
  `worker/src/audit.js`, surfaced at `GET /api/admin/audit`.
- **Feature flags**: `worker/src/flags.js` (`isFlagEnabled`), admin-managed at
  `GET /api/admin/flags` and `PATCH /api/admin/flags/:key`.
- **Existing capability endpoints** to expose over MCP:
  `POST /api/analyze/{cost,vuln,algo,architecture}`, `POST /api/estimate`,
  `GET /api/estimate/providers`, `GET /api/runs`, `GET /api/runs/:id`,
  `GET /api/runs/:id/report`, `POST /api/runs/:id/share`, `GET /api/scorecard`,
  `GET|POST /api/monitors` + `:id/{pause,analyzers,schedule,run}` +
  `:id/result/:analyzer`, `GET /api/arch/snapshots`, `GET /api/arch/snapshots/:id`,
  `GET /api/arch/diff`, `GET /api/ci/snippet` and the other CI snippet routes.
- **Dashboard front end**: static Jekyll site in `site/`, hash-routed dashboard
  (`site/dashboard.html` + `site/assets/js/dash-*.js`, router in `dash-router.js`
  with views `workspace | scanner | cost | arch | optimizer | estimate | monitors |
  team | report | account`). Design tokens live in `site/assets/css/main.css`.

---

## Deliverable 1 — Remote MCP server inside the API Worker

Implement a spec-compliant **Streamable HTTP** MCP server mounted on the existing
Worker. Target MCP protocol revision `2025-06-18`, and negotiate down gracefully if a
client advertises an older revision it can still talk (`2025-03-26`, `2024-11-05`).

### 1.1 New files

```
worker/src/mcp/protocol.js     JSON-RPC 2.0 envelope: parse, batch, result, error codes
worker/src/mcp/session.js      MCP session lifecycle (Mcp-Session-Id) backed by SESSIONS KV
worker/src/mcp/registry.js     the tool/resource/prompt registry (single source of truth)
worker/src/mcp/tools.js        tool definitions + JSON Schemas + adapters to handlers
worker/src/mcp/resources.js    resource definitions (runs, reports, snapshots, scorecard)
worker/src/mcp/prompts.js      prompt templates
worker/src/mcp/transport.js    Streamable HTTP: POST JSON, POST→SSE stream, GET SSE, DELETE
worker/src/mcp/oauth.js        OAuth 2.1 AS metadata, DCR, PKCE authorize/token/revoke
worker/src/handlers/mcp.js     route handlers, auth resolution, usage metering, audit
worker/migrations/0019_mcp.sql schema (see 1.5)
worker/MCP.md                  protocol/ops notes for maintainers
```

### 1.2 Routes to register in `worker/src/index.js`

Insert as a clearly commented block, following the file's existing grouping style:

```
router.post(  "/api/mcp",              mcpRateLimit, mcpAuth, mcpPostHandler);
router.get(   "/api/mcp",              mcpRateLimit, mcpAuth, mcpSseHandler);
router.delete("/api/mcp",              mcpRateLimit, mcpAuth, mcpDeleteHandler);
router.get(   "/api/mcp/manifest",     mcpManifestHandler);          // public, cacheable
router.get(   "/.well-known/oauth-protected-resource", mcpProtectedResourceHandler);
router.get(   "/.well-known/oauth-authorization-server", mcpAsMetadataHandler);
router.post(  "/api/mcp/oauth/register", signupRateLimit, mcpRegisterClientHandler);
router.get(   "/api/mcp/oauth/authorize", mcpAuthorizeHandler);      // session-gated
router.post(  "/api/mcp/oauth/authorize", requireAuth, mcpAuthorizeConsentHandler);
router.post(  "/api/mcp/oauth/token",     mcpTokenHandler);
router.post(  "/api/mcp/oauth/revoke",    mcpRevokeHandler);
router.get(   "/api/mcp/clients",         requireAuth, mcpListClientsHandler);
router.delete("/api/mcp/clients/:id",     requireAuth, mcpRevokeClientHandler);
router.get(   "/api/mcp/usage",           requireAuth, mcpUsageHandler);
```

The two `.well-known` routes must be reachable at the zone apex. The current zone
route is `algosize.com/api/*` only, so **either** add the `.well-known` patterns to
`routes` in `worker/wrangler.toml` for both `production` and `staging`, **or** proxy
them from the site Worker. Pick one, implement it, and write down in `worker/MCP.md`
why. If you add zone routes, remember the ~2 minute propagation delay documented in
`.agents/memory/algosize-infra.md`.

CORS: extend `worker/src/cors.js` so `/api/mcp*` allows the `Mcp-Session-Id` and
`MCP-Protocol-Version` request headers and **exposes** `Mcp-Session-Id` on responses.
Browser-based MCP hosts fail silently without the expose header.

### 1.3 Transport requirements (`transport.js`)

- `POST /api/mcp` accepts a single JSON-RPC request, a notification, or a batch.
  - Notifications and responses only → `202 Accepted`, empty body.
  - Requests → either `application/json` with one response, or, when the client's
    `Accept` includes `text/event-stream`, an SSE stream carrying the response plus
    any server-initiated progress notifications for that request.
- `GET /api/mcp` with `Accept: text/event-stream` opens the server→client stream for
  a resumable session; support `Last-Event-ID` by replaying from the session's KV
  buffer, and return `405` when the server has nothing to push.
- `DELETE /api/mcp` terminates the session.
- Issue `Mcp-Session-Id` on the `initialize` response; require it on every later
  request; `404` when a session is unknown or expired so clients re-`initialize`.
- Validate `Origin` on all MCP requests and reject cross-origin browser callers not
  in an allowlist (`SITE_ORIGIN`, `https://claude.ai`, `https://*.anthropic.com`, and
  localhost during dev). This is the DNS-rebinding guard the MCP spec requires.
- Sessions live in `SESSIONS` KV under `mcp:sess:<id>` with a 24-hour TTL, holding
  `{ orgId, authMethod, apiKeyId|userId, clientInfo, protocolVersion, capabilities,
  createdAt, lastSeenAt }`. Do **not** invent a new KV namespace.

### 1.4 Methods to implement

| Method | Behavior |
|---|---|
| `initialize` | Negotiate protocol version, return `serverInfo` `{ name: "algosize", version }` and capabilities `{ tools: { listChanged: true }, resources: { subscribe: false, listChanged: true }, prompts: {}, logging: {} }` |
| `notifications/initialized` | Ack, mark session ready |
| `ping` | Empty result |
| `tools/list` | From `registry.js`, cursor-paginated, filtered by the caller's entitlement and feature flags |
| `tools/call` | Dispatch through the adapter layer (1.6) |
| `resources/list`, `resources/templates/list`, `resources/read` | See 1.7 |
| `prompts/list`, `prompts/get` | See 1.8 |
| `logging/setLevel` | Store on the session; gate `notifications/message` emissions |
| `completion/complete` | Argument autocompletion for `repoUrl` (from the org's monitors) and `runId` (from recent runs). Nice-to-have; implement if time allows, otherwise return an empty completion rather than an error |

Unknown methods → JSON-RPC `-32601`. Malformed JSON → `-32700`. Bad params →
`-32602` with a message a human can act on.

### 1.5 Migration `0019_mcp.sql`

Follow the commenting style of `0005_api_keys.sql` — explain *why* each table exists.
Never delete rows for revocation; set a `revoked_at` so "who had access and when"
survives. Tables:

- `mcp_clients` — dynamically registered OAuth clients:
  `client_id TEXT PK, client_secret_hash TEXT, client_name TEXT NOT NULL,
  redirect_uris TEXT NOT NULL /* JSON array */, grant_types TEXT, scope TEXT,
  token_endpoint_auth_method TEXT, software_id TEXT, created_at INTEGER NOT NULL,
  revoked_at INTEGER`. Store only `sha256(client_secret)`, exactly as `api_keys`
  does with the key — the same reasoning applies.
- `mcp_authorizations` — short-lived authorization codes:
  `code_hash TEXT PK, client_id TEXT NOT NULL, org_id TEXT NOT NULL,
  user_id TEXT NOT NULL, redirect_uri TEXT NOT NULL, scope TEXT,
  code_challenge TEXT NOT NULL, code_challenge_method TEXT NOT NULL,
  resource TEXT, expires_at INTEGER NOT NULL, consumed_at INTEGER`. PKCE S256 only;
  reject `plain`.
- `mcp_tokens` — issued access/refresh tokens:
  `token_hash TEXT PK, token_type TEXT NOT NULL /* access|refresh */,
  client_id TEXT NOT NULL, org_id TEXT NOT NULL, user_id TEXT,
  scope TEXT, expires_at INTEGER, created_at INTEGER NOT NULL,
  last_used_at INTEGER, revoked_at INTEGER`, indexed on `(org_id)` and `(client_id)`.
- `mcp_tool_calls` — per-call usage/audit:
  `call_id TEXT PK, org_id TEXT NOT NULL, session_id TEXT, tool TEXT NOT NULL,
  client_name TEXT, auth_method TEXT NOT NULL, run_id TEXT, ok INTEGER NOT NULL,
  error_code TEXT, duration_ms INTEGER, created_at INTEGER NOT NULL`, indexed on
  `(org_id, created_at DESC)` and `(tool)`.

Add the migration to whatever migration-application script/doc the repo already uses,
and extend `worker/scripts/test-schema-check.mjs` plus the
`GET /api/admin/schema-check` handler so the new tables are asserted like the
existing ones.

### 1.6 Tool catalog and the adapter layer

Every tool is `{ name, title, description, inputSchema, outputSchema?, annotations,
minTier?, flag?, adapt }`, where `adapt` builds a synthetic `Request` and calls the
existing HTTP handler, then maps the JSON response into MCP `content` blocks.
Build **one** `callHandler(handlerChain, { method, path, body, query, request, env,
ctx })` helper that clones the authenticated request's identity fields
(`request.user`, `request.org`, `request.authMethod`, `request.apiKeyId`) onto the
synthetic request so quota, entitlement, and audit all behave identically to a direct
HTTP call. Do not bypass `enforceQuota` — route analyzer tools through the same
wrapped handler the HTTP route uses.

Ship these tools, `snake_case`, prefixed `algosize_`:

**Analysis (metered, `readOnlyHint: false`, `destructiveHint: false`)**
1. `algosize_scan_dependencies` — `POST /api/analyze/vuln`. Input: lockfile content or
   `{ packages: [...] }` per `validateVulnInput`. Output: severity counts, findings,
   grade, `runId`.
2. `algosize_analyze_cloud_cost` — `POST /api/analyze/cost`. Accept the JSON
   `services` array path and a CUR CSV string; document the 100 MB cap and reject
   oversize input with a clear message rather than a truncated upload.
3. `algosize_optimize_algorithm` — `POST /api/analyze/algo`. Input: source code,
   language, optional entry point. Return Big-O findings and suggested rewrites.
4. `algosize_xray_architecture` — `POST /api/analyze/architecture`. Return the graph
   summary and findings, and the snapshot id when one is recorded.
5. `algosize_estimate_infrastructure` — `POST /api/estimate`. Support the terraform
   plan, compose, k8s, and manual adapters that `worker/src/estimator/adapters/`
   already implements.
6. `algosize_list_cost_providers` — `GET /api/estimate/providers`. Read-only.

**Runs and reports (read-only unless noted)**
7. `algosize_list_runs` — `GET /api/runs` with `limit`, `cursor`, `source`,
   `analyzer`.
8. `algosize_get_run` — `GET /api/runs/:id`.
9. `algosize_get_run_report` — `GET /api/runs/:id/report?format=json|md`. Return
   markdown as a text block; never inline HTML.
10. `algosize_share_run_report` — `POST /api/runs/:id/share`. **`destructiveHint:
    false`, `openWorldHint: true`, and require explicit confirmation semantics**:
    this mints a public link, so the tool description must say so in its first
    sentence and the tool must be excluded from any "auto-approve" annotation.

**Posture**
11. `algosize_get_scorecard` — `GET /api/scorecard`. Preserve the four cell kinds
    (`grade | stale | pending | off`) verbatim in the output; do not collapse
    `pending` and `off`, for the reason the handler's own header comment gives.
12. `algosize_list_arch_snapshots` — `GET /api/arch/snapshots`.
13. `algosize_diff_architecture` — `GET /api/arch/diff`.

**Monitors**
14. `algosize_list_monitors` — `GET /api/monitors`.
15. `algosize_create_monitor` — `POST /api/monitors` (`repoUrl`, `branch`,
    `schedule`, `runAtHour`, `analyzers`).
16. `algosize_set_monitor_analyzers` — `POST /api/monitors/:id/analyzers`.
17. `algosize_pause_monitor` — `POST /api/monitors/:id/pause`.
18. `algosize_run_monitor_now` — `POST /api/monitors/:id/run` (metered).
19. `algosize_delete_monitor` — `DELETE /api/monitors/:id`, `destructiveHint: true`.
20. `algosize_get_ci_snippet` — `GET /api/ci/snippet` and the optimizer/estimate/
    architecture snippet routes behind one `kind` enum.

Rules for the catalog:
- Descriptions are written for a model, not a human: state what the tool does, what
  it costs (metered vs free), and when *not* to use it. One to three sentences.
- Input schemas must be strict — `additionalProperties: false`, explicit enums,
  documented size limits. A model handed a loose schema will send garbage and burn a
  metered run on a 400.
- Tools whose underlying route needs a human (`/api/me`, billing, org management,
  key management) are **not** exposed. An API-key or OAuth MCP session has no member
  behind it, and `keys.js` already refuses key-managed keys for exactly this reason.
- Every tool result carries both a human-readable text block and
  `structuredContent` matching `outputSchema`. Set `isError: true` plus a plain-text
  explanation for tool-level failures — never a JSON-RPC error, which the host shows
  as a transport fault the model can't recover from.
- Gate by tier: annotate tools with `minTier` and filter `tools/list` using
  `resolveEntitlementForOrg`. A tool the caller cannot use must not appear in the
  list; if it is called anyway, return an `isError` result explaining the required
  plan and linking `${SITE_ORIGIN}/#pricing`.
- Gate the whole surface behind a feature flag `mcp.enabled` via
  `isFlagEnabled(env, ctx, "mcp.enabled", orgId)`, defaulting **on** for staging and
  off in production until the deploy runbook flips it.

### 1.7 Resources

Expose read-only context so a host can attach findings without a tool call:
- `algosize://scorecard` — current scorecard JSON.
- `algosize://run/{runId}` — one run's normalized result.
- `algosize://run/{runId}/report.md` — the rendered markdown report.
- `algosize://arch/snapshot/{snapshotId}` — one architecture snapshot.
- `algosize://monitor/{monitorId}/result/{analyzer}` — latest analyzer baseline.

Implement `resources/templates/list` for the parameterized URIs, and emit
`notifications/resources/list_changed` when a new run lands during a live session.
Reports rendered into R2 must be served from R2, not re-rendered per read.

### 1.8 Prompts

Three prompt templates, each with declared arguments:
- `audit_repository` — args `repoUrl`, optional `branch`. Walks the model through
  dependency scan → architecture x-ray → scorecard read → prioritized findings.
- `explain_findings` — args `runId`, optional `audience` (`engineer` | `exec`).
- `pre_release_check` — args `repoUrl`, `diffOrBranch`. Gate-style pass/fail summary
  suitable for pasting into a PR.

### 1.9 Authentication — two paths, both org-scoped

**Path A (primary, zero new UI): existing API keys.** `Authorization: Bearer
ask_live_…` reuses `requireAuth` unchanged. This is what Claude Code and any
config-file MCP client will use. Nothing new is needed server-side beyond letting
`/api/mcp` sit behind `requireAuth`.

**Path B: OAuth 2.1 for hosts that require it** (Claude.ai remote connectors).
Implement, per MCP authorization spec:
- `GET /.well-known/oauth-protected-resource` → `{ resource, authorization_servers:
  [origin], scopes_supported, bearer_methods_supported: ["header"] }`.
- `GET /.well-known/oauth-authorization-server` → issuer, `authorization_endpoint`,
  `token_endpoint`, `registration_endpoint`, `revocation_endpoint`,
  `code_challenge_methods_supported: ["S256"]`,
  `grant_types_supported: ["authorization_code","refresh_token"]`.
- `POST /api/mcp/oauth/register` — RFC 7591 dynamic client registration, rate limited,
  `redirect_uris` validated (https or `http://localhost`/`127.0.0.1` only, no
  wildcards, no fragments).
- `GET /api/mcp/oauth/authorize` — if there is no valid `algosize_session` cookie,
  302 to the existing magic-link/Google sign-in with a `return_to` back to this URL.
  Once signed in, render a **consent screen** naming the client, the org the grant
  will be scoped to, the scopes requested, and the tools those scopes unlock. If the
  user belongs to multiple orgs, make them pick one explicitly — a grant silently
  bound to the wrong org is a data-leak class bug.
- `POST /api/mcp/oauth/authorize` — record consent, mint a 10-minute single-use
  authorization code (store `sha256(code)` only), redirect with `code` and `state`.
- `POST /api/mcp/oauth/token` — `authorization_code` (verify PKCE S256, `redirect_uri`
  exact match, single use, honour and validate the `resource` parameter) and
  `refresh_token` (rotate on use, revoke the presented token). Access tokens are
  opaque `ask_mcp_` random strings; store only `sha256(token)`; 1-hour access, 30-day
  refresh.
- `POST /api/mcp/oauth/revoke` — RFC 7009.
- On any missing/expired/invalid bearer, return `401` with
  `WWW-Authenticate: Bearer resource_metadata="https://algosize.com/.well-known/oauth-protected-resource"`.
  This header is what makes a host start the OAuth dance instead of just failing.
- Extend `requireAuth` (or add a thin `mcpAuth` wrapper that falls through to it) so
  an `ask_mcp_` token resolves to `{ orgId, userId, scope }`, sets
  `request.authMethod = "mcp_oauth"`, and bumps `last_used_at` in `ctx.waitUntil`,
  exactly the way `touchApiKeyLastUsed` already does. Scopes: `algosize:read`,
  `algosize:analyze`, `algosize:manage`. Map each tool to its required scope and
  enforce it in `tools/call` **and** filter `tools/list` by it.

### 1.10 Fix the integration gap you will hit

`maybePersist` in `worker/src/handlers/analyze.js` requires `request.user.userId` and
returns early without it — so an analyzer run made with an API key today produces **no
run history, no report in R2, and no architecture snapshot**. MCP traffic is
key/OAuth-only, so every MCP analysis would vanish from the dashboard.

Fix it properly: make run persistence org-first. When there is no session user, file
the run against `request.org.orgId` with a null/synthetic actor, and record the
originating credential (`api_key_id` or `mcp_token_hash` reference) so the runs feed
can label the row "via MCP — <client name>" or "via API key — <prefix>". Add the
column(s) in `0019_mcp.sql`, backfill nothing, and make `GET /api/runs` return the
new provenance field. Add a regression test asserting an API-key analyzer call now
appears in `GET /api/runs` for that org.

### 1.11 Observability, limits, safety

- Rate limits via `makeApiKeyRateLimit`: MCP envelope 120 req/min per credential,
  `tools/call` on metered analysis tools 20/min, `oauth/register` 5/hour per IP.
- Log every `tools/call` to `mcp_tool_calls` in `ctx.waitUntil` — never on the
  response path.
- New `AUDIT_ACTIONS` entries, following the existing naming: `MCP_CLIENT_REGISTERED`
  (`"mcp.client_registered"`), `MCP_GRANT_AUTHORIZED` (`"mcp.grant_authorized"`),
  `MCP_GRANT_REVOKED` (`"mcp.grant_revoked"`), `MCP_TOOL_CALLED`
  (`"mcp.tool_called"`, sampled or write-behind so a chatty client can't flood the
  audit table — pick one and justify it in a comment). Log client name and token
  prefix; never a token, code, or secret.
- Wrap handler dispatch in `captureException` from `worker/src/observability.js`.
- Cap request bodies (reuse the analyzer's existing cap), cap SSE stream lifetime,
  and make every unbound resource read explicitly org-scoped in SQL — an MCP tool
  that forgets `WHERE org_id = ?` is a cross-tenant leak.
- Never echo secrets in tool results or error messages. Redact anything matching the
  `ask_live_`/`ask_mcp_` tags in outbound text.

---

## Deliverable 2 — `@algosize/mcp` stdio bridge

Not every host speaks remote MCP. Add a tiny published-shaped package:

```
mcp/package.json          name @algosize/mcp, bin algosize-mcp, ESM, node >= 20
mcp/src/index.js          stdio ↔ Streamable HTTP proxy
mcp/src/config.js         reads ALGOSIZE_API_KEY, ALGOSIZE_BASE_URL (default https://algosize.com)
mcp/README.md             install + client config snippets
mcp/test/smoke.test.mjs   spawns the bin, sends initialize + tools/list over stdio
```

The bridge is a **dumb pipe**: it must not maintain its own tool list, cache results,
or transform payloads — otherwise the catalog drifts the moment the Worker ships a
new tool. It forwards frames, injects `Authorization`, manages `Mcp-Session-Id`,
retries idempotent reads on 5xx with jittered backoff, and prints an actionable error
on 401 (`"Set ALGOSIZE_API_KEY to an ask_live_… key from
https://algosize.com/dashboard#/mcp"`).

Add `mcp/README.md` config snippets for Claude Code (`claude mcp add` and
`.mcp.json`), Claude Desktop (`claude_desktop_config.json`), and Cursor — one block
each, copy-pasteable, with `ALGOSIZE_API_KEY` as a placeholder.

---

## Deliverable 3 — Dashboard wiring (implementation half; the Design prompt covers the visuals)

- New hash route `#/mcp` in `site/assets/js/dash-router.js`, added to `VIEWS` and to
  the `UNDER_WORKSPACE` grouping so the tab strip stays honest.
- New `site/assets/js/dash-mcp.js` in the same no-framework, `window.DashCore` style
  as `dash-team.js` and `dash-monitors.js`. It renders:
  connection status; a copy-ready remote URL (`https://algosize.com/api/mcp`); the
  npx/stdio config snippets per client with a one-click copy; the org's API keys
  reachable inline (reuse `GET /api/keys`, don't duplicate the create flow — link to
  Team → API Keys); connected OAuth clients from `GET /api/mcp/clients` with revoke;
  the live tool catalog from `GET /api/mcp/manifest` grouped by category with tier
  badges; and recent tool-call activity from `GET /api/mcp/usage`.
- A Workspace tool card linking to `#/mcp` alongside the existing analyzer cards.
- An admin surface: extend the admin panel's automation/overview area with
  MCP adoption (orgs with ≥1 grant, calls/day, top tools, error rate) reading from
  `mcp_tool_calls`. Follow `worker/src/handlers/admin_panel.js` conventions.
- Front-end tests in the style of `worker/scripts/test-tools-frontend.mjs` and
  `test-monitors-frontend.mjs`: assert the view exists, the route resolves, the
  snippets contain the right binary name and env var, and no secret is ever rendered.

---

## Deliverable 4 — Tests, CI, docs

- `worker/scripts/test-mcp-protocol.mjs` — initialize/version negotiation, session id
  issuance and enforcement, unknown method → `-32601`, malformed JSON → `-32700`,
  batch handling, `202` for notification-only posts, `404` on stale session.
- `worker/scripts/test-mcp-tools.mjs` — every tool in the registry: schema validates,
  adapter reaches the real handler, output has both text and `structuredContent`,
  tier gating filters `tools/list`, scope gating rejects in `tools/call`, tool errors
  come back as `isError` results not JSON-RPC errors.
- `worker/scripts/test-mcp-oauth.mjs` — DCR validation, PKCE happy path, replayed
  code rejected, wrong `redirect_uri` rejected, `plain` challenge rejected, refresh
  rotation, revocation, `WWW-Authenticate` on 401, cross-org token cannot read
  another org's run.
- `worker/scripts/test-mcp-quota.mjs` — metered MCP call decrements the org's free
  runs, 402 surfaces as a clean `isError` result with the upgrade URL, and a failed
  analysis releases the reservation.
- `worker/scripts/test-mcp-persistence.mjs` — the 1.10 regression test.
- Append all of them to the `test` script in `worker/package.json`, in order.
- New workflow `.github/workflows/mcp.yml` mirroring `.github/workflows/worker.yml`:
  run the MCP tests plus `mcp/test/smoke.test.mjs` on PRs touching `worker/src/mcp/**`,
  `worker/src/handlers/mcp.js`, `worker/migrations/**`, or `mcp/**`.
- Docs: `worker/MCP.md` (protocol decisions, session model, scope→tool matrix,
  why `.well-known` is routed the way it is), `DEPLOY-mcp.md` (ordered runbook:
  apply `0019_mcp.sql` to staging then production with
  `wrangler d1 execute algosize --file=migrations/0019_mcp.sql --remote --config wrangler.toml`,
  add zone routes, deploy staging, verify, flip `mcp.enabled`, deploy production,
  verify again, rollback steps), plus README and `replit.md` updates and a
  `.agents/memory/mcp-server.md` note in the style of the existing memory files.
- Update `.env.example` and `worker/.dev.vars.example` with any new vars
  (e.g. `MCP_ALLOWED_ORIGINS`). Secrets go through `wrangler secret put --config
  wrangler.toml`, never `[env.*.vars]` — see the price-ID lesson in
  `.agents/memory/algosize-infra.md`.

---

## Execution order

1. Read the files listed in ground rule 1. Then write `MCP-PLAN.md` at the repo root:
   the tool→endpoint→scope→tier matrix, the auth decision, the `.well-known` routing
   decision, and the file list you will create. **Stop and show me this plan before
   writing implementation code.**
2. Migration + schema-check wiring + the 1.10 persistence fix, with its test.
3. `protocol.js` → `session.js` → `transport.js` → `handlers/mcp.js`, wired into
   `index.js` behind the flag. Protocol tests green.
4. `registry.js` + `tools.js` + adapters, tool by tool, running
   `test-mcp-tools.mjs` as you go.
5. `resources.js` + `prompts.js`.
6. `oauth.js` + consent screen + `.well-known` routing. OAuth tests green.
7. Rate limits, audit actions, observability, usage endpoint.
8. `mcp/` stdio bridge + smoke test.
9. Dashboard `#/mcp` view + admin panel additions + front-end tests.
10. CI workflow + all docs. Run the full `npm test` from `worker/` and report the
    result honestly — if something fails, fix it or say clearly what is unfinished.
11. Print the deploy runbook and a manual verification checklist that includes:
    `claude mcp add --transport http algosize https://staging.algosize.com/api/mcp
    --header "Authorization: Bearer ask_live_…"`, then `initialize`, `tools/list`, one
    read-only tool, one metered tool, and confirmation the run appears in
    `GET /api/runs`.

Do not mark the task complete while any test in the chain fails, any tool bypasses
`enforceQuota`, any SQL read is missing an `org_id` scope, or any secret is written to
a log, an audit row, or a tool result.
