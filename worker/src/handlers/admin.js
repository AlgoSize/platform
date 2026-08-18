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

import { requireAuth } from "../auth.js";

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

function isAdmin(env, email) {
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
  const result = await env.DB
    .prepare(
      `SELECT user_id, email, plan, sub_status, stripe_customer_id,
              created_at, updated_at
         FROM users
         ORDER BY created_at DESC`,
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
  const items = rows.map((r) => ({
    userId:           r.user_id,
    email:            r.email,
    plan:             r.plan || (r.stripe_customer_id ? "paid" : "free"),
    subStatus:        r.sub_status,
    stripeCustomerId: r.stripe_customer_id || null,
    createdAt:        r.created_at,
    updatedAt:        r.updated_at,
  }));
  return jsonResponse({ count: items.length, items }, 200);
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
