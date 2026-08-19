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
