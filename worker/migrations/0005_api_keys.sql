-- API keys for machine access — CI, scheduled jobs, and anything else that
-- needs to call the scanner without a human present to click through a
-- magic-link sign-in.
--
-- Format: ask_live_<32 bytes, base64url>. We store ONLY sha256(key) — the
-- plaintext key exists nowhere at rest, including in this table. It is shown
-- to the caller exactly once, in the POST /api/keys response, and the
-- response says so; if it's lost, the only recovery is revoking the row and
-- minting a new one.
--
-- prefix is the first 16 characters of the full key (e.g. "ask_live_AbCdEf")
-- — enough for a human to recognise which key is which in a list, nowhere
-- near enough entropy to reconstruct or brute-force the rest.
--
-- Ownership follows the ORGANISATION, not the user who created the key
-- (migrations/0004): a key authenticates AS the org, the same way the Stripe
-- subscription belongs to the org rather than to whoever bought it. A member
-- who creates a key and later leaves the org does not orphan it.
--
-- revoked_at NULL = live. Keys are never deleted — a revoked row stays
-- listed (name, prefix, revoked_at) so "who had access and when" survives
-- the revocation, which is the question a security incident review asks.
--
-- Apply with:
--   wrangler d1 execute algosize --file=migrations/0005_api_keys.sql --remote

CREATE TABLE IF NOT EXISTS api_keys (
  key_id       TEXT PRIMARY KEY,
  org_id       TEXT NOT NULL,
  name         TEXT NOT NULL,
  key_hash     TEXT NOT NULL UNIQUE,
  prefix       TEXT NOT NULL,
  created_by   TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  last_used_at INTEGER,
  revoked_at   INTEGER
);

-- Every read here is "keys for this org" (GET /api/keys) or a single
-- key_hash point lookup (requireAuth, already covered by the UNIQUE index).
CREATE INDEX IF NOT EXISTS idx_api_keys_org ON api_keys (org_id);
