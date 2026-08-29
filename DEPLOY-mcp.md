# Deploy runbook — MCP server

Ordered. Nothing here is optional except where it says so, and the surface
stays invisible to customers until step 6.

All wrangler commands run from `worker/` and **must** pass `--config
wrangler.toml`. The repo root has a `wrangler.jsonc` that targets the separate
`algosize-site` Worker and shadows it otherwise — that shadowing caused a
production incident on 2026-08-20 and the explicit flag is the standing
mitigation. `--env production` is likewise required: without it the D1 binding
resolves a placeholder id and fails with "database not found".

## 0. What merging this does — nothing

`MCP_ENABLED` is unset, so `/api/mcp` refuses every caller: 404 for an
authenticated one, 401 for an unauthenticated one (see §4). The flag lookup
fails shut, so a D1 hiccup cannot open it either. Merging is safe on its own.

The one change that takes effect immediately on merge is the §1.10 fix: runs
made with an API key now persist and appear in `GET /api/runs`. That is a bug
fix — those runs were already being billed — but it means the runs feed will
start showing rows for CI traffic that previously left no trace. Expect the
feed to get busier, and to carry a `credentialKind` on new rows (null on old
ones, which is not the same as "session" and must not render as one).

## 1. Apply migration 0019

Staging first if staging is live; see the open question at the end.

```
cd worker
npx wrangler d1 execute algosize --file=migrations/0019_mcp.sql \
  --remote --env production --config wrangler.toml
```

Then confirm from the outside rather than trusting the command:

```
curl -s https://algosize.com/api/admin/schema-check -H "Cookie: <admin session>"
```

Expect `0019` present with all seven checks passing — including
`runs.credential_kind` and `runs.credential_id`, whose absence is **silent**:
runs still persist without them, they just lose their provenance label.

## 1b. Apply migration 0021 — session correlation

Ships with the grouped activity feed. Same shape as above:

```
cd worker
npx wrangler d1 execute algosize --file=migrations/0021_mcp_session_ref.sql \
  --remote --env production --config wrangler.toml
```

Expect `0021` present in the schema check (`mcp_tool_calls.session_ref`).

Its absence is **silent in a specific way worth knowing**: calls keep logging,
they simply never group, and the dashboard shows every existing row under
"recorded before session grouping existed" — which is exactly what a
pre-migration row is, so the UI stays truthful either way. The failure mode is
a feature that quietly does nothing, not a broken page.

Nothing backfills. Rows written before this migration have no session id to
recover; they age out of the 30-day window on their own.

## 2. Add the `.well-known` zone routes

The OAuth discovery documents must be reachable at the apex, which the current
`algosize.com/api/*` route does not cover. Add two exact-path routes (no
wildcard, so nothing else on the apex moves off GitHub Pages) for production
and staging:

```
algosize.com/.well-known/oauth-protected-resource
algosize.com/.well-known/oauth-authorization-server
```

Propagation takes about two minutes. A bare 404 immediately after deploy is
expected, not a failure.

**This step is only needed for OAuth**, which is not finished. API-key
connections — Claude Code, Cursor, the bridge — work without it. The
`/api/.well-known/…` aliases are already served by the existing route and are
enough to exercise discovery meanwhile.

## 3. Deploy

`worker.yml` deploys automatically on push to `main` touching `worker/**`. It
does **not** run on pull requests, so the full worker suite's first CI run
against these changes happens at merge — watch that run, because a failure
there fails the production deploy.

`mcp.yml` does run on pull requests, which is why it exists.

## 4. Verify the endpoint is closed

**An unauthenticated probe cannot answer this.** `mcpAuth` runs ahead of the
handler and 401s before the flag is ever read — that ordering is deliberate
(its `WWW-Authenticate` header is what lets an OAuth client discover it can
authenticate at all), so a bare POST returns 401 whether MCP is on or off:

```
curl -s -o /dev/null -w "%{http_code}\n" https://algosize.com/api/mcp -X POST
```

Expect **401 in both states**. It tells you the route is deployed and nothing
more. An earlier version of this runbook said to expect 404 here and to read
a 401 as proof the flag was set; both were wrong.

To actually check the gate, authenticate. With a real API key, a disabled
surface answers **404** and an enabled one completes `initialize`:

```
curl -s -o /dev/null -w "%{http_code}\n" -X POST https://algosize.com/api/mcp \
  -H "Authorization: Bearer $ALGOSIZE_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","clientInfo":{"name":"curl","version":"1"},"capabilities":{}}}'
```

The manifest is public by design and should already answer:

```
curl -s https://algosize.com/api/mcp/manifest | head -c 300
```

## 5. Decide on Kimi K3 — needs an operator

Nothing changes until an AI Gateway exists. `src/analyzers/llm.js` uses K3
only when `AI_GATEWAY_ID` is set, and stays on K2.6 otherwise.

K3 is a **third-party** model, so it requires an AI Gateway with Unified
Billing — Cloudflare manages the provider credentials and deducts credits from
the account. Before enabling it, report back:

1. whether an AI Gateway exists on the account, and its id;
2. whether Unified Billing is enabled on it, and the current credit balance;
3. K3's per-token price against K2.6's, at our volume.

To enable afterwards:

```
cd worker
npx wrangler secret put AI_GATEWAY_ID --config wrangler.toml --env production
```

To roll back, unset it — the code falls back to K2.6 with no deploy.

Note that K2.6 and K3 both require the **Workers Paid** plan; several models
moved behind it on 2026-07-28. If the account is on Workers Free, both fail
with a 403 and the optimizer falls back to its descriptive stub. That is worth
confirming before blaming the model change.

## 6. Turn MCP on

Environment-wide:

```
cd worker
npx wrangler secret put MCP_ENABLED --config wrangler.toml --env production
# value: true
```

Or for chosen organisations, leaving `MCP_ENABLED` unset. Turn the flag on
with no global rollout, then name each org explicitly (migrations/0020):

```
PATCH /api/admin/flags/mcp.enabled          {"enabled": true, "rolloutPct": 0}
PUT   /api/admin/flags/mcp.enabled/overrides/<org_id>   {"enabled": true}
```

An override is checked before the flag's own state and wins over it in both
directions, so `rolloutPct: 0` keeps everyone else off while the named orgs
are on. `DELETE` on the same path clears one, returning that org to whatever
the global rollout says.

Prefer this for a pilot. **Note what `rolloutPct` alone cannot do:** it is a
deterministic hash bucket over (flag, org), so it selects *roughly* N% of
organisations and gives you no say in which. An earlier version of this
runbook claimed the flag "takes an org id as its subject" in a way that
implied it could target one — it could not, until 0020.

## 7. Verify end to end

With a real API key from `https://algosize.com/dashboard/#/account/keys`:

```
claude mcp add --transport http algosize https://algosize.com/api/mcp \
  --header "Authorization: Bearer ask_live_…"
```

Then, in Claude Code:

1. confirm the tool list appears (22 tools);
2. run a **read-only** tool — `algosize_whoami` or `algosize_list_runs`;
3. run **one metered** tool on a small input;
4. confirm that run now appears in `GET /api/runs` with
   `credentialKind: "api_key"`. This is the §1.10 fix; before it, step 4
   returned nothing.

Also confirm the usage row landed:

```
curl -s https://algosize.com/api/mcp/usage -H "Authorization: Bearer ask_live_…"
```

## Rollback

Unset `MCP_ENABLED` (or disable the `mcp.enabled` flag). The endpoint returns
404 again within a request. No deploy, no migration reversal — table 0019 is
additive and inert when nothing writes to it.

The §1.10 persistence fix is **not** covered by that switch, since it is a fix
to an existing billing/visibility bug rather than part of the MCP surface. To
revert it you would revert the commit.

## Open question, unchanged from the arch-snapshots runbook

Staging's D1 database id in `worker/wrangler.toml` is still the placeholder
`00000000-0000-0000-0000-00000000stg1`, and its KV ids are likewise
placeholders. Whether step 1 needs a staging pass depends on whether staging
is meant to be live — which only you know. If it is, staging needs its own D1,
KV namespaces, queue and every migration, which is a much larger task than
anything above.
