-- Monitor health and schedule time (D-8).
--
-- Two problems this fixes, both of which make the Monitors screen lie today.
--
-- 1. HEALTH IS NOT PERSISTED. The sweep records a run only when the audit
--    SUCCEEDS. A monitor whose repo has no supported lockfile fails every
--    night, records nothing, and therefore renders forever as "baseline
--    pending" — the same state a healthy monitor shows on its first day.
--    A night that was SKIPPED (GitHub throttled) is likewise invisible, so a
--    monitor that has not actually run in a week looks identical to one that
--    swept clean last night. `last_status` and `last_error` make the four
--    outcomes distinguishable:
--
--      'ok'      the sweep completed; baselines advanced
--      'failed'  it ran and failed for a reason retrying will not fix
--                (no supported lockfile, repo gone) — last_error says which
--      'skipped' transient upstream failure; baselines deliberately unchanged
--      NULL      never attempted — the honest "baseline pending"
--
--    NULL is therefore never written by a sweep, only by row creation. That
--    is what keeps "never ran" distinct from "ran and found nothing".
--
-- 2. SCHEDULE HAS NO TIME. Every monitor fires at 03:00 UTC because that is
--    when the cron fires, and `run_at_hour` did not exist. Storing the hour
--    lets isDue() hold a monitor back until its own hour has arrived, which
--    is the whole of time-of-day scheduling given a cron that already ticks
--    more often than daily. NULL means "whenever the sweep runs", i.e. the
--    behaviour every existing row has today — so this column is additive and
--    no backfill is needed.

ALTER TABLE monitors ADD COLUMN last_status TEXT;
-- When the sweep last ATTEMPTED this monitor, as opposed to last_run_at which
-- is when it last produced a result. The gap between the two is exactly how
-- long a monitor has been failing or being skipped, which is what the "stale"
-- state on the Monitors screen measures.
ALTER TABLE monitors ADD COLUMN last_attempt_at INTEGER;
ALTER TABLE monitors ADD COLUMN last_error TEXT;
ALTER TABLE monitors ADD COLUMN run_at_hour INTEGER;

-- 3. THE SCORECARD HAS NOTHING TO GRADE. last_advisory_ids stores identity
--    keys (`id/ecosystem/package`) and nothing else, so the stored baseline
--    can say HOW MANY advisories a repo has but not how bad they are. A
--    security column that reads "6" beside a column that reads "0" is not a
--    grade: one critical and five lows is a very different repository from
--    six lows, and the audit's own grading rules (analyzers/audit.js) turn
--    entirely on the severity mix.
--
--    So the run persists the per-severity tally alongside the identity set.
--    JSON, matching the other baseline columns, shaped
--    {"critical":n,"high":n,"medium":n,"low":n,"unknown":n}. NULL means no
--    run has recorded severities — rendered as "pending", never as a clean
--    grade.
ALTER TABLE monitors ADD COLUMN last_severity_json TEXT;
