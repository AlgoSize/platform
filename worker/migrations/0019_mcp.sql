-- Migration 0019: MCP server tables
-- Applies after 0018_arch_snapshots.sql

-- Dynamic Client Registration
CREATE TABLE IF NOT EXISTS mcp_clients (
  client_id            TEXT PRIMARY KEY,
  client_secret_hash   TEXT,           -- NULL for public (PKCE-only) clients
  client_name          TEXT NOT NULL,
  redirect_uris        TEXT NOT NULL,  -- JSON array
  grant_types          TEXT NOT NULL,  -- JSON array
  scope                TEXT NOT NULL,
  created_at           INTEGER NOT NULL DEFAULT (unixepoch()),
  disabled_at          INTEGER
);

-- Short-lived authorization codes (OAuth 2.1 PKCE)
CREATE TABLE IF NOT EXISTS mcp_authorizations (
  code_hash              TEXT PRIMARY KEY,
  client_id              TEXT NOT NULL REFERENCES mcp_clients(client_id),
  org_id                 TEXT NOT NULL,
  user_id                TEXT NOT NULL,
  scope                  TEXT NOT NULL,
  code_challenge         TEXT NOT NULL,
  code_challenge_method  TEXT NOT NULL DEFAULT 'S256',
  redirect_uri           TEXT NOT NULL,
  expires_at             INTEGER NOT NULL,
  consumed_at            INTEGER
);
CREATE INDEX IF NOT EXISTS idx_mcp_auth_org ON mcp_authorizations(org_id, expires_at);

-- Access + refresh tokens
CREATE TABLE IF NOT EXISTS mcp_tokens (
  token_id         TEXT PRIMARY KEY,
  token_hash       TEXT NOT NULL UNIQUE,
  token_type       TEXT NOT NULL CHECK(token_type IN ('access', 'refresh')),
  client_id        TEXT NOT NULL REFERENCES mcp_clients(client_id),
  org_id           TEXT NOT NULL,
  user_id          TEXT,
  scope            TEXT NOT NULL,
  expires_at       INTEGER NOT NULL,
  revoked_at       INTEGER,
  last_used_at     INTEGER,
  parent_token_id  TEXT REFERENCES mcp_tokens(token_id)
);
CREATE INDEX IF NOT EXISTS idx_mcp_tokens_org  ON mcp_tokens(org_id, token_type, expires_at);
CREATE INDEX IF NOT EXISTS idx_mcp_tokens_hash ON mcp_tokens(token_hash);

-- Tool call audit log (no args, no results — they contain customer code)
CREATE TABLE IF NOT EXISTS mcp_tool_calls (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id       TEXT NOT NULL,
  tool_name    TEXT NOT NULL,
  auth_method  TEXT NOT NULL,  -- 'api_key' | 'mcp_oauth' | 'session'
  scope_used   TEXT NOT NULL,
  status       TEXT NOT NULL,  -- 'ok' | 'error' | 'quota_exceeded'
  duration_ms  INTEGER,
  run_id       TEXT,           -- FK to runs.id when the tool produced a run
  error_code   TEXT,
  created_at   INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_mcp_tool_calls_org ON mcp_tool_calls(org_id, created_at);

-- §1.10: run provenance columns
ALTER TABLE runs ADD COLUMN credential_kind TEXT CHECK(credential_kind IN ('session','api_key','mcp_oauth'));
ALTER TABLE runs ADD COLUMN credential_id   TEXT;
CREATE INDEX IF NOT EXISTS idx_runs_credential ON runs(org_id, credential_kind);
