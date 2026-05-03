-- D1 schema for the algosize Worker (Task #25).
--
-- Replaces the user records previously stored under USERS KV
--   user:<userId>   →  full JSON
--   email:<email>   →  userId index
--   cust:<custId>   →  userId index
-- and the run history previously stored under RUNS KV
--   run:<userId>:<runId>  →  full JSON (90-day TTL)
--   runs:<userId>         →  newest-first id list, capped at 100
--
-- SESSIONS KV stays (rotating session JWTs + Stripe-event dedup), and
-- USERS KV stays for the monthly quota counters at quota:<userId>:<YYYY-MM>
-- (high write rate, perfect KV workload). Everything else is in D1.
--
-- Apply with:
--   wrangler d1 execute algosize --file=migrations/0001_init.sql --remote
-- See DEPLOY.md §2.5.

CREATE TABLE IF NOT EXISTS users (
  user_id            TEXT PRIMARY KEY,
  email              TEXT NOT NULL UNIQUE,
  -- NULL for free users. UNIQUE allows multiple NULLs in SQLite/D1, so we
  -- can have many free users without needing a sentinel value.
  stripe_customer_id TEXT UNIQUE,
  -- "free" | "paid". Free signups (no Stripe) start at 'free'; a Stripe
  -- checkout flips them to 'paid' via upsertUserFromCheckout.
  plan               TEXT NOT NULL DEFAULT 'free',
  -- "active" | "inactive" | NULL. NULL = no subscription on file (free tier).
  sub_status         TEXT,
  -- Unix epoch SECONDS, set once at insert.
  created_at         INTEGER NOT NULL,
  -- Unix epoch SECONDS, bumped on every UPDATE.
  updated_at         INTEGER NOT NULL
);

-- The UNIQUE constraints above already create implicit indexes; the explicit
-- ones below are belt-and-braces in case someone drops the UNIQUE later.
CREATE INDEX IF NOT EXISTS idx_users_email
  ON users (email);
CREATE INDEX IF NOT EXISTS idx_users_customer
  ON users (stripe_customer_id);

CREATE TABLE IF NOT EXISTS runs (
  -- runId is `<13-digit ts ms>_<8 hex chars>` — see runs.js newRunId().
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  -- 'cost' | 'vuln' | 'algo'
  analyzer    TEXT NOT NULL,
  -- JSON-encoded original input (or {_omitted:true,reason} marker if oversized).
  input_json  TEXT,
  -- JSON-encoded analyzer result.
  result_json TEXT,
  -- Wall time of the analyzer in milliseconds (REAL since values are
  -- sub-millisecond for tiny inputs).
  ms          REAL,
  -- Pre-computed one-line summary used by the dashboard list view.
  headline    TEXT,
  -- Unix epoch MILLISECONDS (Date.now()). Kept in ms because that's what
  -- the analyzer pipeline natively uses; readers that need the 90-day cutoff
  -- compute `Date.now() - 90*86400*1000` and filter on this column.
  created_at  INTEGER NOT NULL
  -- No FK to users(user_id) on purpose. The auth pipeline guarantees the
  -- user exists before persistRun runs, and a hard FK would (a) make the
  -- D1 stub tests churn (every test would have to seed a user first),
  -- and (b) prevent us from keeping orphaned history rows when a user
  -- record is hard-deleted for GDPR — we'd rather scrub run rows
  -- explicitly via a cleanup task than have CASCADE silently nuke them.
);

-- Pagination index: dashboard list = "WHERE user_id = ? ORDER BY created_at DESC".
CREATE INDEX IF NOT EXISTS idx_runs_user_created
  ON runs (user_id, created_at DESC);
