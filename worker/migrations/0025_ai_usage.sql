-- AI usage metering (Workers AI billing foundation).
--
-- One row per LLM call. Neurons are Cloudflare's billing unit and the
-- reconciliation truth; tokens are carried for product-side visibility when a
-- model exposes a token mapping; USD is derived from Neurons × the versioned
-- rate in worker/src/ai/pricing.js.
--
-- Nullable token/cost columns are deliberate and load-bearing: a call whose
-- Neurons or cost could not be measured (unverified/unpriced model) stores
-- NULL, never 0 — the schema-level expression of "unmeasured is not free."
--
-- Every read of this table MUST filter org_id first, matching the platform's
-- standing tenant-isolation rule. Prompts and completions are NEVER stored —
-- request_metadata holds correlation keys only, not content.

CREATE TABLE IF NOT EXISTS ai_usage (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id               TEXT    NOT NULL,
  user_id              TEXT,                 -- NULL for system/cron calls
  repository_id        TEXT,                 -- workspace/repo, when the call is repo-scoped
  feature_name         TEXT    NOT NULL,     -- enum: optimizer_refactor | advisory_fix | fix_proposal | fix_explain | fix_risk | fix_compare
  provider             TEXT    NOT NULL,     -- workers-ai | workers-ai-gateway | anthropic | openai
  model                TEXT,
  request_type         TEXT,                 -- chat | embedding | rerank | image | audio | ...

  input_tokens         INTEGER,              -- NULL when the provider did not report usage
  output_tokens        INTEGER,
  cached_input_tokens  INTEGER,
  units                REAL,                 -- generalized unit count for non-token models (images, audio-seconds)

  neurons_consumed     REAL,                 -- NULL when unmeasured; the reconciliation quantity
  neurons_source       TEXT,                 -- reported | estimated | none
  unit_cost            REAL,                 -- USD per 1,000 Neurons in effect at the time (for reconciliation)
  total_cost           REAL,                 -- RAW Cloudflare cost. NULL when unmeasured; NEVER 0 for an unpriced call
  currency             TEXT    DEFAULT 'USD',
  price_verified       INTEGER DEFAULT 0,    -- 0 = rate was unverified when this row was written

  -- Algosize platform margin, computed at write time (see worker/src/ai/margin.js).
  -- total_cost is the raw Cloudflare cost; algosize_price is what Algosize bills.
  -- All NULL when total_cost is NULL (unmeasured stays unmeasured through the margin).
  margin_rate            REAL,               -- the rate in effect when this row was written
  platform_margin_cost   REAL,               -- total_cost * margin_rate (0 for internal orgs)
  algosize_price         REAL,               -- total_cost + platform_margin_cost (what the customer is billed)
  margin_version         TEXT,               -- the margin_config.id used, so a rate change never reprices history

  latency_ms           INTEGER,
  status               TEXT    NOT NULL,     -- ok | error | fallback
  error_code           TEXT,
  fallback_provider    TEXT,                 -- set when this call succeeded only after another provider failed
  fallback_model       TEXT,

  scan_id              TEXT,                 -- correlation, nullable
  fix_task_id          TEXT,
  request_metadata     TEXT,                 -- JSON: correlation keys only, NEVER prompt/response content

  created_at           INTEGER NOT NULL
);

-- Reads are org-first, usually windowed by time; this index serves the
-- dashboard's per-org and trend queries.
CREATE INDEX IF NOT EXISTS idx_ai_usage_org      ON ai_usage(org_id, created_at);
-- Per-feature and per-model rollups within an org.
CREATE INDEX IF NOT EXISTS idx_ai_usage_feature  ON ai_usage(org_id, feature_name, created_at);
CREATE INDEX IF NOT EXISTS idx_ai_usage_model    ON ai_usage(org_id, model, created_at);

-- ---------------------------------------------------------------------------
-- Platform margin configuration — versioned so the rate can change without a
-- deploy, and a change never reprices history.
-- ---------------------------------------------------------------------------
--
-- The active rate for a category is the row with effective_to IS NULL. Changing
-- the rate is non-destructive: close the current row (set effective_to = now)
-- and insert a new one. Every ai_usage row records the margin_config.id it used
-- (ai_usage.margin_version), so old rows keep the rate they were billed at.
CREATE TABLE IF NOT EXISTS margin_config (
  id             TEXT    PRIMARY KEY,
  margin_rate    REAL    NOT NULL,           -- e.g. 0.25 for 25%
  description    TEXT,
  applies_to     TEXT    NOT NULL DEFAULT 'workers_ai',  -- workers_ai | all | <provider>
  effective_from INTEGER NOT NULL,
  effective_to   INTEGER,                    -- NULL = currently active
  created_by     TEXT,
  created_at     INTEGER  NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_margin_config_active ON margin_config(applies_to, effective_to);

-- Seed the default 25% platform margin on Workers AI consumption.
INSERT OR IGNORE INTO margin_config (id, margin_rate, description, applies_to, effective_from, effective_to, created_by, created_at)
VALUES ('mc_default_v1', 0.25, 'Algosize platform margin on Cloudflare Workers AI consumption', 'workers_ai', 0, NULL, 'system', 0);

-- Internal Algosize orgs are exempt from the margin (billed at raw cost).
ALTER TABLE organisations ADD COLUMN is_internal INTEGER DEFAULT 0;
