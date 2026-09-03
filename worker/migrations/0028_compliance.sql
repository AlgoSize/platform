-- 0028_compliance.sql — attestations and frozen audit records.
--
-- Three tables behind the Compliance & Release Audit page.
--
-- Apply with:
--   wrangler d1 execute algosize --file=migrations/0028_compliance.sql --remote
--
-- ---------------------------------------------------------------------------
-- Why anything is stored here at all
-- ---------------------------------------------------------------------------
-- The coverage map is computed live from runs and needs no schema. Two things
-- cannot be:
--
--   1. An attestation is a human's claim about a control no analyzer can see.
--      It has an owner, a document and an end date, and it belongs to the
--      organisation rather than to any one scan.
--
--   2. A published audit must outlive its own evidence. Runs stop being
--      readable after 90 days (handlers/runs.js:41) and architecture snapshots
--      are hard-deleted at the same age (arch/snapshots.js:305), while an
--      auditor works over twelve months. So publishing DENORMALIZES: each
--      control's title, text, verdict and the concrete numbers asserted are
--      copied into compliance_audit_controls as self-describing prose. The
--      frozen row is what the page and the download read from. It survives the
--      run TTL, and bumping CATALOG_VERSION cannot retroactively rewrite what
--      a published pack said.
--
-- ---------------------------------------------------------------------------
-- Units
-- ---------------------------------------------------------------------------
-- Every timestamp here is UNIX SECONDS, matching audit_log and monitors.
-- `runs.created_at` is the outlier at milliseconds; the compliance collectors
-- convert once, at the query (compliance/evidence.js).

-- ---------------------------------------------------------------------------
-- Attestations
-- ---------------------------------------------------------------------------
-- expires_at is NOT NULL on purpose. A perpetual attestation is the mechanism
-- by which an evidence product goes stale without anyone noticing: it was true
-- when it was signed, nobody revisits it, and it keeps rendering green for
-- years. Forcing an end date means a claim either gets renewed by someone who
-- still believes it, or it lapses visibly.
--
-- A `not_applicable` attestation lives here rather than in its own table
-- because scoping a control out is itself a claim somebody owns, and it should
-- expire on the same terms as any other.
CREATE TABLE IF NOT EXISTS compliance_attestations (
  id             TEXT PRIMARY KEY,
  org_id         TEXT NOT NULL,
  framework_id   TEXT NOT NULL,
  control_id     TEXT NOT NULL,
  kind           TEXT NOT NULL DEFAULT 'attested'
                 CHECK(kind IN ('attested','not_applicable')),
  statement      TEXT NOT NULL,
  owner_email    TEXT,
  document_url   TEXT,
  attested_by    TEXT,
  attested_at    INTEGER NOT NULL,
  expires_at     INTEGER NOT NULL,
  revoked_at     INTEGER,
  revoked_by     TEXT,
  -- The catalog version the signer was reading when they signed. A later
  -- rewording of the control does not silently re-point their signature.
  catalog_version TEXT
);

-- The read path: "the live attestation for this control on this org".
CREATE INDEX IF NOT EXISTS idx_compliance_att_control
  ON compliance_attestations (org_id, framework_id, control_id, revoked_at);

-- The sweep path: "what is expiring".
CREATE INDEX IF NOT EXISTS idx_compliance_att_expiry
  ON compliance_attestations (expires_at, revoked_at);

-- ---------------------------------------------------------------------------
-- Audits
-- ---------------------------------------------------------------------------
-- status: draft is computed live and holds no frozen rows; published is frozen
-- and immutable; superseded is a published audit that a correction replaced.
--
-- Corrections SUPERSEDE rather than edit. An evidence record whose past can be
-- rewritten is not an evidence record, and "we corrected it" is a fact an
-- auditor is entitled to see rather than one to be tidied away.
--
-- retain_until defaults to period_end + 365 days and is set at publish. Nothing
-- in the compliance path may prune a row before it.
CREATE TABLE IF NOT EXISTS compliance_audits (
  id                TEXT PRIMARY KEY,
  org_id            TEXT NOT NULL,
  -- The watch whose repository this audit is about. Runs carry no repo column,
  -- so the monitor is what ties an audit to a codebase.
  monitor_id        TEXT,
  repo_url          TEXT,
  framework_id      TEXT NOT NULL,
  framework_version TEXT,
  catalog_version   TEXT NOT NULL,
  title             TEXT,
  period_start      INTEGER NOT NULL,
  period_end        INTEGER NOT NULL,
  status            TEXT NOT NULL DEFAULT 'draft'
                    CHECK(status IN ('draft','published','superseded')),
  -- Counts only — never a percentage. See resolve.js summarize().
  summary_json      TEXT,
  -- SHA-256 over the canonical frozen JSON, shown in the UI so a recipient can
  -- verify the file they were sent is the file that was published.
  pack_sha256       TEXT,
  pack_bytes        INTEGER,
  retain_until      INTEGER NOT NULL,
  superseded_by     TEXT,
  created_by        TEXT,
  created_at        INTEGER NOT NULL,
  published_at      INTEGER
);

CREATE INDEX IF NOT EXISTS idx_compliance_audits_org
  ON compliance_audits (org_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_compliance_audits_retain
  ON compliance_audits (retain_until);

-- ---------------------------------------------------------------------------
-- Frozen control rows
-- ---------------------------------------------------------------------------
-- One row per control per published audit. Denormalized on purpose: control_
-- title and control_text are the framework's wording as of catalog_version, and
-- evidence_json holds the concrete numbers asserted, so the row still reads as
-- a complete sentence long after the run behind it has aged out.
--
-- evidence_json is REDACTED at freeze time: rule ids, CWE and OWASP mappings,
-- confidence, language, fingerprint, file and line survive; the matched source
-- snippet never does. That keeps the standing source-free rule from
-- 0027_scan_patches.sql and makes a pack safe to hand a third party.
CREATE TABLE IF NOT EXISTS compliance_audit_controls (
  id                  TEXT PRIMARY KEY,
  audit_id            TEXT NOT NULL,
  org_id              TEXT NOT NULL,
  control_id          TEXT NOT NULL,
  control_title       TEXT NOT NULL,
  control_text        TEXT,
  -- How we know. Never collapsed with the result below — they answer two
  -- different questions and the page renders them in two separate columns.
  evidence_state      TEXT NOT NULL
                      CHECK(evidence_state IN ('automated','attested','not_covered')),
  -- What the answer is. A not_covered control has no meaningful result; it is
  -- stored as insufficient_evidence and excluded from every result tally.
  result              TEXT NOT NULL
                      CHECK(result IN ('met','not_met','insufficient_evidence',
                                       'not_applicable','attestation_expired')),
  evidence_json       TEXT,
  source_run_id       TEXT,
  source_analyzer     TEXT,
  source_captured_at  INTEGER,
  attestation_id      TEXT,
  attested_owner      TEXT,
  attested_expires_at INTEGER,
  document_url        TEXT,
  rationale           TEXT
);

CREATE INDEX IF NOT EXISTS idx_compliance_controls_audit
  ON compliance_audit_controls (audit_id);

CREATE INDEX IF NOT EXISTS idx_compliance_controls_org
  ON compliance_audit_controls (org_id, control_id);
