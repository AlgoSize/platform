-- Agent-applied patch provenance (MCP handoff).
--
-- When an external agent (Claude Code, Kimi, another MCP host) fixes a finding
-- from an Algosize scan and reports the patch back through the
-- algosize_record_patch MCP tool, THIS is the record of it. It answers "an agent
-- applied a fix for finding X, at time T, and here is its content hash" —
-- enough to audit and to reconcile against a later re-scan, without becoming a
-- copy of the customer's source.
--
-- SOURCE-FREE, deliberately. The platform's standing rule (see
-- worker/src/fix/schemas.js) is that durable records hold paths, identities and
-- content HASHES, never fetched file contents or a model's rewrite of them.
-- A patch is a diff of customer source, so this table stores its hash and a
-- short, caller-provided summary — NOT the raw diff. The agent holds the
-- writable checkout and applies the patch there; the Worker records that it
-- happened. This mirrors AgentExecutionRecord exactly.
--
-- Every read MUST filter org_id first (tenant rule).

CREATE TABLE IF NOT EXISTS scan_patches (
  id            TEXT    PRIMARY KEY,
  org_id        TEXT    NOT NULL,
  run_id        TEXT,                    -- the scan run the finding came from (correlation)
  fingerprint   TEXT    NOT NULL,        -- the finding's stable fingerprint
  rule_id       TEXT,
  file_path     TEXT,
  patch_hash    TEXT,                    -- content hash of the diff the agent reported (never the diff itself)
  summary       TEXT,                    -- short, non-source description the agent supplied
  source        TEXT    NOT NULL DEFAULT 'mcp_agent',  -- mcp_agent | platform | cli
  applied_by    TEXT,                    -- actor: agent name / user email / org id
  status        TEXT    NOT NULL DEFAULT 'applied',    -- applied | proposed
  created_at    INTEGER NOT NULL
);

-- Reads are org-first; this serves "patches for this org" and "for this run".
CREATE INDEX IF NOT EXISTS idx_scan_patches_org ON scan_patches(org_id, created_at);
CREATE INDEX IF NOT EXISTS idx_scan_patches_run ON scan_patches(org_id, run_id);
-- De-dupe / lookup by the finding a patch addresses.
CREATE INDEX IF NOT EXISTS idx_scan_patches_fp  ON scan_patches(org_id, fingerprint);
