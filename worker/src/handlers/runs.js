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
import { toCycloneDX } from "../analyzers/cyclonedx.js";
import { toAuditCsv } from "../analyzers/csv.js";
import { reportHtmlFor } from "../reports/render.js";
import { createShare, readShare, revokeShare, listShares, DEFAULT_SHARE_DAYS, MAX_SHARE_DAYS } from "../reports/share.js";

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
 * The analyzers a run can belong to — closed set, used to gate the SQL filter.
 *
 * "estimate" was missing, and its absence was not cosmetic: without a member
 * here the infrastructure estimator could not persist a run at all, so it
 * never appeared in Recent runs, never had a report, and never showed in the
 * per-analyzer filter. Every other tool on the Workspace could point at
 * something it had produced; that one could only ever be used and forgotten.
 *
 * The column is plain TEXT with no CHECK, so adding a member needs no
 * migration — this list is the only gate, which is why it is also the only
 * place to add one.
 */
export const ANALYZERS = Object.freeze(["cost", "vuln", "algo", "arch", "estimate"]);

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
  if (analyzer === "estimate") {
    // The cheapest provider, because that is the number a decision turns on.
    // Named, not just quoted: "$12.40/mo" without "on Hetzner" is a figure
    // nobody can act on or reproduce.
    const providers = Array.isArray(result.providers) ? result.providers : [];
    const priced = providers.filter((p) => typeof p.estimatedTotalMicroUsd === "number");
    if (!priced.length) return "no providers priced";
    const best = priced.reduce((a, b) =>
      b.estimatedTotalMicroUsd < a.estimatedTotalMicroUsd ? b : a);
    const dollars = (best.estimatedTotalMicroUsd / 1_000_000).toFixed(2);
    const n = (result.normalizedSpec && result.normalizedSpec.resources || []).length;
    return `$${dollars}/mo on ${best.providerName || best.providerId} · ` +
           `${n} resource${n === 1 ? "" : "s"} · ${priced.length} provider${priced.length === 1 ? "" : "s"}`;
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
export async function persistRun(env, { userId, orgId = null, analyzer, input, result, ms, source = null, credentialKind = null, credentialId = null }) {
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
    // How this run was authenticated (migrations/0019). Recorded so the runs
    // feed can say "via MCP" or "via API key" rather than presenting a run
    // nobody in the dashboard remembers starting as if a person had.
    credentialKind,
    credentialId,
  };

  try {
    await env.DB.prepare(
      `INSERT INTO runs
         (id, user_id, org_id, source, analyzer, input_json, result_json, ms, headline, created_at,
          credential_kind, credential_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      credentialKind,
      credentialId,
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
export async function listRuns(env, scope, { limit = 20, cursor = null, source = null, analyzer = null } = {}) {
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
  let scopeSql  = orgId && userId ? "(org_id = ? OR user_id = ?)" : orgId ? "org_id = ?" : "user_id = ?";
  const scopeArgs = orgId && userId ? [orgId, userId] : orgId ? [orgId] : [userId];

  // Provenance filter (D-3): a busy pipeline pushes every manual run off the
  // first page, so the feed filters server-side rather than over-fetching.
  // "manual" means a NULL source — dashboard runs predate the column and
  // never write one.
  if (source === "ci")     scopeSql += " AND source = 'ci'";
  if (source === "manual") scopeSql += " AND source IS NULL";

  // Analyzer filter. Needed by the architecture X-ray's run-over-run diff,
  // which has to find the PREVIOUS architecture run — filtering client-side
  // would mean over-fetching a page of cost and vuln runs and hoping an
  // architecture one survived the cut. Whitelisted rather than interpolated:
  // this lands in SQL, and the set of analyzers is closed.
  if (ANALYZERS.includes(analyzer)) {
    scopeSql += " AND analyzer = ?";
    scopeArgs.push(analyzer);
  }

  // Fetch (cap+1) rows to determine whether there's a next page.
  let result;
  if (cursor) {
    const c = decodeCursor(cursor);
    if (!c) return { items: [], nextCursor: null };
    // Strictly-after the cursor in DESC order: row.created_at < c.ts, OR
    // (== c.ts AND id < c.id). The compound index makes this cheap.
    result = await env.DB.prepare(
      `SELECT id, analyzer, headline, ms, created_at, input_json, source, credential_kind
         FROM runs
        WHERE ${scopeSql}
          AND created_at > ?
          AND (created_at < ? OR (created_at = ? AND id < ?))
        ORDER BY created_at DESC, id DESC
        LIMIT ?`,
    ).bind(...scopeArgs, cutoff, c.ts, c.ts, c.id, cap + 1).all();
  } else {
    result = await env.DB.prepare(
      `SELECT id, analyzer, headline, ms, created_at, input_json, source, credential_kind
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
    const isCi = r.source === "ci";
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
      // Provenance for the CI badge (D-3): which repo and commit produced
      // this run. Pulled from the already-parsed input rather than a new
      // column — the values were stored at ingest and never change. Null on
      // dashboard runs, where there is no commit to name.
      repo:      isCi && input && typeof input.repo === "string" ? input.repo : null,
      commitSha: isCi && input && typeof input.commitSha === "string" ? input.commitSha : null,
      // Re-run depends on the input still being there. Disabled for CUR
      // uploads (input was too big to keep) so the dashboard can grey out
      // the button without having to fetch the full record first.
      hasInput:  !!(input && !input._omitted),
      // How this run was authenticated (migrations/0019), so the feed can
      // label a row "via MCP" or "via API key". Null on every run recorded
      // before the column existed — which is NOT the same as "session", and
      // the UI must not render it as one.
      credentialKind: r.credential_kind || null,
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
  // ?source=ci|manual — anything else (including absent) means no filter.
  const rawSource = url.searchParams.get("source");
  const source = rawSource === "ci" || rawSource === "manual" ? rawSource : null;
  // ?analyzer=cost|vuln|algo|arch|estimate — anything else (including absent) means no
  // filter. Whitelisted against ANALYZERS rather than passed through, because
  // the value reaches a SQL predicate.
  const rawAnalyzer = url.searchParams.get("analyzer");
  const analyzer = ANALYZERS.includes(rawAnalyzer) ? rawAnalyzer : null;

  const result = await listRuns(env, scope, { limit, cursor, source, analyzer });
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

// ---------------------------------------------------------------------------
// Report rendering — shared by the authenticated route and the share link
// ---------------------------------------------------------------------------

export const REPORT_FORMATS = Object.freeze(["html", "sarif", "cyclonedx", "csv", "json"]);

/**
 * Build the response for one run in one format.
 *
 * Factored out because the authenticated route and the public share route must
 * produce byte-identical documents — the whole promise of a share link is that
 * the client sees what the customer saw. Two code paths would eventually
 * disagree about something small and embarrassing, like the generated-at date.
 */
async function renderReportResponse(env, ctx, run, format) {
  if (format === "json") return json(run.result ?? {}, 200);

  // The three real report formats all describe a dependency audit. A cost or
  // algorithm run has no advisories, no packages, and nothing to hand anyone.
  if (format !== "json" && run.analyzer !== "vuln") {
    return json({
      error: "unsupported_format",
      message: `${format.toUpperCase()} is only produced for dependency audits; this run is a "${run.analyzer}" run.`,
    }, 400);
  }

  if (format === "html") {
    const { html } = await reportHtmlFor(env, ctx, run);
    return new Response(html, {
      status: 200,
      headers: {
        "content-type": "text/html; charset=utf-8",
        // Inline, not an attachment: this one is meant to be READ, and the
        // print-to-PDF path needs it rendered in a browser tab.
        "content-disposition": `inline; filename="algosize-report-${run.id}.html"`,
        // The report embeds nothing but an operator-set logo. Locking the page
        // down means a forwarded document cannot be turned into a delivery
        // vehicle for anything else.
        "content-security-policy":
          "default-src 'none'; img-src https: data:; style-src 'unsafe-inline'; " +
          "script-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
        "x-content-type-options": "nosniff",
        "referrer-policy": "no-referrer",
      },
    });
  }

  if (format === "sarif") {
    const sarif = toSarif(run.result, { runId: run.id, siteOrigin: env.SITE_ORIGIN || "" });
    return new Response(JSON.stringify(sarif, null, 2), {
      status: 200,
      headers: {
        "content-type": "application/sarif+json",
        "content-disposition": `attachment; filename="algosize-${run.id}.sarif"`,
      },
    });
  }

  if (format === "cyclonedx") {
    const input = run.input || {};
    const bom = toCycloneDX(run.result, {
      runId: run.id,
      siteOrigin: env.SITE_ORIGIN || "",
      serialNumber: `urn:uuid:${crypto.randomUUID()}`,
      timestamp: new Date(run.createdAt || Date.now()).toISOString(),
      projectName: input.repo || (run.result && run.result.ci && run.result.ci.repo) || null,
    });
    return new Response(JSON.stringify(bom, null, 2), {
      status: 200,
      headers: {
        "content-type": "application/vnd.cyclonedx+json; version=1.5",
        "content-disposition": `attachment; filename="algosize-${run.id}.cdx.json"`,
      },
    });
  }

  if (format === "csv") {
    // The spreadsheet export — for the person tracking remediation in Sheets
    // or pasting findings into a client workbook. Same audit, same ordering
    // as the HTML report; see analyzers/csv.js for why scope and score ride
    // in the file as comment rows.
    return new Response(toAuditCsv(run), {
      status: 200,
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="algosize-audit-${run.id}.csv"`,
      },
    });
  }

  return json({
    error: "unsupported_format",
    message: `Supported formats: ${REPORT_FORMATS.join(", ")}.`,
  }, 400);
}

/**
 * GET /api/runs/:id/report?format=html|sarif|cyclonedx|json
 *
 *   html       the client-facing report. Served from R2 when it is there,
 *              rendered and backfilled when it is not. Print to PDF from the
 *              browser — see the print stylesheet in reports/html.js.
 *   sarif      SARIF 2.1.0, so findings land in the repo's Security tab.
 *   cyclonedx  CycloneDX 1.5 SBOM, for the procurement questionnaire.
 *   json       the raw stored result, unchanged.
 */
export async function getRunReportHandler(request, env, ctx) {
  const scope = await runScopeFor(request, env);
  if (!scope) return json({ error: "unauthorized" }, 401);

  const id = request.params && request.params.id;
  if (!id) return json({ error: "missing_id", message: "run id required" }, 400);

  const run = await getRun(env, scope, id);
  if (!run) return json({ error: "not_found", message: "no such run" }, 404);

  const url = new URL(request.url);
  const format = (url.searchParams.get("format") || "json").toLowerCase();
  if (!REPORT_FORMATS.includes(format)) {
    return json({
      error: "unsupported_format",
      message: `Supported formats: ${REPORT_FORMATS.join(", ")}.`,
    }, 400);
  }

  return renderReportResponse(env, ctx, run, format);
}

// ---------------------------------------------------------------------------
// POST /api/runs/:id/share
// ---------------------------------------------------------------------------

/**
 * Mint a read-only share link for one run.
 *
 * Authenticated and org-scoped: you can only share a run you can already read,
 * which is what stops a token being minted for someone else's audit. The link
 * itself then needs no session at all — that is the point, since the person
 * opening it is the customer's client.
 */
export async function createRunShareHandler(request, env) {
  const scope = await runScopeFor(request, env);
  if (!scope) return json({ error: "unauthorized" }, 401);

  const id = request.params && request.params.id;
  if (!id) return json({ error: "missing_id", message: "run id required" }, 400);

  const run = await getRun(env, scope, id);
  if (!run) return json({ error: "not_found", message: "no such run" }, 404);

  let body = null;
  try { body = await request.json(); } catch { /* no body — defaults apply */ }

  const share = await createShare(env, {
    runId: run.id,
    // The RUN's org, not the caller's, so the link resolves to the same
    // branding and the same data no matter who later opens it.
    orgId: run.orgId,
    createdBy: (request.user && request.user.userId) || null,
    expiresInDays: body && body.expiresInDays,
  });

  if (!share) {
    return json({ error: "share_failed", message: "Could not create a share link. Try again." }, 502);
  }

  const origin = (env.SITE_ORIGIN || "").replace(/\/$/, "");
  return json({
    ok: true,
    url: `${origin}/api/share/${share.token}`,
    token: share.token,
    expiresAt: share.expiresAt,
    expiresInDays: share.expiresInDays,
    defaultExpiresInDays: DEFAULT_SHARE_DAYS,
    maxExpiresInDays: MAX_SHARE_DAYS,
    message: "Anyone with this link can read this one report until it expires. It grants nothing else.",
  }, 201);
}

/** DELETE /api/runs/:id/share/:token — revoke a link early. */
export async function revokeRunShareHandler(request, env) {
  const scope = await runScopeFor(request, env);
  if (!scope) return json({ error: "unauthorized" }, 401);

  const token = request.params && request.params.token;
  if (!token) return json({ error: "invalid_request", message: "No share token supplied." }, 400);

  // Confirm the token belongs to a run this caller can read before deleting
  // it, so a guessed token cannot be revoked by someone outside the org.
  const existing = await readShare(env, token);
  const runId = existing.share && existing.share.runId;
  if (!runId || !(await getRun(env, scope, runId))) {
    return json({ error: "not_found", message: "No share link with that token on this organisation." }, 404);
  }

  // Pass the runId so the per-run index is pruned too, not just the token row.
  await revokeShare(env, token, runId);
  return json({ ok: true, revoked: true });
}

// ---------------------------------------------------------------------------
// GET /api/runs/:id/shares  — the links minted for this report
// ---------------------------------------------------------------------------
//
// Without this, a link is visible exactly once: in the response that minted
// it. Anyone who closed the dialog had no way to see what was still live, and
// no way to revoke a link they could no longer name — which made revocation
// theoretical for the one case it exists for (a report sent to the wrong
// client).
//
// Tokens are returned in full. They are already in the recipient's inbox, the
// caller is the org that minted them, and a truncated token cannot be revoked
// — there is nothing to protect here that is not already known to everyone
// who matters.
//
// Expired rows are included with `expired: true` rather than filtered, so the
// list distinguishes "this link stopped working" from "this link was never
// made". Both are answers; only one of them is silence.
export async function listRunSharesHandler(request, env) {
  const scope = await runScopeFor(request, env);
  if (!scope) return json({ error: "unauthorized" }, 401);

  const runId = request.params && request.params.id;
  if (!runId) return json({ error: "invalid_request", message: "No run id supplied." }, 400);

  // Same ownership gate the mint path uses: prove the caller can read the run
  // before disclosing which links exist for it.
  if (!(await getRun(env, scope, runId))) {
    return json({ error: "not_found", message: "No run with that id on this organisation." }, 404);
  }

  const origin = (env.SITE_ORIGIN || "").replace(/\/$/, "");
  const shares = await listShares(env, runId);

  return json({
    runId,
    count: shares.length,
    shares: shares.map((s) => ({
      token:     s.token,
      // Same shape the mint path returns — /api/share/:token, not /r/:token.
      // A list whose URLs differ from the one the user already copied would
      // read as two different links to the same report.
      url:       `${origin}/api/share/${s.token}`,
      createdAt: s.createdAt,
      expiresAt: s.expiresAt,
      expired:   s.expired,
    })),
  });
}

// ---------------------------------------------------------------------------
// GET /api/share/:token — public, read-only, one run
// ---------------------------------------------------------------------------

/**
 * Serve a shared report. NO SESSION REQUIRED — that is the whole feature.
 *
 * The token names exactly one run id, so possession of a link grants exactly
 * one report and nothing else: no listing, no other runs, no account access.
 */
export async function sharedReportHandler(request, env, ctx) {
  const token = request.params && request.params.token;

  const resolved = await readShare(env, token);
  if (!resolved.ok) {
    // Distinct wording, deliberately. "Expired" tells the reader to ask for a
    // fresh link; "not found" tells them to check the one they have. 410 Gone
    // is the honest status for something that existed and stopped.
    if (resolved.reason === "expired") {
      return json({
        error: "share_expired",
        message: "This report link has expired. Ask whoever sent it for a new one.",
      }, 410);
    }
    return json({
      error: "share_not_found",
      message: "This report link is not valid. It may have been revoked, or the address may be incomplete.",
    }, 404);
  }

  // Read the run by its own ids rather than through the caller — there is no
  // caller. The token is the authorisation, and it names both.
  const run = await getRun(env, { orgId: resolved.share.orgId, userId: null }, resolved.share.runId);
  if (!run) {
    return json({
      error: "share_not_found",
      message: "The report this link points to is no longer available.",
    }, 404);
  }

  const url = new URL(request.url);
  const format = (url.searchParams.get("format") || "html").toLowerCase();
  if (!REPORT_FORMATS.includes(format)) {
    return json({
      error: "unsupported_format",
      message: `Supported formats: ${REPORT_FORMATS.join(", ")}.`,
    }, 400);
  }

  const response = await renderReportResponse(env, ctx, run, format);
  // A shared report must never end up in a search index or a shared cache.
  response.headers.set("x-robots-tag", "noindex, nofollow");
  response.headers.set("cache-control", "private, no-store");
  return response;
}
