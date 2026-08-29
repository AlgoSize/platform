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

// How many hex characters of the SHA-256 survive truncation. 16 (64 bits) is
// far past any collision concern at per-org call volumes, and short enough
// that the value obviously reads as an identifier rather than a secret.
const SESSION_REF_HEX = 16;

/**
 * The value stored in mcp_tool_calls.session_ref: a truncated SHA-256 of the
 * MCP session id, never the id itself. The KV session record expires after 24
 * hours while a D1 row is kept indefinitely; storing the raw id would leave a
 * resumable-looking identifier in a table that outlives the thing it
 * identifies, for no gain — grouping needs only equality, which a hash
 * preserves. Exported because session.js uses the same ref to key the
 * short-lived client-label pointer, and two hash implementations is how the
 * label and the rows stop agreeing.
 */
export async function sessionRefFor(sessionId) {
  if (!sessionId || typeof sessionId !== "string") return null;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(sessionId));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, SESSION_REF_HEX);
}

/** KV key for the session's self-reported client label — see session.js. */
export function sessionLabelKey(ref) {
  return `mcp:sesslabel:${ref}`;
}

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
  durationMs = null, runId = null, errorCode = null, sessionId = null, now,
}) {
  if (!env || !env.DB || !orgId || !toolName) return false;
  try {
    // Hashed here, inside the one write path, so a call site cannot store the
    // raw id by accident — the parameter is the id, the column is the ref.
    const sessionRef = await sessionRefFor(sessionId);
    await env.DB.prepare(
      `INSERT INTO mcp_tool_calls
         (org_id, tool_name, auth_method, scope_used, status, duration_ms, run_id, error_code, session_ref, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      orgId, toolName, authMethod || "unknown", scopeUsed || "",
      status || OUTCOME.OK,
      typeof durationMs === "number" ? Math.round(durationMs) : null,
      runId || null, errorCode || null, sessionRef,
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
    return { calls: [], sessions: [], preGrouping: { total: 0, calls: [] }, totals: null, comparable: false };
  }
  const nowSec = Math.floor(Date.now() / 1000);
  const since = sinceSec ?? nowSec - 30 * 24 * 60 * 60;
  const capped = Math.min(Math.max(1, limit | 0), 200);
  const sinceDaily = (Math.floor(nowSec / 86400) - DAILY_WINDOW_DAYS + 1) * 86400;

  const recent = await env.DB.prepare(
    `SELECT tool_name, auth_method, status, duration_ms, run_id, error_code, session_ref, created_at
       FROM mcp_tool_calls
      WHERE org_id = ? AND created_at >= ?
      ORDER BY created_at DESC, id DESC
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

  // Per-session aggregates come from SQL over the WHOLE window, for the same
  // reason perDay does: the detailed call list is capped, and a busy session
  // whose calls straddle the cap would otherwise report a quietly shrunken
  // count exactly when someone is looking at it. The capped rows are attached
  // as each session's visible calls; `totals.calls` on the session is the
  // real number, and a reader can see when the two differ.
  const perSession = await env.DB.prepare(
    `SELECT session_ref,
            COUNT(*)                                                   AS n,
            MIN(created_at)                                            AS first_at,
            MAX(created_at)                                            AS last_at,
            SUM(CASE WHEN status = 'ok' THEN 1 ELSE 0 END)             AS ok,
            SUM(CASE WHEN status = 'denied' THEN 1 ELSE 0 END)         AS denied,
            SUM(CASE WHEN status = 'quota_exceeded' THEN 1 ELSE 0 END) AS quota,
            SUM(CASE WHEN run_id IS NOT NULL THEN 1 ELSE 0 END)        AS runs
       FROM mcp_tool_calls
      WHERE org_id = ? AND created_at >= ? AND session_ref IS NOT NULL
      GROUP BY session_ref
      ORDER BY last_at DESC
      LIMIT 50`,
  ).bind(orgId, since).all();

  const sessionCount = await env.DB.prepare(
    `SELECT COUNT(DISTINCT session_ref) AS n
       FROM mcp_tool_calls
      WHERE org_id = ? AND created_at >= ? AND session_ref IS NOT NULL`,
  ).bind(orgId, since).first();

  // Rows with a NULL session_ref were written before migration 0021 — the
  // only way NULL happens, since every tools/call requires a live session.
  // A finite, closed set that ages out of the window; counted so the reader
  // can be told "recorded before session grouping existed" with a number.
  const preCount = await env.DB.prepare(
    `SELECT COUNT(*) AS n
       FROM mcp_tool_calls
      WHERE org_id = ? AND created_at >= ? AND session_ref IS NULL`,
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

  const callShape = (r) => ({
    tool:       r.tool_name,
    authMethod: r.auth_method,
    status:     r.status,
    durationMs: typeof r.duration_ms === "number" ? r.duration_ms : null,
    runId:      r.run_id || null,
    errorCode:  r.error_code || null,
    sessionRef: r.session_ref || null,
    at:         r.created_at,
  });
  const recentRows = (recent && recent.results) || [];

  // Attach the capped call details to their sessions, chronological inside
  // each group: within a session the list is a narrative — "listed tools,
  // analysed two repos, hit the quota" — and a narrative reads forward.
  const bySession = new Map();
  for (const r of recentRows) {
    if (!r.session_ref) continue;
    if (!bySession.has(r.session_ref)) bySession.set(r.session_ref, []);
    bySession.get(r.session_ref).push(callShape(r));
  }
  for (const list of bySession.values()) list.reverse();

  // The client's self-reported name, resolved through the 24h label pointer
  // session.js writes at initialize. Deliberately allowed to be gone: the
  // rows outlive the label, and an old session is identified by its time
  // span and credential rather than a name nobody stored. Best-effort — a
  // KV hiccup costs a label, never the summary.
  const sessionRows = (perSession && perSession.results) || [];
  const labels = new Map();
  if (env.SESSIONS && sessionRows.length) {
    await Promise.all(sessionRows.map(async (r) => {
      try {
        const raw = await env.SESSIONS.get(sessionLabelKey(r.session_ref));
        if (raw) labels.set(r.session_ref, JSON.parse(raw));
      } catch { /* label stays absent */ }
    }));
  }

  const sessions = sessionRows.map((r) => {
    const shown = bySession.get(r.session_ref) || [];
    const label = labels.get(r.session_ref) || null;
    return {
      ref:     r.session_ref,
      client:  (label && label.clientInfo) || null,
      firstAt: Number(r.first_at),
      lastAt:  Number(r.last_at),
      totals: {
        calls:        Number(r.n),
        ok:           Number(r.ok || 0),
        denied:       Number(r.denied || 0),
        quotaRefused: Number(r.quota || 0),
        runsStarted:  Number(r.runs || 0),
      },
      // The capped subset actually attached. When totals.calls is larger the
      // session is busier than the visible list, and the UI must say so
      // rather than let the list read as complete.
      calls: shown,
    };
  });

  return {
    calls: recentRows.map(callShape),
    sessions,
    preGrouping: {
      total: Number((preCount && preCount.n) || 0),
      calls: recentRows.filter((r) => !r.session_ref).map(callShape),
    },
    totals: {
      calls:         total,
      ok:            Number((agg && agg.ok) || 0),
      quotaRefused:  Number((agg && agg.quota) || 0),
      runsStarted:   Number((agg && agg.runs) || 0),
      avgDurationMs: agg && agg.avg_ms != null ? Math.round(agg.avg_ms) : null,
      busiestTool:   (busiest && busiest.tool_name) || null,
      sessions:      Number((sessionCount && sessionCount.n) || 0),
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
