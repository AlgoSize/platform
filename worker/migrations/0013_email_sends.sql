-- 0013 — outbound transactional email.
--
-- sendTransactional already distinguishes sent / not_configured / send_failed
-- and then discards the answer. That third state is the expensive one: an
-- unconfigured mailer no-ops silently, which is exactly how the magic-link
-- outage earlier in this project stayed invisible — every send "succeeded" by
-- doing nothing at all.
--
-- Storing `reason` verbatim from sendTransactional keeps the admin panel and
-- the code speaking the same vocabulary; the panel renders not_configured
-- differently from failed for the same reason the return value distinguishes
-- them.
--
-- No body is stored. These messages carry sign-in links and billing details,
-- and a log that reproduces them is a second place to leak them from.
CREATE TABLE IF NOT EXISTS email_sends (
  send_id     TEXT PRIMARY KEY,
  recipient   TEXT NOT NULL,
  template    TEXT NOT NULL,
  org_id      TEXT,
  outcome     TEXT NOT NULL,
  reason      TEXT,
  sent_at     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_email_sent ON email_sends (sent_at DESC);
