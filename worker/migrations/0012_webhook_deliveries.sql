-- 0012 — inbound Stripe webhook deliveries.
--
-- The webhook handler is the only thing that writes subscription state back,
-- and it was completely unobservable: a failing or duplicate delivery left no
-- trace, so "this customer paid but is still showing past_due" had no
-- diagnostic path short of the Stripe dashboard.
--
-- `outcome` is the handler's own verdict, not the HTTP status: processed,
-- duplicate (idempotency hit), ignored (event type we don't handle), or
-- failed. Those four are different facts and collapsing them into 200/500
-- loses the one that matters most — a duplicate is a SUCCESS that did nothing,
-- which is the correct behaviour and must not read as a problem.
CREATE TABLE IF NOT EXISTS webhook_deliveries (
  delivery_id   TEXT PRIMARY KEY,
  event_id      TEXT,
  event_type    TEXT NOT NULL,
  org_id        TEXT,
  outcome       TEXT NOT NULL,
  error_message TEXT,
  received_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_webhook_received ON webhook_deliveries (received_at DESC);
