// Per-user run history (Task #17 + Task #25 D1 migration).
//
// Storage: Cloudflare D1, table `runs` (see worker/migrations/0001_init.sql).
// Replaces the previous KV layout (`run:<userId>:<id>` blob + `runs:<userId>`
// per-user index). We dropped the index entirely — D1 gives us ordered range
// scans for free via `ORDER BY created_at DESC`, with cost bounded by the
// `idx_runs_user_created` index.
//
// Visibility: a 90-day cutoff is applied at READ time (`created_at >`)
// instead of via a KV TTL on the row. Old rows still sit in D1 until a
// future cleanup cron deletes them; users just don't see them. That's
// cheaper than reaching back into KV TTLs and matches what the dashboard
// actually needs.
//
// NOTE — retention change vs the pre-#25 KV layout: KV row TTL physically
// deleted blobs after 90 days. D1 keeps them on disk and only filters at
// read time, so storage grows monotonically until a cleanup job runs.
// See DEPLOY.md §2.5 + the follow-up task for the cron/scheduled-event
// that hard-deletes runs older than the cutoff. Privacy policy was
// updated to reflect this.
//
// Persistence is fire-and-forget from the analyze handlers via
// `ctx.waitUntil(queuePersist(...))` — never block the user's response on
// the D1 write. If D1 is unreachable we log and move on; history is a
// nice-to-have, not part of the analyzer's correctness contract.

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

// 90-day visibility cutoff. Kept as an exported constant for tests and
// future cleanup-cron code that needs the same number.
export const RUN_TTL_SECONDS = 60 * 60 * 24 * 90;

// Hard cap on the per-page list size. The dashboard only ever shows ~20;
// this is just defense against `?limit=999999`. Kept as an export for
// parity with the old KV-era constant.
export const MAX_INDEX_ENTRIES = 100;

// Cap how big a stored input can get. The cost CUR path uploads multi-MB
// CSVs that would blow D1's per-row size limit and cost us write IO for
// no real benefit (the user already has the file). Anything past this
// gets replaced with a `_omitted` marker so re-run is gracefully disabled.
export const MAX_INPUT_BYTES = 256 * 1024;

/**
 * Build a stable, sortable run id. Format: `<13-digit ts ms>_<8 hex chars>`
 * so naive lexicographic sorting matches creation order — which lets us
 * tie-break in `ORDER BY created_at DESC, id DESC` when two runs land in
 * the same millisecond.
 */
export function newRunId() {
  const ts   = Date.now().toString().padStart(13, "0");
  const rand = crypto.randomUUID().replace(/-/g, "").slice(0, 8);
  return `${ts}_${rand}`;
}

/**
 * One-line headline metric for the dashboard list. Kept analyzer-specific
 * because the three analyzers don't have a common shape — but each one has
 * an obvious "what's the verdict?" number.
 */
export function summarize(analyzer, result) {
  if (!result || typeof result !== "object") return "";
  if (analyzer === "cost") {
    const pct = typeof result.totalSavingsPct === "number" ? result.totalSavingsPct : 0;
    const sug = (result.suggestions && result.suggestions.length) || 0;
    return `${pct}% savings · ${sug} suggestion${sug === 1 ? "" : "s"}`;
  }
  if (analyzer === "vuln") {
    const c = result.counts || {};
    const total = (c.critical || 0) + (c.high || 0) + (c.medium || 0) + (c.low || 0);
    return `${total} advisor${total === 1 ? "y" : "ies"} · ${c.critical || 0} crit, ${c.high || 0} high`;
  }
  if (analyzer === "algo") {
    const bigO = (result.bigO && result.bigO.label) || "unknown";
    const ms = typeof result.wallTimeMs === "number" ? result.wallTimeMs.toFixed(2) : "—";
    return `${bigO} · ${ms} ms`;
  }
  return "";
}

/**
 * Trim a payload that's safe to JSON-stringify but possibly too big to keep.
 * Returns either the original value or a `{ _omitted: true, reason }` marker.
 */
function safeInput(input) {
  let serialized;
  try {
    serialized = JSON.stringify(input ?? null);
  } catch {
    return { _omitted: true, reason: "input_not_serializable" };
  }
  if (serialized.length > MAX_INPUT_BYTES) {
    return { _omitted: true, reason: "input_too_large_for_history" };
  }
  return input ?? null;
}

/**
 * Persist a single run. Best-effort — any D1 failure logs and resolves null
 * instead of throwing, so the caller's `ctx.waitUntil` never surfaces an
 * error to the user.
 */
export async function persistRun(env, { userId, analyzer, input, result, ms }) {
  if (!env || !env.DB || !userId || !analyzer) return null;
  const id = newRunId();
  const safe = safeInput(input);
  const safeResult = result ?? null;
  const record = {
    id,
    userId,
    analyzer,
    input: safe,
    result: safeResult,
    ms: typeof ms === "number" ? ms : null,
    headline: summarize(analyzer, result),
    createdAt: Date.now(),
  };

  try {
    await env.DB.prepare(
      `INSERT INTO runs
         (id, user_id, analyzer, input_json, result_json, ms, headline, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      id,
      userId,
      analyzer,
      safe === null ? null : JSON.stringify(safe),
      safeResult === null ? null : JSON.stringify(safeResult),
      record.ms,
      record.headline,
      record.createdAt,
    ).run();
  } catch (err) {
    console.error("persistRun: write failed", err);
    return null;
  }

  return record;
}

/**
 * Convenience wrapper that pushes the persistRun promise into ctx.waitUntil
 * when a Worker execution context is available. In tests (no ctx) it falls
 * back to a fire-and-forget promise that the caller may await if it wants
 * deterministic timing.
 */
export function queuePersist(ctx, env, payload) {
  const p = persistRun(env, payload).catch((err) => {
    console.error("queuePersist: unexpected error", err);
    return null;
  });
  if (ctx && typeof ctx.waitUntil === "function") {
    ctx.waitUntil(p);
  }
  return p;
}

// Cursor format: `<createdAt>_<id>`. Encodes BOTH the timestamp and the id
// so we get a total ordering even when two runs share a millisecond — the
// SQL below tie-breaks on `id DESC` with the same composite predicate.
function encodeCursor(row) {
  return `${row.created_at}_${row.id}`;
}
function decodeCursor(cursor) {
  const idx = String(cursor).indexOf("_");
  if (idx <= 0) return null;
  const ts = parseInt(cursor.slice(0, idx), 10);
  if (!Number.isFinite(ts)) return null;
  return { ts, id: cursor.slice(idx + 1) };
}

/**
 * Page through a user's runs newest-first. Returns at most `limit` items
 * plus a cursor to pass into the next call (or null if we hit the end).
 *
 * Items older than RUN_TTL_SECONDS are filtered out at read time — same
 * user-visible behavior as the old KV TTL, just enforced by a WHERE clause.
 */
export async function listRuns(env, userId, { limit = 20, cursor = null } = {}) {
  if (!env || !env.DB || !userId) return { items: [], nextCursor: null };
  const cap = Math.min(MAX_INDEX_ENTRIES, Math.max(1, limit | 0));
  const cutoff = Date.now() - RUN_TTL_SECONDS * 1000;

  // Fetch (cap+1) rows to determine whether there's a next page.
  let result;
  if (cursor) {
    const c = decodeCursor(cursor);
    if (!c) return { items: [], nextCursor: null };
    // Strictly-after the cursor in DESC order: row.created_at < c.ts, OR
    // (== c.ts AND id < c.id). The compound index makes this cheap.
    result = await env.DB.prepare(
      `SELECT id, analyzer, headline, ms, created_at, input_json
         FROM runs
        WHERE user_id = ?
          AND created_at > ?
          AND (created_at < ? OR (created_at = ? AND id < ?))
        ORDER BY created_at DESC, id DESC
        LIMIT ?`,
    ).bind(userId, cutoff, c.ts, c.ts, c.id, cap + 1).all();
  } else {
    result = await env.DB.prepare(
      `SELECT id, analyzer, headline, ms, created_at, input_json
         FROM runs
        WHERE user_id = ?
          AND created_at > ?
        ORDER BY created_at DESC, id DESC
        LIMIT ?`,
    ).bind(userId, cutoff, cap + 1).all();
  }

  const rows = result.results || [];
  const slice = rows.slice(0, cap);
  const items = slice.map((r) => {
    let input;
    try { input = r.input_json ? JSON.parse(r.input_json) : null; } catch { input = null; }
    return {
      id:        r.id,
      analyzer:  r.analyzer,
      headline:  r.headline || "",
      ms:        r.ms ?? null,
      createdAt: r.created_at,
      // Re-run depends on the input still being there. Disabled for CUR
      // uploads (input was too big to keep) so the dashboard can grey out
      // the button without having to fetch the full record first.
      hasInput:  !!(input && !input._omitted),
    };
  });

  const nextCursor = rows.length > cap && slice.length > 0
    ? encodeCursor(slice[slice.length - 1])
    : null;
  return { items, nextCursor };
}

/** Fetch a full run record by id, scoped to the requesting user. */
export async function getRun(env, userId, id) {
  if (!env || !env.DB || !userId || !id) return null;
  const cutoff = Date.now() - RUN_TTL_SECONDS * 1000;
  const row = await env.DB.prepare(
    `SELECT id, user_id, analyzer, input_json, result_json, ms, headline, created_at
       FROM runs
      WHERE id = ? AND user_id = ? AND created_at > ?`,
  ).bind(id, userId, cutoff).first();
  if (!row) return null;
  let input = null, result = null;
  try { input  = row.input_json  ? JSON.parse(row.input_json)  : null; } catch {}
  try { result = row.result_json ? JSON.parse(row.result_json) : null; } catch {}
  return {
    id:        row.id,
    userId:    row.user_id,
    analyzer:  row.analyzer,
    input,
    result,
    ms:        row.ms ?? null,
    headline:  row.headline || "",
    createdAt: row.created_at,
  };
}

// ---------------------------------------------------------------------------
// HTTP handlers — gated by requireAuth in the router
// ---------------------------------------------------------------------------

export async function listRunsHandler(request, env) {
  const userId = request.user && request.user.userId;
  if (!userId) return json({ error: "unauthorized" }, 401);

  const url = new URL(request.url);
  const rawLimit = parseInt(url.searchParams.get("limit") || "20", 10);
  const limit = Number.isFinite(rawLimit) ? Math.min(50, Math.max(1, rawLimit)) : 20;
  const cursor = url.searchParams.get("cursor") || null;

  const result = await listRuns(env, userId, { limit, cursor });
  return json(result, 200);
}

export async function getRunHandler(request, env) {
  const userId = request.user && request.user.userId;
  if (!userId) return json({ error: "unauthorized" }, 401);
  // itty-router 5 puts route params on request.params.
  const id = request.params && request.params.id;
  if (!id) return json({ error: "missing_id", message: "run id required" }, 400);
  const run = await getRun(env, userId, id);
  if (!run) return json({ error: "not_found", message: "no such run" }, 404);
  return json(run, 200);
}
