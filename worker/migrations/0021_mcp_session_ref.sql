-- Migration 0021: session correlation on the MCP tool-call log.
--
-- TRACE-AND-GRAPH-PLAN.md §1.3: the flat log's one real gap is grouping the
-- calls of one working session. run_id links a call to the run it produced,
-- but read-only calls have none, so nothing says "these forty calls were one
-- assistant working through one problem".
--
-- The value stored is a TRUNCATED SHA-256 of the MCP session id, never the id
-- itself: the KV session record expires after 24 hours while these rows are
-- kept indefinitely, and grouping needs only equality, which a hash preserves.
-- A row with NULL session_ref predates this migration — that is the only way
-- NULL happens, because every method except `initialize` is refused without a
-- live session (handlers/mcp.js) — and readers must render it as "recorded
-- before session grouping existed", never as an unknown or broken session.

ALTER TABLE mcp_tool_calls ADD COLUMN session_ref TEXT;
CREATE INDEX IF NOT EXISTS idx_mcp_tool_calls_session
  ON mcp_tool_calls(org_id, session_ref, created_at);
