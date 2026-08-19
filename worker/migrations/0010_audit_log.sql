-- 0010 — the admin audit log.
--
-- Until now nothing recorded who did what. `runs` records analyzer executions
-- and observability.js captures errors, but neither answers the question an
-- operator or an auditor actually asks: which human revoked that key, when,
-- and against which org.
--
-- Every destructive or privileged action writes one row here. The rule the
-- write sites follow: if an action would be surprising to the person it was
-- done TO, it is logged. That is why role changes and plan overrides are here
-- alongside revocations.
--
-- actor is an email rather than a user id because the reader is a human
-- scanning for a name, and admins are identified by email in ADMIN_EMAILS
-- anyway. `system` is a reserved actor for automated writes (the monitor
-- sweep, webhook-driven plan changes) so an unattended change is never
-- attributed to whoever happened to be signed in.
--
-- metadata_json holds the shape specific to each action. Deliberately schemaless:
-- a key revocation wants the key prefix, a role change wants both roles, and
-- forcing those into shared columns would produce a table that is mostly NULL.
CREATE TABLE IF NOT EXISTS audit_log (
  audit_id      TEXT PRIMARY KEY,
  actor         TEXT NOT NULL,
  actor_user_id TEXT,
  action        TEXT NOT NULL,
  target_type   TEXT,
  target_id     TEXT,
  org_id        TEXT,
  metadata_json TEXT,
  created_at    INTEGER NOT NULL
);

-- The two reads the admin panel does: the global stream (newest first) and
-- one org's slice. Both are covered rather than relying on a table scan that
-- grows with every action ever taken.
CREATE INDEX IF NOT EXISTS idx_audit_created     ON audit_log (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_org_created ON audit_log (org_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_actor       ON audit_log (actor, created_at DESC);
