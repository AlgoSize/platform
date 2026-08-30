// Admin-only endpoints.
//
// All endpoints in here are gated by `requireAdmin` — the caller must be
// authenticated AND their email must appear in the comma-separated
// env.ADMIN_EMAILS list. Non-admins get 403, not 404, so we don't accidentally
// leak which surfaces are admin-only via probing.
//
//   GET /api/admin/users          — JSON list of all users (paginated)
//   GET /api/admin/users.csv      — CSV export of the same data
//   GET /api/admin/schema-check   — which migrations the live database has
//   GET /api/admin/stripe-check   — Stripe account config the code depends on

import { requireAuth } from "../auth.js";
import { stripeFetch, StripeError } from "../stripe.js";
import { tierForOrg } from "../reports/branding.js";
import { aggregateBy, costTrend, topExpensive, budgetStatus, coverage, sortGroups, GROUP_SORTS } from "../ai/aggregate.js";

function jsonResponse(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...extraHeaders },
  });
}

function parseAdminEmails(env) {
  const raw = (env && env.ADMIN_EMAILS) || "";
  return raw.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
}

// Exported so /api/me can expose `isAdmin` to the dashboard without
// re-deriving the allowlist check — one definition of "is this email an
// admin", same as everything else in this file that reads ADMIN_EMAILS.
export function isAdmin(env, email) {
  if (!email) return false;
  return parseAdminEmails(env).includes(email.toLowerCase());
}

/**
 * Composable middleware: runs requireAuth, then checks admin allowlist.
 * Returns a 403 Response for non-admins; falls through to the next handler
 * for admins (itty-router treats `undefined` as continue).
 */
export async function requireAdmin(request, env) {
  const authRes = await requireAuth(request, env);
  if (authRes) return authRes;          // 401 from requireAuth
  const email = request.user && request.user.email;
  if (!isAdmin(env, email)) {
    return jsonResponse({ error: "forbidden", message: "Admin access required." }, 403);
  }
}

function csvEscape(value) {
  if (value === null || value === undefined) return "";
  const s = String(value);
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

async function fetchAllUsers(env) {
  // No artificial cap — admin export should see everything. If the user
  // table grows past ~100k rows we'll need server-side pagination, but
  // for an early-stage product this is fine.
  //
  // The org join is a LEFT join through `active_org_id`, not through
  // memberships: a user can belong to several orgs, and picking one of them
  // arbitrarily would make the column silently wrong for exactly the accounts
  // an operator is most likely to be investigating. `active_org_id` is the
  // org the user is currently acting as, which is a fact rather than a guess.
  const result = await env.DB
    .prepare(
      `SELECT u.user_id, u.email, u.plan, u.sub_status, u.stripe_customer_id,
              u.auth_method, u.active_org_id, u.created_at, u.updated_at,
              o.name AS org_name, o.sub_status AS org_sub_status, o.price_id AS org_price_id,
              m.role AS org_role
         FROM users u
         LEFT JOIN organisations o ON o.org_id = u.active_org_id
         LEFT JOIN memberships   m ON m.org_id = u.active_org_id AND m.user_id = u.user_id
         ORDER BY u.created_at DESC`,
    )
    .all();
  return (result && result.results) || [];
}

// ---------------------------------------------------------------------------
// GET /api/admin/users  — JSON
// ---------------------------------------------------------------------------
export async function adminListUsersHandler(request, env) {
  if (!env || !env.DB) {
    return jsonResponse({ error: "not_configured", message: "Database is not configured." }, 500);
  }
  const rows = await fetchAllUsers(env);
  let items = rows.map((r) => ({
    userId:           r.user_id,
    email:            r.email,
    plan:             r.plan || (r.stripe_customer_id ? "paid" : "free"),
    subStatus:        r.sub_status,
    stripeCustomerId: r.stripe_customer_id || null,
    createdAt:        r.created_at,
    updatedAt:        r.updated_at,
    orgId:            r.active_org_id || null,
    orgName:          r.org_name || null,
    orgSubStatus:     r.org_sub_status || null,
    // Null when the user has no active org, and also null for a user whose
    // active_org_id points at an org they are not a member of — which is a
    // real inconsistency worth being able to see rather than smoothing over.
    role:             r.org_role || null,
    tier:             tierForOrg(env, { priceId: r.org_price_id }),
    authMethod:       r.auth_method || null,
    // Rows predating migrations/0011 have not recorded a method. That is not
    // the same as "this account has no sign-in method", and the panel needs
    // to be able to tell the difference.
    authMethodKnown:  Boolean(r.auth_method),
  }));

  const url = new URL(request.url);
  const q = (url.searchParams.get("q") || "").trim().toLowerCase();
  if (q) {
    items = items.filter((u) =>
      u.email.toLowerCase().includes(q) ||
      u.userId.toLowerCase().includes(q) ||
      (u.orgName || "").toLowerCase().includes(q));
  }
  const plan = url.searchParams.get("plan");
  if (plan) items = items.filter((u) => u.plan === plan);

  return jsonResponse({ count: items.length, items, total: rows.length }, 200);
}

// ---------------------------------------------------------------------------
// GET /api/admin/users.csv  — CSV download
// ---------------------------------------------------------------------------
export async function adminUsersCsvHandler(request, env) {
  if (!env || !env.DB) {
    return new Response("error: database not configured\n", {
      status: 500,
      headers: { "content-type": "text/plain" },
    });
  }
  const rows = await fetchAllUsers(env);

  const headers = [
    "email", "plan", "sub_status", "stripe_customer_id",
    "user_id", "created_at_iso", "updated_at_iso",
  ];
  const lines = [headers.join(",")];
  for (const r of rows) {
    const createdIso = r.created_at ? new Date(r.created_at * 1000).toISOString() : "";
    const updatedIso = r.updated_at ? new Date(r.updated_at * 1000).toISOString() : "";
    lines.push([
      csvEscape(r.email),
      csvEscape(r.plan || (r.stripe_customer_id ? "paid" : "free")),
      csvEscape(r.sub_status),
      csvEscape(r.stripe_customer_id || ""),
      csvEscape(r.user_id),
      csvEscape(createdIso),
      csvEscape(updatedIso),
    ].join(","));
  }
  const body = lines.join("\n") + "\n";

  const today = new Date().toISOString().slice(0, 10);
  return new Response(body, {
    status: 200,
    headers: {
      "content-type":        "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="algosize-users-${today}.csv"`,
    },
  });
}

// ---------------------------------------------------------------------------
// GET /api/admin/ai-usage
// ---------------------------------------------------------------------------
//
// Platform-wide reporting still obeys the ai_usage tenant rule: every usage
// query has an explicit org_id predicate. We first enumerate organisations the
// admin is allowed to operate, then read each tenant separately. This is more
// queries than an unscoped SELECT, deliberately — a future change to admin
// identity must not turn this endpoint into an accidental cross-tenant read.
const AI_USAGE_WINDOWS = Object.freeze({
  "7d": 7 * 86_400_000,
  "30d": 30 * 86_400_000,
});
const AI_USAGE_GROUPS = Object.freeze({
  org: "org_id",
  model: "model",
  feature: "feature_name",
});

function aiUsageRange(windowName, now) {
  if (windowName === "period") {
    const d = new Date(now);
    return {
      startAt: Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1),
      endAt: now,
    };
  }
  return { startAt: now - AI_USAGE_WINDOWS[windowName], endAt: now };
}

/**
 * Margin as a share of what the customer is billed.
 *
 * Null unless BOTH sides were measured and revenue is non-zero — a ratio built
 * from an unmeasured numerator or denominator is not a small margin, it is no
 * margin figure at all. Revenue is the denominator (not raw cost), so a 25%
 * markup reads as 20% of revenue; that is the number an operator reconciles
 * against an invoice.
 */
function marginPct(marginUsd, revenueUsd) {
  if (typeof marginUsd !== "number" || typeof revenueUsd !== "number") return null;
  if (!(revenueUsd > 0)) return null;
  return (marginUsd / revenueUsd) * 100;
}

function usageTotals(rows) {
  if (!rows.length) {
    return {
      requests: 0, measuredRequests: 0, neurons: null, totalCostUsd: null,
      platformMarginUsd: null, algosizePriceUsd: null, marginPct: null, partial: false,
    };
  }
  const [total] = aggregateBy(rows.map((row) => ({ ...row, report_scope: "all" })), "report_scope");
  return {
    requests: total.requests,
    measuredRequests: total.measuredRequests,
    neurons: total.neurons,
    totalCostUsd: total.totalCostUsd,
    platformMarginUsd: total.platformMarginUsd,
    algosizePriceUsd: total.algosizePriceUsd,
    marginPct: marginPct(total.platformMarginUsd, total.algosizePriceUsd),
    partial: total.partial,
  };
}

/** Total tokens for a usage row — null when neither side was recorded. */
function totalTokens(row) {
  const inTok = typeof row.input_tokens === "number" ? row.input_tokens : null;
  const outTok = typeof row.output_tokens === "number" ? row.output_tokens : null;
  if (inTok === null && outTok === null) return null;
  return (inTok || 0) + (outTok || 0);
}

/**
 * Turn a D1 "no such table/column" into a named, actionable answer.
 *
 * Migrations in this platform are applied BY HAND — there is no ledger table
 * and the deploy pipeline does not run `wrangler d1 execute` (which is why
 * /api/admin/schema-check exists at all). So the single most likely reason
 * this panel cannot read is that migration 0025 was never applied to the
 * database it is pointed at, and an operator seeing "internal_error" has no
 * way to know that.
 *
 * Returns a body for a schema problem, or null for anything else — an
 * unexpected error must keep bubbling to the top-level handler so Sentry still
 * captures it. Swallowing every failure to make this panel look calm would be
 * the same mistake as rendering unmeasured spend as $0.
 */
function schemaGap(err) {
  const detail = String((err && err.message) || "");
  const m = /no such (table|column):\s*([A-Za-z0-9_.]+)/i.exec(detail);
  if (!m) return null;
  return {
    error: "schema_missing",
    message: `This database has no ${m[1]} \`${m[2]}\`, so there is no AI usage to read. ` +
      "Migration 0025_ai_usage has not been applied here — migrations are applied by hand, " +
      "so a deploy does not create it. Settings → Environment lists which migrations this " +
      "database actually has.",
    missing: { kind: m[1], name: m[2] },
    migration: "0025_ai_usage",
    // Not "no spend" and not "nothing recorded yet": the table that would hold
    // the answer is absent, so the question cannot be asked at all.
    state: "unreadable",
  };
}

/**
 * Every ai_usage read this panel makes, in one place.
 *
 * Kept together so the caller has exactly one place to catch a schema gap —
 * two separate try/catches around two queries is how one of them ends up
 * unguarded later.
 */
async function readUsage(env, range) {
  const orgResult = await env.DB.prepare(
    "SELECT org_id, name FROM organisations ORDER BY org_id"
  ).all();
  const orgs = (orgResult && orgResult.results) || [];

  const perOrg = await Promise.all(orgs.map(async (org) => {
    const result = await env.DB.prepare(
      `SELECT id, org_id, user_id, repository_id, feature_name, provider, model,
              request_type, input_tokens, output_tokens, neurons_consumed,
              total_cost, platform_margin_cost,
              algosize_price, status, error_code, scan_id, fix_task_id, created_at
         FROM ai_usage
        WHERE org_id = ? AND created_at >= ? AND created_at <= ?
        ORDER BY created_at DESC`
    ).bind(org.org_id, range.startAt, range.endAt).all();
    return (result && result.results) || [];
  }));

  // The newest recorded call for a known tenant, ignoring the window. This is
  // the difference between "this account spent nothing in the last 7 days" and
  // "nothing has ever written to ai_usage" — an empty table is a plumbing
  // problem, an empty window is a quiet week, and a dashboard that renders
  // both as an empty state teaches an operator to ignore the first one.
  // Queried per org with the same explicit binding as the usage read, so a row
  // outside the enumerated tenants can never widen the answer.
  const lastPerOrg = await Promise.all(orgs.map(async (org) => {
    const result = await env.DB.prepare(
      "SELECT MAX(created_at) AS last_at FROM ai_usage WHERE org_id = ?"
    ).bind(org.org_id).first();
    const at = result && result.last_at;
    return typeof at === "number" ? at : null;
  }));
  const seen = lastPerOrg.filter((at) => at !== null);

  return { orgs, rows: perOrg.flat(), lastRowAt: seen.length ? Math.max(...seen) : null };
}

function configuredAiBudget(env) {
  const n = Number(env && env.AI_BUDGET_USD);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export async function adminAiUsageHandler(request, env) {
  if (!env || !env.DB) {
    return jsonResponse({ error: "not_configured", message: "Database is not configured." }, 500);
  }

  const url = new URL(request.url);
  const windowName = url.searchParams.get("window") || "30d";
  const groupBy = url.searchParams.get("groupBy") || "org";
  if (!Object.prototype.hasOwnProperty.call(AI_USAGE_WINDOWS, windowName) && windowName !== "period") {
    return jsonResponse({
      error: "invalid_window",
      message: "window must be one of: 7d, 30d, period.",
    }, 400);
  }
  if (!Object.prototype.hasOwnProperty.call(AI_USAGE_GROUPS, groupBy)) {
    return jsonResponse({
      error: "invalid_group",
      message: "groupBy must be one of: org, model, feature.",
    }, 400);
  }
  // Sorting is server-side because the client only ever holds the rollup, and
  // the parking rule for unmeasured groups has to be applied where the null is
  // still a null — once a number reaches the table it is too late to tell an
  // unpriced group from a cheap one.
  const sort = url.searchParams.get("sort") || "cost";
  const dir = url.searchParams.get("dir") || "desc";
  if (!Object.prototype.hasOwnProperty.call(GROUP_SORTS, sort)) {
    return jsonResponse({
      error: "invalid_sort",
      message: "sort must be one of: " + Object.keys(GROUP_SORTS).join(", ") + ".",
    }, 400);
  }
  if (dir !== "asc" && dir !== "desc") {
    return jsonResponse({ error: "invalid_dir", message: "dir must be asc or desc." }, 400);
  }

  const now = Date.now();
  const range = aiUsageRange(windowName, now);

  let orgs, rows, lastRowAt;
  try {
    ({ orgs, rows, lastRowAt } = await readUsage(env, range));
  } catch (err) {
    const gap = schemaGap(err);
    // A schema gap is an operator fact, reported as one. Anything else is a
    // real bug and is re-thrown so the top-level handler captures it.
    if (!gap) throw err;
    return jsonResponse({ generatedAt: Math.floor(now / 1000), window: windowName, groupBy, ...gap }, 500);
  }

  const dimension = AI_USAGE_GROUPS[groupBy];
  const orgNames = new Map(orgs.map((org) => [org.org_id, org.name || org.org_id]));
  const limitUsd = configuredAiBudget(env);
  const groups = sortGroups(aggregateBy(rows, dimension).map((group) => {
    const key = group[dimension];
    return {
      key,
      label: groupBy === "org" ? (orgNames.get(key) || key) : key,
      requests: group.requests,
      measuredRequests: group.measuredRequests,
      // full | partial | none — the tri-state `partial` flattens. "none" is
      // what parks a group below the sort on a money scale.
      measured: group.measured,
      neurons: group.neurons,
      totalCostUsd: group.totalCostUsd,
      platformMarginUsd: group.platformMarginUsd,
      algosizePriceUsd: group.algosizePriceUsd,
      marginPct: marginPct(group.platformMarginUsd, group.algosizePriceUsd),
      partial: group.partial,
      errors: group.errors,
      budget: budgetStatus(group.algosizePriceUsd, limitUsd),
    };
  }), sort, dir);

  const expensive = topExpensive(rows, 10).map((row) => ({
    id: row.id,
    orgId: row.org_id,
    orgName: orgNames.get(row.org_id) || row.org_id,
    feature: row.feature_name,
    model: row.model,
    provider: row.provider,
    totalCostUsd: row.total_cost,
    platformMarginUsd: row.platform_margin_cost,
    algosizePriceUsd: row.algosize_price,
    neurons: typeof row.neurons_consumed === "number" ? row.neurons_consumed : null,
    // Tokens are what makes an expensive row explainable — "this call cost
    // $0.41" is a number, "611k tokens through a reasoning model" is a cause.
    // Null when the provider returned no usage block, never 0.
    inputTokens: typeof row.input_tokens === "number" ? row.input_tokens : null,
    outputTokens: typeof row.output_tokens === "number" ? row.output_tokens : null,
    totalTokens: totalTokens(row),
    scanId: row.scan_id || null,
    fixTaskId: row.fix_task_id || null,
    status: row.status,
    createdAt: row.created_at,
  }));

  return jsonResponse({
    generatedAt: Math.floor(now / 1000),
    window: windowName,
    groupBy,
    sort,
    dir,
    range,
    summary: usageTotals(rows),
    // How much of this window could be priced at all — the denominator under
    // every figure above. Rendered as a banner rather than left implicit,
    // because a total summed over measured rows only is a lower bound and must
    // say so.
    coverage: coverage(rows),
    // Why the page is empty, when it is. `no_rows_ever` is a plumbing failure
    // (nothing has ever reached ai_usage); `no_rows_in_window` is a quiet
    // period. Neither is $0 of spend.
    emptyState: rows.length ? null : {
      reason: lastRowAt === null ? "no_rows_ever" : "no_rows_in_window",
      lastRowAt,
    },
    lastRowAt,
    groups,
    trend: costTrend(rows, "day"),
    topExpensive: expensive,
    budget: {
      limitUsd,
      note: limitUsd === null
        ? "No AI_BUDGET_USD limit is configured; spend is tracked but not capped."
        : "Budget state is based on customer-billed revenue (raw cost plus margin).",
    },
  });
}

// ---------------------------------------------------------------------------
// GET /api/admin/schema-check
// ---------------------------------------------------------------------------
//
// Which migrations does the live database actually have?
//
// This exists because the deploy pipeline does NOT run `wrangler d1 execute`
// — migrations are applied by hand, and there has been no way to confirm from
// outside the Cloudflare account whether that ever happened. A worker whose
// code expects `organisations` while production still has the 0001 schema
// fails at request time with "no such table", which reads as a 500 rather
// than as "you forgot a migration". This turns that into one HTTPS call.
//
// IT REPORTS SCHEMA STATE, NOT MIGRATION HISTORY. There is no migrations
// ledger table; each entry below is judged by whether its signature table or
// column is present. A database built some other way — the e2e seed endpoint
// creates tables directly, for instance — reports "applied" for anything
// whose shape it happens to match. That is the honest answer to the question
// the caller is really asking ("does the schema have what the code needs?"),
// but it is not proof that a particular .sql file was executed.

/**
 * What each migration leaves behind, as a testable signature.
 *
 * A migration counts as applied only when EVERY check passes, so a partial
 * application (an ALTER that ran, a CREATE that didn't) reports false rather
 * than rounding up to done. The per-check detail is in the response so the
 * caller can see which half is missing.
 *
 * Kept in this file rather than derived from migrations/*.sql because the
 * Worker bundle has no filesystem — and because parsing SQL to guess at its
 * effects would be a second, worse implementation of the thing being checked.
 */
const MIGRATIONS = Object.freeze([
  { id: "0001", name: "init",
    checks: [{ table: "users" }, { table: "runs" }] },
  { id: "0002", name: "entitlement",
    checks: [{ table: "users", column: "current_period_end" }] },
  { id: "0003", name: "subscription_details",
    checks: [{ table: "users", column: "quantity" }, { table: "users", column: "price_id" }] },
  // 0004 does three things; all three are checked because an org table with
  // no memberships table would leave every /api/org call broken in a way the
  // table check alone would miss.
  { id: "0004", name: "orgs",
    checks: [{ table: "organisations" }, { table: "memberships" }, { table: "users", column: "active_org_id" }] },
  { id: "0005", name: "api_keys",
    checks: [{ table: "api_keys" }] },
  { id: "0006", name: "monitors",
    checks: [{ table: "monitors" }] },
  // 0007 is a full table rebuild — the surviving evidence is the two columns
  // the rebuilt table gained.
  { id: "0007", name: "runs_org",
    checks: [{ table: "runs", column: "org_id" }, { table: "runs", column: "source" }] },
  { id: "0008", name: "org_branding",
    checks: [{ table: "organisations", column: "brand_company_name" },
             { table: "organisations", column: "brand_logo_url" }] },
  { id: "0009", name: "monitor_delta",
    checks: [{ table: "monitors", column: "last_delta_json" }] },
  { id: "0010", name: "audit_log",
    checks: [{ table: "audit_log" }] },
  { id: "0011", name: "user_auth_method",
    checks: [{ table: "users", column: "auth_method" }] },
  { id: "0012", name: "webhook_deliveries",
    checks: [{ table: "webhook_deliveries" }] },
  { id: "0013", name: "email_sends",
    checks: [{ table: "email_sends" }] },
  { id: "0014", name: "feature_flags",
    checks: [{ table: "feature_flags" }] },
  // 0015 spans five concerns because they ship as one screen. Checked at both
  // ends — a column added by the first statement and a table created by the
  // last — so a migration that died partway through reports as missing rather
  // than as applied.
  { id: "0015", name: "account_management",
    checks: [{ table: "users", column: "display_name" },
             { table: "organisations", column: "brand_domain" },
             { table: "email_changes" },
             { table: "notification_prefs" },
             { table: "referral_codes" },
             { table: "credit_events" }] },
  // Checked at both ends (first and last ALTER) so a partial apply reports
  // as missing rather than as applied.
  { id: "0016", name: "monitor_analyzers",
    checks: [{ table: "monitors", column: "analyzers" },
             { table: "monitors", column: "last_algo_json" }] },
  { id: "0017", name: "monitor_health",
    checks: [{ table: "monitors", column: "last_status" },
             { table: "monitors", column: "last_attempt_at" },
             { table: "monitors", column: "run_at_hour" },
             { table: "monitors", column: "last_severity_json" }] },
  { id: "0018", name: "arch_snapshots",
    checks: [{ table: "arch_snapshots", column: "snapshot_id" },
             { table: "arch_snapshots", column: "graph_json" },
             { table: "arch_snapshots", column: "prev_snapshot_id" }] },
  { id: "0019", name: "mcp",
    checks: [{ table: "mcp_clients", column: "client_id" },
             { table: "mcp_authorizations", column: "code_challenge" },
             { table: "mcp_tokens", column: "token_hash" },
             { table: "mcp_tokens", column: "parent_token_id" },
             { table: "mcp_tool_calls", column: "tool_name" },
             // The §1.10 provenance columns. Checked here because their
             // absence is silent: runs still persist without them, they just
             // lose the label saying which credential produced them.
             { table: "runs", column: "credential_kind" },
             { table: "runs", column: "credential_id" }] },
  { id: "0020", name: "flag_overrides",
    checks: [{ table: "feature_flag_overrides", column: "flag_key" },
             { table: "feature_flag_overrides", column: "subject" }] },
  { id: "0021", name: "mcp_session_ref",
    // Absence is silent in the same way as §1.10: calls still log without the
    // column's index-side twin, they just never group into sessions.
    checks: [{ table: "mcp_tool_calls", column: "session_ref" }] },
  { id: "0022", name: "monitor_skips",
    // Absence is silent too, and in the worst direction: without it a skipped
    // analyzer's empty baseline renders as a measured zero.
    checks: [{ table: "monitors", column: "last_skips_json" }] },
  { id: "0023", name: "scorecard_evidence",
    // Silent again: without these the Cloud spend column is permanently
    // "first run pending" no matter how many sweeps succeed, and the
    // architecture zero goes back to being unfalsifiable.
    checks: [{ table: "monitors", column: "last_cost_json" },
             { table: "monitors", column: "last_arch_scope_json" }] },
  { id: "0024", name: "monitor_source_findings",
    // Silent in the worst direction again: without it the sweep scans the
    // source, finds nothing to store it in, and the scorecard keeps grading
    // the advisory list alone — a repo with twelve injection findings reads
    // as clean.
    checks: [{ table: "monitors", column: "last_source_json" }] },
  { id: "0025", name: "ai_usage",
    // AI metering foundation. Without it every Workers AI call is unbilled and
    // untracked — the meter has nowhere to write, so per-org AI spend reads as
    // zero when it is merely unrecorded. The margin column and margin_config
    // table are checked too: if they are missing the meter writes raw cost with
    // no markup, silently under-billing every customer.
    checks: [{ table: "ai_usage", column: "neurons_consumed" },
             { table: "ai_usage", column: "algosize_price" },
             { table: "margin_config", column: "margin_rate" }] },
  { id: "0026", name: "fix_pipeline",
    // Multi-model fix pipeline routing. Absent, resolveStageModel silently
    // falls back to the recommendation engine for every stage — the pipeline
    // still runs, but an operator's routing overrides are ignored, so the
    // schema check exists to make a missing table visible rather than silent.
    checks: [{ table: "model_routing_config", column: "model_id" }] },
  { id: "0027", name: "scan_patches",
    // Agent-applied patch provenance (MCP handoff). Absent, algosize_record_patch
    // has nowhere to record that an external agent fixed a finding, so the
    // patch history reads empty when it is merely unstored.
    checks: [{ table: "scan_patches", column: "patch_hash" }] },
]);

/** Plain SQLite identifier — the only shape we will interpolate into a PRAGMA. */
const SAFE_IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

async function listTables(env) {
  const res = await env.DB
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all();
  return ((res && res.results) || []).map((r) => r.name);
}

/**
 * Column names on a table, or [] when the table does not exist.
 *
 * PRAGMA does not accept a bound parameter, so the table name is
 * interpolated. Every name reaching here comes from the frozen MIGRATIONS
 * manifest above — never from the request — and is re-checked against
 * SAFE_IDENT anyway, because "the caller can't reach this" is the kind of
 * invariant that quietly stops being true.
 */
async function listColumns(env, table) {
  if (!SAFE_IDENT.test(table)) return [];
  try {
    const res = await env.DB.prepare(`PRAGMA table_info(${table})`).all();
    return ((res && res.results) || []).map((r) => r.name);
  } catch {
    // D1 raises rather than returning empty for some missing-table cases.
    return [];
  }
}

export async function adminSchemaCheckHandler(request, env) {
  if (!env || !env.DB) {
    return jsonResponse(
      { ok: false, error: "not_configured", message: "Database is not configured." },
      500,
    );
  }

  let tables;
  try {
    tables = await listTables(env);
  } catch (err) {
    return jsonResponse(
      {
        ok: false,
        error: "database_unreachable",
        message: `Could not read the schema: ${(err && err.message) || "unknown error"}`,
      },
      500,
    );
  }
  const tableSet = new Set(tables);

  // One PRAGMA per table, not per check — 0004 and 0008 both interrogate
  // `organisations`, and this endpoint should stay a single cheap round trip.
  const columnCache = new Map();
  const columnsOf = async (table) => {
    if (!columnCache.has(table)) {
      columnCache.set(table, tableSet.has(table) ? await listColumns(env, table) : []);
    }
    return columnCache.get(table);
  };

  const migrations = [];
  for (const m of MIGRATIONS) {
    const checks = [];
    for (const c of m.checks) {
      if (c.column) {
        const cols = await columnsOf(c.table);
        checks.push({
          kind: "column",
          target: `${c.table}.${c.column}`,
          present: cols.includes(c.column),
        });
      } else {
        checks.push({ kind: "table", target: c.table, present: tableSet.has(c.table) });
      }
    }
    migrations.push({
      migration: m.id,
      name: m.name,
      applied: checks.every((c) => c.present),
      checks,
    });
  }

  const pending = migrations.filter((m) => !m.applied).map((m) => m.migration);
  const appliedCount = migrations.length - pending.length;

  return jsonResponse({
    // The field to script against. The status stays 200 whenever the schema
    // could be READ — "some migrations are pending" is a successful report,
    // not a failed request, and conflating the two makes a curl -f useless
    // for telling a broken endpoint from a broken database.
    ok: pending.length === 0,
    appliedCount,
    total: migrations.length,
    pending,
    summary: pending.length === 0
      ? `All ${migrations.length} migrations are applied.`
      : `${appliedCount} of ${migrations.length} applied; pending: ${pending.join(", ")}. ` +
        `Apply with: wrangler d1 execute algosize --env production --remote --file=migrations/<file>.sql`,
    migrations,
    tables,
    note: "Reports schema STATE, not migration history — there is no ledger table. " +
          "A database built another way (e.g. the e2e seed endpoint) can match a " +
          "signature without the .sql file ever having run.",
  }, 200);
}

// ---------------------------------------------------------------------------
// GET /api/admin/stripe-check
// ---------------------------------------------------------------------------
//
// Two pieces of Stripe ACCOUNT configuration that the code depends on, that
// live outside the repo, and that fail in ways nothing in CI can see.
//
// Neither is expressible as a secret or a wrangler.toml entry — both are
// dashboard state — so the only way to know they are right is to ask Stripe.
// Both failures are also invisible until a real customer hits them:
//
//   Portal configuration  /api/billing/portal calls
//                         POST /billing_portal/sessions, which 400s with "No
//                         configuration provided" until a default exists in
//                         THIS mode. Every "Manage billing" click fails, and
//                         it fails for the first paying customer rather than
//                         in any test.
//
//   Webhook endpoint      The webhook is the only thing that writes
//                         subscription state back. Without a live endpoint
//                         pointed at this deployment, checkout still works —
//                         the customer pays — but the renewal, cancellation
//                         and payment_failed events never arrive, so
//                         entitlement silently drifts from what Stripe thinks.
//                         A cancelled subscriber keeps their access forever.
//
// MODE IS REPORTED BECAUSE IT DECIDES WHAT WAS ACTUALLY CHECKED. Stripe's
// live and test modes are separate worlds: separate portal configurations,
// separate webhook endpoints, separate prices. A green result in test mode
// says nothing about live. The mode comes from the key prefix rather than an
// API call, so the answer is available even when the key is rejected.

/** Events the webhook handler acts on (handlers/webhook.js). */
const REQUIRED_WEBHOOK_EVENTS = Object.freeze([
  "checkout.session.completed",
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "customer.subscription.trial_will_end",
  "invoice.paid",
  "invoice.payment_failed",
]);

/**
 * Which Stripe mode a key belongs to, from its prefix alone.
 *
 * `sk_` is a standard secret key, `rk_` a restricted one; both carry the mode
 * in the same position. Anything else is reported as "unknown" rather than
 * guessed — a wrong mode label is worse than an absent one, because the whole
 * point of this field is telling the reader which of the two worlds the rest
 * of the response describes.
 */
export function stripeKeyMode(key) {
  if (typeof key !== "string") return "unknown";
  if (/^[sr]k_live_/.test(key)) return "live";
  if (/^[sr]k_test_/.test(key)) return "test";
  return "unknown";
}

/** Compare two webhook URLs the way Stripe does: host case-insensitive, no trailing slash. */
function sameUrl(a, b) {
  const norm = (u) => {
    try {
      const parsed = new URL(u);
      return `${parsed.protocol}//${parsed.host.toLowerCase()}${parsed.pathname.replace(/\/$/, "")}`;
    } catch {
      return String(u || "").replace(/\/$/, "");
    }
  };
  return norm(a) === norm(b);
}

/** Dashboard deep link for the mode actually in use — test URLs carry /test/. */
function dashboardUrl(mode, path) {
  return `https://dashboard.stripe.com/${mode === "test" ? "test/" : ""}${path}`;
}

export async function adminStripeCheckHandler(request, env) {
  if (!env || !env.STRIPE_SECRET_KEY) {
    return jsonResponse(
      { ok: false, error: "not_configured", message: "STRIPE_SECRET_KEY is not set on this environment." },
      500,
    );
  }

  const mode = stripeKeyMode(env.STRIPE_SECRET_KEY);

  let configurations, endpoints;
  try {
    // Two calls, not one — Stripe has no combined endpoint, and both lists are
    // small enough that limit=100 is the whole set for any real account.
    [configurations, endpoints] = await Promise.all([
      stripeFetch(env, "/billing_portal/configurations?limit=100", { method: "GET" }),
      stripeFetch(env, "/webhook_endpoints?limit=100", { method: "GET" }),
    ]);
  } catch (err) {
    // A rejected key is a broken deployment, not a failed check — same
    // distinction schema-check draws between "cannot read" and "read, and
    // here is what is missing". 500 so `curl -f` separates the two.
    const isStripe = err instanceof StripeError;
    return jsonResponse(
      {
        ok:    false,
        error: "stripe_unreachable",
        mode,
        message: isStripe && err.status === 401
          ? "Stripe rejected the configured STRIPE_SECRET_KEY (401). It is wrong, revoked, or a restricted key without read access to billing settings."
          : `Could not reach the Stripe API: ${(err && err.message) || "unknown error"}`,
      },
      500,
    );
  }

  // --- 1. Customer Portal default configuration ---------------------------
  const configs      = (configurations && configurations.data) || [];
  const defaultConfig = configs.find((c) => c && c.is_default && c.active !== false);
  const portalCheck = defaultConfig
    ? { ok: true, detail: `Default configuration ${defaultConfig.id} is active.` }
    : {
        ok: false,
        detail: configs.length === 0
          ? "No Customer Portal configuration exists in this mode."
          : `${configs.length} configuration(s) exist but none is both default and active.`,
        fix: `Open ${dashboardUrl(mode, "settings/billing/portal")} and press Save once. ` +
             "Until then every /api/billing/portal call 400s with \"No configuration provided\".",
      };

  // --- 2. Webhook endpoint pointed at this deployment ---------------------
  const origin   = (env.SITE_ORIGIN || "").replace(/\/$/, "");
  const expected = origin ? `${origin}/api/stripe/webhook` : null;
  const all      = (endpoints && endpoints.data) || [];

  let webhookCheck;
  if (!expected) {
    // Without SITE_ORIGIN there is no URL to look for, and reporting the
    // first endpoint found would be a guess. Say so instead.
    webhookCheck = {
      ok: false,
      detail: "SITE_ORIGIN is not set, so the expected webhook URL cannot be determined.",
      fix: "Set SITE_ORIGIN in wrangler.toml for this environment.",
    };
  } else {
    const match = all.find((e) => e && sameUrl(e.url, expected));
    if (!match) {
      webhookCheck = {
        ok: false,
        expected,
        detail: all.length === 0
          ? "No webhook endpoints exist in this mode."
          : `${all.length} endpoint(s) exist, none pointed at this deployment. Found: ${all.map((e) => e.url).join(", ")}.`,
        fix: `Create one at ${dashboardUrl(mode, "webhooks")} for ${expected}, subscribed to: ` +
             `${REQUIRED_WEBHOOK_EVENTS.join(", ")}. Then push its signing secret as STRIPE_WEBHOOK_SECRET.`,
      };
    } else {
      // `["*"]` is Stripe's "everything" wildcard and satisfies every event.
      const enabled = match.enabled_events || [];
      const missing = enabled.includes("*")
        ? []
        : REQUIRED_WEBHOOK_EVENTS.filter((e) => !enabled.includes(e));
      const disabled = match.status !== "enabled";
      webhookCheck = {
        ok: !disabled && missing.length === 0,
        id: match.id,
        url: match.url,
        status: match.status,
        missingEvents: missing,
        detail: disabled
          ? `Endpoint ${match.id} exists but its status is "${match.status}".`
          : missing.length
            ? `Endpoint ${match.id} is enabled but is not subscribed to: ${missing.join(", ")}.`
            : `Endpoint ${match.id} is enabled and subscribed to all ${REQUIRED_WEBHOOK_EVENTS.length} events the worker handles.`,
        ...(disabled || missing.length
          ? { fix: `Edit it at ${dashboardUrl(mode, "webhooks")} — an endpoint that exists but is disabled or missing events fails silently: checkout still succeeds and the customer is charged, but subscription state never updates.` }
          : {}),
      };
    }
  }

  const failing = [
    !portalCheck.ok  ? "customer portal" : null,
    !webhookCheck.ok ? "webhook endpoint" : null,
  ].filter(Boolean);

  return jsonResponse({
    ok: failing.length === 0,
    mode,
    summary: failing.length === 0
      ? `Stripe ${mode} mode is correctly configured: portal default present, webhook endpoint enabled.`
      : `Stripe ${mode} mode is missing: ${failing.join(" and ")}.`,
    checks: { portalConfiguration: portalCheck, webhookEndpoint: webhookCheck },
    note: "Live and test are separate Stripe modes with separate portal configurations, " +
          "webhook endpoints and prices. This reports only the mode the deployed " +
          "STRIPE_SECRET_KEY belongs to.",
  }, 200);
}


// ---------------------------------------------------------------------------
// GET /api/admin/sandbox-check
// ---------------------------------------------------------------------------
//
// The counterpart to stripe-check, for the one binding whose absence is
// invisible until a nightly sweep reports nonsense.
//
// `bindingState` in the settings endpoint already answers "is env.SANDBOX
// present". That is necessary and not sufficient: a binding can be present and
// point at a service that is failing, and the difference matters because the
// remedies differ (deploy the sandbox vs. read the sandbox's own logs).
//
// Until now the only way to tell those apart was to trigger a full monitor
// sweep and read the optimizer panel — a minutes-long round trip through
// unrelated machinery, for a question that is one request wide. So this asks
// directly: it sends a trivial function through the real binding and reports
// which of four states the deployment is in.
//
// The probe is deliberately the most boring program that still proves the
// whole path: it compiles, runs, and returns a value we can compare against.
// If `1 + 1` comes back as 2 through the service binding, the sandbox is live.
const SANDBOX_PROBE = "function run(input) { return input.a + input.b; }";

export async function adminSandboxCheckHandler(request, env) {
  const bound = Boolean(env && env.SANDBOX && typeof env.SANDBOX.fetch === "function");
  if (!bound) {
    return jsonResponse({
      ok: false,
      state: "not_bound",
      message: "env.SANDBOX is not a service binding on this deployment.",
      // The consequence, named — an operator reading this should not have to
      // know what the binding is for.
      impact: "The optimizer cannot grade any function. Monitors stay on FIRST RUN " +
              "PENDING, no baseline is recorded, and no regression alert can fire.",
      fix: "Deploy the algosize-sandbox Worker, then redeploy this Worker so the " +
           "binding resolves. See [[env.production.services]] in worker/wrangler.toml.",
    }, 200);
  }

  const startedAt = Date.now();
  let res;
  try {
    res = await env.SANDBOX.fetch("https://sandbox.internal/run", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: SANDBOX_PROBE, input: { a: 1, b: 1 } }),
    });
  } catch (err) {
    return jsonResponse({
      ok: false,
      state: "unreachable",
      message: `The binding exists but the sandbox service did not answer: ${String(err && err.message || err)}`,
      impact: "Grading fails for every entry until the sandbox service recovers.",
      fix: "Check the algosize-sandbox Worker's own logs and deployment status.",
      elapsedMs: Date.now() - startedAt,
    }, 200);
  }

  let body = null;
  try { body = await res.json(); } catch { /* handled as bad_response below */ }
  const elapsedMs = Date.now() - startedAt;

  if (!body || typeof body !== "object") {
    return jsonResponse({
      ok: false, state: "bad_response", elapsedMs,
      message: `The sandbox answered ${res.status} with a body that is not JSON.`,
      impact: "Grading fails for every entry.",
      fix: "The bound service is answering but is not the sandbox, or is a version " +
           "that predates the /run contract. Redeploy algosize-sandbox.",
    }, 200);
  }

  // The probe's own result is the proof. A sandbox that answers but cannot
  // execute — the exact production failure this endpoint exists for — comes
  // back ok:false here, and reporting it as "working" because HTTP said 200
  // would reproduce the original bug at a new layer.
  const ran = body.ok !== false && body.sampleResult === 2;
  if (!ran) {
    return jsonResponse({
      ok: false, state: "bad_response", elapsedMs,
      message: body.ok === false
        ? `The sandbox refused the probe: ${body.error || "unknown"} — ${body.message || ""}`.trim()
        : `The sandbox ran the probe but returned ${JSON.stringify(body.sampleResult)} instead of 2.`,
      impact: "Grading fails or produces wrong numbers.",
      fix: "Check the algosize-sandbox Worker's logs; redeploy it if it is out of date.",
    }, 200);
  }

  return jsonResponse({
    ok: true, state: "bound_and_working", elapsedMs,
    message: `The sandbox executed a probe function and returned the expected value in ${elapsedMs}ms.`,
  }, 200);
}
