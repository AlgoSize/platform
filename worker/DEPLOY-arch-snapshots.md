# Deploying architecture snapshots (X-ray Phase 1)

One migration, then a Worker deploy — and the Worker deploy is automatic.

## 1. Required — apply migration 0018

**Needs Cloudflare access.** Until it is applied:

- Every architecture run still works and still returns its graph. Snapshot
  recording is best-effort by construction (`src/arch/snapshots.js`), so a
  missing table costs the history and nothing else.
- `GET /api/arch/snapshots`, `/api/arch/snapshots/:id` and `/api/arch/diff`
  return 500 — they query a table that is not there.

```bash
cd worker
npx wrangler d1 execute algosize \
  --file=migrations/0018_arch_snapshots.sql \
  --remote --env production --config wrangler.toml
```

Note `--env production`. Without it wrangler resolves the placeholder database
id in the top-level block and fails with "database not found".

Verify with an admin session: `GET /api/admin/schema-check` should report
`0018 arch_snapshots` applied.

## 2. Automatic — the Worker deploy

`worker.yml` deploys on every push to `main` touching `worker/**`. This change
does, so merging is the deploy. Nothing to run by hand.

## 3. What starts happening

Every architecture run — manual upload, CI ingestion, nightly sweep — records
a versioned snapshot of the graph it built. No UI renders them yet; Phase 1 is
storage plus reads so the history is accumulating before the drift view that
needs it exists.

Storage is small: graphs are extremely repetitive and gzip to well under a
fifth of their size. A snapshot too large for a D1 row is stored with its
evidence citations dropped and flagged `reduced`; one too large even then is
refused rather than truncated, because half a graph diffs as though everything
missing was deleted.

Retention is 90 days, matching run history, via `pruneSnapshots()`. **Nothing
calls it yet** — wire it into the cron when the first org has enough history
to matter. Until then snapshots accumulate, which for current volumes is
measured in kilobytes per repo per day.

## 4. Not in this change

No SPOF detection, no blast radius, no trust boundaries, no data
classification — those are Phase 3. Every field for them exists on the stored
graph and every one of them is `null`, which renders as *not analysed* rather
than as a pass. No runtime signals — Phase 2, and see
`ARCHITECTURE-XRAY-PHASE-0.md` §7.2 for why that half needs a decision before
it can be built.
