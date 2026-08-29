# Replit prompt — Cloudflare tasks for the AI-visibility release

One database migration and one verification. Nothing else in this release
touches Cloudflare configuration.

**What this release does NOT need**, stated so nobody goes looking: no new
bindings, no new queues, no new routes, no new secrets, no dashboard clicks.
The session-correlation feature reuses the `SESSIONS` KV namespace and the
`DB` D1 binding that are already bound in every environment, and the drift
view is a frontend that reads endpoints deployed since Phase 1.

The one thing a deploy will **not** do for you is apply a migration — nothing
in `.github/workflows/` runs `d1 execute` or `migrations apply`. That is
deliberate (a schema change lands when a human decides, not when a merge
happens), and it is why this file exists.

---

## Paste this into Replit

```
You have direct Cloudflare access for the Algosize account. Two tasks, in
order. Task 2 verifies Task 1; do not skip it.

Repo: AlgoSize/platform, branch main.

All wrangler commands run from `worker/` and MUST pass `--config wrangler.toml`
explicitly. The repo root has a wrangler.jsonc that shadows it otherwise —
that shadowing caused a production incident on 2026-08-20, so the explicit
flag is not optional even when it looks redundant.

Never paste an API key, token, session id or cookie value back into chat.
Report only the outputs each task names.

--------------------------------------------------------------------------
TASK 1 — apply migration 0021 to production D1
--------------------------------------------------------------------------

The migration adds one nullable column and one index to an existing table:

  ALTER TABLE mcp_tool_calls ADD COLUMN session_ref TEXT;
  CREATE INDEX IF NOT EXISTS idx_mcp_tool_calls_session
    ON mcp_tool_calls(org_id, session_ref, created_at);

It is additive and non-destructive: no data is rewritten, no column is
dropped, and existing rows keep working with session_ref NULL. There is
nothing to back up beyond the standard D1 point-in-time recovery, and no
downtime window is needed.

Run it:

  cd worker
  npx wrangler d1 execute algosize --file=migrations/0021_mcp_session_ref.sql \
    --remote --env production --config wrangler.toml

If staging is live, apply it there first with --env staging and the staging
database name, then production.

Report: the command's output, and whether it reported success.

--------------------------------------------------------------------------
TASK 2 — verify from outside, not from the command's own exit code
--------------------------------------------------------------------------

Open this in a browser where you are signed in as an Algosize admin:

  https://algosize.com/api/admin/schema-check

Paste ONLY the JSON response. No cookies, no tokens, no API keys.

Expect migration "0021" present and applied, with its single check
(mcp_tool_calls.session_ref) passing, and ok:true overall with 21 migrations.

If 0021 reports NOT applied, say so and stop — do not re-run Task 1 more than
once. A repeated ALTER TABLE on a column that already exists is an error, not
an idempotent no-op, and the second failure would be reported as though the
first had not landed.

--------------------------------------------------------------------------
WHAT TO EXPECT AFTERWARDS — so nothing here reads as a bug
--------------------------------------------------------------------------

Nothing backfills. Every tool call recorded before this migration has no
session id to recover, and the dashboard shows those rows under "recorded
before session grouping existed". That is correct, not a failure. They age
out of the 30-day activity window on their own.

New calls group immediately. The next time an assistant connects and uses a
tool, its calls appear as one session card in Workspace → MCP → Activity.

If the migration is NOT applied, the failure is silent but honest: calls keep
logging, they simply never group, and every row reads as pre-grouping — which
is exactly what they would be. Nothing breaks; the feature just does nothing.
```

---

## Optional, new with the tree-discovery fix: GITHUB_TOKEN

The Architecture X-ray now discovers a watched repository's manifests through
the GitHub git-tree API instead of guessing root-level names. Unauthenticated,
that API allows 60 requests/hour per IP — and Workers egress IPs are shared,
so the sweep can hit someone else's exhausted quota. A rate-limited listing is
handled honestly (the analyzer skips without touching baselines), but setting
a token makes the limit a non-issue:

  cd worker
  npx wrangler secret put GITHUB_TOKEN --env production --config wrangler.toml

Use a fine-grained personal access token with **public repository read-only**
access and nothing else. This is OUR read token for public content — not a
customer credential, and not the §7.2 connector; the invariant about customer
cloud accounts is untouched. Skip this entirely if you prefer: the feature
works without it, just with a shared rate limit.

## Still open from the earlier prompt files

Not part of this release, and not blocked by it. Listed so they do not get
lost between files:

| From | Task | Status |
| --- | --- | --- |
| `REPLIT-CLOUDFLARE-PROMPT.md` | Cron trigger check | unverified |
| `REPLIT-CLOUDFLARE-PROMPT.md` | Secrets inventory | unverified |
| `REPLIT-CLOUDFLARE-PROMPT.md` | Workers-Builds trigger guard | unverified |
| `REPLIT-CLOUDFLARE-PROMPT.md` | Workers Logs decision | needs an operator decision |
| — | GitHub secret `ALGOSIZE_API_KEY` for the CI gates | not set |

## What I could not check from here

Whether staging's D1 and KV ids in `wrangler.toml` are real resources or
placeholders. If staging has never been deployed, applying 0021 there will
fail on a database that does not exist — which is informative, not harmful,
but worth knowing before it looks like a migration problem.
