// Per-call usage recording for the MCP surface.
//
// One row per tools/call, and deliberately NOT one audit-log entry per
// tools/call: a connected assistant makes hundreds of calls an hour, and
// writing those to `audit_log` would bury every human action — the invites,
// the key revocations, the plan changes — under machine noise. The audit log
// answers "what did a person do"; this table answers "what did the assistant
// do", and they are different questions with different retention needs.
//
// What is NOT stored here, ever: the tool's arguments and the tool's result.
// A tool argument is customer source code, a lockfile, or an infrastructure
// plan. Recording it would turn a usage table into a copy of the customer's
// codebase, held indefinitely, outside the R2 lifecycle that governs reports.
// The row records that a call happened and how it went — never what was in it.

// How many days the call-volume series covers. Fourteen because that is what
// the dashboard draws, and a window defined on the server means the chart
// cannot disagree with its own axis label.
export const DAILY_WINDOW_DAYS = 14;

export const OUTCOME = Object.freeze({
  OK:             "ok",
  ERROR:          "error",
  QUOTA_EXCEEDED: "quota_exceeded",
  RATE_LIMITED:   "rate_limited",
  DENIED:         "denied",
});

/**
 * Record one tool call.
 *
 * Best-effort and fire-and-forget: the caller passes this to `ctx.waitUntil`
 * rather than awaiting it, because a usage row that fails to write must never
 * cost the customer the analysis they already paid a run for. Returns false
 * instead of throwing so a caller that does await it cannot be broken by a
 * D1 hiccup.
 */
export async function logToolCall(env, {
  orgId, toolName, authMethod, scopeUsed, status,
  durationMs = null, runId = null, errorCode = null, now,
}) {
  if (!env || !env.DB || !orgId || !toolName) return false;
  try {
    await env.DB.prepare(
      `INSERT INTO mcp_tool_calls
         (org_id, tool_name, auth_method, scope_used, status, duration_ms, run_id, error_code, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      orgId, toolName, authMethod || "unknown", scopeUsed || "",
      status || OUTCOME.OK,
      typeof durationMs === "number" ? Math.round(durationMs) : null,
      runId || null, errorCode || null,
      now ?? Math.floor(Date.now() / 1000),
    ).run();
    return true;
  } catch {
    return false;
  }
}

/**
 * The usage summary behind GET /api/mcp/usage and the dashboard's activity feed.
 *
 * Every read filters org_id first — an MCP tool that forgets that is a
 * cross-tenant leak, so it is the leading term of every query in this file
 * rather than a condition appended at the end where it can be dropped.
 */
export async function usageSummary(env, orgId, { sinceSec, limit = 50 } = {}) {
  if (!env || !env.DB || !orgId) {
    return { calls: [], totals: null, comparable: false };
  }
  const nowSec = Math.floor(Date.now() / 1000);
  const since = sinceSec ?? nowSec - 30 * 24 * 60 * 60;
  const capped = Math.min(Math.max(1, limit | 0), 200);
  const sinceDaily = (Math.floor(nowSec / 86400) - DAILY_WINDOW_DAYS + 1) * 86400;

  const recent = await env.DB.prepare(
    `SELECT tool_name, auth_method, status, duration_ms, run_id, error_code, created_at
       FROM mcp_tool_calls
      WHERE org_id = ? AND created_at >= ?
      ORDER BY created_at DESC
      LIMIT ?`,
  ).bind(orgId, since, capped).all();

  const agg = await env.DB.prepare(
    `SELECT COUNT(*)                                                   AS total,
            SUM(CASE WHEN status = 'ok' THEN 1 ELSE 0 END)             AS ok,
            SUM(CASE WHEN status = 'quota_exceeded' THEN 1 ELSE 0 END) AS quota,
            SUM(CASE WHEN run_id IS NOT NULL THEN 1 ELSE 0 END)        AS runs,
            AVG(duration_ms)                                           AS avg_ms
       FROM mcp_tool_calls
      WHERE org_id = ? AND created_at >= ?`,
  ).bind(orgId, since).first();

  // Calls per day, for the sparkline. Grouped in SQL rather than derived from
  // `recent`, which is capped at 200 rows — deriving it there would draw a
  // chart that quietly flattens as soon as an org is busy enough for the cap
  // to bite, i.e. exactly when the chart starts being worth looking at.
  const perDay = await env.DB.prepare(
    `SELECT CAST(created_at / 86400 AS INTEGER) AS day, COUNT(*) AS n
       FROM mcp_tool_calls
      WHERE org_id = ? AND created_at >= ?
      GROUP BY day`,
  ).bind(orgId, sinceDaily).all();

  const busiest = await env.DB.prepare(
    `SELECT tool_name, COUNT(*) AS n
       FROM mcp_tool_calls
      WHERE org_id = ? AND created_at >= ?
      GROUP BY tool_name
      ORDER BY n DESC
      LIMIT 1`,
  ).bind(orgId, since).first();

  // A dense series: every day in the window gets an entry, including the ones
  // with no calls. A sparse array would draw a chart with the quiet days
  // silently closed up, which turns "used it twice, a week apart" into
  // "used it twice, back to back" — the shape is the whole information here.
  const byDay = new Map(((perDay && perDay.results) || []).map((r) => [Number(r.day), Number(r.n)]));
  const today = Math.floor(nowSec / 86400);
  const daily = [];
  for (let d = today - DAILY_WINDOW_DAYS + 1; d <= today; d++) {
    daily.push({ day: d * 86400, calls: byDay.get(d) || 0 });
  }

  const total = Number((agg && agg.total) || 0);
  return {
    calls: ((recent && recent.results) || []).map((r) => ({
      tool:       r.tool_name,
      authMethod: r.auth_method,
      status:     r.status,
      durationMs: typeof r.duration_ms === "number" ? r.duration_ms : null,
      runId:      r.run_id || null,
      errorCode:  r.error_code || null,
      at:         r.created_at,
    })),
    totals: {
      calls:         total,
      ok:            Number((agg && agg.ok) || 0),
      quotaRefused:  Number((agg && agg.quota) || 0),
      runsStarted:   Number((agg && agg.runs) || 0),
      avgDurationMs: agg && agg.avg_ms != null ? Math.round(agg.avg_ms) : null,
      busiestTool:   (busiest && busiest.tool_name) || null,
      // Stated rather than computed by the reader, because "0 errors out of 0
      // calls" is not a 0% error rate — it is no data, and a dashboard that
      // renders it as a reassuring 0% is lying about a surface nobody has used.
      errorRate: total > 0 ? (total - Number((agg && agg.ok) || 0)) / total : null,
    },
    daily,
    comparable: true,
    since,
  };
}
