// The admin control panel's read API.
//
// Every endpoint here is behind `requireAdmin` (see admin.js) and every one
// of them reads. The panel's write actions live on the endpoints the product
// already has — revoking a key is the same call an owner makes — with two
// exceptions that only make sense for an operator: revoking someone else's
// session, and flipping a feature flag.
//
//   GET   /api/admin/overview            KPIs, alerts, recent activity
//   GET   /api/admin/accounts            one row per organisation
//   GET   /api/admin/accounts/:orgId     everything about one account
//   GET   /api/admin/users/:userId       one user, with sessions and activity
//   DELETE /api/admin/users/:userId/sessions/:sessionId
//   GET   /api/admin/billing             failed payments and revenue
//   GET   /api/admin/automation          monitors, webhooks, email
//   GET   /api/admin/audit               the audit log, filtered
//   GET   /api/admin/flags               feature flags
//   PATCH /api/admin/flags/:key          set one
//   GET   /api/admin/settings            admins, connections, environment
//
// THE RULE THIS FILE IS BUILT AROUND
//
// An admin panel is a decision-making surface. Every number on it will be
// used to decide whether to act, so a number we cannot compute must come
// back as null with a stated reason — never as zero, and never as a
// plausible estimate. "0 failed payments" and "we can't reach Stripe" lead
// to opposite actions, and a panel that renders the second as the first is
// worse than a panel that renders nothing.
//
// Anywhere this file returns null you will find the reason beside it, and
// anywhere it returns a partial answer you will find a flag saying so.

import { stripeFetch, StripeError, PLANS, INTERVALS } from "../stripe.js";
import { tierForOrg } from "../reports/branding.js";
import { listAuditEvents, writeAudit, AUDIT_ACTIONS } from "../audit.js";
import { listWebhookDeliveries, listEmailSends, WEBHOOK_OUTCOME, EMAIL_OUTCOME } from "../oplog.js";
import { listFlags, upsertFlag, FLAG_KEY_RE } from "../flags.js";
import { listUserSessions, revokeUserSession } from "../sessions.js";
import { resolveEntitlementForOrg } from "../entitlement.js";

function jsonResponse(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...extraHeaders },
  });
}

function notConfigured() {
  return jsonResponse({ error: "not_configured", message: "Database is not configured." }, 500);
}

const nowSec = () => Math.floor(Date.now() / 1000);
const DAY = 86_400;

async function allRows(env, sql, ...binds) {
  const res = await env.DB.prepare(sql).bind(...binds).all();
  return (res && res.results) || [];
}

// ---------------------------------------------------------------------------
// Stripe price amounts — the only route to a real MRR figure
// ---------------------------------------------------------------------------
//
// We store `price_id` on the org, never an amount. Deriving revenue therefore
// means asking Stripe what the configured prices cost. That is at most a
// dozen prices (plan × interval × optional seat), so it is a bounded number
// of calls, cached for the life of the isolate.
//
// If Stripe is unreachable or unconfigured, this returns null and every
// revenue figure downstream becomes null with a reason. It does not fall back
// to a hardcoded price list: a stale hardcoded number is indistinguishable
// from a live one on screen, and that is precisely the confusion that makes
// someone act on it.

let priceCache = null;

function configuredPriceIds(env) {
  const ids = new Map();   // priceId -> { plan, interval, perSeat }
  for (const plan of PLANS) {
    for (const interval of INTERVALS) {
      const key = `STRIPE_PRICE_${plan.toUpperCase()}_${interval.toUpperCase()}`;
      if (env[key])                ids.set(env[key],                { plan, interval, perSeat: false });
      if (env[`${key}_SEAT`])      ids.set(env[`${key}_SEAT`],      { plan, interval, perSeat: true });
    }
  }
  if (env.STRIPE_PRICE_ID) ids.set(env.STRIPE_PRICE_ID, { plan: null, interval: null, perSeat: false });
  return ids;
}

async function loadPrices(env, ctx) {
  if (priceCache) return priceCache;
  if (!env.STRIPE_SECRET_KEY) return { ok: false, reason: "stripe_not_configured", prices: new Map() };

  const wanted = configuredPriceIds(env);
  if (wanted.size === 0) return { ok: false, reason: "no_prices_configured", prices: new Map() };

  const prices = new Map();
  for (const [priceId, meta] of wanted) {
    try {
      const price = await stripeFetch(env, `/prices/${encodeURIComponent(priceId)}`, { method: "GET" });
      prices.set(priceId, {
        ...meta,
        unitAmount: typeof price.unit_amount === "number" ? price.unit_amount : null,
        currency:   price.currency || null,
        // A yearly price contributes a twelfth of itself to a MONTHLY revenue
        // figure. Adding an annual price to a monthly one at face value
        // inflates MRR by 12x for that customer, which is the single easiest
        // way to make this number wrong in a direction nobody questions.
        perMonth:   price.recurring && price.recurring.interval === "year",
      });
    } catch (err) {
      if (err instanceof StripeError) {
        return { ok: false, reason: "stripe_unreachable", detail: err.message, prices: new Map() };
      }
      throw err;
    }
  }
  priceCache = { ok: true, reason: null, prices };
  return priceCache;
}

/** Test seam — the cache is per-isolate and would otherwise leak across suites. */
export function _resetPriceCache() { priceCache = null; }

/**
 * Monthly recurring revenue for one org, in the price's smallest currency
 * unit. Returns null when we hold no amount for that org's price — an org on
 * a price created outside our config is UNKNOWN revenue, not zero revenue.
 */
function mrrForOrg(org, prices) {
  if (!org.priceId) return 0;                      // free org: genuinely zero
  const price = prices.get(org.priceId);
  if (!price || price.unitAmount === null) return null;
  const seats  = price.perSeat ? Math.max(1, org.seatsPurchased || 1) : 1;
  const amount = price.unitAmount * seats;
  return price.perMonth ? Math.round(amount / 12) : amount;
}

// ---------------------------------------------------------------------------
// Shared org loading
// ---------------------------------------------------------------------------

function rowToOrg(row) {
  return {
    orgId:            row.org_id,
    name:             row.name,
    stripeCustomerId: row.stripe_customer_id || null,
    plan:             row.plan,
    subStatus:        row.sub_status || null,
    currentPeriodEnd: row.current_period_end || null,
    seatsPurchased:   row.seats_purchased,
    priceId:          row.price_id || null,
    createdAt:        row.created_at,
    updatedAt:        row.updated_at,
  };
}

async function loadOrgs(env) {
  return (await allRows(env,
    `SELECT org_id, name, stripe_customer_id, plan, sub_status, current_period_end,
            seats_purchased, price_id, created_at, updated_at
       FROM organisations ORDER BY created_at DESC`,
  )).map(rowToOrg);
}

/** memberCount and pendingInvites are separate reads; both are cheap aggregates. */
async function memberCounts(env) {
  const rows = await allRows(env, `SELECT org_id, COUNT(*) AS n FROM memberships GROUP BY org_id`);
  return new Map(rows.map((r) => [r.org_id, r.n]));
}

async function runCountsSince(env, since) {
  const rows = await allRows(env,
    `SELECT org_id, source, COUNT(*) AS n FROM runs WHERE created_at >= ? GROUP BY org_id, source`, since);
  const byOrg = new Map();
  for (const r of rows) {
    const entry = byOrg.get(r.org_id) || { total: 0, ci: 0, dashboard: 0 };
    entry.total += r.n;
    if (r.source === "ci") entry.ci += r.n;
    else entry.dashboard += r.n;
    byOrg.set(r.org_id, entry);
  }
  return byOrg;
}

async function monitorCounts(env) {
  const rows = await allRows(env,
    `SELECT org_id,
            COUNT(*) AS n,
            SUM(CASE WHEN paused_at IS NULL THEN 1 ELSE 0 END) AS active
       FROM monitors GROUP BY org_id`);
  return new Map(rows.map((r) => [r.org_id, { total: r.n, active: r.active }]));
}

// ---------------------------------------------------------------------------
// GET /api/admin/overview
// ---------------------------------------------------------------------------

export async function adminOverviewHandler(request, env, ctx) {
  if (!env || !env.DB) return notConfigured();

  const now   = nowSec();
  const orgs  = await loadOrgs(env);
  const priceInfo = await loadPrices(env, ctx);

  // --- subscriptions ------------------------------------------------------
  const entitling = orgs.filter((o) => o.subStatus === "active" || o.subStatus === "trialing");
  const trialing  = orgs.filter((o) => o.subStatus === "trialing");
  const dunning   = orgs.filter((o) => o.subStatus === "past_due" || o.subStatus === "unpaid");

  // --- revenue ------------------------------------------------------------
  let mrr = 0;
  let unpriced = 0;
  for (const org of entitling) {
    const amount = mrrForOrg(org, priceInfo.prices);
    if (amount === null) unpriced += 1;
    else mrr += amount;
  }
  const revenue = priceInfo.ok
    ? {
        // Cents. Formatting belongs to the client, which knows the locale.
        mrr,
        currency: [...priceInfo.prices.values()].map((p) => p.currency).find(Boolean) || null,
        // Not a footnote: with unpriced orgs the figure is a FLOOR, and a
        // floor presented as a total is a number someone will plan against.
        partial:  unpriced > 0,
        unpricedOrgs: unpriced,
        reason:   unpriced > 0 ? "some_orgs_on_unconfigured_prices" : null,
      }
    : { mrr: null, currency: null, partial: false, unpricedOrgs: 0, reason: priceInfo.reason };

  // --- free accounts near their quota ------------------------------------
  // FREE_MONTHLY_LIMIT is 5; "near" is 4 or more used this calendar month.
  const monthStart = Math.floor(new Date(new Date(now * 1000).toISOString().slice(0, 7) + "-01T00:00:00Z").getTime() / 1000);
  const freeOrgIds = new Set(orgs.filter((o) => o.plan !== "paid").map((o) => o.orgId));
  const monthRuns  = await runCountsSince(env, monthStart);
  let nearQuota = 0;
  for (const [orgId, counts] of monthRuns) {
    if (freeOrgIds.has(orgId) && counts.total >= 4) nearQuota += 1;
  }

  // --- runs today ---------------------------------------------------------
  const todayStart = now - (now % DAY);
  const todayRuns  = await runCountsSince(env, todayStart);
  const runsToday  = [...todayRuns.values()].reduce(
    (acc, c) => ({ total: acc.total + c.total, ci: acc.ci + c.ci, dashboard: acc.dashboard + c.dashboard }),
    { total: 0, ci: 0, dashboard: 0 },
  );

  // --- monitors -----------------------------------------------------------
  const monitorSummary = await sweepSummary(env, now);

  // --- alerts -------------------------------------------------------------
  // Each alert is a fact plus where to go about it. Nothing is an alert
  // unless there is an action; a panel that alerts on everything is a panel
  // whose alerts get ignored.
  const alerts = [];

  const graceSoon = dunning.filter(
    (o) => o.currentPeriodEnd && o.currentPeriodEnd > now && o.currentPeriodEnd - now < 3 * DAY,
  );
  if (graceSoon.length) {
    alerts.push({
      severity: "action", tone: "danger", to: "billing",
      text: `${graceSoon.length} account${graceSoon.length === 1 ? "" : "s"} lose access within 3 days`,
      meta: graceSoon.map((o) => o.name).join(", "),
    });
  }
  const dunningOnly = dunning.filter((o) => !graceSoon.includes(o));
  if (dunningOnly.length) {
    alerts.push({
      severity: "action", tone: "warn", to: "billing",
      text: `${dunningOnly.length} account${dunningOnly.length === 1 ? "" : "s"} past due`,
      meta: dunningOnly.map((o) => o.name).join(", "),
    });
  }
  if (monitorSummary.overdue > 0) {
    alerts.push({
      severity: "action", tone: "warn", to: "automation",
      text: `${monitorSummary.overdue} monitor${monitorSummary.overdue === 1 ? "" : "s"} overdue for a run`,
      meta: "expected within the last 48 hours",
    });
  }
  if (!env.EMAIL_FROM || !env.GOOGLE_SERVICE_ACCOUNT_JSON || !env.EMAIL_DELEGATED_USER) {
    // The failure mode this panel exists to make visible: nothing errors,
    // every send "succeeds", and no mail leaves the building.
    const skipped = await countEmailOutcome(env, EMAIL_OUTCOME.SKIPPED, now - 7 * DAY);
    alerts.push({
      severity: "config", tone: "warn", to: "settings",
      text: "Transactional email is not configured — sends are silently skipped",
      meta: skipped > 0 ? `${skipped} skipped in the last 7 days` : "no sends attempted yet",
    });
  }
  if (!priceInfo.ok) {
    alerts.push({
      severity: "config", tone: "warn", to: "settings",
      text: "Revenue figures are unavailable",
      meta: priceInfo.reason === "stripe_not_configured"
        ? "STRIPE_SECRET_KEY is not set"
        : `Stripe price lookup failed: ${priceInfo.reason}`,
    });
  }
  const failedWebhooks = await countWebhookOutcome(env, WEBHOOK_OUTCOME.FAILED, now - DAY);
  if (failedWebhooks > 0) {
    alerts.push({
      severity: "action", tone: "danger", to: "automation",
      text: `${failedWebhooks} webhook deliver${failedWebhooks === 1 ? "y" : "ies"} failed in the last 24 hours`,
      meta: "subscription state may be stale for those accounts",
    });
  }

  // --- activity -----------------------------------------------------------
  const { events } = await listAuditEvents(env, { limit: 15 });

  return jsonResponse({
    generatedAt: now,
    kpis: {
      activeSubscriptions: { value: entitling.length, trialing: trialing.length },
      revenue,
      freeNearQuota: { value: nearQuota, of: freeOrgIds.size, limit: 5 },
      monitors: monitorSummary,
      runsToday,
    },
    alerts,
    // The panel shows this only when `alerts` is empty. It is deliberately a
    // list of things CHECKED rather than a single "all clear": an empty
    // alert list can also mean the checks did not run, and naming them is
    // what tells the two apart.
    checked: [
      "accounts past due",
      "accounts within 3 days of losing access",
      "monitors overdue for a run",
      "webhook deliveries in the last 24 hours",
      "transactional email configuration",
      "Stripe price configuration",
    ],
    activity: events,
  });
}

async function countWebhookOutcome(env, outcome, since) {
  const row = await env.DB
    .prepare("SELECT COUNT(*) AS n FROM webhook_deliveries WHERE outcome = ? AND received_at >= ?")
    .bind(outcome, since).first();
  return (row && row.n) || 0;
}

async function countEmailOutcome(env, outcome, since) {
  const row = await env.DB
    .prepare("SELECT COUNT(*) AS n FROM email_sends WHERE outcome = ? AND sent_at >= ?")
    .bind(outcome, since).first();
  return (row && row.n) || 0;
}

/**
 * What we can honestly say about the monitor sweep.
 *
 * We do NOT record per-run success or failure — `monitors.last_run_at` and
 * `last_delta_json` are all that survives a sweep. So this reports what the
 * data supports: how many monitors are active, how many have never run, and
 * how many are overdue. It does not report a succeeded/failed split, and
 * `outcomesRecorded: false` says so out loud, because a UI that invented
 * that column would be inventing the one number an operator acts on.
 */
async function sweepSummary(env, now) {
  const rows = await allRows(env,
    `SELECT monitor_id, org_id, repo_url, branch, schedule, last_run_at, paused_at, last_delta_json
       FROM monitors`);
  const active  = rows.filter((r) => r.paused_at === null);
  const never   = active.filter((r) => !r.last_run_at);
  const overdue = active.filter((r) => r.last_run_at && now - r.last_run_at > 2 * DAY);
  return {
    total:   rows.length,
    active:  active.length,
    paused:  rows.length - active.length,
    neverRun: never.length,
    overdue: overdue.length,
    lastRunAt: active.reduce((max, r) => Math.max(max, r.last_run_at || 0), 0) || null,
    outcomesRecorded: false,
    note: "Per-run success and failure are not stored — only each monitor's last run time " +
          "and its last delta. 'Overdue' means no run in 48 hours.",
  };
}

// ---------------------------------------------------------------------------
// GET /api/admin/accounts
// ---------------------------------------------------------------------------

export async function adminAccountsHandler(request, env, ctx) {
  if (!env || !env.DB) return notConfigured();

  const now  = nowSec();
  const url  = new URL(request.url);
  const q    = (url.searchParams.get("q") || "").trim().toLowerCase();
  const statusFilter = url.searchParams.get("status");

  const [orgs, members, monitors, priceInfo] = await Promise.all([
    loadOrgs(env), memberCounts(env), monitorCounts(env), loadPrices(env, ctx),
  ]);
  const runs30 = await runCountsSince(env, now - 30 * DAY);

  let accounts = orgs.map((org) => {
    const mrr   = mrrForOrg(org, priceInfo.prices);
    const seats = members.get(org.orgId) || 0;
    const runs  = runs30.get(org.orgId) || { total: 0, ci: 0, dashboard: 0 };
    const mon   = monitors.get(org.orgId) || { total: 0, active: 0 };
    return {
      orgId:  org.orgId,
      name:   org.name,
      stripeCustomerId: org.stripeCustomerId,
      plan:   org.plan,
      tier:   tierForOrg(env, org),
      subStatus: org.subStatus,
      currentPeriodEnd: org.currentPeriodEnd,
      seatsUsed: seats,
      seatsPurchased: org.seatsPurchased,
      // Membership can exceed purchased seats when a subscription is
      // downgraded — surfaced rather than clamped, because it is a billing
      // conversation somebody has to have.
      seatsOver: Math.max(0, seats - org.seatsPurchased),
      mrr,
      mrrKnown: mrr !== null,
      monitors: mon,
      runs30: runs,
      createdAt: org.createdAt,
    };
  });

  if (q) {
    accounts = accounts.filter((a) =>
      a.name.toLowerCase().includes(q) ||
      a.orgId.toLowerCase().includes(q) ||
      (a.stripeCustomerId || "").toLowerCase().includes(q));
  }
  if (statusFilter) {
    accounts = accounts.filter((a) => (a.subStatus || "none") === statusFilter);
  }

  return jsonResponse({
    accounts,
    total: accounts.length,
    revenueAvailable: priceInfo.ok,
    revenueReason: priceInfo.ok ? null : priceInfo.reason,
  });
}

// ---------------------------------------------------------------------------
// GET /api/admin/accounts/:orgId
// ---------------------------------------------------------------------------

export async function adminAccountDetailHandler(request, env, ctx) {
  if (!env || !env.DB) return notConfigured();
  const orgId = request.params && request.params.orgId;
  if (!orgId) return jsonResponse({ error: "invalid_request", message: "No org id supplied." }, 400);

  const row = await env.DB.prepare(
    `SELECT org_id, name, stripe_customer_id, plan, sub_status, current_period_end,
            seats_purchased, price_id, created_at, updated_at,
            brand_company_name, brand_logo_url
       FROM organisations WHERE org_id = ?`).bind(orgId).first();
  if (!row) return jsonResponse({ error: "not_found", message: "No organisation with that id." }, 404);

  const org = rowToOrg(row);
  const now = nowSec();

  const [priceInfo, entitlement] = await Promise.all([
    loadPrices(env, ctx),
    resolveEntitlementForOrg(env, orgId, { request }).catch(() => null),
  ]);

  const members = await allRows(env,
    `SELECT m.user_id, m.role, m.created_at, u.email, u.auth_method
       FROM memberships m LEFT JOIN users u ON u.user_id = m.user_id
      WHERE m.org_id = ? ORDER BY m.created_at ASC`, orgId);

  const keys = await allRows(env,
    `SELECT key_id, name, prefix, created_by, created_at, last_used_at, revoked_at
       FROM api_keys WHERE org_id = ? ORDER BY created_at DESC`, orgId);

  const monitors = await allRows(env,
    `SELECT monitor_id, repo_url, branch, schedule, last_run_at, paused_at, last_delta_json
       FROM monitors WHERE org_id = ? ORDER BY created_at DESC`, orgId);

  const runs = await allRows(env,
    `SELECT id, analyzer, source, headline, created_at
       FROM runs WHERE org_id = ? ORDER BY created_at DESC LIMIT 20`, orgId);

  const [audit, webhooks] = await Promise.all([
    listAuditEvents(env, { orgId, limit: 25 }),
    env.DB.prepare(
      `SELECT rowid AS cursor, delivery_id, event_id, event_type, outcome, error_message, received_at
         FROM webhook_deliveries WHERE org_id = ? ORDER BY rowid DESC LIMIT 15`).bind(orgId).all(),
  ]);

  const mrr = mrrForOrg(org, priceInfo.prices);

  return jsonResponse({
    account: {
      ...org,
      tier: tierForOrg(env, org),
      branding: {
        companyName: row.brand_company_name || null,
        logoUrl:     row.brand_logo_url || null,
      },
      entitlement: entitlement
        ? { active: entitlement.active, reason: entitlement.reason, tier: entitlement.tier || null }
        : null,
      // Distinct from `entitlement: {active:false}` — null means the resolver
      // itself failed, and an operator deciding whether to intervene needs to
      // know which of the two they are looking at.
      entitlementReason: entitlement ? null : "entitlement_resolver_failed",
      mrr,
      mrrKnown: mrr !== null,
      mrrReason: mrr === null ? (priceInfo.ok ? "price_not_in_config" : priceInfo.reason) : null,
      seatsUsed: members.length,
      seatsOver: Math.max(0, members.length - org.seatsPurchased),
    },
    members: members.map((m) => ({
      userId: m.user_id,
      email:  m.email || null,
      role:   m.role,
      joinedAt: m.created_at,
      authMethod: m.auth_method || null,
      // Rows that predate migrations/0011 genuinely have no recorded method.
      authMethodKnown: Boolean(m.auth_method),
      // A membership whose user row is gone is a real, findable inconsistency
      // rather than something to paper over with a blank cell.
      orphaned: !m.email,
    })),
    apiKeys: keys.map((k) => ({
      keyId: k.key_id, name: k.name, prefix: k.prefix,
      createdBy: k.created_by, createdAt: k.created_at,
      lastUsedAt: k.last_used_at, revokedAt: k.revoked_at,
    })),
    monitors: monitors.map((m) => ({
      monitorId: m.monitor_id, repoUrl: m.repo_url, branch: m.branch,
      schedule: m.schedule, lastRunAt: m.last_run_at, pausedAt: m.paused_at,
      lastDelta: parseJson(m.last_delta_json),
      overdue: m.paused_at === null && m.last_run_at !== null && now - m.last_run_at > 2 * DAY,
      neverRun: m.last_run_at === null,
    })),
    recentRuns: runs.map((r) => ({
      runId: r.id, analyzer: r.analyzer, source: r.source || null,
      headline: r.headline || null, createdAt: r.created_at,
    })),
    audit: audit.events,
    webhooks: ((webhooks && webhooks.results) || []).map((w) => ({
      deliveryId: w.delivery_id, eventId: w.event_id, eventType: w.event_type,
      outcome: w.outcome, error: w.error_message || null, receivedAt: w.received_at,
    })),
    // Invoices come from Stripe, not from us — the panel fetches them
    // separately so a Stripe outage costs the invoice table and nothing else
    // on this page.
    invoices: { available: false, reason: "fetch_separately", endpoint: `/api/admin/accounts/${orgId}/invoices` },
  });
}

function parseJson(raw) {
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

// ---------------------------------------------------------------------------
// GET /api/admin/accounts/:orgId/invoices
// ---------------------------------------------------------------------------

export async function adminAccountInvoicesHandler(request, env) {
  if (!env || !env.DB) return notConfigured();
  const orgId = request.params && request.params.orgId;
  const row = await env.DB.prepare(
    "SELECT stripe_customer_id FROM organisations WHERE org_id = ?").bind(orgId).first();
  if (!row) return jsonResponse({ error: "not_found", message: "No organisation with that id." }, 404);
  if (!row.stripe_customer_id) {
    return jsonResponse({ invoices: [], reason: "no_stripe_customer", message: "This account has never been through checkout." });
  }
  if (!env.STRIPE_SECRET_KEY) {
    return jsonResponse({ invoices: null, reason: "stripe_not_configured" }, 200);
  }

  try {
    const list = await stripeFetch(
      env,
      `/invoices?customer=${encodeURIComponent(row.stripe_customer_id)}&limit=12`,
      { method: "GET" },
    );
    return jsonResponse({
      invoices: (list.data || []).map((inv) => ({
        id: inv.id, number: inv.number || null,
        amountDue: inv.amount_due, amountPaid: inv.amount_paid, currency: inv.currency,
        status: inv.status, created: inv.created,
        hostedInvoiceUrl: inv.hosted_invoice_url || null,
        attemptCount: typeof inv.attempt_count === "number" ? inv.attempt_count : null,
      })),
      reason: null,
    });
  } catch (err) {
    // Null, not []. An empty invoice list and an unreachable Stripe look
    // identical on screen and mean opposite things.
    return jsonResponse(
      { invoices: null, reason: "stripe_unreachable", message: (err && err.message) || "unknown error" },
      200,
    );
  }
}

// ---------------------------------------------------------------------------
// GET /api/admin/users/:userId
// ---------------------------------------------------------------------------

export async function adminUserDetailHandler(request, env) {
  if (!env || !env.DB) return notConfigured();
  const userId = request.params && request.params.userId;
  if (!userId) return jsonResponse({ error: "invalid_request", message: "No user id supplied." }, 400);

  const user = await env.DB.prepare(
    `SELECT user_id, email, stripe_customer_id, plan, sub_status, auth_method,
            active_org_id, created_at, updated_at
       FROM users WHERE user_id = ?`).bind(userId).first();
  if (!user) return jsonResponse({ error: "not_found", message: "No user with that id." }, 404);

  const memberships = await allRows(env,
    `SELECT m.org_id, m.role, m.created_at, o.name, o.plan, o.sub_status
       FROM memberships m LEFT JOIN organisations o ON o.org_id = m.org_id
      WHERE m.user_id = ? ORDER BY m.created_at ASC`, userId);

  const lastRun = await env.DB.prepare(
    "SELECT created_at FROM runs WHERE user_id = ? ORDER BY created_at DESC LIMIT 1")
    .bind(userId).first();

  const sessions = await listUserSessions(env, userId);
  const { events } = await listAuditEvents(env, { actor: user.email, limit: 25 });

  return jsonResponse({
    user: {
      userId: user.user_id,
      email:  user.email,
      plan:   user.plan,
      subStatus: user.sub_status || null,
      stripeCustomerId: user.stripe_customer_id || null,
      activeOrgId: user.active_org_id || null,
      createdAt: user.created_at,
      authMethod: user.auth_method || null,
      // Never rendered as "unknown method" versus "no method" by accident:
      // rows created before migrations/0011 have not recorded it, and that is
      // a different statement from "this user has never signed in".
      authMethodKnown: Boolean(user.auth_method),
      // We do not store a last-active timestamp. The most recent run is the
      // closest real signal, and it is labelled as what it is rather than
      // relabelled "last active", which would read as session activity.
      lastRunAt: (lastRun && lastRun.created_at) || null,
    },
    memberships: memberships.map((m) => ({
      orgId: m.org_id, orgName: m.name || null, role: m.role,
      joinedAt: m.created_at, plan: m.plan || null, subStatus: m.sub_status || null,
    })),
    sessions: sessions.sessions,
    // The session index only covers sessions issued after it shipped, and KV
    // list can paginate. Either way the count is a FLOOR, and saying so is
    // what stops "1 session" being read as "exactly one device".
    sessionsComplete: sessions.complete,
    sessionsNote: "Sessions issued before the session index shipped are not listed. " +
                  "Sessions expire after 30 days, so this gap closes on its own.",
    activity: events,
  });
}

// ---------------------------------------------------------------------------
// DELETE /api/admin/users/:userId/sessions/:sessionId
// ---------------------------------------------------------------------------

export async function adminRevokeSessionHandler(request, env, ctx) {
  const userId    = request.params && request.params.userId;
  const sessionId = request.params && request.params.sessionId;
  if (!userId || !sessionId) {
    return jsonResponse({ error: "invalid_request", message: "Both a user id and a session id are required." }, 400);
  }

  const result = await revokeUserSession(env, userId, sessionId);
  if (!result.revoked) {
    return jsonResponse(
      {
        error: result.reason,
        message: result.reason === "not_found"
          ? "That session is not in this user's index — it may already have been revoked or expired."
          : "Could not revoke that session.",
      },
      result.reason === "not_found" ? 404 : 400,
    );
  }

  // Signing someone else out is exactly the kind of action the audit log
  // exists for: it is invisible to the person it happens to until they are
  // logged out mid-task.
  const actor = (request.user && request.user.email) || "unknown";
  await writeAudit(env, ctx, {
    actor,
    actorUserId: request.user && request.user.userId,
    action:      AUDIT_ACTIONS.SESSION_REVOKED,
    targetType:  "user",
    targetId:    userId,
    metadata:    { sessionId },
  });

  return jsonResponse({ ok: true, userId, sessionId });
}

// ---------------------------------------------------------------------------
// GET /api/admin/billing
// ---------------------------------------------------------------------------

export async function adminBillingHandler(request, env, ctx) {
  if (!env || !env.DB) return notConfigured();
  const now = nowSec();
  const [orgs, priceInfo] = await Promise.all([loadOrgs(env), loadPrices(env, ctx)]);

  const byStatus = {};
  for (const org of orgs) {
    const key = org.subStatus || "none";
    byStatus[key] = (byStatus[key] || 0) + 1;
  }

  const atRisk = orgs
    .filter((o) => o.subStatus === "past_due" || o.subStatus === "unpaid" || o.subStatus === "canceled")
    .map((o) => {
      const mrr = mrrForOrg(o, priceInfo.prices);
      return {
        orgId: o.orgId, name: o.name, subStatus: o.subStatus,
        stripeCustomerId: o.stripeCustomerId,
        currentPeriodEnd: o.currentPeriodEnd,
        // Negative means access already ended; the panel needs the sign, not
        // a clamped zero that makes a lapsed account look like it has today.
        daysOfAccessLeft: o.currentPeriodEnd ? Math.ceil((o.currentPeriodEnd - now) / DAY) : null,
        accessEnded: o.currentPeriodEnd ? o.currentPeriodEnd <= now : null,
        mrrAtRisk: mrr, mrrKnown: mrr !== null,
      };
    })
    .sort((a, b) => (a.currentPeriodEnd || Infinity) - (b.currentPeriodEnd || Infinity));

  const trials = orgs
    .filter((o) => o.subStatus === "trialing")
    .map((o) => ({
      orgId: o.orgId, name: o.name, currentPeriodEnd: o.currentPeriodEnd,
      daysLeft: o.currentPeriodEnd ? Math.ceil((o.currentPeriodEnd - now) / DAY) : null,
    }))
    .sort((a, b) => (a.currentPeriodEnd || Infinity) - (b.currentPeriodEnd || Infinity));

  const byTier = {};
  for (const org of orgs) {
    if (org.subStatus !== "active" && org.subStatus !== "trialing") continue;
    const tier = tierForOrg(env, org) || "unconfigured_price";
    const entry = byTier[tier] || { count: 0, mrr: 0, mrrKnown: true };
    entry.count += 1;
    const mrr = mrrForOrg(org, priceInfo.prices);
    if (mrr === null) entry.mrrKnown = false;
    else entry.mrr += mrr;
    byTier[tier] = entry;
  }

  const recentPlanChanges = await listAuditEvents(env, { action: AUDIT_ACTIONS.PLAN_CHANGED, limit: 25 });

  return jsonResponse({
    generatedAt: now,
    revenueAvailable: priceInfo.ok,
    revenueReason: priceInfo.ok ? null : priceInfo.reason,
    byStatus,
    byTier,
    atRisk,
    trials,
    planChanges: recentPlanChanges.events,
    // The panel's dunning table needs invoice detail, and invoices live in
    // Stripe. Named here so the client knows where to go rather than
    // rendering an empty table that implies there are no failed payments.
    invoicesNote: "Invoice-level detail is per-account: GET /api/admin/accounts/:orgId/invoices",
  });
}

// ---------------------------------------------------------------------------
// GET /api/admin/automation
// ---------------------------------------------------------------------------

export async function adminAutomationHandler(request, env) {
  if (!env || !env.DB) return notConfigured();
  const now = nowSec();
  const url = new URL(request.url);
  const limit = Math.min(100, Number(url.searchParams.get("limit")) || 30);

  const monitors = await allRows(env,
    `SELECT m.monitor_id, m.org_id, m.repo_url, m.branch, m.schedule,
            m.last_run_at, m.paused_at, m.last_delta_json, o.name AS org_name
       FROM monitors m LEFT JOIN organisations o ON o.org_id = m.org_id
      ORDER BY m.last_run_at DESC NULLS LAST`);

  const [webhooks, emails] = await Promise.all([
    listWebhookDeliveries(env, { limit }),
    listEmailSends(env, { limit }),
  ]);

  const emailConfigured = Boolean(env.EMAIL_FROM && env.GOOGLE_SERVICE_ACCOUNT_JSON && env.EMAIL_DELEGATED_USER);

  return jsonResponse({
    generatedAt: now,
    monitors: {
      summary: await sweepSummary(env, now),
      items: monitors.map((m) => ({
        monitorId: m.monitor_id,
        orgId: m.org_id,
        orgName: m.org_name || null,
        repoUrl: m.repo_url,
        branch: m.branch,
        schedule: m.schedule,
        lastRunAt: m.last_run_at,
        paused: m.paused_at !== null,
        lastDelta: parseJson(m.last_delta_json),
        neverRun: m.last_run_at === null,
        overdue: m.paused_at === null && m.last_run_at !== null && now - m.last_run_at > 2 * DAY,
      })),
    },
    webhooks: {
      items: webhooks.deliveries,
      cursor: webhooks.cursor,
      hasMore: webhooks.hasMore,
      counts: {
        last24h: {
          processed: await countWebhookOutcome(env, WEBHOOK_OUTCOME.PROCESSED, now - DAY),
          duplicate: await countWebhookOutcome(env, WEBHOOK_OUTCOME.DUPLICATE, now - DAY),
          ignored:   await countWebhookOutcome(env, WEBHOOK_OUTCOME.IGNORED,   now - DAY),
          failed:    await countWebhookOutcome(env, WEBHOOK_OUTCOME.FAILED,    now - DAY),
        },
      },
    },
    email: {
      configured: emailConfigured,
      // Named individually because "email is broken" and "EMAIL_FROM is unset"
      // send an operator to completely different places.
      missing: [
        !env.EMAIL_FROM && "EMAIL_FROM",
        !env.GOOGLE_SERVICE_ACCOUNT_JSON && "GOOGLE_SERVICE_ACCOUNT_JSON",
        !env.EMAIL_DELEGATED_USER && "EMAIL_DELEGATED_USER",
      ].filter(Boolean),
      items: emails.sends,
      cursor: emails.cursor,
      hasMore: emails.hasMore,
      counts: {
        last24h: {
          sent:    await countEmailOutcome(env, EMAIL_OUTCOME.SENT,    now - DAY),
          skipped: await countEmailOutcome(env, EMAIL_OUTCOME.SKIPPED, now - DAY),
          failed:  await countEmailOutcome(env, EMAIL_OUTCOME.FAILED,  now - DAY),
        },
      },
    },
    mcp: await mcpAdoption(env, now),
  });
}

/**
 * MCP adoption, for the automation view.
 *
 * Answers the three questions an operator actually has about a surface that
 * was shipped behind a flag: is anyone using it, is it working, and is it
 * costing them runs they did not expect.
 *
 * Aggregate only — no org is named and no tool argument exists to leak. The
 * per-org detail belongs on the account drawer, where an operator is already
 * looking at one customer on purpose.
 */
async function mcpAdoption(env, now) {
  const since = now - 30 * DAY;

  // Every count is over the same 30-day window so the numbers can be read
  // against each other. A "calls" figure for 30 days beside an "orgs" figure
  // for all time would invite exactly the wrong ratio.
  const totals = await allRows(env,
    `SELECT COUNT(*)                                                   AS calls,
            COUNT(DISTINCT org_id)                                     AS orgs,
            SUM(CASE WHEN status = 'ok' THEN 1 ELSE 0 END)             AS ok,
            SUM(CASE WHEN status = 'quota_exceeded' THEN 1 ELSE 0 END) AS quota,
            SUM(CASE WHEN run_id IS NOT NULL THEN 1 ELSE 0 END)        AS runs,
            AVG(duration_ms)                                           AS avg_ms
       FROM mcp_tool_calls
      WHERE created_at >= ?`, since);
  const t = totals[0] || {};
  const calls = Number(t.calls || 0);

  const topTools = await allRows(env,
    `SELECT tool_name, COUNT(*) AS n,
            SUM(CASE WHEN status <> 'ok' THEN 1 ELSE 0 END) AS errors
       FROM mcp_tool_calls
      WHERE created_at >= ?
      GROUP BY tool_name
      ORDER BY n DESC
      LIMIT 10`, since);

  const byDay = await allRows(env,
    `SELECT created_at / 86400 AS day, COUNT(*) AS n
       FROM mcp_tool_calls
      WHERE created_at >= ?
      GROUP BY day
      ORDER BY day`, since);

  const grants = await allRows(env,
    `SELECT COUNT(DISTINCT org_id)                                        AS orgs,
            COUNT(DISTINCT client_id)                                     AS clients,
            SUM(CASE WHEN revoked_at IS NULL THEN 1 ELSE 0 END)           AS live
       FROM mcp_tokens`);
  const g = grants[0] || {};

  return {
    // Stated, because "0 calls" from a flag that is off and "0 calls" from a
    // flag that is on and unused are different facts, and only one of them is
    // a product problem.
    enabled: String(env.MCP_ENABLED || "").toLowerCase() === "true",
    windowDays: 30,
    calls,
    orgsCalling: Number(t.orgs || 0),
    runsConsumed: Number(t.runs || 0),
    quotaRefused: Number(t.quota || 0),
    avgDurationMs: t.avg_ms != null ? Math.round(t.avg_ms) : null,
    // Null rather than 0 when nothing has been called. A 0% error rate over
    // zero calls is not a healthy surface, it is an untested one, and a
    // dashboard that renders them the same way hides the difference.
    errorRate: calls > 0 ? (calls - Number(t.ok || 0)) / calls : null,
    oauth: {
      orgsWithGrant: Number(g.orgs || 0),
      clients:       Number(g.clients || 0),
      liveTokens:    Number(g.live || 0),
    },
    topTools: topTools.map((r) => ({
      tool: r.tool_name, calls: Number(r.n), errors: Number(r.errors || 0),
    })),
    byDay: byDay.map((r) => ({ day: Number(r.day) * 86400, calls: Number(r.n) })),
  };
}

// ---------------------------------------------------------------------------
// GET /api/admin/audit
// ---------------------------------------------------------------------------

export async function adminAuditHandler(request, env) {
  if (!env || !env.DB) return notConfigured();
  const url = new URL(request.url);
  const result = await listAuditEvents(env, {
    orgId:  url.searchParams.get("orgId")  || null,
    actor:  url.searchParams.get("actor")  || null,
    action: url.searchParams.get("action") || null,
    before: url.searchParams.get("before") || null,
    limit:  Number(url.searchParams.get("limit")) || 50,
  });
  return jsonResponse({
    ...result,
    // The filter vocabulary, served alongside the data so the panel's filter
    // menu cannot drift out of sync with what the writers actually emit.
    actions: Object.values(AUDIT_ACTIONS),
  });
}

// ---------------------------------------------------------------------------
// GET /api/admin/flags, PATCH /api/admin/flags/:key
// ---------------------------------------------------------------------------

export async function adminFlagsHandler(request, env) {
  if (!env || !env.DB) return notConfigured();
  return jsonResponse({ flags: await listFlags(env) });
}

export async function adminSetFlagHandler(request, env, ctx) {
  if (!env || !env.DB) return notConfigured();
  const key = request.params && request.params.key;
  if (!key || !FLAG_KEY_RE.test(key)) {
    return jsonResponse(
      { error: "invalid_key", message: "A flag key is lowercase letters, digits, dot, dash or underscore." },
      400,
    );
  }

  let body;
  try { body = await request.json(); }
  catch { return jsonResponse({ error: "invalid_json", message: "Request body must be valid JSON." }, 400); }

  const actor  = (request.user && request.user.email) || "unknown";
  const result = await upsertFlag(env, key, {
    enabled:     body && body.enabled,
    rolloutPct:  body && body.rolloutPct,
    description: body && body.description,
    updatedBy:   actor,
  });

  if (!result.ok) {
    const status = result.error === "write_failed" ? 500 : 400;
    return jsonResponse({ error: result.error, message: result.message || flagErrorMessage(result.error) }, status);
  }

  await writeAudit(env, ctx, {
    actor,
    actorUserId: request.user && request.user.userId,
    action:      AUDIT_ACTIONS.FLAG_UPDATED,
    targetType:  "flag",
    targetId:    key,
    // Both sides recorded. "Turned on white_label_reports" is a much weaker
    // record than "turned it on, from 25% to 40%", and the second is what
    // someone reconstructing an incident needs.
    metadata:    { from: result.previous || null, to: result.flag, created: result.created },
  });

  return jsonResponse({ ok: true, flag: result.flag, created: result.created }, result.created ? 201 : 200);
}

function flagErrorMessage(error) {
  if (error === "invalid_rollout") return "rolloutPct must be a whole number from 0 to 100.";
  if (error === "invalid_key")     return "A flag key is lowercase letters, digits, dot, dash or underscore.";
  return "Could not update the flag.";
}

// ---------------------------------------------------------------------------
// GET /api/admin/settings
// ---------------------------------------------------------------------------

/**
 * Whether a binding is present. Never its value — this endpoint is a
 * configuration report, and a report that echoes secrets is a way to
 * exfiltrate them through a surface that only needs to say yes or no.
 */
function bindingState(env, name) {
  const v = env && env[name];
  return { name, set: Boolean(v && String(v).length) };
}

export async function adminSettingsHandler(request, env) {
  const adminEmails = ((env && env.ADMIN_EMAILS) || "")
    .split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  const self = (request.user && request.user.email || "").toLowerCase();

  // Stripe key MODE from the prefix, which is a fact about the string we
  // already hold and requires no call. The value itself never leaves here.
  const key  = (env && env.STRIPE_SECRET_KEY) || "";
  const mode = key.startsWith("sk_live_") ? "live" : key.startsWith("sk_test_") ? "test" : key ? "unknown" : null;

  const connections = [
    {
      name: "Stripe",
      configured: Boolean(key),
      detail: mode ? `${mode} mode` : "STRIPE_SECRET_KEY is not set",
      // The panel calls these to test; they are the existing endpoints
      // rather than a second implementation that could disagree with them.
      testEndpoint: "/api/admin/stripe-check",
      missing: [!key && "STRIPE_SECRET_KEY", !env.STRIPE_WEBHOOK_SECRET && "STRIPE_WEBHOOK_SECRET"].filter(Boolean),
    },
    {
      name: "Google Workspace mail",
      configured: Boolean(env.EMAIL_FROM && env.GOOGLE_SERVICE_ACCOUNT_JSON && env.EMAIL_DELEGATED_USER),
      detail: env.EMAIL_FROM ? `sends as ${env.EMAIL_FROM}` : "no sender configured",
      testEndpoint: null,
      missing: [
        !env.EMAIL_FROM && "EMAIL_FROM",
        !env.GOOGLE_SERVICE_ACCOUNT_JSON && "GOOGLE_SERVICE_ACCOUNT_JSON",
        !env.EMAIL_DELEGATED_USER && "EMAIL_DELEGATED_USER",
      ].filter(Boolean),
    },
    {
      name: "Google sign-in",
      configured: Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET),
      detail: env.GOOGLE_CLIENT_ID ? "OAuth client configured" : "sign-in falls back to email links only",
      testEndpoint: null,
      missing: [
        !env.GOOGLE_CLIENT_ID && "GOOGLE_CLIENT_ID",
        !env.GOOGLE_CLIENT_SECRET && "GOOGLE_CLIENT_SECRET",
      ].filter(Boolean),
    },
    {
      name: "Error reporting",
      configured: Boolean(env.SENTRY_DSN),
      detail: env.SENTRY_DSN ? "events are being sent" : "exceptions are logged to the console only",
      testEndpoint: null,
      missing: [!env.SENTRY_DSN && "SENTRY_DSN"].filter(Boolean),
    },
  ];

  let counts = null;
  if (env && env.DB) {
    const [orgs, users, runs, monitors] = await Promise.all([
      env.DB.prepare("SELECT COUNT(*) AS n FROM organisations").first(),
      env.DB.prepare("SELECT COUNT(*) AS n FROM users").first(),
      env.DB.prepare("SELECT COUNT(*) AS n FROM runs").first(),
      env.DB.prepare("SELECT COUNT(*) AS n FROM monitors").first(),
    ]);
    counts = {
      organisations: (orgs && orgs.n) || 0,
      users:    (users && users.n) || 0,
      runs:     (runs && runs.n) || 0,
      monitors: (monitors && monitors.n) || 0,
    };
  }

  return jsonResponse({
    admins: {
      // The allowlist IS the admin list — there is no admins table, and
      // inventing "added" and "last seen" columns for a comma-separated env
      // var would be inventing data.
      emails: adminEmails.map((email) => ({ email, self: email === self })),
      source: "ADMIN_EMAILS environment variable",
      note: "Roles are not split — every address here has full access. " +
            "Changing this list is a deploy, not an action in this panel.",
    },
    connections,
    environment: {
      name: (env && env.ENVIRONMENT_NAME) || null,
      siteOrigin: (env && env.SITE_ORIGIN) || null,
      stripeMode: mode,
      bindings: [
        bindingState(env, "DB"), bindingState(env, "SESSIONS"), bindingState(env, "USERS"),
        bindingState(env, "REPORTS"), bindingState(env, "SCAN_QUEUE"), bindingState(env, "USAGE"),
        bindingState(env, "SANDBOX"),
      ],
      counts,
      // Schema state is its own endpoint with its own semantics; pointing at
      // it beats duplicating the manifest here and letting the two disagree.
      schemaEndpoint: "/api/admin/schema-check",
    },
  });
}
