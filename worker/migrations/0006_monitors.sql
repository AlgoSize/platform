-- Scheduled repository monitors — the thing that turns a one-shot scanner
-- into a service.
--
-- Every analyzer run today is synchronous and user-initiated, so nothing
-- notices that a dependency became vulnerable overnight. That is the actual
-- event a security team needs to hear about, and it is also the difference
-- between a tool someone remembers to use and a subscription they keep.
--
-- Owned by the ORGANISATION (migrations/0004), like keys and billing: a
-- monitor outlives the member who created it.
--
-- schedule       "daily" | "weekly". The Cron Trigger fires once a day and
--                the scheduled handler decides which monitors are due, so
--                adding a cadence later means a new value here and a new
--                branch in isDue() — not a second cron entry.
--
-- last_result_hash
--                Hash of the last run's advisory-identity set. A cheap
--                "nothing at all changed" short-circuit: equal hash means
--                skip the diff and send nothing.
--
-- last_advisory_ids
--                JSON array of the advisory identities seen last run. THIS
--                is what makes "alert only on what's new" possible — a hash
--                can say something changed but not what, and sending the
--                whole list because the hash moved is exactly the nightly
--                repetition this feature exists to avoid. NULL means the
--                monitor has never completed a run; its first run reports
--                everything it finds as a baseline.
--
-- paused_at      NULL = active. Pausing keeps the row (and its diff
--                baseline) so resuming doesn't re-alert on everything the
--                org already saw.
--
-- Apply with:
--   wrangler d1 execute algosize --file=migrations/0006_monitors.sql --remote

CREATE TABLE IF NOT EXISTS monitors (
  monitor_id        TEXT PRIMARY KEY,
  org_id            TEXT NOT NULL,
  repo_url          TEXT NOT NULL,
  branch            TEXT,
  schedule          TEXT NOT NULL DEFAULT 'daily',
  last_run_at       INTEGER,
  last_result_hash  TEXT,
  last_advisory_ids TEXT,
  created_by        TEXT,
  created_at        INTEGER NOT NULL,
  paused_at         INTEGER
);

-- The scheduled sweep reads "every monitor, oldest run first"; the API reads
-- "this org's monitors". Both are covered here.
CREATE INDEX IF NOT EXISTS idx_monitors_org ON monitors (org_id);
CREATE INDEX IF NOT EXISTS idx_monitors_due ON monitors (paused_at, last_run_at);

-- One monitor per repo+branch per org. Re-adding the same target is a
-- no-op-shaped 409 rather than a second row that doubles the email volume
-- and splits the diff baseline in two.
CREATE UNIQUE INDEX IF NOT EXISTS idx_monitors_unique_target
  ON monitors (org_id, repo_url, IFNULL(branch, ''));
