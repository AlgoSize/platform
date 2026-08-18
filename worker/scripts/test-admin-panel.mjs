// Tests for the admin control panel's read API (src/handlers/admin_panel.js).
//
// The panel is a decision-making surface: every number on it gets used to
// decide whether to act. So the assertions here spend most of their effort on
// one property — that a figure we cannot compute comes back as null with a
// stated reason, and never as zero. "0 accounts past due" and "we could not
// reach Stripe" lead to opposite actions, and a panel that renders the second
// as the first is worse than one that renders nothing.
//
// Everything runs through the real router so requireAdmin is exercised on the
// real path rather than by calling handlers directly.
//
// Run with:  node scripts/test-admin-panel.mjs

import worker from "../src/index.js";
import { makeD1 } from "./_d1-stub.mjs";
import { issueJWT } from "../src/auth.js";
import { _resetPriceCache } from "../src/handlers/admin_panel.js";
import { writeAudit, AUDIT_ACTIONS, SYSTEM_ACTOR } from "../src/audit.js";
import { recordWebhookDelivery, recordEmailSend, WEBHOOK_OUTCOME } from "../src/oplog.js";
import { indexSession, sessionIdFor } from "../src/sessions.js";

let failures = 0;
const ok   = (msg) => console.log(`  \x1b[32m✓\x1b[0m ${msg}`);
const fail = (msg) => { console.log(`  \x1b[31m✗\x1b[0m ${msg}`); failures++; };
const expect = (cond, label) => cond ? ok(label) : fail(label);
const group  = (name) => console.log(`\n\x1b[1m${name}\x1b[0m\n`);

const ADMIN_EMAIL = "sam@algosize.com";
const JWT_SECRET  = "admin-panel-test-secret-that-is-long-enough";
const DAY = 86_400;
const now = Math.floor(Date.now() / 1000);

function makeKV() {
  const store = new Map();
  return {
    async get(k) { return store.has(k) ? store.get(k) : null; },
    async put(k, v) { store.set(k, v); },
    async delete(k) { store.delete(k); },
    async list({ prefix = "" } = {}) {
      return { keys: [...store.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })), list_complete: true };
    },
    _store: store,
  };
}

/**
 * A Stripe stub that answers price lookups. Amounts are in cents and the
 * annual price is deliberately 12x the monthly one, so the monthly-equivalent
 * arithmetic has something real to get wrong.
 */
const PRICES = {
  price_solo_monthly:      { unit_amount: 2900,  currency: "usd", recurring: { interval: "month" } },
  price_practice_monthly:  { unit_amount: 8900,  currency: "usd", recurring: { interval: "month" } },
  price_firm_annual:       { unit_amount: 298800, currency: "usd", recurring: { interval: "year" } },
};

function stripeFetchStub({ fail: shouldFail = false, invoices = [] } = {}) {
  return async (url) => {
    if (shouldFail) return new Response(JSON.stringify({ error: { message: "no" } }), { status: 500 });
    const u = new URL(url);
    const priceMatch = u.pathname.match(/^\/v1\/prices\/(.+)$/);
    if (priceMatch) {
      const p = PRICES[decodeURIComponent(priceMatch[1])];
      if (!p) return new Response(JSON.stringify({ error: { message: "No such price" } }), { status: 404 });
      return new Response(JSON.stringify({ id: priceMatch[1], ...p }), { status: 200 });
    }
    if (u.pathname === "/v1/invoices") {
      return new Response(JSON.stringify({ data: invoices }), { status: 200 });
    }
    return new Response(JSON.stringify({}), { status: 200 });
  };
}

function makeEnv(overrides = {}) {
  return {
    JWT_SECRET,
    SITE_ORIGIN:  "https://algosize.com",
    COOKIE_NAME:  "algosize_session",
    ADMIN_EMAILS: ADMIN_EMAIL,
    ENVIRONMENT_NAME: "test",
    STRIPE_SECRET_KEY: "sk_test_abc",
    STRIPE_WEBHOOK_SECRET: "whsec_abc",
    STRIPE_PRICE_SOLO_MONTHLY:     "price_solo_monthly",
    STRIPE_PRICE_PRACTICE_MONTHLY: "price_practice_monthly",
    STRIPE_PRICE_FIRM_ANNUAL:      "price_firm_annual",
    SESSIONS: makeKV(),
    USERS:    makeKV(),
    DB:       makeD1(),
    ...overrides,
  };
}

async function seed(env) {
  const q = (sql, ...b) => env.DB.prepare(sql).bind(...b).run();

  // Four orgs covering the states the panel has to distinguish.
  const orgs = [
    // active, priced, per-seat-less monthly
    ["org_meridian", "Meridian Legal", "cus_mer", "paid", "active",   now + 20 * DAY, 12, "price_firm_annual"],
    // past due, inside its grace window
    ["org_north",    "Northgate",      "cus_nor", "paid", "past_due", now + 2 * DAY,   6, "price_practice_monthly"],
    // trialing
    ["org_vance",    "Vance",          "cus_van", "paid", "trialing", now + 3 * DAY,   1, "price_solo_monthly"],
    // paid, but on a price that is NOT in our env config — the unknown-revenue case
    ["org_legacy",   "Legacy Co",      "cus_leg", "paid", "active",   now + 10 * DAY,  3, "price_off_config"],
    // free
    ["org_free",     "Free Co",        null,      "free", null,       null,            1, null],
  ];
  for (const [id, name, cus, plan, status, pe, seats, price] of orgs) {
    await q(`INSERT INTO organisations
               (org_id, name, stripe_customer_id, plan, sub_status, current_period_end,
                seats_purchased, price_id, created_at, updated_at)
             VALUES (?,?,?,?,?,?,?,?,?,?)`,
            id, name, cus, plan, status, pe, seats, price, now - 100 * DAY, now);
  }

  const users = [
    ["usr_sam",  ADMIN_EMAIL,             "org_meridian", "google"],
    ["usr_dana", "dana@meridian.com",     "org_meridian", "magic_link"],
    ["usr_ines", "ines@northgate.com",    "org_north",    null],          // pre-0011 row
    ["usr_free", "solo@free.com",         "org_free",     "magic_link"],
  ];
  for (const [id, email, org, auth] of users) {
    await q(`INSERT INTO users (user_id, email, plan, sub_status, auth_method, active_org_id, created_at, updated_at)
             VALUES (?,?,?,?,?,?,?,?)`,
            id, email, "paid", "active", auth, org, now - 90 * DAY, now);
    await q(`INSERT INTO memberships (org_id, user_id, role, created_at) VALUES (?,?,?,?)`,
            org, id, id === "usr_sam" ? "owner" : "member", now - 90 * DAY);
  }
  // Northgate has more members than seats — the over-seat case.
  for (let i = 0; i < 7; i++) {
    await q(`INSERT INTO memberships (org_id, user_id, role, created_at) VALUES (?,?,?,?)`,
            "org_north", `usr_extra_${i}`, "member", now - 10 * DAY);
  }

  // Runs: 3 today for Meridian (2 ci), and 4 this month for the free org so
  // it lands in the near-quota bucket.
  for (let i = 0; i < 3; i++) {
    await q(`INSERT INTO runs (id, user_id, org_id, source, analyzer, created_at) VALUES (?,?,?,?,?,?)`,
            `run_m${i}`, "usr_sam", "org_meridian", i < 2 ? "ci" : "dashboard", "cost", now - 60);
  }
  for (let i = 0; i < 4; i++) {
    await q(`INSERT INTO runs (id, user_id, org_id, source, analyzer, created_at) VALUES (?,?,?,?,?,?)`,
            `run_f${i}`, "usr_free", "org_free", "dashboard", "vuln", now - 60);
  }

  // Monitors: one healthy, one overdue, one never run, one paused.
  const monitors = [
    ["mon_ok",      "org_meridian", "https://github.com/a/b", now - 3600, null],
    ["mon_overdue", "org_meridian", "https://github.com/a/c", now - 5 * DAY, null],
    ["mon_new",     "org_north",    "https://github.com/a/d", null, null],
    ["mon_paused",  "org_north",    "https://github.com/a/e", now - 9 * DAY, now - DAY],
  ];
  for (const [id, org, repo, lastRun, paused] of monitors) {
    await q(`INSERT INTO monitors (monitor_id, org_id, repo_url, schedule, last_run_at, paused_at, created_at)
             VALUES (?,?,?,?,?,?,?)`, id, org, repo, "daily", lastRun, paused, now - 30 * DAY);
  }

  await q(`INSERT INTO api_keys (key_id, org_id, name, key_hash, prefix, created_by, created_at)
           VALUES (?,?,?,?,?,?,?)`,
          "key_1", "org_north", "CI · main", "hash1", "ask_live_7Qa1", "usr_ines", now - 40 * DAY);

  await writeAudit(env, null, {
    actor: ADMIN_EMAIL, action: AUDIT_ACTIONS.API_KEY_REVOKED,
    targetType: "api_key", targetId: "key_0", orgId: "org_north", metadata: { prefix: "ask_live_x" },
  });
  await writeAudit(env, null, {
    actor: SYSTEM_ACTOR, action: AUDIT_ACTIONS.PLAN_CHANGED, orgId: "org_north",
    metadata: { changes: { subStatus: { from: "active", to: "past_due" } } },
  });

  await recordWebhookDelivery(env, null, {
    eventId: "evt_1", eventType: "invoice.payment_failed", orgId: "org_north",
    outcome: WEBHOOK_OUTCOME.FAILED, error: "boom",
  });
  await recordWebhookDelivery(env, null, {
    eventId: "evt_2", eventType: "invoice.paid", orgId: "org_meridian",
    outcome: WEBHOOK_OUTCOME.PROCESSED,
  });
  await recordEmailSend(env, null, {
    recipient: "ines@northgate.com", template: "payment_failed", orgId: "org_north",
    result: { sent: false, reason: "not_configured" },
  });
}

async function call(env, path, { method = "GET", body, token } = {}) {
  const headers = {};
  if (token) headers.Cookie = `algosize_session=${token}`;
  if (body)  headers["content-type"] = "application/json";
  const req = new Request(`https://algosize.com${path}`, {
    method, headers, body: body ? JSON.stringify(body) : undefined,
  });
  const res = await worker.fetch(req, env, { waitUntil() {} });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON body */ }
  return { status: res.status, body: json, text };
}

async function adminToken(env) {
  return issueJWT(env, "usr_sam", ADMIN_EMAIL, "active");
}

// ===========================================================================
group("the gate");
// ===========================================================================
{
  _resetPriceCache();
  const env = makeEnv({ fetch: stripeFetchStub() });
  globalThis.fetch = stripeFetchStub();
  await seed(env);

  const paths = [
    "/api/admin/overview", "/api/admin/accounts", "/api/admin/billing",
    "/api/admin/automation", "/api/admin/audit", "/api/admin/flags", "/api/admin/settings",
  ];
  for (const p of paths) {
    const anon = await call(env, p);
    expect(anon.status === 401, `${p} without a session → 401`);
  }

  const memberToken = await issueJWT(env, "usr_dana", "dana@meridian.com", "active");
  const asMember = await call(env, "/api/admin/overview", { token: memberToken });
  expect(asMember.status === 403,
    "a signed-in non-admin gets 403, not 404 — an operator locked out by a typo'd ADMIN_EMAILS " +
    "needs to see 'you are not on the list', not 'this page does not exist'");
  expect(asMember.body && asMember.body.error === "forbidden", "and the reason says so");

  const flagPatch = await call(env, "/api/admin/flags/x_flag", {
    method: "PATCH", body: { enabled: true }, token: memberToken,
  });
  expect(flagPatch.status === 403, "the one write endpoint is behind the same gate");
}

// ===========================================================================
group("overview");
// ===========================================================================
{
  _resetPriceCache();
  const env = makeEnv();
  globalThis.fetch = stripeFetchStub();
  await seed(env);
  const token = await adminToken(env);

  const { status, body } = await call(env, "/api/admin/overview", { token });
  expect(status === 200, `responds 200 (got ${status})`);

  expect(body.kpis.activeSubscriptions.value === 3,
    `active + trialing orgs are counted together (got ${body.kpis.activeSubscriptions.value}) — ` +
    "a trial is a live subscription, and splitting them hides half the base");
  expect(body.kpis.activeSubscriptions.trialing === 1, "with the trialing count broken out separately");

  // Firm annual 298800/yr → 24900/mo; Practice monthly 8900; Solo monthly 2900.
  // org_legacy is on an unconfigured price and must NOT contribute a zero.
  // Only entitling orgs count: Meridian (firm annual, 298800/yr → 24900/mo) and
  // Vance (solo monthly, 2900). Northgate is past_due and contributes nothing —
  // counting revenue you are not collecting is the whole reason dunning exists.
  expect(body.kpis.revenue.mrr === 24900 + 2900,
    `MRR sums monthly equivalents (got ${body.kpis.revenue.mrr}, expected ${24900 + 2900}) — ` +
    "an annual price added at face value would inflate that customer 12-fold");
  expect(body.kpis.revenue.partial === true && body.kpis.revenue.unpricedOrgs === 1,
    "an org on a price outside our config makes the figure a FLOOR, and it is flagged as one " +
    "rather than quietly counted as zero revenue");
  expect(body.kpis.revenue.reason === "some_orgs_on_unconfigured_prices", "with the reason named");

  expect(body.kpis.runsToday.total === 7 && body.kpis.runsToday.ci === 2,
    `runs today are split by source (got ${JSON.stringify(body.kpis.runsToday)})`);
  expect(body.kpis.freeNearQuota.value === 1,
    "a free org at 4 of 5 runs is flagged before it hits the wall, not after");

  expect(body.kpis.monitors.outcomesRecorded === false,
    "the monitor summary states that per-run outcomes are NOT stored, rather than showing a " +
    "succeeded/failed split it cannot actually compute");
  expect(body.kpis.monitors.overdue === 1 && body.kpis.monitors.neverRun === 1,
    `overdue and never-run are counted separately (${body.kpis.monitors.overdue}/${body.kpis.monitors.neverRun}) — ` +
    "a monitor that has never run is not a monitor that stopped running");
  expect(body.kpis.monitors.paused === 1, "and a paused monitor is neither");

  const texts = body.alerts.map((a) => a.text).join(" | ");
  expect(body.alerts.some((a) => a.to === "billing"), `a past-due account raises a billing alert (${texts})`);
  expect(body.alerts.some((a) => a.to === "automation" && /webhook/i.test(a.text)),
    "a failed webhook delivery raises an automation alert");
  expect(body.alerts.some((a) => /email is not configured/i.test(a.text)),
    "an unconfigured mailer is itself an alert — the failure mode is that nothing errors and no mail leaves");

  expect(Array.isArray(body.checked) && body.checked.length > 0,
    "the response names what was CHECKED, so an empty alert list can be told apart from checks that never ran");
  expect(body.activity.length === 2, "recent audit activity is included");
}

{
  // Stripe down. The one case where a fabricated number does the most damage.
  _resetPriceCache();
  const env = makeEnv();
  globalThis.fetch = stripeFetchStub({ fail: true });
  await seed(env);
  const token = await adminToken(env);
  const { status, body } = await call(env, "/api/admin/overview", { token });

  expect(status === 200, "an unreachable Stripe does not take the whole page down");
  expect(body.kpis.revenue.mrr === null,
    "MRR is null, not 0 — a revenue figure of zero would read as 'the business stopped'");
  expect(body.kpis.revenue.reason === "stripe_unreachable", "with the reason named");
  expect(body.alerts.some((a) => /Revenue figures are unavailable/.test(a.text)),
    "and it raises its own alert, so nobody scrolls past a blank number assuming it means zero");
  expect(body.kpis.runsToday.total === 7,
    "every figure that does NOT depend on Stripe is still computed — one broken dependency " +
    "must not blank the page");
}

{
  _resetPriceCache();
  const env = makeEnv({ STRIPE_SECRET_KEY: null });
  globalThis.fetch = stripeFetchStub();
  await seed(env);
  const token = await adminToken(env);
  const { body } = await call(env, "/api/admin/overview", { token });
  expect(body.kpis.revenue.reason === "stripe_not_configured",
    "'not configured' and 'unreachable' are distinct reasons — one is a deploy step, the other an outage");
}

// ===========================================================================
group("accounts");
// ===========================================================================
{
  _resetPriceCache();
  const env = makeEnv();
  globalThis.fetch = stripeFetchStub();
  await seed(env);
  const token = await adminToken(env);

  const { body } = await call(env, "/api/admin/accounts", { token });
  expect(body.accounts.length === 5, `every org is listed (got ${body.accounts.length})`);

  const north = body.accounts.find((a) => a.orgId === "org_north");
  expect(north.seatsUsed === 8 && north.seatsPurchased === 6 && north.seatsOver === 2,
    `membership over purchased seats is surfaced, not clamped (${north.seatsUsed}/${north.seatsPurchased}) — ` +
    "it is a billing conversation somebody has to have");

  const legacy = body.accounts.find((a) => a.orgId === "org_legacy");
  expect(legacy.mrr === null && legacy.mrrKnown === false,
    "an org on an unconfigured price reports unknown revenue rather than zero");
  expect(legacy.tier === null,
    "and no tier — 'not one of our tiers' is deliberately not rounded up to the top one");

  const free = body.accounts.find((a) => a.orgId === "org_free");
  expect(free.mrr === 0 && free.mrrKnown === true,
    "a free org is genuinely zero revenue, which is a different statement from unknown");

  const filtered = await call(env, "/api/admin/accounts?status=past_due", { token });
  expect(filtered.body.accounts.length === 1, "the status filter narrows the list");
  const searched = await call(env, "/api/admin/accounts?q=merid", { token });
  expect(searched.body.accounts.length === 1, "search matches on name");
  const byCus = await call(env, "/api/admin/accounts?q=cus_nor", { token });
  expect(byCus.body.accounts.length === 1,
    "and on the Stripe customer id, which is what an operator has in hand when they arrive from Stripe");
}

// ===========================================================================
group("account detail");
// ===========================================================================
{
  _resetPriceCache();
  const env = makeEnv();
  globalThis.fetch = stripeFetchStub({ invoices: [
    { id: "in_1", number: "INV-1", amount_due: 8900, amount_paid: 0, currency: "usd",
      status: "open", created: now - DAY, attempt_count: 2, hosted_invoice_url: "https://x" },
  ] });
  await seed(env);
  const token = await adminToken(env);

  const { status, body } = await call(env, "/api/admin/accounts/org_north", { token });
  expect(status === 200, "an account detail loads");
  expect(body.account.name === "Northgate", "with the account itself");
  expect(body.members.length === 8, `all members (got ${body.members.length})`);

  const ines = body.members.find((m) => m.userId === "usr_ines");
  expect(ines.authMethodKnown === false && ines.authMethod === null,
    "a member whose row predates the auth_method column reports 'not known', not a guessed method");
  const orphan = body.members.find((m) => m.userId === "usr_extra_0");
  expect(orphan.orphaned === true,
    "a membership whose user row is missing is flagged as an inconsistency rather than rendered as a blank cell");

  expect(body.apiKeys.length === 1 && body.apiKeys[0].prefix === "ask_live_7Qa1",
    "API keys are listed by prefix");
  expect(!JSON.stringify(body.apiKeys).includes("hash1"),
    "and never the stored hash — the panel has no use for it and every exposure is a risk");

  expect(body.monitors.some((m) => m.neverRun === true), "monitors distinguish never-run");
  expect(body.audit.length === 2, "this org's audit slice is included");
  expect(body.webhooks.length === 1, "as are its webhook deliveries");

  const missing = await call(env, "/api/admin/accounts/org_nope", { token });
  expect(missing.status === 404, "an unknown org id is a 404, not an empty account");

  const inv = await call(env, "/api/admin/accounts/org_north/invoices", { token });
  expect(inv.status === 200 && inv.body.invoices.length === 1, "invoices come from Stripe on their own endpoint");
  expect(inv.body.invoices[0].attemptCount === 2, "carrying the dunning attempt count");
}

{
  _resetPriceCache();
  const env = makeEnv();
  globalThis.fetch = stripeFetchStub({ fail: true });
  await seed(env);
  const token = await adminToken(env);
  const inv = await call(env, "/api/admin/accounts/org_north/invoices", { token });
  expect(inv.status === 200 && inv.body.invoices === null && inv.body.reason === "stripe_unreachable",
    "an unreachable Stripe returns null invoices, NOT an empty list — an empty invoice table " +
    "and a broken connection look identical on screen and mean opposite things");

  const free = await call(env, "/api/admin/accounts/org_free/invoices", { token });
  expect(Array.isArray(free.body.invoices) && free.body.invoices.length === 0 &&
         free.body.reason === "no_stripe_customer",
    "an account that never went through checkout genuinely has no invoices, and says which of the two it is");
}

// ===========================================================================
group("user detail and session revocation");
// ===========================================================================
{
  _resetPriceCache();
  const env = makeEnv();
  globalThis.fetch = stripeFetchStub();
  await seed(env);
  const token = await adminToken(env);

  const danaToken1 = await issueJWT(env, "usr_dana", "dana@meridian.com", "active", { authMethod: "google" });
  // A second device. issueJWT signs deterministically over (sub, email,
  // subStatus, iat), so two logins inside the same second produce the
  // identical token — harmless in production, degenerate here. The second
  // session is placed exactly the way issueJWT would place it a second later.
  const danaToken2 = "second.device.token";
  await env.SESSIONS.put(`sess:${danaToken2}`, JSON.stringify({ userId: "usr_dana", email: "dana@meridian.com" }));
  await indexSession(env, "usr_dana", danaToken2, null);

  const { status, body } = await call(env, "/api/admin/users/usr_dana", { token });
  expect(status === 200, "a user detail loads");
  expect(body.sessions.length === 2, `both sessions are listed (got ${body.sessions.length})`);
  expect(body.sessionsComplete === true, "and the list reports itself complete");
  expect(typeof body.sessionsNote === "string" && body.sessionsNote.length > 0,
    "with a note about the sessions this index cannot see — a count presented without that " +
    "caveat reads as an exact device count");
  expect(!JSON.stringify(body.sessions).includes(danaToken1),
    "no session token is returned — the handle is a hash, so a live credential never reaches the client");
  expect(body.user.lastRunAt !== undefined,
    "the closest real signal to 'last active' is the last run, and it is labelled as that rather than relabelled");
  expect(body.user.authMethod === "google",
    "auth_method is recorded at issueJWT, so the drawer can answer 'why can't this person sign in'");

  const ines = await call(env, "/api/admin/users/usr_ines", { token });
  expect(ines.body.user.authMethodKnown === false,
    "and a row that predates the column says it does not know, rather than guessing magic link");

  const sid = await sessionIdFor(danaToken1);
  const revoked = await call(env, `/api/admin/users/usr_dana/sessions/${sid}`, { method: "DELETE", token });
  expect(revoked.status === 200, "an admin can revoke someone else's session");
  expect(await env.SESSIONS.get(`sess:${danaToken1}`) === null, "which really does kill the session");
  expect(await env.SESSIONS.get(`sess:${danaToken2}`) !== null, "and leaves their other session alone");

  const audit = await call(env, "/api/admin/audit?action=session.revoked", { token });
  expect(audit.body.events.length === 1 && audit.body.events[0].actor === ADMIN_EMAIL,
    "signing someone else out is audited — it is invisible to the person it happens to until " +
    "they are logged out mid-task");

  const again = await call(env, `/api/admin/users/usr_dana/sessions/${sid}`, { method: "DELETE", token });
  expect(again.status === 404, "revoking it twice reports not_found rather than a second false success");

  const nobody = await call(env, "/api/admin/users/usr_nope", { token });
  expect(nobody.status === 404, "an unknown user id is a 404");
}

// ===========================================================================
group("billing");
// ===========================================================================
{
  _resetPriceCache();
  const env = makeEnv();
  globalThis.fetch = stripeFetchStub();
  await seed(env);
  const token = await adminToken(env);

  const { body } = await call(env, "/api/admin/billing", { token });
  expect(body.atRisk.length === 1 && body.atRisk[0].orgId === "org_north", "past-due accounts are listed");
  expect(body.atRisk[0].daysOfAccessLeft === 2, `with days of access remaining (got ${body.atRisk[0].daysOfAccessLeft})`);
  expect(body.atRisk[0].accessEnded === false, "and whether access has already ended");
  expect(body.atRisk[0].mrrAtRisk === 8900, "and the revenue at risk");

  expect(body.trials.length === 1, "trials are listed separately");
  expect(body.trials[0].daysLeft === 3, "with days remaining");

  expect(body.byTier.firm && body.byTier.firm.count === 1, "revenue is broken down by tier");
  expect(body.byTier.unconfigured_price && body.byTier.unconfigured_price.mrrKnown === false,
    "an org on an unconfigured price forms its own bucket whose revenue is explicitly unknown — " +
    "folding it into a real tier would attribute revenue to a plan nobody is on");
  expect(body.planChanges.length === 1, "recent plan changes come from the audit log");
  expect(body.planChanges[0].system === true, "and are attributed to `system`, not to a person");
}

// ===========================================================================
group("automation");
// ===========================================================================
{
  _resetPriceCache();
  const env = makeEnv();
  globalThis.fetch = stripeFetchStub();
  await seed(env);
  const token = await adminToken(env);

  const { body } = await call(env, "/api/admin/automation", { token });
  expect(body.monitors.items.length === 4, "every monitor is listed");
  expect(body.monitors.summary.outcomesRecorded === false, "with the same honest sweep caveat");
  expect(body.webhooks.counts.last24h.failed === 1 && body.webhooks.counts.last24h.processed === 1,
    "webhook outcomes are counted by kind");
  expect(body.email.configured === false, "the mailer reports as unconfigured in this environment");
  expect(body.email.missing.includes("EMAIL_FROM") && body.email.missing.includes("GOOGLE_SERVICE_ACCOUNT_JSON"),
    "naming each missing binding — 'email is broken' and 'EMAIL_FROM is unset' send an operator " +
    "to completely different places");
  expect(body.email.items.length === 1 && body.email.items[0].outcome === "skipped",
    "a skipped send is shown as skipped, not as sent and not as failed");
}

// ===========================================================================
group("flags");
// ===========================================================================
{
  _resetPriceCache();
  const env = makeEnv();
  globalThis.fetch = stripeFetchStub();
  await seed(env);
  const token = await adminToken(env);

  const empty = await call(env, "/api/admin/flags", { token });
  expect(empty.body.flags.length === 0, "no flags to begin with");

  const created = await call(env, "/api/admin/flags/white_label_reports", {
    method: "PATCH", token, body: { enabled: true, rolloutPct: 40, description: "d" },
  });
  expect(created.status === 201, `creating a flag responds 201 (got ${created.status})`);
  expect(created.body.flag.rolloutPct === 40, "with the rollout stored");

  const updated = await call(env, "/api/admin/flags/white_label_reports", {
    method: "PATCH", token, body: { rolloutPct: 60 },
  });
  expect(updated.status === 200 && updated.body.flag.enabled === true,
    "a partial patch leaves the fields it did not mention alone");

  const audit = await call(env, "/api/admin/audit?action=flag.updated", { token });
  expect(audit.body.events.length === 2, "every flag change is audited");
  const last = audit.body.events[0];
  expect(last.metadata.from.rolloutPct === 40 && last.metadata.to.rolloutPct === 60,
    "recording BOTH sides — 'turned on white_label_reports' is a much weaker record than " +
    "'moved it from 40% to 60%', and the second is what reconstructs an incident");

  const bad = await call(env, "/api/admin/flags/white_label_reports", {
    method: "PATCH", token, body: { rolloutPct: 150 },
  });
  expect(bad.status === 400 && bad.body.error === "invalid_rollout", "an out-of-range rollout is refused");
  const badKey = await call(env, "/api/admin/flags/NOT_VALID", { method: "PATCH", token, body: { enabled: true } });
  expect(badKey.status === 400, "and so is a malformed key");
}

// ===========================================================================
group("audit feed");
// ===========================================================================
{
  _resetPriceCache();
  const env = makeEnv();
  globalThis.fetch = stripeFetchStub();
  await seed(env);
  const token = await adminToken(env);

  const { body } = await call(env, "/api/admin/audit", { token });
  expect(body.events.length === 2, "the feed loads");
  expect(Array.isArray(body.actions) && body.actions.includes(AUDIT_ACTIONS.API_KEY_REVOKED),
    "the action vocabulary ships with the data, so the panel's filter menu cannot drift out of " +
    "sync with what the writers actually emit");

  const byOrg = await call(env, "/api/admin/audit?orgId=org_north", { token });
  expect(byOrg.body.events.length === 2, "filters pass through");
  const byActor = await call(env, `/api/admin/audit?actor=${encodeURIComponent(ADMIN_EMAIL)}`, { token });
  expect(byActor.body.events.length === 1, "including by actor");
}

// ===========================================================================
group("settings");
// ===========================================================================
{
  _resetPriceCache();
  const env = makeEnv();
  globalThis.fetch = stripeFetchStub();
  await seed(env);
  const token = await adminToken(env);

  const { body } = await call(env, "/api/admin/settings", { token });
  expect(body.admins.emails.length === 1 && body.admins.emails[0].self === true,
    "the admin list comes from ADMIN_EMAILS and marks the caller");
  expect(/ADMIN_EMAILS/.test(body.admins.source),
    "naming its source — there is no admins table, and inventing 'added' and 'last seen' " +
    "columns for an env var would be inventing data");

  const stripe = body.connections.find((c) => c.name === "Stripe");
  expect(stripe.configured === true && body.environment.stripeMode === "test",
    "the Stripe key MODE is reported from its prefix");
  const raw = JSON.stringify(body);
  expect(!raw.includes("sk_test_abc") && !raw.includes("whsec_abc"),
    "and no secret value appears anywhere in the response — this endpoint says yes or no, " +
    "and a config report that echoes secrets is a way to exfiltrate them");

  const mail = body.connections.find((c) => c.name === "Google Workspace mail");
  expect(mail.configured === false && mail.missing.length === 3, "each missing binding is named");

  expect(body.environment.counts.organisations === 5 && body.environment.counts.users === 4,
    "row counts are real reads, not estimates");
  expect(body.environment.bindings.find((b) => b.name === "DB").set === true,
    "bindings report presence only");
  expect(body.environment.schemaEndpoint === "/api/admin/schema-check",
    "schema state points at the endpoint that owns it rather than duplicating its manifest here");
}

console.log("");
if (failures > 0) {
  console.log(`\x1b[31m  ${failures} admin-panel test(s) failed\x1b[0m`);
  process.exit(1);
}
console.log("\x1b[32m  all admin-panel tests passed\x1b[0m");
