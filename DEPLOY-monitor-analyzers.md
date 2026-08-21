# Deploying multi-analyzer monitors

The multi-analyzer monitor work (Architecture X-ray, Infrastructure Cost
Estimator and Algorithm optimizer on a monitor's schedule, plus the optimizer
CI panel) works from the code once **one** thing has happened: migration
`0016` has been applied to the production D1 database.

Everything runs inside the existing monitor pipeline — same cron, same queue,
same email path — so there is nothing else to provision. In particular there
is **no cloud-account connector and no credential storage**: the scheduled
estimator prices the repository's *committed* compose file, exactly as if the
user had pasted it, and never contacts a cloud provider.

---

## 1. Required — apply migration 0016

**Needs Cloudflare access.** Until it is done, **creating** a monitor and
toggling a monitor's analyzers both return 500 — those writes name the new
`analyzers` column. Listing and running existing monitors keep working
(the reads are `SELECT *`, and the sweep only writes the new baseline
columns when a secondary analyzer actually ran), and rows created before the
migration read as `["vuln"]` — exactly what they always ran.

```bash
cd worker
npx wrangler d1 execute algosize \
  --file=migrations/0016_monitor_analyzers.sql \
  --remote --config wrangler.toml
```

It is not idempotent — SQLite has no `ADD COLUMN IF NOT EXISTS`, so a second
run errors on the first `ALTER`. That is the intended behaviour; it means a
re-run tells you it already applied rather than half-applying again.

Verify from outside the Cloudflare account, with an admin session:

```
GET /api/admin/schema-check
```

`0016 monitor_analyzers` should report `applied: true`. It checks the first
column the migration adds and the last, so a migration that died partway
through reports as missing rather than as applied.

### Replit prompt

> Run this in the Cloudflare-connected shell for the algosize Worker:
>
> `cd worker && npx wrangler d1 execute algosize --file=migrations/0016_monitor_analyzers.sql --remote --config wrangler.toml`
>
> Then, signed in as an admin, open `/api/admin/schema-check` and confirm the
> entry whose `migration` is `0016` reports `applied: true`. If the wrangler
> command errors with "duplicate column name", the migration was already
> applied — that is success, not failure.

---

## 2. Nothing else

No new bindings, secrets, queues or routes. The secondary analyzers reuse:

- the monitor cron (03:00 UTC) and `SCAN_QUEUE` consumer,
- the GitHub raw-content fetch path the lockfile audit already uses,
- the estimator's existing sanitizing handler (`/api/estimate`'s code path,
  called in-process — no HTTP hop, no new exposure),
- the optimizer sandbox binding (`SANDBOX`) where configured; without it the
  Worker-local runner is used, same as the dashboard endpoint.

The optimizer CI workflow shown on the Monitors & CI screen authenticates
with the **same** `ALGOSIZE_API_KEY` repository secret as the dependency
audit workflow — customers who did the audit setup have nothing new to
create.
