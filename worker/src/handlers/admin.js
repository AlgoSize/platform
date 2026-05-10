// Admin-only endpoints.
//
// All endpoints in here are gated by `requireAdmin` — the caller must be
// authenticated AND their email must appear in the comma-separated
// env.ADMIN_EMAILS list. Non-admins get 403, not 404, so we don't accidentally
// leak which surfaces are admin-only via probing.
//
//   GET /api/admin/users          — JSON list of all users (paginated)
//   GET /api/admin/users.csv      — CSV export of the same data

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
