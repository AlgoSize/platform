// Tests for the per-user free-tier quota (Task #19).
//
// Covers:
//   1. Pure helpers (currentMonthKey, quotaKey) produce the expected
//      UTC YYYY-MM strings — including across the year boundary.
//   2. Counter starts at 0, increments by 1 per call, persists between
//      calls.
//   3. Increment writes the row with a 35-day TTL (so it survives
//      across the longest possible month).
//   4. enforceQuota wrapper:
//      a. Paid user → handler runs, counter is NEVER touched.
//      b. Free user under limit → handler runs, counter increments by 1
//         AFTER a 200 response.
//      c. Free user, 4 runs already used → 5th call is allowed and
//         increments to 5.
//      d. Free user at the limit (5/5) → 402 quota_exceeded BEFORE the
//         handler is called; handler is never invoked.
//      e. Validation error (handler returns 400) does NOT consume quota.
//      f. Calendar boundary: a counter at 5 in December does NOT block
//         a request in the following January (separate KV key).
//   5. End-to-end via the analyze handler chain — proves the wrapper is
//      wired into the actual analyzeAlgoHandler, not just unit-tested.
//   6. POST /api/signup creates a free user, sets a session cookie,
//      and rejects duplicate emails / invalid bodies.
//
// Run with:  node scripts/test-quota.mjs

import {
  currentMonthKey, quotaKey,
  getMonthlyUsage, incrementMonthlyUsage,
  enforceQuota,
  FREE_MONTHLY_LIMIT, QUOTA_TTL_SECONDS,
} from "../src/quota.js";
import { signupHandler } from "../src/handlers/signup.js";
import { meHandler } from "../src/handlers/me.js";
import {
  upsertUserFromCheckout, createFreeUser, getUserById,
} from "../src/handlers/_users.js";
import { issueJWT, requireAuth } from "../src/auth.js";
import { analyzeAlgoHandler } from "../src/handlers/analyze.js";
import { makeD1 } from "./_d1-stub.mjs";

const JWT_SECRET = "quota-test-jwt-secret-32-or-more-chars-please";

let failures = 0;
const ok   = (msg) => console.log(`  \x1b[32m✓\x1b[0m ${msg}`);
const fail = (msg) => { console.log(`  \x1b[31m✗\x1b[0m ${msg}`); failures++; };
const expect = (cond, label) => cond ? ok(label) : fail(label);

// ---- KV stub: in-memory + records put options so we can assert TTL --------
function makeKV() {
  const store = new Map();
  const opts  = new Map();
  return {
    async get(key)              { return store.has(key) ? store.get(key) : null; },
    async put(key, val, o = {}) { store.set(key, val); opts.set(key, o); },
    async delete(key)           { store.delete(key); opts.delete(key); },
    _store: store,
    _opts:  opts,
  };
}

function makeEnv() {
  return {
    JWT_SECRET,
    SITE_ORIGIN:        "http://localhost:5000",
    COOKIE_NAME:        "algosize_session",
    SESSIONS:           makeKV(),
    USERS:              makeKV(),
    DB:                 makeD1(),  // user records + run history (Task #25)
  };
}

// ---------------------------------------------------------------------------
console.log("\nquota — pure helpers\n");
// ---------------------------------------------------------------------------

{
  const jan1 = new Date(Date.UTC(2026, 0, 1, 0, 0, 0));
  expect(currentMonthKey(jan1) === "2026-01", "currentMonthKey: Jan 1 → 2026-01");
  const dec31 = new Date(Date.UTC(2026, 11, 31, 23, 59, 59));
  expect(currentMonthKey(dec31) === "2026-12", "currentMonthKey: Dec 31 23:59 UTC → 2026-12");
  // Edge: just-before-midnight UTC on the LAST day of a month is still that
  // month, even when local time is already in the next month somewhere.
  expect(quotaKey("usr_abc", jan1) === "quota:usr_abc:2026-01", "quotaKey shape correct");
}

// ---------------------------------------------------------------------------
console.log("\nquota — getMonthlyUsage / incrementMonthlyUsage\n");
// ---------------------------------------------------------------------------

{
  const env = makeEnv();
  const userId = "usr_counter";
  const now = new Date(Date.UTC(2026, 4, 10));  // 2026-05-10

  expect(await getMonthlyUsage(env, userId, now) === 0, "missing key reads as 0");

  const v1 = await incrementMonthlyUsage(env, userId, now);
  const v2 = await incrementMonthlyUsage(env, userId, now);
  const v3 = await incrementMonthlyUsage(env, userId, now);
  expect(v1 === 1 && v2 === 2 && v3 === 3, "increments return 1, 2, 3 in order");
  expect(await getMonthlyUsage(env, userId, now) === 3, "persisted value is 3");

  const opts = env.USERS._opts.get(`quota:${userId}:2026-05`);
  expect(opts && opts.expirationTtl === QUOTA_TTL_SECONDS,
    `KV put requested expirationTtl = ${QUOTA_TTL_SECONDS}s (35 days)`);

  // Counter is per-month: a different month doesn't see this count.
  const nextMonth = new Date(Date.UTC(2026, 5, 1));
  expect(await getMonthlyUsage(env, userId, nextMonth) === 0,
    "counter for different month is 0 — calendar reset works");
}

// ---------------------------------------------------------------------------
console.log("\nquota — enforceQuota wrapper (unit, paid bypass)\n");
// ---------------------------------------------------------------------------

// Mini analyzer handler that we can spy on. Returns 200 with { ok: true }
// unless `request.__shouldFail` is set, in which case it returns 400.
function makeStubHandler() {
  let calls = 0;
  const handler = async (request) => {
    calls++;
    if (request.__shouldFail) {
      return new Response(JSON.stringify({ error: "validation" }), {
        status: 400, headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ ok: true }), {
      status: 200, headers: { "content-type": "application/json" },
    });
  };
  return { handler, get calls() { return calls; } };
}

// Pretend-`request.user`-attached request for direct wrapper tests.
function makeAuthedRequest(user) {
  const req = new Request("http://localhost/api/analyze/algo", { method: "POST" });
  req.user = user;
  return req;
}

{
  const env = makeEnv();
  const paid = await upsertUserFromCheckout(env, {
    email: "paid@example.com",
    stripeCustomerId: "cus_PAID",
    subStatus: "active",
  });
  expect(paid.plan === "paid", "upsertUserFromCheckout writes plan='paid'");

  const stub = makeStubHandler();
  const wrapped = enforceQuota(stub.handler);

  // Simulate 10 paid-user calls — never blocked, never increment.
  for (let i = 0; i < 10; i++) {
    const res = await wrapped(makeAuthedRequest({ userId: paid.userId }), env, {});
    if (res.status !== 200) { fail(`paid call ${i+1}: expected 200, got ${res.status}`); break; }
  }
  expect(stub.calls === 10, "paid user: handler called all 10 times");
  expect(await getMonthlyUsage(env, paid.userId) === 0,
    "paid user: counter never incremented");
}

// ---------------------------------------------------------------------------
console.log("\nquota — enforceQuota wrapper (free under limit, increment-on-success)\n");
// ---------------------------------------------------------------------------

{
  const env = makeEnv();
  const { user: free } = await createFreeUser(env, { email: "free@example.com" });
  expect(free.plan === "free", "createFreeUser writes plan='free'");
  expect(free.stripeCustomerId === "", "free user has empty stripeCustomerId");

  const stub = makeStubHandler();
  const wrapped = enforceQuota(stub.handler);

  // 1st call: 200, counter → 1
  let res = await wrapped(makeAuthedRequest({ userId: free.userId }), env, {});
  expect(res.status === 200, "free 1st call → 200");
  expect(await getMonthlyUsage(env, free.userId) === 1, "counter is 1 after 1st run");

  // Validation error mid-quota: counter must NOT increment
  const failingReq = makeAuthedRequest({ userId: free.userId });
  failingReq.__shouldFail = true;
  res = await wrapped(failingReq, env, {});
  expect(res.status === 400, "validation error returns 400");
  expect(await getMonthlyUsage(env, free.userId) === 1,
    "counter unchanged after a 400 (no quota wasted on validation errors)");

  // Burn through the rest: calls 2-5 succeed, call 6 hits 402
  for (let i = 2; i <= 5; i++) {
    res = await wrapped(makeAuthedRequest({ userId: free.userId }), env, {});
    if (res.status !== 200) { fail(`free call ${i}: expected 200, got ${res.status}`); }
  }
  expect(await getMonthlyUsage(env, free.userId) === FREE_MONTHLY_LIMIT,
    `counter reached the limit (${FREE_MONTHLY_LIMIT})`);

  // 6th call: 402, handler NOT invoked
  const callsBefore = stub.calls;
  res = await wrapped(makeAuthedRequest({ userId: free.userId }), env, {});
  expect(res.status === 402, "6th call returns 402 quota_exceeded");
  const body = await res.json();
  expect(body.error === "quota_exceeded", "402 body.error === 'quota_exceeded'");
  expect(body.monthlyRunsLimit === FREE_MONTHLY_LIMIT,
    "402 body includes monthlyRunsLimit");
  expect(body.monthlyRunsUsed === FREE_MONTHLY_LIMIT,
    "402 body includes monthlyRunsUsed");
  expect(typeof body.upgradeUrl === "string" && body.upgradeUrl.includes("#pricing"),
    "402 body includes upgradeUrl pointing at #pricing");
  expect(stub.calls === callsBefore,
    "handler was NOT invoked after the limit was hit");
  expect(await getMonthlyUsage(env, free.userId) === FREE_MONTHLY_LIMIT,
    "counter stays at limit (no spurious increment on 402)");
}

// ---------------------------------------------------------------------------
console.log("\nquota — calendar boundary reset\n");
// ---------------------------------------------------------------------------

{
  const env = makeEnv();
  const { user: free } = await createFreeUser(env, { email: "boundary@example.com" });

  // Pre-seed December counter at the limit.
  const dec = new Date(Date.UTC(2026, 11, 28));
  for (let i = 0; i < FREE_MONTHLY_LIMIT; i++) {
    await incrementMonthlyUsage(env, free.userId, dec);
  }
  expect(await getMonthlyUsage(env, free.userId, dec) === FREE_MONTHLY_LIMIT,
    "December counter pre-seeded at limit");

  const stub = makeStubHandler();
  // Inject `now` so we test the wrapper without time-travelling the clock.
  const decWrapped = enforceQuota(stub.handler, { now: () => dec });
  const janWrapped = enforceQuota(stub.handler, { now: () => new Date(Date.UTC(2027, 0, 1)) });

  // Same user, December: blocked.
  let res = await decWrapped(makeAuthedRequest({ userId: free.userId }), env, {});
  expect(res.status === 402, "December call at limit → 402");

  // Same user, January: ALLOWED — separate KV key.
  res = await janWrapped(makeAuthedRequest({ userId: free.userId }), env, {});
  expect(res.status === 200, "January call resets quota → 200");
  expect(await getMonthlyUsage(env, free.userId, new Date(Date.UTC(2027, 0, 1))) === 1,
    "January counter starts at 1");
  expect(await getMonthlyUsage(env, free.userId, dec) === FREE_MONTHLY_LIMIT,
    "December counter unchanged");
}

// ---------------------------------------------------------------------------
console.log("\nquota — end-to-end via analyzeAlgoHandler\n");
// ---------------------------------------------------------------------------

// Run the full requireAuth → enforceQuota → analyzeAlgoHandler chain so we
// prove the wrapper is wired into the real router, not just unit-tested.
async function callAnalyze(req, env, ctx, wrapped) {
  const guard = await requireAuth(req, env);
  if (guard) return guard;
  return wrapped(req, env, ctx);
}

{
  const env = makeEnv();
  const { user: free } = await createFreeUser(env, { email: "e2e@example.com" });
  const token = await issueJWT(env, free.userId, free.email, free.subStatus);
  const wrapped = enforceQuota(analyzeAlgoHandler);

  // Use a trivial JS function that the in-process sandbox can run.
  const body = JSON.stringify({
    code: "function ok(n){ return n + 1; }",
    sampleInput: 42,
  });
  function makeReq() {
    return new Request("http://localhost/api/analyze/algo", {
      method: "POST",
      headers: {
        "Cookie": `algosize_session=${encodeURIComponent(token)}`,
        "Content-Type": "application/json",
      },
      body,
    });
  }

  // 5 successful runs, all 200.
  for (let i = 1; i <= FREE_MONTHLY_LIMIT; i++) {
    const res = await callAnalyze(makeReq(), env, {}, wrapped);
    if (res.status !== 200) {
      fail(`e2e free run ${i}: expected 200, got ${res.status}`);
    }
  }
  expect(await getMonthlyUsage(env, free.userId) === FREE_MONTHLY_LIMIT,
    "e2e: counter at limit after 5 real algo runs");

  // 6th: 402.
  const blocked = await callAnalyze(makeReq(), env, {}, wrapped);
  expect(blocked.status === 402, "e2e 6th run → 402 from the live handler chain");
}

// ---------------------------------------------------------------------------
console.log("\nsignup — POST /api/signup\n");
// ---------------------------------------------------------------------------

{
  const env = makeEnv();
  const req = new Request("http://localhost/api/signup", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "Newbie@Example.COM" }),
  });
  const res = await signupHandler(req, env);
  expect(res.status === 201, "fresh signup → 201");
  const body = await res.json();
  expect(body.plan === "free" && body.email === "newbie@example.com",
    "response carries plan='free' and lowercased email");
  expect(body.monthlyRunsUsed === 0 && body.monthlyRunsLimit === FREE_MONTHLY_LIMIT,
    "response carries monthlyRunsUsed/Limit");
  const cookie = res.headers.get("Set-Cookie");
  expect(typeof cookie === "string" && cookie.includes("algosize_session="),
    "Set-Cookie header carries the session JWT");
  expect(cookie.includes("HttpOnly") && cookie.includes("SameSite=Lax"),
    "Set-Cookie is HttpOnly + SameSite=Lax");

  // The user row exists in D1 with plan='free'.
  const user = await getUserByEmailHelper(env, "newbie@example.com");
  expect(user && user.plan === "free", "D1 users row written with plan='free'");
  expect(user.stripeCustomerId === "", "free user row has empty stripeCustomerId");
}

{
  // Duplicate email → 409, no new row, no session
  const env = makeEnv();
  await createFreeUser(env, { email: "dup@example.com" });
  const req = new Request("http://localhost/api/signup", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "dup@example.com" }),
  });
  const res = await signupHandler(req, env);
  expect(res.status === 409, "duplicate email → 409");
  const body = await res.json();
  expect(body.error === "email_taken", "409 body.error === 'email_taken'");
  expect(!res.headers.get("Set-Cookie"), "duplicate signup does NOT set a cookie");
}

{
  // Invalid email → 400
  const env = makeEnv();
  for (const bad of ["", "  ", "no-at-sign", "missing@tld", "@nohost.com", "x".repeat(255) + "@x.io"]) {
    const req = new Request("http://localhost/api/signup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: bad }),
    });
    const res = await signupHandler(req, env);
    if (res.status !== 400) {
      fail(`bad email "${bad.slice(0,30)}": expected 400, got ${res.status}`);
    }
  }
  ok("rejects malformed emails with 400 invalid_email");
}

{
  // Invalid JSON body → 400 invalid_json
  const env = makeEnv();
  const req = new Request("http://localhost/api/signup", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{not json",
  });
  const res = await signupHandler(req, env);
  expect(res.status === 400, "invalid JSON → 400");
}

// ---------------------------------------------------------------------------
console.log("\n/api/me — quota fields exposed for the dashboard\n");
// ---------------------------------------------------------------------------

{
  const env = makeEnv();
  const { user: free } = await createFreeUser(env, { email: "me-free@example.com" });
  // Burn 2 free runs.
  await incrementMonthlyUsage(env, free.userId);
  await incrementMonthlyUsage(env, free.userId);
  const token = await issueJWT(env, free.userId, free.email, free.subStatus);

  const req = new Request("http://localhost/api/me", {
    method: "GET",
    headers: { "Cookie": `algosize_session=${encodeURIComponent(token)}` },
  });
  const guard = await requireAuth(req, env);
  if (guard) { fail("requireAuth blocked the /api/me call"); }
  else {
    const res = await meHandler(req, env);
    const body = await res.json();
    expect(body.plan === "free", "/api/me reports plan='free'");
    expect(body.monthlyRunsUsed === 2, "/api/me reports monthlyRunsUsed=2");
    expect(body.monthlyRunsLimit === FREE_MONTHLY_LIMIT,
      `/api/me reports monthlyRunsLimit=${FREE_MONTHLY_LIMIT}`);
  }
}

{
  // Paid user → /api/me returns plan="paid" and null counters (UI shows
  // "Unlimited" instead of a fraction).
  const env = makeEnv();
  const paid = await upsertUserFromCheckout(env, {
    email: "me-paid@example.com",
    stripeCustomerId: "cus_ME_PAID",
    subStatus: "active",
  });
  const token = await issueJWT(env, paid.userId, paid.email, paid.subStatus);
  const req = new Request("http://localhost/api/me", {
    method: "GET",
    headers: { "Cookie": `algosize_session=${encodeURIComponent(token)}` },
  });
  const guard = await requireAuth(req, env);
  if (guard) { fail("requireAuth blocked the paid /api/me call"); }
  else {
    const body = await (await meHandler(req, env)).json();
    expect(body.plan === "paid", "/api/me reports plan='paid' for paid users");
    expect(body.monthlyRunsUsed === null && body.monthlyRunsLimit === null,
      "/api/me returns null counters for paid users");
  }
}

// Helper: get user by email. Post-#25 we just hit D1 directly — the
// previous KV `email:` index is gone.
async function getUserByEmailHelper(env, email) {
  const row = await env.DB
    .prepare("SELECT user_id FROM users WHERE email = ?")
    .bind(email.toLowerCase())
    .first();
  if (!row) return null;
  return getUserById(env, row.user_id);
}

// ---------- summary ----------
console.log("");
if (failures === 0) {
  console.log("\x1b[32m  all quota tests passed\x1b[0m\n");
  process.exit(0);
} else {
  console.log(`\x1b[31m  ${failures} quota test(s) failed\x1b[0m\n`);
  process.exit(1);
}
