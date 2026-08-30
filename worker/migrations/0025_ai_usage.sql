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
  total_cost           REAL,                 -- NULL when unmeasured; NEVER 0 for an unpriced call
  currency             TEXT    DEFAULT 'USD',
  price_verified       INTEGER DEFAULT 0,    -- 0 = rate was unverified when this row was written

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
