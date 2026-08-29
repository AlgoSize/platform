-- 0020 — per-subject feature flag overrides.
--
-- feature_flags (0014) is deliberately small: on/off plus a rollout
-- percentage, bucketed deterministically by hashing (flag_key, subject).
-- That is the right primitive for "roll this out to roughly N% of accounts
-- and don't play favourites" — and the wrong one for "turn this on for
-- exactly these three accounts, and no others, while everyone else stays
-- off." Percentage bucketing gives you a set you don't choose; a real pilot
-- needs a set you do.
--
-- This is that: an explicit allow/deny list, keyed by (flag_key, subject),
-- that wins over the flag's own enabled/rollout_pct state entirely — in
-- both directions. An override row with enabled=1 turns a flag on for that
-- subject even while the flag is globally off; enabled=0 turns it off for
-- that subject even while the flag is globally on or in rollout. Deleting
-- the row returns that subject to whatever the global rollout says.
--
-- Small on purpose, same as 0014: one flag, one subject, one boolean. No
-- expiry, no reason field, no approval workflow — those need a product to
-- justify them, same reasoning 0014's own header gives for not having
-- targeting rules at all. This is the smallest thing that makes "pilot with
-- our own orgs before any customer sees it" possible without gambling on a
-- hash.
CREATE TABLE IF NOT EXISTS feature_flag_overrides (
  flag_key    TEXT NOT NULL,
  -- Whatever isFlagEnabled's `subject` is for this flag — an org id today,
  -- since that is the only caller. Not constrained to org_id specifically:
  -- a future flag keyed on a different subject (a user id, say) reuses this
  -- table rather than needing its own.
  subject     TEXT NOT NULL,
  enabled     INTEGER NOT NULL,   -- 1 or 0, always explicit — never NULL
  updated_by  TEXT,
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (flag_key, subject)
);
