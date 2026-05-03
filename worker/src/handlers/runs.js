// Per-user run history (Task #17).
//
// Layout in the RUNS KV namespace:
//   run:<userId>:<runId>   → JSON full record  (TTL = 90 days)
//   runs:<userId>          → JSON [runId, …]   newest-first index, capped at
//                            MAX_INDEX_ENTRIES. The index itself has NO TTL —
//                            individual run blobs expire under it and the
//                            list endpoint filters out missing entries.
//
// The runId is `<13-digit ts>_<8 hex chars>` so the keys are lexicographically
// sortable by creation time without parsing.
//
// Persistence is fire-and-forget from the analyze handlers via
// `ctx.waitUntil(queuePersist(...))` — never block the user's response on
// the KV write. If KV is unreachable we log and move on; history is a
// nice-to-have, not part of the analyzer's correctness contract.

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

// 90-day TTL. KV stores `expiration` as absolute epoch seconds; we use
// the relative `expirationTtl` form so callers don't have to compute it.
export const RUN_TTL_SECONDS  = 60 * 60 * 24 * 90;

// Hard cap on the per-user index. Keeps the index value small (one int per
// entry, well under the 25 MB KV value limit even at 100k entries) and bounds
// the list endpoint's worst-case cost. The dashboard only ever shows ~20.
export const MAX_INDEX_ENTRIES = 100;

// Cap how big a stored input can get. The cost CUR path uploads multi-MB
// CSVs that would blow KV's 25 MB value limit and cost us hot-key writes
// for no real benefit (the user already has the file). Anything past this
// gets replaced with a `_omitted` marker so re-run is gracefully disabled.
export const MAX_INPUT_BYTES = 256 * 1024;

/**
 * Build a stable, sortable run id. Format: `<ts>_<rand>` so naive string
 * sorting yields newest-last (index stores newest-first explicitly).
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
 * Persist a single run + push it onto the per-user index. Best-effort — any
 * KV failure logs and resolves null instead of throwing, so the caller's
 * `ctx.waitUntil` never surfaces an error to the user.
 */
export async function persistRun(env, { userId, analyzer, input, result, ms }) {
  if (!env || !env.RUNS || !userId || !analyzer) return null;
  const id = newRunId();
  const record = {
    id,
    userId,
    analyzer,
    input: safeInput(input),
    result: result ?? null,
    ms: typeof ms === "number" ? ms : null,
    headline: summarize(analyzer, result),
    createdAt: Date.now(),
  };

  try {
    await env.RUNS.put(`run:${userId}:${id}`, JSON.stringify(record), {
      expirationTtl: RUN_TTL_SECONDS,
    });
  } catch (err) {
    console.error("persistRun: write failed", err);
    return null;
  }

  // Update the per-user index. Read-modify-write is racy under concurrent
  // writes from the same user (two simultaneous analyzer runs could lose
  // one index entry), but the run blob itself is still queryable by id and
  // the worst case is "one missing item from the recent list" — acceptable
  // for v1. D1 migration in Task #25 makes this transactional.
  try {
    const raw = await env.RUNS.get(`runs:${userId}`);
    let list = [];
    if (raw) {
      try { list = JSON.parse(raw) || []; } catch { list = []; }
      if (!Array.isArray(list)) list = [];
    }
    list.unshift(id);
    if (list.length > MAX_INDEX_ENTRIES) list = list.slice(0, MAX_INDEX_ENTRIES);
    await env.RUNS.put(`runs:${userId}`, JSON.stringify(list));
  } catch (err) {
    console.error("persistRun: index update failed", err);
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

/**
 * Page through the per-user index. `cursor` is the runId to start at; if
 * omitted we start from the newest. Returns at most `limit` items, plus the
 * id to pass as the next cursor (or null if we hit the end).
 */
export async function listRuns(env, userId, { limit = 20, cursor = null } = {}) {
  if (!env || !env.RUNS || !userId) return { items: [], nextCursor: null };
  const raw = await env.RUNS.get(`runs:${userId}`);
  if (!raw) return { items: [], nextCursor: null };
  let ids;
  try { ids = JSON.parse(raw); }
  catch { return { items: [], nextCursor: null }; }
  if (!Array.isArray(ids)) return { items: [], nextCursor: null };

  let start = 0;
  if (cursor) {
    const idx = ids.indexOf(cursor);
    if (idx >= 0) start = idx;
  }
  const slice = ids.slice(start, start + limit);

  const items = [];
  for (const id of slice) {
    const rec = await env.RUNS.get(`run:${userId}:${id}`);
    if (!rec) continue;  // expired under us — silently skip
    let parsed;
    try { parsed = JSON.parse(rec); } catch { continue; }
    items.push({
      id: parsed.id,
      analyzer: parsed.analyzer,
      headline: parsed.headline || "",
      ms: parsed.ms ?? null,
      createdAt: parsed.createdAt,
      // Re-run depends on the input still being there. Disabled for CUR
      // uploads (input was too big to keep) so the dashboard can grey out
      // the button without having to fetch the full record first.
      hasInput: !!(parsed.input && !(parsed.input && parsed.input._omitted)),
    });
  }

  const nextIdx = start + limit;
  const nextCursor = nextIdx < ids.length ? ids[nextIdx] : null;
  return { items, nextCursor };
}

/** Fetch a full run record by id, scoped to the requesting user. */
export async function getRun(env, userId, id) {
  if (!env || !env.RUNS || !userId || !id) return null;
  const raw = await env.RUNS.get(`run:${userId}:${id}`);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
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
