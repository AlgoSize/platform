/**
 * MCP audit helpers — log tool calls to mcp_tool_calls table.
 * No arguments, no results are stored (they may contain customer source code).
 */

export async function logToolCall(env, { orgId, toolName, authMethod, scopeUsed, status, durationMs, runId, errorCode }) {
  try {
    await env.DB.prepare(
      `INSERT INTO mcp_tool_calls
         (org_id, tool_name, auth_method, scope_used, status, duration_ms, run_id, error_code)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(orgId, toolName, authMethod, scopeUsed, status, durationMs ?? null, runId ?? null, errorCode ?? null).run();
  } catch {
    // Audit failure must never fail the tool call
  }
}
