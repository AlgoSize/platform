-- Organisations, memberships and seats.
--
-- Until now the data model was one flat `users` table: no org, no membership,
-- no role, and checkout hardcoded quantity 1. "Licence" had nothing to refer
-- to, and the person holding the budget could not be sold to separately from
-- the person running the scans.
--
-- After this migration the ORGANISATION is the billing subject. `stripe_customer_id`,
-- `plan`, `sub_status` and `current_period_end` on `organisations` are the
-- authoritative copies; src/entitlement.js reads them and nothing else.
--
-- The same columns still exist on `users`. They are left in place so the
-- backfill below is reversible and so nothing that reads a user row breaks
-- mid-deploy, but they are now DEAD for entitlement purposes: the Stripe
-- webhook writes to organisations, and no code path decides access from
-- users.plan any more. Treat them as a snapshot of the pre-migration state.
-- Dropping them is a follow-up once this has been live for a cycle.
--
-- Apply with:
--   wrangler d1 execute algosize --file=migrations/0004_orgs.sql --remote
--
-- Run it once. SQLite has no ADD COLUMN IF NOT EXISTS, so re-running errors on
-- the ALTER; the local adapter tracks applied files in `_migrations`.

CREATE TABLE IF NOT EXISTS organisations (
  org_id             TEXT PRIMARY KEY,
  name               TEXT NOT NULL,
  -- NULL until the org goes through checkout. UNIQUE permits many NULLs in
  -- SQLite/D1, so every free org can coexist without a sentinel value.
  stripe_customer_id TEXT UNIQUE,
  -- "free" | "paid". Same vocabulary as users.plan had.
  plan               TEXT NOT NULL DEFAULT 'free',
  -- Stripe's own subscription status verbatim: "active" | "trialing" |
  -- "past_due" | "canceled" | "unpaid" | "incomplete" | … | NULL.
  -- src/entitlement.js owns the mapping from this to what we serve.
  sub_status         TEXT,
  -- Unix epoch SECONDS. Paid-through date; entitlement grants a cancelled or
  -- past-due org the remainder of it. See migrations/0002.
  current_period_end INTEGER,
  -- Seats bought from Stripe (the subscription's line-item quantity). The
  -- invite path refuses to let membership exceed it.
  seats_purchased    INTEGER NOT NULL DEFAULT 1,
  price_id           TEXT,
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_orgs_customer ON organisations (stripe_customer_id);

CREATE TABLE IF NOT EXISTS memberships (
  org_id     TEXT NOT NULL,
  user_id    TEXT NOT NULL,
  -- owner:  billing + everything an admin can do. Cannot be removed.
  -- admin:  invite and remove members.
  -- member: use the product, see the org, change nothing.
  role       TEXT NOT NULL CHECK (role IN ('owner','admin','member')),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (org_id, user_id)
);

-- Seat counting is "how many members does this org have", so the org-first
-- PRIMARY KEY already serves it. This index serves the other direction:
-- "which orgs does this user belong to", used on every entitlement resolve.
CREATE INDEX IF NOT EXISTS idx_memberships_user ON memberships (user_id, created_at);

-- Which org a user's requests act as. NULL is tolerated — entitlement falls
-- back to their oldest membership — but the backfill sets it for everyone.
ALTER TABLE users ADD COLUMN active_org_id TEXT;

-- ---------------------------------------------------------------------------
-- Backfill: every existing user gets a personal org they own, and that org
-- inherits their plan, subscription status, paid-through date and Stripe
-- customer. Nobody loses access, and nobody gains any.
--
-- org_id is 'org_' || user_id rather than a fresh random id so the backfill is
-- deterministic and re-derivable: given a user row you can compute the org it
-- was given without consulting this migration's output. It produces ids like
-- `org_usr_a1b2…`, which is uglier than the `org_…` shape newOrgId() mints for
-- orgs created from here on. That is a deliberate trade — deriving from the
-- primary key is the only form that CANNOT collide, and a migration that might
-- trip a UNIQUE constraint on live data is a worse outcome than an ugly id.
-- ---------------------------------------------------------------------------

INSERT INTO organisations
  (org_id, name, stripe_customer_id, plan, sub_status, current_period_end,
   seats_purchased, price_id, created_at, updated_at)
SELECT
  'org_' || user_id,
  email,                    -- personal orgs are named for their owner until renamed
  stripe_customer_id,
  plan,
  sub_status,
  current_period_end,
  1,                        -- one seat: exactly what they have today
  price_id,
  created_at,
  updated_at
FROM users;

INSERT INTO memberships (org_id, user_id, role, created_at)
SELECT 'org_' || user_id, user_id, 'owner', created_at
FROM users;

UPDATE users SET active_org_id = 'org_' || user_id;
