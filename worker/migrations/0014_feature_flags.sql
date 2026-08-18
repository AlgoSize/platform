-- 0014 — feature flags.
--
-- Small on purpose. This is a two-person team's flag system: a key, on/off,
-- and an optional rollout percentage. No targeting rules, no segments, no
-- audiences — those need a product to justify them, and adding them now would
-- be building a worse LaunchDarkly nobody asked for.
--
-- rollout_pct is 0-100 and only consulted when enabled = 1, so turning a flag
-- off is one field rather than "set the percentage to zero", which reads
-- ambiguously in a list (is 0% off, or is it on-but-nobody?).
--
-- updated_by is stored because a flag flip is exactly the kind of change
-- someone will need to attribute at 3am. It is also written to audit_log; this
-- column answers "who last touched it" without a join.
CREATE TABLE IF NOT EXISTS feature_flags (
  flag_key    TEXT PRIMARY KEY,
  enabled     INTEGER NOT NULL DEFAULT 0,
  rollout_pct INTEGER NOT NULL DEFAULT 100,
  description TEXT,
  updated_by  TEXT,
  updated_at  INTEGER NOT NULL
);
