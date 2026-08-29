# Replit prompt — Cloudflare tasks for the MCP server

Everything here needs the Cloudflare account and cannot be done from a
sandboxed agent. Paste the block below into Replit as a single prompt.

This is a **second** prompt file, not a replacement. `REPLIT-CLOUDFLARE-PROMPT.md`
covers the monitor/queue/secrets tasks; only its Task 3 (the dead-letter queue)
is repeated here, because it is still unverified and is genuinely urgent.

Read Task 1 before anything else. It is not an MCP task — it is a check on
whether **run history is currently broken in production**, and the answer
decides whether the rest of this file is routine or an incident.

---

```
You have direct Cloudflare access for the Algosize account. Work through the
tasks below IN ORDER. Task 1 gates everything else.

Repo: AlgoSize/platform, branch main, currently at merge commit 7cc4230
(worker.yml run #72 deployed it successfully).

All wrangler commands run from `worker/` and MUST pass `--config wrangler.toml`
explicitly. The repo root has a wrangler.jsonc that shadows it otherwise —
that shadowing caused a production incident on 2026-08-20 and the explicit
flag is the standing mitigation.

Report each task as PASS / FAIL / FIXED with the actual command output. Paste
what the commands printed; do not summarise. If something is ambiguous, stop
and say so rather than guessing.

────────────────────────────────────────────────────────────────────────
TASK 1 — URGENT. Is migration 0019 applied? Run history may be broken.
────────────────────────────────────────────────────────────────────────
This is the first task because the deployed code already depends on it.

Commit 3717eea (merged in PR #52, deployed 08:15 UTC today) changed
worker/src/handlers/runs.js so that:

  - listRuns()   SELECTs `credential_kind` from `runs`, unconditionally
  - persistRun() INSERTs `credential_kind, credential_id`, unconditionally

Those two columns are added by migrations/0019_mcp.sql. If that migration has
NOT been applied to the production D1, then right now:

  - GET /api/runs returns a 500 — the dashboard's run history is empty/broken
  - every analysis silently fails to record a run (persistRun catches the
    error and returns null, so the analysis still answers the caller and the
    run is simply never written)

The second one is the dangerous half: it is invisible from the outside. The
customer gets their analysis, the run never appears in history, and nothing
alerts.

CHECK — read the live schema:

  cd worker
  npx wrangler d1 execute algosize --command "PRAGMA table_info(runs);" \
    --remote --env production --config wrangler.toml

EXPECT columns including `credential_kind` and `credential_id`.

Also confirm from the outside:

  curl -s -o /dev/null -w "%{http_code}\n" https://algosize.com/api/runs

EXPECT 401 (route exists, refusing an unauthenticated caller). A 500 here
means the migration is missing and the table is being queried for columns it
does not have.

IF THE COLUMNS ARE MISSING — apply the migration:

  cd worker
  npx wrangler d1 execute algosize --file=migrations/0019_mcp.sql \
    --remote --env production --config wrangler.toml

Then re-run both checks above and paste the output. Also report roughly how
long the gap lasted. Commit 3717eea first reached main in PR #52 (merge
3938ef4) and was deployed by worker.yml run #69 at 08:15 UTC on 2026-08-29 —
any analysis run since then was not recorded and cannot be recovered.

NOTE: 0019 creates the MCP tables too, but it does NOT turn MCP on. Applying
it changes no behaviour except fixing the above. Turning MCP on is Task 6.

────────────────────────────────────────────────────────────────────────
TASK 2 — Confirm the schema check agrees
────────────────────────────────────────────────────────────────────────
The app has its own migration manifest at /api/admin/schema-check, which
verifies each migration by probing for the objects it should have created.
It lists 0019 with seven checks.

Sign in as an admin at https://algosize.com/dashboard/ and then:

  curl -s https://algosize.com/api/admin/schema-check -H "Cookie: <admin session>"

EXPECT 0019 present with all seven checks passing.

This is a genuinely independent check, not a duplicate of Task 1: PRAGMA tells
you the columns exist, this tells you every object the migration was supposed
to create actually landed — including the mcp_tool_calls table and its index.
A partially-applied migration passes Task 1 and fails here.

────────────────────────────────────────────────────────────────────────
TASK 3 — The dead-letter queue. STILL UNVERIFIED, carried over.
────────────────────────────────────────────────────────────────────────
This was Task 3 in the previous prompt and I have no record of it being
answered. It is more important now, not less: monitor sweeps do more work per
message than they used to (each sweep now also writes run rows), so a message
that exhausts its retries loses more.

worker/wrangler.toml names `algosize-scans-dlq` as the dead_letter_queue for
both the production and staging consumers. Nothing in the repo creates it.
If it does not exist, a monitor message that exhausts its 3 retries is dropped
with no record — silent data loss on the failure path.

  cd worker && npx wrangler queues list --config wrangler.toml

EXPECT: algosize-scans, algosize-scans-staging, algosize-scans-dlq.

If algosize-scans-dlq is MISSING, create it and redeploy so the consumer
binding attaches to a queue that now exists:

  cd worker && npx wrangler queues create algosize-scans-dlq --config wrangler.toml
  cd worker && npx wrangler deploy --config wrangler.toml --env production

Also report whether the staging consumer points at the same DLQ (it does in
config) and whether that is intended — a shared DLQ across environments is
defensible but should be a decision, not an accident.

────────────────────────────────────────────────────────────────────────
TASK 4 — Pre-flight: confirm MCP is still closed
────────────────────────────────────────────────────────────────────────
Before turning anything on, confirm the current state is what the code claims.

  curl -s -o /dev/null -w "%{http_code}\n" -X POST https://algosize.com/api/mcp

EXPECT 404. The surface is off by default and fails shut — a flag lookup that
errors returns false. 404 rather than 403 is deliberate: an endpoint nobody is
entitled to use should not confirm it exists.

A 401 here would mean MCP_ENABLED is already set somewhere. Report that rather
than continuing.

The manifest is public by design and should already answer 200:

  curl -s https://algosize.com/api/mcp/manifest | head -c 300

EXPECT JSON naming 22 tools. It carries no customer data and no credentials —
it describes what the tools ARE, which is why it is readable before anything
is connected.

────────────────────────────────────────────────────────────────────────
TASK 5 — Kimi K3. INVESTIGATE AND REPORT. Change nothing.
────────────────────────────────────────────────────────────────────────
src/analyzers/llm.js picks Kimi K3 (`moonshotai/kimi-k3`) when AI_GATEWAY_ID
is set, and Kimi K2.6 (`@cf/moonshotai/kimi-k2.6`) otherwise. K3 has no `@cf/`
prefix because Cloudflare lists it as a third-party catalog entry, which means
it requires an AI Gateway with Unified Billing and is invoked at the
OpenAI-compatible route rather than /ai/run/.

Do not set the secret yet. Report these four:

  a) Does an AI Gateway exist on this account? If so, its id.
  b) Is Unified Billing enabled on it, and what is the current credit balance?
  c) K3's per-token price against K2.6's, at our volume.
  d) Is this account on the Workers PAID plan?

(d) is the one people skip and it invalidates the rest. Several models moved
behind Workers Paid on 2026-07-28, K2.6 and K3 among them. On Workers Free
BOTH fail with a 403 and the optimizer silently falls back to its descriptive
stub — so if refactor suggestions have looked thin lately, check this before
blaming the model choice.

To enable afterwards, once someone has decided:

  cd worker && npx wrangler secret put AI_GATEWAY_ID --config wrangler.toml --env production

To roll back, unset it. The code falls back to K2.6 with no deploy needed.

────────────────────────────────────────────────────────────────────────
TASK 6 — Turn MCP on. ONLY after Tasks 1, 2 and 4 pass.
────────────────────────────────────────────────────────────────────────
Two ways. Prefer the second for a staged rollout.

Environment-wide:

  cd worker && npx wrangler secret put MCP_ENABLED --config wrangler.toml --env production
  # value: true

Per organisation, leaving MCP_ENABLED unset — the feature flag takes an org id
as its subject, so one organisation can be switched on alone:

  PATCH /api/admin/flags/mcp.enabled     (via the admin panel's Flags section)

Say which one you used and, if per-org, which org.

────────────────────────────────────────────────────────────────────────
TASK 7 — Verify end to end, with a real credential
────────────────────────────────────────────────────────────────────────
Create an API key at https://algosize.com/dashboard/#/account/keys (the full
value is shown once, at creation — nothing can read it back afterwards).

  KEY=<the key>

  # initialize — expect 200 and an Mcp-Session-Id response header
  curl -si -X POST https://algosize.com/api/mcp \
    -H "Authorization: Bearer $KEY" \
    -H "Content-Type: application/json" \
    -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","clientInfo":{"name":"curl","version":"1"},"capabilities":{}}}' \
    | grep -i "mcp-session-id\|HTTP/"

  SID=<the Mcp-Session-Id value>

  # whoami — read-only and unmetered, so this costs nothing
  curl -s -X POST https://algosize.com/api/mcp \
    -H "Authorization: Bearer $KEY" \
    -H "Mcp-Session-Id: $SID" \
    -H "Content-Type: application/json" \
    -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"algosize_whoami","arguments":{}}}'

EXPECT a result naming the organisation, with "isError": false.

Then confirm the call was recorded, which is what the dashboard's activity
feed reads:

  curl -s https://algosize.com/api/mcp/usage -H "Authorization: Bearer $KEY"

EXPECT totals.calls >= 1 and a `daily` array of 14 entries.

Note on that array: it is DENSE — every one of the 14 days has an entry,
including days with zero calls. If you see fewer than 14 entries, something is
wrong; do not read a short array as "quiet days omitted".

────────────────────────────────────────────────────────────────────────
TASK 8 — REPORT ONLY: D1 growth from monitor sweeps
────────────────────────────────────────────────────────────────────────
Change nothing. This is a capacity question I cannot answer from outside.

As of commit 3529e2c, every monitor sweep now files one run row per analyzer
that produced a result — up to four rows per monitor per sweep, where
previously it wrote none. Runs are pruned at 90 days.

Report:

  a) the current row count of `runs` on production
  b) the number of enabled monitors, and how many analyzers each has on

  cd worker
  npx wrangler d1 execute algosize --command \
    "SELECT COUNT(*) AS runs FROM runs;" \
    --remote --env production --config wrangler.toml

  npx wrangler d1 execute algosize --command \
    "SELECT COUNT(*) AS monitors, SUM(paused_at IS NULL) AS active FROM monitors;" \
    --remote --env production --config wrangler.toml

At present volumes this is almost certainly a non-issue — the arithmetic is
roughly (active monitors × analyzers × 90) additional rows in steady state.
I want the actual numbers on record rather than an assumption, because the
growth is now automatic and nobody will be watching it.

────────────────────────────────────────────────────────────────────────
DEFERRED — do NOT do this one, it needs a decision first
────────────────────────────────────────────────────────────────────────
The OAuth discovery documents need two exact-path zone routes on the apex:

  algosize.com/.well-known/oauth-protected-resource
  algosize.com/.well-known/oauth-authorization-server

The existing zone route is algosize.com/api/*; everything else on the apex is
GitHub Pages, so these must be added as exact paths (no wildcard) or other
apex content moves off Pages. Propagation takes about two minutes, so a bare
404 immediately after adding them is expected, not a failure.

This is ONLY needed for the OAuth flow — the browser-based "add a connector"
path in Claude.ai. API-key connections (Claude Code, Cursor, the local bridge)
do not touch it, and the same documents are already served at
/api/.well-known/… by the existing route, which is enough to exercise
discovery meanwhile.

Do not add these until someone confirms OAuth is being launched. Adding zone
routes to the apex is the change in this file most likely to affect something
unrelated.

────────────────────────────────────────────────────────────────────────
ALREADY DONE — do not redo
────────────────────────────────────────────────────────────────────────
- D1 migrations 0015, 0016, 0017, 0018 are applied to production.
- The Worker is deployed at 7cc4230 via worker.yml run #72 (successful).
- Nothing in this file should require a code change. If one seems to, stop and
  report rather than editing the repo — this prompt is for operating the
  account, not for changing the application.
```

---

## What I could not check from here

The sandbox has no egress to algosize.com, so every "EXPECT" above is derived
from reading the code and the config, not from observing production. Task 1 in
particular is a *prediction*: I can prove the deployed code selects and inserts
`credential_kind`, and I can prove migration 0019 is what creates it. I cannot
prove the migration has not been applied — only that the runbook still lists it
as pending and I have no record of it being run.

So Task 1 may well come back PASS in ten seconds. That is the good outcome and
it costs almost nothing to establish. It is first because the failure mode, if
it is failing, is one nobody would notice: analyses keep working and simply
stop being recorded.
