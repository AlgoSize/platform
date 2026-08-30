-- Multi-model fix pipeline — model routing configuration.
--
-- The 5-stage pipeline (triage → validate → ensemble → fix → verify) picks a
-- model per stage. The code default comes from the recommendation engine
-- (worker/src/ai/models.js); this table lets an operator OVERRIDE the routing
-- for a specific (stage, cwe_family, file_language, complexity) key WITHOUT a
-- code deploy — the brief's "model routing stored in a config table" rule.
--
-- Versioned like pricing and margin: a routing change is a NEW row (close the
-- old one's effective_to, insert a new one), never a mutation. effective_to
-- IS NULL means currently active. A '*' (or NULL) in a key column is a
-- wildcard; the resolver prefers the most specific match.
--
-- model_id is a slug that MUST exist in the recommendation registry — the
-- resolver does not invent models, and an override naming an unpriced slug
-- would meter as unpriced (null cost, never $0), the same discipline the rest
-- of the metering system runs on.

CREATE TABLE IF NOT EXISTS model_routing_config (
  id             TEXT    PRIMARY KEY,
  stage          TEXT    NOT NULL,          -- triage | validate | ensemble | fix | verify | embed | rerank
  cwe_family     TEXT    NOT NULL DEFAULT '*',  -- injection | auth | crypto | ... | '*'
  file_language  TEXT    NOT NULL DEFAULT '*',  -- javascript | python | ... | '*'
  complexity     TEXT    NOT NULL DEFAULT '*',  -- single_file | multi_file | '*'
  model_id       TEXT    NOT NULL,          -- @cf/... slug; must exist in ai/models.js
  provider       TEXT    NOT NULL DEFAULT 'workers-ai',
  note           TEXT,
  effective_from INTEGER NOT NULL DEFAULT 0,
  effective_to   INTEGER,                   -- NULL = currently active
  created_by     TEXT,
  created_at     INTEGER NOT NULL DEFAULT 0
);

-- Resolver reads by stage first, then narrows by the wildcards; this index
-- serves the active-row lookup.
CREATE INDEX IF NOT EXISTS idx_model_routing_active
  ON model_routing_config(stage, effective_to);

-- The table ships EMPTY on purpose: with no rows, every stage falls back to
-- the recommendation engine, which is the intended default. Seeding a row
-- here would freeze a model choice that recommend() is meant to keep current
-- as the registry evolves. Operators add rows only to deliberately override.
