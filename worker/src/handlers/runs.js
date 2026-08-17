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

import { getActiveOrg } from "./_orgs.js";
import { toSarif } from "../analyzers/sarif.js";

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
    // Prefer the audit summary when present — it covers both scan modes and
    // already counts every severity.
    if (result.summary && typeof result.summary.totalIssues === "number") {
      const s = result.summary;
      return `${s.totalIssues} issue${s.totalIssues === 1 ? "" : "s"} · grade ${s.grade} · ` +
             `${s.counts.critical} crit, ${s.counts.high} high`;
    }
    const c = result.counts || {};
    // `unknown` must be in the total. Leaving it out reported "0 advisories"
    // for a repo whose advisories were all unrated — which, before the CVSS
    // fix, was most of them.
    const total = (c.critical || 0) + (c.high || 0) + (c.medium || 0) + (c.low || 0) + (c.unknown || 0);
    return `${total} advisor${total === 1 ? "y" : "ies"} · ${c.critical || 0} crit, ${c.high || 0} high`;
  }
  if (analyzer === "arch") {
    const s = result.summary || {};
    const bySev = s.bySeverity || {};
    const findings = typeof s.findings === "number" ? s.findings : 0;
    return `${s.clusters || 0} cluster${s.clusters === 1 ? "" : "s"} · ` +
           `${findings} finding${findings === 1 ? "" : "s"} · ` +
           `${bySev.critical || 0} crit, ${bySev.high || 0} high`;
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
export async function persistRun(env, { userId, orgId = null, analyzer, input, result, ms, source = null }) {
  // A run needs an owner of SOME kind. A dashboard run has a user; a CI run
  // (handlers/ci.js) has only an org, because an API key authenticates as the
  // organisation and there is no human behind it.
  if (!env || !env.DB || !analyzer) return null;
  if (!userId && !orgId) return null;
  const id = newRunId();
  const safe = safeInput(input);
  const safeResult = result ?? null;
  const record = {
    id,
    userId: userId || null,
    orgId,
    source,
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
         (id, user_id, org_id, source, analyzer, input_json, result_json, ms, headline, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      id,
      userId || null,
      orgId,
      source,
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
export async function listRuns(env, scope, { limit = 20, cursor = null } = {}) {
  // Back-compat: callers that pass a bare user id keep working.
  const { userId = null, orgId = null } = typeof scope === "string" ? { userId: scope } : (scope || {});
  if (!env || !env.DB || (!userId && !orgId)) return { items: [], nextCursor: null };
  const cap = Math.min(MAX_INDEX_ENTRIES, Math.max(1, limit | 0));
  const cutoff = Date.now() - RUN_TTL_SECONDS * 1000;

  // Scope by org when we have one (migrations/0007) — that is what makes a CI
  // run, which has no user behind it, visible to the team it belongs to. The
  // user_id arm is kept as an OR rather than replaced so a row the backfill
  // could not resolve to an org stays visible to the person who created it
  // instead of silently vanishing from their history.
  const scopeSql  = orgId && userId ? "(org_id = ? OR user_id = ?)" : orgId ? "org_id = ?" : "user_id = ?";
  const scopeArgs = orgId && userId ? [orgId, userId] : orgId ? [orgId] : [userId];

  // Fetch (cap+1) rows to determine whether there's a next page.
  let result;
  if (cursor) {
    const c = decodeCursor(cursor);
    if (!c) return { items: [], nextCursor: null };
    // Strictly-after the cursor in DESC order: row.created_at < c.ts, OR
    // (== c.ts AND id < c.id). The compound index makes this cheap.
    result = await env.DB.prepare(
      `SELECT id, analyzer, headline, ms, created_at, input_json, source
         FROM runs
        WHERE ${scopeSql}
          AND created_at > ?
          AND (created_at < ? OR (created_at = ? AND id < ?))
        ORDER BY created_at DESC, id DESC
        LIMIT ?`,
    ).bind(...scopeArgs, cutoff, c.ts, c.ts, c.id, cap + 1).all();
  } else {
    result = await env.DB.prepare(
      `SELECT id, analyzer, headline, ms, created_at, input_json, source
         FROM runs
        WHERE ${scopeSql}
          AND created_at > ?
        ORDER BY created_at DESC, id DESC
        LIMIT ?`,
    ).bind(...scopeArgs, cutoff, cap + 1).all();
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
      // "ci" for runs submitted by the ingestion endpoint, null for runs
      // started from the dashboard — so the UI can badge and filter them
      // (D-3) without inspecting the payload.
      source:    r.source || null,
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

/** Fetch a full run record by id, scoped to the requesting org (or user). */
export async function getRun(env, scope, id) {
  const { userId = null, orgId = null } = typeof scope === "string" ? { userId: scope } : (scope || {});
  if (!env || !env.DB || !id || (!userId && !orgId)) return null;
  const cutoff = Date.now() - RUN_TTL_SECONDS * 1000;

  // Same scoping rule as listRuns — see the comment there for why the
  // user_id arm survives alongside org_id.
  const scopeSql  = orgId && userId ? "(org_id = ? OR user_id = ?)" : orgId ? "org_id = ?" : "user_id = ?";
  const scopeArgs = orgId && userId ? [orgId, userId] : orgId ? [orgId] : [userId];

  const row = await env.DB.prepare(
    `SELECT id, user_id, org_id, source, analyzer, input_json, result_json, ms, headline, created_at
       FROM runs
      WHERE id = ? AND ${scopeSql} AND created_at > ?`,
  ).bind(id, ...scopeArgs, cutoff).first();
  if (!row) return null;
  let input = null, result = null;
  try { input  = row.input_json  ? JSON.parse(row.input_json)  : null; } catch {}
  try { result = row.result_json ? JSON.parse(row.result_json) : null; } catch {}
  return {
    id:        row.id,
    userId:    row.user_id,
    orgId:     row.org_id || null,
    source:    row.source || null,
    analyzer:  row.analyzer,
    input,
    result,
    ms:        row.ms ?? null,
    headline:  row.headline || "",
    createdAt: row.created_at,
  };
}

/**
 * Resolve the run scope for a request under either credential.
 *
 * A cookie session has a user (and, through them, an org); an API key has only
 * an org. Both read the same history, which is the whole point of CI runs
 * landing in the dashboard.
 */
export async function runScopeFor(request, env) {
  if (request.org && request.org.orgId) return { orgId: request.org.orgId, userId: null };
  const userId = request.user && request.user.userId;
  if (!userId) return null;
  const active = await getActiveOrg(env, userId);
  return { userId, orgId: active ? active.org.orgId : null };
}

// ---------------------------------------------------------------------------
// HTTP handlers — gated by requireAuth in the router
// ---------------------------------------------------------------------------

export async function listRunsHandler(request, env) {
  const scope = await runScopeFor(request, env);
  if (!scope) return json({ error: "unauthorized" }, 401);

  const url = new URL(request.url);
  const rawLimit = parseInt(url.searchParams.get("limit") || "20", 10);
  const limit = Number.isFinite(rawLimit) ? Math.min(50, Math.max(1, rawLimit)) : 20;
  const cursor = url.searchParams.get("cursor") || null;

  const result = await listRuns(env, scope, { limit, cursor });
  return json(result, 200);
}

export async function getRunHandler(request, env) {
  const scope = await runScopeFor(request, env);
  if (!scope) return json({ error: "unauthorized" }, 401);
  // itty-router 5 puts route params on request.params.
  const id = request.params && request.params.id;
  if (!id) return json({ error: "missing_id", message: "run id required" }, 400);
  const run = await getRun(env, scope, id);
  if (!run) return json({ error: "not_found", message: "no such run" }, 404);
  return json(run, 200);
}

/**
 * GET /api/runs/:id/report?format=sarif|json
 *
 * SARIF 2.1.0 so findings land in the repo's GitHub Security tab — the
 * workflow in .github/workflows/algosize-audit.yml.example downloads this and
 * hands it to github/codeql-action/upload-sarif.
 *
 * Rendered ON DEMAND from the stored result rather than served from R2. P-6
 * is what introduces the R2 bucket and the HTML/PDF artefacts; adding an R2
 * binding here would mean a resource that has to be provisioned before the
 * next deploy succeeds, for no benefit yet — the run row already holds
 * everything SARIF needs. When P-6 lands it can cache into R2 behind this
 * same URL without changing a single caller.
 */
export async function getRunReportHandler(request, env) {
  const scope = await runScopeFor(request, env);
  if (!scope) return json({ error: "unauthorized" }, 401);

  const id = request.params && request.params.id;
  if (!id) return json({ error: "missing_id", message: "run id required" }, 400);

  const run = await getRun(env, scope, id);
  if (!run) return json({ error: "not_found", message: "no such run" }, 404);

  const url = new URL(request.url);
  const format = (url.searchParams.get("format") || "json").toLowerCase();

  if (format === "json") return json(run.result ?? {}, 200);

  if (format === "sarif") {
    if (run.analyzer !== "vuln") {
      return json({
        error: "unsupported_format",
        message: `SARIF is only produced for dependency audits; this run is a "${run.analyzer}" run.`,
      }, 400);
    }
    const sarif = toSarif(run.result, { runId: run.id, siteOrigin: env.SITE_ORIGIN || "" });
    return new Response(JSON.stringify(sarif, null, 2), {
      status: 200,
      headers: {
        "content-type": "application/sarif+json",
        "content-disposition": `attachment; filename="algosize-${run.id}.sarif"`,
      },
    });
  }

  return json({
    error: "unsupported_format",
    message: 'Supported formats: "sarif", "json". HTML and CycloneDX arrive with the report work (P-6).',
  }, 400);
}
