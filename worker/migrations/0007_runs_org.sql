-- Runs belong to the organisation, not only to the user who started them.
--
-- Every other billable thing moved to the org in migrations/0004 — the Stripe
-- customer, seats, API keys, and later monitors. Run history did not, and that
-- gap is what blocks CI ingestion: a request authenticated by an API key has
-- `request.org` and no `request.user` at all (see requireAuth in src/auth.js),
-- so there is no user id to file its run under.
--
-- `runs.user_id` was declared NOT NULL in 0001, so a CI run could not be
-- inserted at all. SQLite cannot drop a NOT NULL constraint in place, which is
-- why this is a full table rebuild rather than a pair of ALTERs. The rebuild
-- is the standard create-copy-drop-rename dance and is safe to run once; the
-- local adapter records applied migrations so boot stays idempotent.
--
-- New columns:
--   org_id   The organisation the run belongs to. Backfilled from the runner's
--            oldest membership, which for every pre-0004 account is the
--            personal org the backfill created — so existing rows keep exactly
--            the visibility they had.
--   source   "ci" for the ingestion endpoint, NULL for a dashboard run. A
--            column rather than something inferred from the payload shape, so
--            the dashboard can filter without parsing every stored result.
--
-- user_id survives and still records WHO ran it, which is worth showing on a
-- team. It is now nullable because a CI run has no human behind it.
--
-- VISIBILITY CHANGE, deliberate: /api/runs now lists the ORG's runs rather
-- than only the caller's own. On a single-member org (every account that
-- existed before 0004) that is identical. On a team it means members see each
-- other's scans — which is the point, since a CI run belongs to nobody in
-- particular and would otherwise be invisible to everyone.
--
-- Apply with:
--   wrangler d1 execute algosize --file=migrations/0007_runs_org.sql --remote

CREATE TABLE IF NOT EXISTS runs_v2 (
  id          TEXT PRIMARY KEY,
  -- Nullable now: a CI run authenticates as the org, not as a person.
  user_id     TEXT,
  org_id      TEXT,
  source      TEXT,
  analyzer    TEXT NOT NULL,
  input_json  TEXT,
  result_json TEXT,
  ms          REAL,
  headline    TEXT,
  created_at  INTEGER NOT NULL,
  -- Same documentation-only FK as 0001: D1 does not enforce foreign keys
  -- unless `PRAGMA foreign_keys = ON`, and we deliberately leave it off so a
  -- user delete does not cascade away their run history.
  FOREIGN KEY (user_id) REFERENCES users(user_id)
);

-- Copy every existing row, resolving each runner's org as we go.
INSERT INTO runs_v2 (id, user_id, org_id, source, analyzer, input_json, result_json, ms, headline, created_at)
SELECT
  r.id,
  r.user_id,
  (SELECT m.org_id
     FROM memberships m
    WHERE m.user_id = r.user_id
    ORDER BY m.created_at ASC
    LIMIT 1),
  NULL,
  r.analyzer,
  r.input_json,
  r.result_json,
  r.ms,
  r.headline,
  r.created_at
FROM runs r;

DROP TABLE runs;
ALTER TABLE runs_v2 RENAME TO runs;

-- Both read paths. The org index serves the dashboard list; the user index
-- stays because a row whose org could not be resolved is still read back
-- through user_id (see listRuns in src/handlers/runs.js).
CREATE INDEX IF NOT EXISTS idx_runs_org_created
  ON runs (org_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_runs_user_created
  ON runs (user_id, created_at DESC);
