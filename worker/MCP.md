# MCP server — protocol and operations notes

For maintainers. What the decisions were, and why the non-obvious ones went
the way they did.

Protocol revision: **2025-06-18** (Streamable HTTP, one endpoint). We also
answer to `2025-03-26` and `2024-11-05` when a client asks for them, and
refuse anything else rather than silently downgrading — a client asking for a
revision we have never seen may depend on framing we do not implement, and
answering in an older dialect turns one clear failure at connect time into a
confusing partial failure much later.

## The one rule

Every tool reaches the product through `callHandler` in `src/mcp/dispatch.js`
and through nothing else. No tool contains analyzer logic, validation, quota
accounting, entitlement resolution, or SQL.

This is structural, not a convention: `scripts/test-mcp-purity.mjs` fails the
build if any file under `src/mcp/tools/` imports an analyzer, a handler,
`enforceQuota`, `entitlement.js`, or touches a binding.

That guard is only enforceable because the route→middleware mapping lives in
`src/mcp/chains.js`, one module **outside** `tools/`. A tool asks that table
for a route's chain; it cannot construct one, so it cannot drop the quota
wrapper off a metered route.

The failure this prevents is invisible. A tool importing an analyzer directly
would pass every functional test — correct output, correct shape, no error —
and simply never charge a run. Nobody notices free analyses until the revenue
does not add up.

## `callHandler` takes the chain explicitly

`callHandler(chain, { method, path, query, params, body, request, env, ctx })`.

The caller passes the same chain `index.js` registers for that route, minus
`requireAuth` (already applied) and minus the rate limiters (the MCP envelope
has its own; running the HTTP limiter would charge one user action to two
buckets).

An earlier draft instead re-entered the whole router with a `_mcpDispatch`
flag and asked the router to skip auth for flagged requests. That is a
deliberate authentication bypass living in the main request path, one property
assignment away from being reachable from outside. It also did not work —
`index.js` has no `handleRequest` export for it to call. Passing the chain in
means the bypass does not exist.

## Metering is derived, not declared

`chains.js` records `metered` next to each chain, and it is true exactly when
the chain contains `enforceQuota`. A tool's `metered` flag is checked against
that table by the purity test, so the two cannot drift.

Two routes the original plan listed as metered are **not**, and the tools were
corrected to match:

- `/api/fix` — registered as `analyzeRateLimit, requireAuth,
  generateFixHandler`. It explains a finding the customer already spent a run
  to produce.
- `/api/monitors/:id/run` — behind `requireAuth` alone. The sweep it queues
  does consume runs when it executes, which the tool description says; the
  call itself does not.

## Sessions

`Mcp-Session-Id`, stored in the existing `SESSIONS` KV under `mcp:sess:<id>`
with a 24-hour TTL. No new namespace: a new KV binding is a new thing to
provision in every environment and one more line in DEPLOY.md to forget on
staging.

A session is **bookkeeping, not a credential**. The client re-presents its
bearer on every request; the session only carries negotiated protocol state.
No token, key or hash is ever stored in the record.

`assertSessionOwner` checks the authenticated org against the org the session
was opened for. Without it, a valid token for org B plus a leaked session id
from org A would let B inherit A's state. A session id presented by the wrong
org is reported as **not found**, not as forbidden — confirming it exists
tells the caller something about another tenant.

## Origin checking

A **missing** Origin is allowed; a **present but unlisted** one is refused.
That reads backwards until you remember what the header means: browsers always
send it and cannot forge it, non-browser clients never send it. So "absent"
identifies a native client (Claude Code, the bridge, curl) — the case DNS
rebinding cannot reach — and "present and wrong" identifies exactly the attack.

The Anthropic subdomain match is an anchored pattern, not `endsWith`.
`endsWith(".anthropic.com")` also accepts `https://anthropic.com.attacker.example`.

## `.well-known` routing

The zone route is `algosize.com/api/*`; everything else on the apex is GitHub
Pages. OAuth discovery documents must live at the apex, outside that route.

**Decision: add two exact-path zone routes** to `worker/wrangler.toml` for
production and staging. No wildcard, so nothing else on the apex moves off
Pages.

Serving them as static JSON from the Jekyll site cannot work: the metadata
must change with the environment (staging vs production issuer) and would
become a second source of truth for the supported scopes. Proxying from the
`algosize-site` Worker couples two Workers for two static documents.

Both documents are **also** served from `/api/.well-known/…` so the flow is
exercisable under `wrangler dev`, which has no zone routes at all, and before
new zone routes finish propagating (~2 minutes — see
`.agents/memory/algosize-infra.md`). The `WWW-Authenticate` header advertises
the apex path; the `/api/` copy is a compatibility alias.

## The 401 that matters

`WWW-Authenticate: Bearer realm="algosize", resource_metadata="…"` is the
entire mechanism by which a host discovers it can authenticate. Without it a
spec-compliant client reports "unauthorized" and stops.

This is why `/api/mcp` uses `requireAuthSoft`: `requireAuth`'s own 401 carries
no such header, so a host that hit it would have nowhere to go. `requireAuthSoft`
resolves a credential when there is one and stays silent when there is not,
leaving `mcpAuth` to answer — either by resolving an `ask_mcp_` token, or by
returning the 401 that actually starts the flow. It grants nothing on its own.

## RFC 8707 resource indicators

The metadata advertises `resource_indicators_supported: true`, and both
`authorize` and `token` validate the `resource` parameter against this
server's own MCP endpoint.

That pairing is the point. Advertising the capability and ignoring the
parameter — which is what shipped first — tells a client its token is
audience-bound when it is not. Since this server has exactly one resource,
honouring it completely means refusing any value that names something else;
there is no second audience to issue for, so nothing needs storing.

It is checked on refresh as well as on the initial grant: a refresh is a fresh
token issuance, and a client that could not widen the audience at
authorization time should not be able to at renewal time either.

## Scopes

| Scope | Grants |
|---|---|
| `algosize:read` | run history, reports, scorecard, monitors, snapshots, CI snippets, whoami |
| `algosize:analyze` | the five analyzers and the fix generator |
| `algosize:manage` | monitor create/update/delete/run-now, and the share link |

An API key and a cookie session both grant all three: the credential already
authorises those operations over plain HTTP, so refusing them over MCP would
be theatre. An OAuth token grants exactly what the user consented to — the
only credential where a person made a decision on a consent screen, and so the
only one where a narrower grant is meaningful.

No scope grants key creation, billing, member management, or `/api/admin`.
Those routes have **no tool and no chain entry at all** — absent, not gated —
so no scope bug can reach them.

## Errors: `isError` result vs JSON-RPC error

A tool that ran and failed returns an `isError` **result**. A JSON-RPC
**error** is reserved for transport-level faults: unknown method, unparseable
params, missing scope.

The difference is what the host shows. An RPC error renders as a broken
connection the model cannot recover from; an isError result is information the
model can read and act on. A 402 for an exhausted allowance must be the
second kind, or "you are out of runs this month" reads to the user as "the
integration is down".

## Two rate limits, not one

The envelope limiter on `/api/mcp` allows **120 requests a minute** per
credential. That is sized for a conversational client, which does a dozen
reads in a turn and should never feel it.

It is the wrong number for analyses. 120 metered calls in a minute would burn
a free plan's whole monthly allowance twenty-four times over before the
customer could notice, so `tools/call` on a tool with `metered: true` also
passes a **20 a minute** bucket, keyed on the org and namespaced separately
(`mcp_metered`) so reads and analyses never share a counter.

The distinction matters in both directions. Sharing one bucket would mean a
retry loop on an analyzer locks the model out of `algosize_list_runs` — the
very tool it needs to discover it already has the result it is retrying for.
Having no second bucket would mean the 120/min limit is, in practice, a
spending limit set at twenty-four months of a free plan.

This limit protects the **customer's allowance**, not the server, which is why
the refusal is an `isError` result rather than a 429: the model should read
it, wait the interval it names, and carry on with reads meanwhile. The
refusal is recorded in `mcp_tool_calls` with status `rate_limited` and no
`run_id`, because no run was spent.

## Telemetry

One row per `tools/call` in `mcp_tool_calls`, written through `ctx.waitUntil`.
**No arguments and no results** — a tool argument is customer source code, and
recording it would turn a usage table into a copy of the customer's codebase
outside the R2 lifecycle that governs reports. The table has no column to put
them in.

Tool calls deliberately do **not** go to `audit_log`. A connected assistant
makes hundreds of calls an hour and would bury every human action — invites,
key revocations, plan changes — under machine noise. The audit log answers
"what did a person do"; `mcp_tool_calls` answers "what did the assistant do".

## Enabling it

Off by default, and it fails **shut**: a flag lookup that errors returns
false. `MCP_ENABLED=true` turns it on environment-wide; the `mcp.enabled`
feature flag allows a per-org rollout on top. With it off, `/api/mcp` returns
404 — not 403, because an endpoint nobody is entitled to use should not
confirm it exists.

## Workers AI model selection

`src/analyzers/llm.js` picks Kimi K3 (`moonshotai/kimi-k3`) when
`AI_GATEWAY_ID` is set, and Kimi K2.6 (`@cf/moonshotai/kimi-k2.6`) otherwise.

K3 is a **third-party** catalog entry — no `@cf/` prefix — which means it
requires an AI Gateway and Unified Billing, and is invoked at the
OpenAI-compatible `/ai/v1/chat/completions` with the model named in the body,
not at `/ai/run/<model>`. The two routes also nest their payload differently.
Sending a third-party slug to `/ai/run/` 404s; reading `result` off the
chat-completions reply yields "empty reply" for a call that worked.

The default is conditional rather than a constant so an account with no
gateway keeps working exactly as it does today, instead of silently degrading
refactor suggestions to the stub — a failure nobody would notice.
`WORKERS_AI_MODEL` overrides either way, including when it names a third-party
model with no gateway: an operator who typed a slug deserves the real error
over a silent substitution.
