-- 0015 — the account-management surface.
--
-- Everything the settings area needs that the schema could not already
-- answer. Five concerns, deliberately in one migration because they ship as
-- one screen and splitting them would mean five half-usable deploys.
--
-- Apply with:
--   wrangler d1 execute algosize --file=migrations/0015_account_management.sql --remote
--
-- ---------------------------------------------------------------------------
-- 0. Who the user is
-- ---------------------------------------------------------------------------
-- Until now a user was an email address and nothing else. The account area
-- has to greet someone by name and show an avatar, and "derive initials from
-- the local part of the email" produces "D" for dana@ and "F" for
-- finance@ — which is worse than asking.
--
-- Both nullable. A user who never sets either keeps rendering from their
-- email exactly as they do today, so no backfill is needed and nobody's
-- display changes without them changing it.
--
-- avatar_url is an absolute https:// URL, validated on write and again on
-- render, for the same reason brand_logo_url is (0008): it lands in an
-- <img src> and a data:/javascript: URL there is stored XSS.
ALTER TABLE users ADD COLUMN display_name TEXT;
ALTER TABLE users ADD COLUMN avatar_url   TEXT;

-- ---------------------------------------------------------------------------
-- 1. Billing email
-- ---------------------------------------------------------------------------
-- Invoices and dunning go to a finance inbox that usually is NOT the owner's
-- login address. It lives on the ORGANISATION rather than the user because
-- the invoice belongs to the org: if the owner leaves, the finance contact
-- must not leave with them.
--
-- NULL means "use the owner's login email", which is the behaviour every
-- existing account already has. Dunning is sent to BOTH this address and the
-- owner — a finance inbox nobody reads is how a card decline becomes a lapsed
-- account, and that failure is silent by construction.
ALTER TABLE organisations ADD COLUMN billing_email TEXT;

-- ---------------------------------------------------------------------------
-- 2. Branding, beyond name + logo (extends 0008)
-- ---------------------------------------------------------------------------
-- Same rule as 0008 and for the same reason: these columns are STORED here
-- but the right to USE them is resolved at render time from the live
-- entitlement (see brandingFor in src/reports/branding.js). An org that
-- downgrades stops white-labelling on its next report, not whenever someone
-- remembers to clear a column.
--
-- brand_accent is a #rrggbb string, validated before write and again before
-- render. It is applied to buttons, badges and rules — never to severity
-- colours, because a client who could recolour "critical" could make a
-- critical finding look calm, and the report exists to prevent exactly that.
ALTER TABLE organisations ADD COLUMN brand_accent TEXT;

-- The custom hostname reports are served from, and where its verification got
-- to. Status is a small closed vocabulary rather than a boolean because
-- "not verified" covers three situations a user needs told apart: nothing
-- entered, waiting on DNS propagation, and gave up after repeated failures.
--
--   NULL       no domain set — reports serve from algosize.com/r/…
--   'pending'  entered, DNS not yet observed to point at us
--   'verified' CNAME confirmed; serving from the custom hostname
--   'failed'   checked repeatedly and did not resolve to the expected target
--
-- brand_domain_detail carries the LAST OBSERVED VALUE on a failure, so the UI
-- can say "we found northgate.netlify.app, expected cname.algosize.com".
-- "Verification failed" with no observed value tells the user nothing about
-- whether the record is missing or merely wrong, which are different fixes.
ALTER TABLE organisations ADD COLUMN brand_domain            TEXT;
ALTER TABLE organisations ADD COLUMN brand_domain_status     TEXT;
ALTER TABLE organisations ADD COLUMN brand_domain_checked_at INTEGER;
ALTER TABLE organisations ADD COLUMN brand_domain_detail     TEXT;
ALTER TABLE organisations ADD COLUMN brand_domain_attempts   INTEGER NOT NULL DEFAULT 0;

-- ---------------------------------------------------------------------------
-- 3. Pending email changes
-- ---------------------------------------------------------------------------
-- Changing the login email cannot take effect on request: the login email IS
-- the credential (magic links go to it), so accepting a new address before
-- proving control of it would let a mistyped address — or a hijacked session
-- — lock the real owner out permanently.
--
-- So the change is staged here and only applied when a token sent TO THE NEW
-- ADDRESS comes back. Until then magic links keep going to the old address,
-- and the account cannot be lost to an unfinished change.
--
-- Only the token's SHA-256 is stored. A leaked database row must not be a
-- usable account-takeover token.
--
-- One pending change per user (user_id is the primary key): starting a second
-- change replaces the first, which is what "I typed it wrong, let me redo it"
-- should do.
CREATE TABLE IF NOT EXISTS email_changes (
  user_id     TEXT PRIMARY KEY,
  new_email   TEXT NOT NULL,
  token_hash  TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_email_changes_token ON email_changes (token_hash);

-- ---------------------------------------------------------------------------
-- 4. Notification preferences
-- ---------------------------------------------------------------------------
-- One row per (user, notification, channel) that DIFFERS from the default.
-- Storing only the differences means adding a new notification type ships
-- with its intended default for everyone, instead of arriving switched off
-- for every existing user because nobody backfilled a row.
--
-- The defaults themselves live in code (src/notifications.js), not here — a
-- default is a product decision that changes, and baking one into a column
-- default would freeze it at whatever it was on migration day.
--
-- Two billing notifications cannot be silenced on email; that rule is
-- enforced in code and the write path refuses to persist a row that would
-- turn one off. It is not a CHECK constraint because the locked set is a
-- product decision that will change, and a schema migration is the wrong
-- tool for changing one's mind about it.
CREATE TABLE IF NOT EXISTS notification_prefs (
  user_id    TEXT NOT NULL,
  -- Matches an id in NOTIFICATIONS (src/notifications.js), e.g. 'scan_done'.
  pref_id    TEXT NOT NULL,
  -- 'email' | 'inapp' | 'slack'
  channel    TEXT NOT NULL CHECK (channel IN ('email','inapp','slack')),
  enabled    INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, pref_id, channel)
);

-- Where org-wide Slack notifications go. On the org, not the user: a webhook
-- belongs to a workspace the team shares, and storing one per person would
-- mean the same message posted five times.
ALTER TABLE organisations ADD COLUMN slack_webhook_url TEXT;

-- ---------------------------------------------------------------------------
-- 5. Referrals and credit
-- ---------------------------------------------------------------------------
-- Credit only. There is no payout path anywhere in this schema, and that is
-- deliberate rather than unimplemented: paying money out to customers is a
-- money-transmission question, and the product promise is a discount on an
-- Algosize invoice. Every surface that renders a balance says so.
--
-- One referral code per organisation. The code is the public half of the
-- link (algosize.com/r/<code>) so it is generated to be unguessable — an
-- attacker who could enumerate codes could attribute their own signups to
-- someone else's account.
CREATE TABLE IF NOT EXISTS referral_codes (
  org_id       TEXT PRIMARY KEY,
  code         TEXT NOT NULL UNIQUE,
  -- Signups accepted through this link in the current window, and the cap.
  -- The cap exists to catch abuse, not to limit a genuine partner: hitting it
  -- pauses the link and offers a way to ask for more, rather than silently
  -- dropping attributions.
  signups_used  INTEGER NOT NULL DEFAULT 0,
  signups_limit INTEGER NOT NULL DEFAULT 25,
  -- Unix seconds. When passed, signups_used resets to 0 and this moves on a
  -- year. Stored rather than derived so changing the window length later does
  -- not retroactively re-open every account's spent allowance.
  window_ends_at INTEGER,
  created_at    INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_referral_codes_code ON referral_codes (code);

-- One row per organisation brought in through a link.
--
-- stage is the funnel, and it only ever moves forward:
--   'invited'   the link was shared with this address (manual entry)
--   'signed_up' an account was created through the link
--   'converted' that account started paying
--   'credited'  the referrer's credit has been issued for it
--
-- The split between 'converted' and 'credited' is not bookkeeping pedantry:
-- credit is issued by a webhook that can fail, and collapsing the two would
-- make a failed issuance indistinguishable from one that never qualified.
CREATE TABLE IF NOT EXISTS referrals (
  referral_id      TEXT PRIMARY KEY,
  -- The org that gets the credit.
  referrer_org_id  TEXT NOT NULL,
  -- The org that was referred. NULL while the referral is only an email.
  referred_org_id  TEXT,
  -- Display label: the referred org's name once known, the invited address
  -- before that. Kept denormalised so the list renders without a join to a
  -- row that may since have been deleted.
  label            TEXT NOT NULL,
  stage            TEXT NOT NULL CHECK (stage IN ('invited','signed_up','converted','credited')),
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,
  -- Cents of credit issued for this referral, once it reaches 'credited'.
  credit_cents     INTEGER
);

CREATE INDEX IF NOT EXISTS idx_referrals_referrer ON referrals (referrer_org_id, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_referrals_referred ON referrals (referred_org_id);

-- The credit ledger. Append-only: a balance is the sum of its events, never a
-- column that can drift from them. Correcting a mistake means writing a
-- compensating event, which leaves the history intact and auditable.
--
-- amount_cents is SIGNED — positive when credit is earned, negative when it
-- is applied to an invoice or expires. Summing the column is the balance, so
-- there is no way to render a balance that the events do not explain.
--
-- Cents, matching Stripe's smallest-currency-unit convention, because this
-- money ends up on a Stripe customer balance and a units mismatch between the
-- two ledgers would be a silent, compounding error.
CREATE TABLE IF NOT EXISTS credit_events (
  event_id     TEXT PRIMARY KEY,
  org_id       TEXT NOT NULL,
  kind         TEXT NOT NULL CHECK (kind IN ('earned','applied','expired','adjusted')),
  amount_cents INTEGER NOT NULL,
  -- Human sentence shown verbatim in the credit history. Written at the time
  -- the event happens, so it can name the referral or invoice that caused it.
  description  TEXT NOT NULL,
  -- The referral this came from, when it came from one.
  referral_id  TEXT,
  -- Stripe's customer balance transaction id, once the credit has been pushed
  -- to Stripe. NULL means our ledger says the customer has credit but Stripe
  -- does not yet agree — a state the account API reports rather than hides.
  stripe_txn_id TEXT,
  -- When earned credit stops being spendable. NULL never expires.
  expires_at   INTEGER,
  created_at   INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_credit_events_org ON credit_events (org_id, created_at);
CREATE INDEX IF NOT EXISTS idx_credit_events_expiry ON credit_events (expires_at);
