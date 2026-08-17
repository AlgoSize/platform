// Tests for src/entitlement.js — the single decision point for paid vs free.
//
// Every case here corresponds to a way the old code gave away paid access:
//
//   1. A valid session with no users row resolved to "paid" in BOTH
//      quota.js:196 and me.js:33, so a failed insert or a deleted account
//      handed out unlimited runs and the dashboard displayed "Unlimited".
//   2. `sub_status` was written by the Stripe webhook and never read, so a
//      cancelled customer kept full access forever — cancelling cost them
//      nothing, and nothing ever performed the downgrade the code comment
//      promised.
//
// The last block is the regression test that matters commercially: a user
// with no row, already at the free limit, must be refused. Before this change
// that exact request was served unlimited.
//
// Run with:  node scripts/test-entitlement.mjs

import { resolveEntitlement, ENTITLEMENT_REASON } from "../src/entitlement.js";
import { enforceQuota, FREE_MONTHLY_LIMIT, quotaKey } from "../src/quota.js";
import { analyzeVulnHandler } from "../src/handlers/analyze.js";
import { meHandler } from "../src/handlers/me.js";
import { makeD1 } from "./_d1-stub.mjs";

let failures = 0;
const ok   = (msg) => console.log(`  \x1b[32m✓\x1b[0m ${msg}`);
const fail = (msg) => { console.log(`  \x1b[31m✗\x1b[0m ${msg}`); failures++; };
const expect = (cond, label) => cond ? ok(label) : fail(label);

function makeKV() {
  const store = new Map();
  return {
    async get(key)              { return store.has(key) ? store.get(key) : null; },
    async put(key, val, o = {}) { store.set(key, val); },
    async delete(key)           { store.delete(key); },
    _store: store,
  };
}

function makeEnv(overrides = {}) {
  return {
    JWT_SECRET:  "entitlement-test-secret-32-chars-or-more!",
    SITE_ORIGIN: "https://algosize.com",
    COOKIE_NAME: "algosize_session",
    SESSIONS: makeKV(),
    USERS:    makeKV(),
    DB:       makeD1(),
    ...overrides,
  };
}

const NOW = 1_800_000_000;            // fixed clock, unix seconds
const DAY = 86_400;

// meHandler takes no injectable clock (it has no reason to — nothing in
// /api/me is time-sensitive except this one comparison), so the /api/me block
// below is evaluated against the real wall clock. NOW is a fixed point in the
// future, which makes `NOW - DAY` future-dated too. Use a timestamp that is
// unambiguously in the past for any real clock instead.
const LONG_EXPIRED = 1_000_000_000;   // 2001-09-09

/**
 * Insert a user and the organisation they own, so each case starts from an
 * exact state. Entitlement is resolved from the ORG since migrations/0004 —
 * the plan and subscription columns go there, and the user row carries only
 * identity. Seeding a user alone would resolve as `no_org`.
 */
async function seedUser(env, { userId, plan = "free", subStatus = null, periodEnd = null, email, seats = 1 }) {
  const addr  = email || `${userId}@example.com`;
  const orgId = `org_${userId}`;
  await env.DB.prepare(
    `INSERT INTO users (user_id, email, stripe_customer_id, plan, sub_status,
                        active_org_id, created_at, updated_at)
     VALUES (?, ?, NULL, 'free', NULL, ?, ?, ?)`,
  ).bind(userId, addr, orgId, NOW, NOW).run();
  await env.DB.prepare(
    `INSERT INTO organisations (org_id, name, stripe_customer_id, plan, sub_status,
                                current_period_end, seats_purchased, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(orgId, addr, plan === "paid" ? `cus_${userId}` : null, plan, subStatus,
         periodEnd, seats, NOW, NOW).run();
  await env.DB.prepare(
    "INSERT INTO memberships (org_id, user_id, role, created_at) VALUES (?, ?, 'owner', ?)",
  ).bind(orgId, userId, NOW).run();
}

function authedRequest(userId, url = "https://algosize.com/api/analyze/vuln", body = { code: "const x = 1;" }) {
  const req = new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  req.user = { userId, email: `${userId}@example.com`, subStatus: "active" };
  return req;
}

// ---------------------------------------------------------------------------
console.log("\nresolveEntitlement — the rules\n");
// ---------------------------------------------------------------------------

{
  // 1. Missing row must fail CLOSED, and must be reported rather than hidden.
  const env = makeEnv();
  const captured = [];
  env.SENTRY_DSN = "https://key@o1.ingest.sentry.io/1";
  env.FETCH = async (url, init) => { captured.push({ url, init }); return new Response("{}", { status: 200 }); };

  const r = await resolveEntitlement(env, "usr_ghost", { now: NOW });
  expect(r.plan === "free", `no users row → plan free (got ${r.plan})`);
  expect(r.active === false, "no users row → not entitled");
  expect(r.reason === ENTITLEMENT_REASON.NO_USER_ROW, `reason is no_user_row (got ${r.reason})`);
  expect(r.user === null, "no user object is returned");
}

{
  // A session with no user id at all — defensive; requireAuth should catch it.
  const env = makeEnv();
  const r = await resolveEntitlement(env, undefined, { now: NOW });
  expect(r.active === false && r.reason === ENTITLEMENT_REASON.NO_USER_ID,
         "missing userId → not entitled, reason no_user_id");
}

{
  // 2. A plain free user.
  const env = makeEnv();
  await seedUser(env, { userId: "usr_free", plan: "free" });
  const r = await resolveEntitlement(env, "usr_free", { now: NOW });
  expect(r.plan === "free" && r.active === false, "free plan → not entitled");
  expect(r.reason === ENTITLEMENT_REASON.FREE_PLAN, "reason is free_plan");
  expect(r.user && r.user.email === "usr_free@example.com", "the row is returned to the caller");
}

{
  // 3. An active subscriber. Period end is irrelevant while active.
  const env = makeEnv();
  await seedUser(env, { userId: "usr_paid", plan: "paid", subStatus: "active", periodEnd: NOW - DAY });
  const r = await resolveEntitlement(env, "usr_paid", { now: NOW });
  expect(r.plan === "paid" && r.active === true, "active subscription → entitled");
  expect(r.reason === ENTITLEMENT_REASON.ACTIVE_SUBSCRIPTION, "reason is active_subscription");
}

{
  // 4. Cancelled, still inside the period they paid for → keep serving them.
  const env = makeEnv();
  await seedUser(env, { userId: "usr_grace", plan: "paid", subStatus: "inactive", periodEnd: NOW + 10 * DAY });
  const r = await resolveEntitlement(env, "usr_grace", { now: NOW });
  expect(r.active === true, "cancelled inside the paid period → still entitled");
  expect(r.reason === ENTITLEMENT_REASON.GRACE_PERIOD, "reason is grace_period");
  expect(r.plan === "paid", "plan still reads paid during grace");
}

{
  // 5. Cancelled and past the period → the downgrade that never used to happen.
  const env = makeEnv();
  await seedUser(env, { userId: "usr_expired", plan: "paid", subStatus: "inactive", periodEnd: NOW - DAY });
  const r = await resolveEntitlement(env, "usr_expired", { now: NOW });
  expect(r.active === false, "cancelled past the paid period → no longer entitled");
  expect(r.reason === ENTITLEMENT_REASON.PERIOD_EXPIRED, "reason is period_expired");
}

{
  // The exact boundary: entitlement ends AT current_period_end, not after it.
  const env = makeEnv();
  await seedUser(env, { userId: "usr_edge", plan: "paid", subStatus: "inactive", periodEnd: NOW });
  const atEnd  = await resolveEntitlement(env, "usr_edge", { now: NOW });
  const before = await resolveEntitlement(env, "usr_edge", { now: NOW - 1 });
  expect(atEnd.active === false, "at exactly current_period_end → not entitled");
  expect(before.active === true, "one second before → entitled");
}

{
  // 6. Paid but cancelled with no paid-through date on file: fail closed, and
  //    say so distinctly so a pre-0002 row can be spotted rather than guessed at.
  const env = makeEnv();
  await seedUser(env, { userId: "usr_nodate", plan: "paid", subStatus: "inactive", periodEnd: null });
  const r = await resolveEntitlement(env, "usr_nodate", { now: NOW });
  expect(r.active === false, "cancelled with no period end → not entitled");
  expect(r.reason === ENTITLEMENT_REASON.MISSING_PERIOD_END, "reason is missing_period_end");
}

// ---------------------------------------------------------------------------
console.log("\nenforceQuota — the analyzer gate agrees with the resolver\n");
// ---------------------------------------------------------------------------

const stubHandler = async () => new Response(JSON.stringify({ ok: true }), {
  status: 200, headers: { "content-type": "application/json" },
});

{
  // Active subscriber bypasses the quota entirely and never increments.
  const env = makeEnv();
  await seedUser(env, { userId: "usr_sub", plan: "paid", subStatus: "active" });
  const wrapped = enforceQuota(stubHandler);
  const res = await wrapped(authedRequest("usr_sub"), env, {});
  expect(res.status === 200, "active subscriber: analyzer runs");
  expect(env.USERS._store.size === 0, "active subscriber: no counter written");
}

{
  // Cancelled-and-expired subscriber is now metered like a free user.
  const env = makeEnv();
  await seedUser(env, { userId: "usr_gone", plan: "paid", subStatus: "inactive", periodEnd: NOW - DAY });
  await env.USERS.put(quotaKey("usr_gone", new Date(NOW * 1000)), String(FREE_MONTHLY_LIMIT));

  const wrapped = enforceQuota(stubHandler, { now: () => new Date(NOW * 1000) });
  const res = await wrapped(authedRequest("usr_gone"), env, {});
  const body = await res.json();
  expect(res.status === 402, `expired subscriber at the limit → 402 (got ${res.status})`);
  expect(body.error === "quota_exceeded", "expired subscriber gets quota_exceeded, not unlimited access");
}

{
  // Cancelled but still inside the period → unaffected.
  const env = makeEnv();
  await seedUser(env, { userId: "usr_still", plan: "paid", subStatus: "inactive", periodEnd: NOW + DAY });
  await env.USERS.put(quotaKey("usr_still", new Date(NOW * 1000)), String(FREE_MONTHLY_LIMIT));

  const wrapped = enforceQuota(stubHandler, { now: () => new Date(NOW * 1000) });
  const res = await wrapped(authedRequest("usr_still"), env, {});
  expect(res.status === 200, "cancelled inside the paid period: analyzer still runs");
}

// ---------------------------------------------------------------------------
console.log("\nregression — the leak this change closes\n");
// ---------------------------------------------------------------------------

{
  // THE case: a session whose users row does not exist, already at the free
  // limit. Old behaviour: plan defaulted to "paid" → 200, unlimited, forever.
  // New behaviour: free → 402.
  const env = makeEnv();
  await env.USERS.put(quotaKey("usr_orphan", new Date(NOW * 1000)), String(FREE_MONTHLY_LIMIT));

  const wrapped = enforceQuota(analyzeVulnHandler, { now: () => new Date(NOW * 1000) });
  const res = await wrapped(authedRequest("usr_orphan"), env, {});
  const body = await res.json();

  expect(res.status === 402,
         `no users row + at limit → 402 from analyzeVulnHandler (got ${res.status})`);
  expect(body.error === "quota_exceeded", "the orphan session is metered, not given unlimited access");
  expect(typeof body.upgradeUrl === "string", "the 402 still tells them how to upgrade");
}

{
  // And the same orphan under the limit still works — failing closed on
  // entitlement must not mean failing closed on access.
  const env = makeEnv();
  const wrapped = enforceQuota(stubHandler, { now: () => new Date(NOW * 1000) });
  const res = await wrapped(authedRequest("usr_orphan2"), env, {});
  expect(res.status === 200, "no users row under the limit → still served as a free user");
}

// ---------------------------------------------------------------------------
console.log("\n/api/me reports the same answer as the gate\n");
// ---------------------------------------------------------------------------

async function callMe(env, userId) {
  const req = new Request("https://algosize.com/api/me");
  req.user = { userId, email: `${userId}@example.com`, subStatus: "active" };
  return (await meHandler(req, env, {})).json();
}

{
  const env = makeEnv();
  await seedUser(env, { userId: "usr_m_paid", plan: "paid", subStatus: "active" });
  const body = await callMe(env, "usr_m_paid");
  expect(body.plan === "paid", "/api/me: active subscriber reads paid");
  expect(body.monthlyRunsUsed === null && body.monthlyRunsLimit === null,
         "/api/me: paid users get null counters (dashboard shows Unlimited)");
}

{
  const env = makeEnv();
  await seedUser(env, { userId: "usr_m_gone", plan: "paid", subStatus: "inactive", periodEnd: LONG_EXPIRED });
  const body = await callMe(env, "usr_m_gone");
  expect(body.plan === "free", "/api/me: expired subscriber reads free, matching the gate");
  expect(body.monthlyRunsLimit === FREE_MONTHLY_LIMIT, "/api/me: expired subscriber gets the free limit");
}

{
  // The orphan session: still a usable response, but no longer a false
  // promise of unlimited runs.
  const env = makeEnv();
  const body = await callMe(env, "usr_m_orphan");
  expect(body.email === "usr_m_orphan@example.com", "/api/me: falls back to the session email");
  expect(body.plan === "free", "/api/me: orphan session reads free, not paid");
  expect(body.monthlyRunsLimit === FREE_MONTHLY_LIMIT, "/api/me: orphan session gets the free limit");
}

// ---------------------------------------------------------------------------
console.log(failures === 0
  ? "\n\x1b[32mAll entitlement tests passed\x1b[0m\n"
  : `\n\x1b[31m${failures} entitlement test(s) failed\x1b[0m\n`);
process.exit(failures === 0 ? 0 : 1);
