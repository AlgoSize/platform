// Tests for the "1 free run left" quota-warning email trigger (Task #57).
//
// Covers:
//   1. Pure helpers
//      - quotaWarnedKey shape matches `quota:<userId>:<YYYY-MM>:warned`
//      - QUOTA_WARN_AT_RUNS === FREE_MONTHLY_LIMIT - 1
//   2. maybeSendQuotaWarning unit tests
//      a. Wrong threshold (1, 2, 3, 5) → no send, reason="not_threshold"
//      b. At threshold (4) → exactly one send, recipient + subject + body
//         match the quotaWarning template
//      c. Calling twice at threshold → second call returns
//         reason="already_warned" and the spy was called only once
//      d. Missing user / missing email → reason="no_user", no send
//      e. Sentinel TTL is the same 35d as the counter (so it expires
//         before next month's trigger needs to re-arm)
//   3. End-to-end via enforceQuota wrapper
//      a. Free user runs 4 successful analyses → spy called once after
//         the 4th run, payload has runsUsed=4, runsLimit=5
//      b. 5th run does NOT trigger again (counter past threshold)
//      c. Paid user running 10 times → spy never called
//      d. Validation error (handler returns 400) at the boundary does
//         NOT consume quota and does NOT send the email
//   4. Month rollover re-arms
//      - Same user crosses 4 in May (1 send), then crosses 4 again in
//        June (1 more send) — different sentinel keys, different emails.
//
// Run with:  node scripts/test-quota-email.mjs

import {
  quotaKey, quotaWarnedKey,
  getMonthlyUsage, incrementMonthlyUsage,
  maybeSendQuotaWarning, enforceQuota,
  FREE_MONTHLY_LIMIT, QUOTA_WARN_AT_RUNS, QUOTA_TTL_SECONDS,
} from "../src/quota.js";
import { upsertUserFromCheckout, createFreeUser } from "../src/handlers/_users.js";
import { makeD1 } from "./_d1-stub.mjs";

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
    JWT_SECRET:  "quota-email-test-secret-32-or-more-chars",
    SITE_ORIGIN: "http://localhost:5000",
    COOKIE_NAME: "algosize_session",
    SESSIONS:    makeKV(),
    USERS:       makeKV(),
    DB:          makeD1(),
  };
}

// Spy factory used everywhere a sendTransactional override is needed.
function makeSendSpy({ sent = true } = {}) {
  const calls = [];
  const fn = async (env, ctx, msg) => {
    calls.push({ to: msg.to, subject: msg.subject, text: msg.text, html: msg.html });
    return sent
      ? { sent: true, messageId: `stub-${calls.length}` }
      : { sent: false, reason: "send_failed" };
  };
  fn.calls = calls;
  return fn;
}

// ---------------------------------------------------------------------------
console.log("\nquota email — pure helpers\n");
// ---------------------------------------------------------------------------

{
  expect(QUOTA_WARN_AT_RUNS === FREE_MONTHLY_LIMIT - 1,
    `QUOTA_WARN_AT_RUNS === ${FREE_MONTHLY_LIMIT - 1} (1 run left after this success)`);
  const may = new Date(Date.UTC(2026, 4, 10));
  expect(quotaWarnedKey("usr_x", may) === "quota:usr_x:2026-05:warned",
    "quotaWarnedKey shape: <counter>:warned");
  // The counter and sentinel share the YYYY-MM suffix, so they expire/reset
  // together at the calendar boundary.
  expect(quotaWarnedKey("usr_x", may).startsWith(quotaKey("usr_x", may)),
    "sentinel key derived from counter key");
}

// ---------------------------------------------------------------------------
console.log("\nquota email — maybeSendQuotaWarning unit tests\n");
// ---------------------------------------------------------------------------

{
  const env = makeEnv();
  const { user } = await createFreeUser(env, { email: "warn@example.com" });
  const now = new Date(Date.UTC(2026, 4, 15));
  const spy = makeSendSpy();

  // Below + above the threshold should be a no-op.
  for (const n of [0, 1, 2, 3, 5, 6]) {
    const r = await maybeSendQuotaWarning(env, {}, user, n, now, spy);
    if (r.sent || r.reason !== "not_threshold") {
      fail(`runsUsed=${n}: expected reason="not_threshold", got ${JSON.stringify(r)}`);
    }
  }
  expect(spy.calls.length === 0, "below/above threshold: send spy never called");
}

{
  const env = makeEnv();
  const { user } = await createFreeUser(env, { email: "warn@example.com" });
  const now = new Date(Date.UTC(2026, 4, 15));
  const spy = makeSendSpy();

  const r = await maybeSendQuotaWarning(env, {}, user, QUOTA_WARN_AT_RUNS, now, spy);
  expect(r.sent === true, "threshold crossing → result.sent = true");
  expect(spy.calls.length === 1, "threshold crossing: spy called exactly once");
  const sent = spy.calls[0];
  expect(sent.to === user.email, "email recipient is the user's address");
  expect(sent.subject === "Algosize — 1 free run left this month",
    "subject matches the quotaWarning template");
  expect(sent.text.includes("4 of your 5 free"),
    "text body cites the actual runsUsed/runsLimit");
  expect(sent.text.includes("June 1, 2026"),
    "text body cites the first-of-next-month reset date in human form");
  expect(sent.html.includes("4 of 5"),
    "html body shows '4 of 5' to match the template");

  // Sentinel was written with the 35d TTL.
  const sentinelKey = quotaWarnedKey(user.userId, now);
  expect(env.USERS._store.get(sentinelKey) === "1",
    "sentinel KV key is set to '1' after a successful send");
  const opts = env.USERS._opts.get(sentinelKey);
  expect(opts && opts.expirationTtl === QUOTA_TTL_SECONDS,
    `sentinel TTL is ${QUOTA_TTL_SECONDS}s (matches counter)`);

  // Second call at the same threshold must be a no-op.
  const r2 = await maybeSendQuotaWarning(env, {}, user, QUOTA_WARN_AT_RUNS, now, spy);
  expect(r2.sent === false && r2.reason === "already_warned",
    "second crossing in same month → reason='already_warned'");
  expect(spy.calls.length === 1, "second crossing: spy was NOT called again");
}

{
  // Missing user / email → no_user, never throws.
  const env = makeEnv();
  const spy = makeSendSpy();
  const now = new Date(Date.UTC(2026, 4, 15));
  for (const u of [null, undefined, {}, { userId: "x", email: "" }]) {
    const r = await maybeSendQuotaWarning(env, {}, u, QUOTA_WARN_AT_RUNS, now, spy);
    if (r.sent || r.reason !== "no_user") {
      fail(`user=${JSON.stringify(u)}: expected reason='no_user', got ${JSON.stringify(r)}`);
    }
  }
  expect(spy.calls.length === 0, "missing user/email: spy never called, no throw");
}

// ---------------------------------------------------------------------------
console.log("\nquota email — enforceQuota end-to-end\n");
// ---------------------------------------------------------------------------

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

function makeAuthedRequest(user) {
  const req = new Request("http://localhost/api/analyze/algo", { method: "POST" });
  req.user = user;
  return req;
}

{
  const env = makeEnv();
  const { user: free } = await createFreeUser(env, { email: "freeflow@example.com" });
  const stub = makeStubHandler();
  const spy  = makeSendSpy();
  const wrapped = enforceQuota(stub.handler, { sendTransactional: spy });

  // 1st-3rd successful runs: counter ticks 1, 2, 3 — no email.
  for (let i = 1; i <= 3; i++) {
    const res = await wrapped(makeAuthedRequest({ userId: free.userId }), env, {});
    if (res.status !== 200) fail(`run ${i}: expected 200, got ${res.status}`);
  }
  expect(await getMonthlyUsage(env, free.userId) === 3, "after 3 runs counter is 3");
  expect(spy.calls.length === 0, "no email sent during the first 3 runs");

  // 4th run: counter → 4, single email fires.
  const res4 = await wrapped(makeAuthedRequest({ userId: free.userId }), env, {});
  expect(res4.status === 200, "4th run still 200");
  expect(await getMonthlyUsage(env, free.userId) === 4, "counter is 4 after 4th run");
  expect(spy.calls.length === 1, "warning email sent exactly once at the 4th run");
  expect(spy.calls[0].to === free.email, "email addressed to the free user");

  // 5th run: counter → 5, NO additional email (past the threshold).
  const res5 = await wrapped(makeAuthedRequest({ userId: free.userId }), env, {});
  expect(res5.status === 200, "5th run still 200");
  expect(await getMonthlyUsage(env, free.userId) === FREE_MONTHLY_LIMIT,
    "counter is at the limit after 5th run");
  expect(spy.calls.length === 1, "5th run does NOT re-send the warning email");

  // 6th run: 402 quota_exceeded, still no email.
  const res6 = await wrapped(makeAuthedRequest({ userId: free.userId }), env, {});
  expect(res6.status === 402, "6th run blocked with 402");
  expect(spy.calls.length === 1, "402 path does not send the warning email");
}

{
  // Validation error at the boundary: counter unchanged, no email.
  const env = makeEnv();
  const { user: free } = await createFreeUser(env, { email: "validerr@example.com" });
  // Pre-seed counter at 3 so the next request is the threshold candidate.
  for (let i = 0; i < 3; i++) await incrementMonthlyUsage(env, free.userId);

  const stub = makeStubHandler();
  const spy  = makeSendSpy();
  const wrapped = enforceQuota(stub.handler, { sendTransactional: spy });

  const failingReq = makeAuthedRequest({ userId: free.userId });
  failingReq.__shouldFail = true;
  const res = await wrapped(failingReq, env, {});
  expect(res.status === 400, "validation error returns 400");
  expect(await getMonthlyUsage(env, free.userId) === 3,
    "validation error: counter unchanged at 3");
  expect(spy.calls.length === 0,
    "validation error at the boundary: no warning email");
}

{
  // Paid user blasts through 10 runs — never warned, never increments.
  const env = makeEnv();
  const paid = await upsertUserFromCheckout(env, {
    email: "paid@example.com",
    stripeCustomerId: "cus_PAID",
    subStatus: "active",
  });
  const stub = makeStubHandler();
  const spy  = makeSendSpy();
  const wrapped = enforceQuota(stub.handler, { sendTransactional: spy });

  for (let i = 0; i < 10; i++) {
    const res = await wrapped(makeAuthedRequest({ userId: paid.userId }), env, {});
    if (res.status !== 200) { fail(`paid run ${i+1}: expected 200, got ${res.status}`); break; }
  }
  expect(await getMonthlyUsage(env, paid.userId) === 0, "paid user: counter never moves");
  expect(spy.calls.length === 0, "paid user: warning email never sent");
}

// ---------------------------------------------------------------------------
console.log("\nquota email — month rollover re-arms the trigger\n");
// ---------------------------------------------------------------------------

{
  const env = makeEnv();
  const { user: free } = await createFreeUser(env, { email: "rollover@example.com" });
  const stub = makeStubHandler();
  const spy  = makeSendSpy();

  // May: pre-seed 3 successful runs, then cross to 4.
  const may = new Date(Date.UTC(2026, 4, 15));
  for (let i = 0; i < 3; i++) await incrementMonthlyUsage(env, free.userId, may);
  const mayWrapped = enforceQuota(stub.handler, { now: () => may, sendTransactional: spy });
  const mayRes = await mayWrapped(makeAuthedRequest({ userId: free.userId }), env, {});
  expect(mayRes.status === 200, "May 4th run → 200");
  expect(spy.calls.length === 1, "May: 1 warning email");
  expect(spy.calls[0].text.includes("June 1, 2026"),
    "May email cites June 1 as the reset date");

  // Sentinel is in place for May.
  const maySentinel = quotaWarnedKey(free.userId, may);
  expect(env.USERS._store.get(maySentinel) === "1", "May sentinel set");

  // June: a fresh KV key per the calendar reset. Pre-seed 3 successful June
  // runs, then cross to 4 again. A second email must fire because the June
  // sentinel is a different KV key.
  const june = new Date(Date.UTC(2026, 5, 5));
  for (let i = 0; i < 3; i++) await incrementMonthlyUsage(env, free.userId, june);
  const juneWrapped = enforceQuota(stub.handler, { now: () => june, sendTransactional: spy });
  const juneRes = await juneWrapped(makeAuthedRequest({ userId: free.userId }), env, {});
  expect(juneRes.status === 200, "June 4th run → 200");
  expect(spy.calls.length === 2, "June: a second warning email is sent (rollover re-arms)");
  expect(spy.calls[1].text.includes("July 1, 2026"),
    "June email cites July 1 as the reset date");

  // Sentinels coexist — different month suffixes.
  expect(maySentinel !== quotaWarnedKey(free.userId, june),
    "May/June sentinels are distinct keys");
  expect(env.USERS._store.get(quotaWarnedKey(free.userId, june)) === "1",
    "June sentinel set");
}

// ---------- summary ----------
console.log("");
if (failures === 0) {
  console.log("\x1b[32m  all quota-email tests passed\x1b[0m\n");
  process.exit(0);
} else {
  console.log(`\x1b[31m  ${failures} quota-email test(s) failed\x1b[0m\n`);
  process.exit(1);
}
