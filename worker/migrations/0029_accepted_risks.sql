-- 0029: accepted risks — a named person signing for a finding that will not be fixed.
--
-- Apply with:
--   wrangler d1 execute algosize --config wrangler.toml --env production \
--     --remote --file=migrations/0029_accepted_risks.sql
--
-- ---------------------------------------------------------------------------
-- WHY THIS TABLE EXISTS
-- ---------------------------------------------------------------------------
-- The scanner had no suppression of any kind: no inline ignore, no baseline
-- file, no allowlist. That is a defensible starting point and an untenable
-- ending one. Some true positives cannot be fixed — this product's own
-- optimizer sandbox compiles user code with `new Function`, which IS the
-- feature — and a scanner that offers no answer but "fix it" teaches its users
-- to stop reading it. Every finding then costs the same as the real one.
--
-- So: accept it, in writing, with a name against it and a date it runs out.
--
-- ---------------------------------------------------------------------------
-- WHAT KEEPS THIS FROM BECOMING A WAY TO MAKE THE SCANNER LIE
-- ---------------------------------------------------------------------------
--   * Nothing is deleted. An accepted finding is still found, still listed,
--     still exported. It moves out of the OPEN count and nowhere else.
--   * `expires_at` is NOT NULL and capped at a year. Enforced read-side, so
--     stale rows cannot outlive their expiry no matter what wrote them.
--   * `owner_email` is NOT NULL — stricter than compliance_attestations, where
--     it is optional. An attestation is a claim about a control; this is a
--     person saying they will carry a risk. Anonymous acceptance is the thing
--     to prevent.
--   * Secrets and dependency advisories can never be accepted. Refused at the
--     API and re-checked at read time; see risk/accept.js.
--   * The acceptance is never written into a stored run result. It is applied
--     on every read, so a revocation reaches all history at once and there is
--     nothing stored to bypass.
--
-- Timestamps are unix SECONDS, matching 0028 and the rest of the compliance
-- tables (runs.created_at is milliseconds; this is not that).

CREATE TABLE IF NOT EXISTS accepted_risks (
  id            TEXT PRIMARY KEY,
  org_id        TEXT NOT NULL,

  -- owner/name, lowercased (src/repo-key.js). Never null: a scan of pasted
  -- content belongs to no repository, so no acceptance can apply to it.
  repo_key      TEXT NOT NULL,

  -- The registry rule id, e.g. sast.code-injection.eval. Never a raw `type`:
  -- the registry id is the stable public name.
  rule_id       TEXT NOT NULL,
  path          TEXT NOT NULL,

  -- The witness. An EXACT match on (rule_id, path, fingerprint) is what grants
  -- acceptance. A match on (rule_id, path) alone is reported as DRIFTED — the
  -- finding stays open, and the reader is told an acceptance was signed here
  -- and the code has since changed. The loose half never grants anything; it
  -- exists so a signed decision leaves a sentence behind instead of silently
  -- reappearing. Fingerprints are computed from the MASKED snippet and are not
  -- line-keyed, so an acceptance survives the code moving down the file.
  fingerprint   TEXT NOT NULL,

  -- Frozen at signing time. `category` is re-checked against the ban list on
  -- read; `severity` ratchets one way — an acceptance covers a finding that
  -- got quieter, never one that got louder.
  category      TEXT NOT NULL,
  severity      TEXT NOT NULL,

  rationale     TEXT NOT NULL,
  owner_email   TEXT NOT NULL,
  document_url  TEXT,
  accepted_by   TEXT,
  accepted_at   INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL,
  revoked_at    INTEGER,
  revoked_by    TEXT,

  -- What the rule meant when this was signed. Same purpose as
  -- compliance_attestations.catalog_version: a rule's meaning can change, and
  -- an acceptance signed against the old meaning should be visibly old.
  analyzer_version TEXT,

  -- Correlation only, like scan_patches.run_id. Never a join key: the
  -- acceptance outlives the run that surfaced it.
  run_id        TEXT
);

-- The read path: every scan asks "what is accepted for this org, this repo".
CREATE INDEX IF NOT EXISTS idx_accepted_risks_match
  ON accepted_risks (org_id, repo_key, rule_id, path, revoked_at);

-- The expiry sweep, which notifies and never mutates.
CREATE INDEX IF NOT EXISTS idx_accepted_risks_expiry
  ON accepted_risks (expires_at, revoked_at);

-- The register as a list, newest first.
CREATE INDEX IF NOT EXISTS idx_accepted_risks_org
  ON accepted_risks (org_id, accepted_at DESC);
