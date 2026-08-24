# Deploying the Workspace / Monitors redesign

Two screens were rebuilt (D-8) and the tab strip collapsed from five entries
to two. The frontend half needs nothing but a deploy. The backend half needs
**one** thing: migration `0017` applied to the production D1 database.

As with every scheduled analyzer already shipped, there is **no cloud-account
connector and no credential storage** in any of this. The scorecard grades
what the nightly sweep already stored, and the sweep reads only committed
repository files.

---

## 1. Required — apply migration 0017

**Needs Cloudflare access.** Until it is done:

- **Creating a monitor returns 500.** The insert names `run_at_hour`.
- **Every sweep returns 500 at the point it records its run.** The update
  names `last_status`, `last_attempt_at`, `last_error` and
  `last_severity_json`. The Queue will retry, and retry, and never succeed —
  so apply this before the next 03:00 UTC sweep, not after.
- **`GET /api/scorecard` returns 500**, because listing monitors selects the
  new columns. The Workspace shows its error state for the scorecard panel
  and the rest of the page keeps working.

```bash
cd worker
npx wrangler d1 execute algosize \
  --file=migrations/0017_monitor_health.sql \
  --remote --config wrangler.toml
```

Not idempotent — SQLite has no `ADD COLUMN IF NOT EXISTS`, so a second run
errors on the first `ALTER`. That is intended: a re-run tells you it already
applied rather than half-applying again.

Verify from outside the Cloudflare account, with an admin session:

```
GET /api/admin/schema-check
```

`0017 monitor_health` should report applied, with all four columns present.

Every existing row backfills to nothing, and nothing is the correct value:

| Column | Existing rows read as | Which means |
| --- | --- | --- |
| `last_status` | NULL | never attempted — the honest "baseline pending" |
| `last_attempt_at` | NULL | no attempt recorded yet |
| `last_error` | NULL | no failure recorded yet |
| `run_at_hour` | NULL | runs in the 03:00 UTC sweep, exactly as today |
| `last_severity_json` | NULL | not graded — the scorecard shows "pending", never a passing grade |

So a monitor created before this migration keeps behaving identically. The
first sweep after the migration fills in its health and its severity mix, and
its scorecard row goes from pending to graded on its own.

---

## 2. Nothing else to provision

- **No new bindings.** The manual-run endpoint puts a message on the existing
  `SCAN_QUEUE`; if that binding is missing the endpoint answers 503 and says
  so, rather than pretending to have queued something.
- **No new secrets.** Slack delivery reads the webhook the organisation
  already stores (`organisations.slack_webhook_url`, migration 0015). An org
  with no webhook simply has no Slack leg, and the "where the next alert
  goes" card says that in those words.
- **One cron change, and it ships in this diff** — see section 3. Nothing to
  provision by hand; `wrangler deploy` applies the trigger.

---

## 3. Included — the cron is now hourly

`wrangler.toml` ships this change with an hourly trigger instead of the
single 03:00 UTC one, in all three blocks (top level, production, staging).
That is not a tuning knob — it is what makes the time-of-day setting mean
anything. With one daily tick, a monitor asking for 14:00 would simply never
come due.

```toml
[triggers]
crons = ["0 * * * *"]      # was "0 3 * * *"
```

**Nobody's existing delivery time moves.** `isDue` reads the cron expression
it was actually invoked with, and when the sweep ticks hourly a monitor that
never chose an hour falls back to `DEFAULT_SWEEP_HOUR` — 03:00, exactly where
it has always run. Without that fallback the 20-hour minimum gap would walk a
"daily" monitor around the clock on an hourly tick, which is the bug the
default exists to prevent.

Cost of the extra ticks: one `listMonitorsDue` query per hour, enqueueing
nothing the other 23 times.

Deploy the Worker and the cron changes together. Deploying the code without
the trigger leaves the hour control storing a value that is never honoured;
deploying the trigger without the code is the drift case above.

## 4. What changed for people already using it

Two settings that had never done anything now do:

- **Monitor alert emails go to every member who has them switched on**, not
  to the billing owner alone. An org whose members left the default on will
  see more people receiving the nightly alert than before — that is the
  setting finally working, not a bug. Anyone who does not want it can switch
  it off on Account → Notifications, and that will now be honoured.
- **The Slack toggle delivers.** An org that had `monitor:slack` switched on
  and a webhook configured was previously getting nothing on Slack; it will
  start posting.

Worth a line in the release notes, because the first one changes who gets
mail.

---

## 5. Still outstanding from earlier work

- Migrations **0015** and **0016** must already be applied — 0017 assumes the
  `notification_prefs` table and the `analyzers` column exist. Check
  `GET /api/admin/schema-check` before running anything.
- The pricing catalog's `verificationStatus` is still author-set. Nothing in
  this change touches it; flipping an entry to `"verified"` still requires a
  human opening the provider's actual pricing page.
