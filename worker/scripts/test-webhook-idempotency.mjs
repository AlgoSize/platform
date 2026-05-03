// Tests for Stripe webhook idempotency (Task #20).
//
// Covers:
//   1. The same Stripe event delivered twice: the SECOND call short-
//      circuits with `{ received: true, deduped: true }` and never touches
//      USERS KV (no extra writes for the same event id).
//   2. The same event delivered three times: still only one user record,
//      and the dedup KV row exists with the documented 7-day TTL.
//   3. Two DIFFERENT events that share a Stripe customer id (e.g.
//      checkout.session.completed followed by customer.subscription.deleted)
//      BOTH process — dedup is per-event, not per-customer.
//   4. Unknown event types are still deduped (so Stripe doesn't keep
//      retrying an event we've already chosen to ignore).
//   5. A handler failure (5xx) does NOT mark the event processed — the
//      next retry of the same id is allowed through and can actually do
//      the work.
//   6. Bad signatures are rejected at the front door and do NOT poison
//      the dedup table — i.e. an attacker can't write `stripeEvent:*`
//      keys by spamming the endpoint.
//
// Run with:  node scripts/test-webhook-idempotency.mjs

import { stripeWebhookHandler } from "../src/handlers/webhook.js";
import { buildSignatureHeader } from "../src/stripe.js";
import { getUserByEmail, getUserByCustomerId } from "../src/handlers/_users.js";
import { makeD1, makeFailingD1 } from "./_d1-stub.mjs";

const SECRET     = "whsec_idempotency_test_secret_xxxxxxxxxxxxxx";  // 32+ chars
const JWT_SECRET = "idempotency-test-jwt-secret-32-or-more-chars";

let failures = 0;
const ok   = (msg) => console.log(`  \x1b[32m✓\x1b[0m ${msg}`);
const fail = (msg) => { console.log(`  \x1b[31m✗\x1b[0m ${msg}`); failures++; };
const expect = (cond, label) => cond ? ok(label) : fail(label);

// In-memory KV stub that ALSO records the put options + a write counter
// per key, so we can assert "this row was only written once" and "the
// 7-day TTL was actually requested". Mirrors the helper used in
// test-history.mjs.
function makeKV() {
  const store  = new Map();
  const opts   = new Map();
  const writes = new Map();   // key → number of put() calls
  return {
    async get(key)              { return store.has(key) ? store.get(key) : null; },
    async put(key, val, o = {}) {
      store.set(key, val);
      opts.set(key, o);
      writes.set(key, (writes.get(key) || 0) + 1);
    },
    async delete(key)           { store.delete(key); opts.delete(key); writes.delete(key); },
    _store: store,
    _opts:  opts,
    _writes: writes,
  };
}

function makeEnv(overrides = {}) {
  return {
    JWT_SECRET,
    SITE_ORIGIN: "http://localhost:5000",
    COOKIE_NAME: "algosize_session",
    STRIPE_SECRET_KEY: "sk_test_FAKE",
    STRIPE_WEBHOOK_SECRET: SECRET,
    STRIPE_PRICE_ID: "price_test_monthly",
    SESSIONS: makeKV(),
    USERS:    makeKV(),
    DB:       makeD1(),
    ...overrides,
  };
}

// Build a signed webhook request for a given event body.
async function makeSignedRequest(body, opts = {}) {
  const t   = opts.timestamp || Math.floor(Date.now() / 1000);
  const sig = await buildSignatureHeader(body, opts.secret || SECRET, t);
  return new Request("http://x/api/stripe/webhook", {
    method: "POST",
    headers: { "Stripe-Signature": sig, "Content-Type": "application/json" },
    body,
  });
}

// Count how many user rows exist in D1 (post-#25 user records live there).
async function countUserRecords(env) {
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM users").first();
  return row ? row.n : 0;
}

// Count how many times any USERS KV key was written. Useful to assert
// "the second delivery did not touch USERS at all" (USERS KV still holds
// quota counters and the Stripe-event dedup row lives in SESSIONS).
function totalUsersWrites(env) {
  let n = 0;
  for (const v of env.USERS._writes.values()) n += v;
  return n;
}

// ---------------------------------------------------------------------------
console.log("\nwebhook idempotency — dedup on event.id\n");
// ---------------------------------------------------------------------------

// 1. Same event delivered twice → second short-circuits.
{
  const env = makeEnv();
  const body = JSON.stringify({
    id: "evt_idem_1",
    type: "checkout.session.completed",
    data: {
      object: {
        id: "cs_idem_1",
        customer: "cus_IDEM_1",
        customer_details: { email: "idem1@example.com" },
        payment_status: "paid",
        status: "complete",
      },
    },
  });

  // First delivery — should process normally.
  const res1 = await stripeWebhookHandler(await makeSignedRequest(body), env);
  const body1 = await res1.json();
  expect(res1.status === 200,                      "first delivery → 200");
  expect(body1.received === true && !body1.deduped, "first delivery body has no `deduped` flag");
  expect(body1.handled === "checkout.session.completed",
    "first delivery body reports handled=checkout.session.completed");

  const writesAfterFirst = totalUsersWrites(env);
  expect(await countUserRecords(env) === 1, "first delivery created exactly 1 user");

  // Second delivery — should short-circuit.
  const res2 = await stripeWebhookHandler(await makeSignedRequest(body), env);
  const body2 = await res2.json();
  expect(res2.status === 200,        "duplicate delivery → 200");
  expect(body2.deduped === true,     "duplicate delivery body.deduped === true");
  expect(body2.received === true,    "duplicate delivery body.received === true");

  // Critical: USERS KV must NOT have been touched on the duplicate.
  expect(totalUsersWrites(env) === writesAfterFirst,
    "duplicate delivery did not touch USERS KV (write count unchanged)");
  expect(await countUserRecords(env) === 1, "still exactly 1 user record after duplicate");
}

// 2. Same event delivered three times — dedup row exists with 7-day TTL.
{
  const env = makeEnv();
  const body = JSON.stringify({
    id: "evt_idem_triple",
    type: "checkout.session.completed",
    data: {
      object: {
        id: "cs_triple",
        customer: "cus_TRIPLE",
        customer_details: { email: "triple@example.com" },
        payment_status: "paid",
        status: "complete",
      },
    },
  });

  for (let i = 0; i < 3; i++) {
    await stripeWebhookHandler(await makeSignedRequest(body), env);
  }
  expect(await countUserRecords(env) === 1, "3x delivery → 1 user record");

  const dedupKey = "stripeEvent:evt_idem_triple";
  expect(env.SESSIONS._store.has(dedupKey), "dedup row written under stripeEvent:<id>");

  const opts = env.SESSIONS._opts.get(dedupKey);
  const SEVEN_DAYS = 60 * 60 * 24 * 7;
  expect(opts && opts.expirationTtl === SEVEN_DAYS,
    `dedup row TTL is ${SEVEN_DAYS}s (7 days)`);

  // The dedup row should also have only been written once (the first
  // delivery wrote it; the next two short-circuited before reaching put).
  expect(env.SESSIONS._writes.get(dedupKey) === 1,
    "dedup row was written exactly once across 3 deliveries");
}

// ---------------------------------------------------------------------------
console.log("\nwebhook idempotency — independence between events\n");
// ---------------------------------------------------------------------------

// 3. Two DIFFERENT events that share a customer id → both process.
{
  const env = makeEnv();

  // Event A: checkout.session.completed.
  const bodyA = JSON.stringify({
    id: "evt_AAAA",
    type: "checkout.session.completed",
    data: {
      object: {
        id: "cs_shared",
        customer: "cus_SHARED",
        customer_details: { email: "shared@example.com" },
        payment_status: "paid",
        status: "complete",
      },
    },
  });
  const resA = await stripeWebhookHandler(await makeSignedRequest(bodyA), env);
  expect(resA.status === 200, "event A (checkout.session.completed) processes");
  expect((await getUserByEmail(env, "shared@example.com"))?.subStatus === "active",
    "event A created an active user for cus_SHARED");

  // Event B: customer.subscription.deleted on the SAME customer, but a
  // distinct event id. Must NOT be deduped — the cancellation has to land.
  const bodyB = JSON.stringify({
    id: "evt_BBBB",
    type: "customer.subscription.deleted",
    data: { object: { id: "sub_x", customer: "cus_SHARED", status: "canceled" } },
  });
  const resB = await stripeWebhookHandler(await makeSignedRequest(bodyB), env);
  const bodyJsonB = await resB.json();
  expect(resB.status === 200,                       "event B (different id, same customer) → 200");
  expect(bodyJsonB.deduped !== true,                "event B is NOT deduped");
  expect(bodyJsonB.handled === "customer.subscription.deleted",
    "event B fully processed (handled=customer.subscription.deleted)");

  const cancelled = await getUserByCustomerId(env, "cus_SHARED");
  expect(cancelled && cancelled.subStatus === "inactive",
    "event B flipped subStatus to inactive (per-event dedup, not per-customer)");

  // Re-deliver event B — should now dedup.
  const resB2 = await stripeWebhookHandler(await makeSignedRequest(bodyB), env);
  const bodyJsonB2 = await resB2.json();
  expect(resB2.status === 200 && bodyJsonB2.deduped === true,
    "re-delivering event B is deduped on its own id");
}

// 4. Unknown event types are also deduped.
{
  const env = makeEnv();
  const body = JSON.stringify({ id: "evt_unknown_1", type: "invoice.paid", data: { object: {} } });
  const res1 = await stripeWebhookHandler(await makeSignedRequest(body), env);
  const body1 = await res1.json();
  expect(res1.status === 200 && body1.handled === false,
    "unknown event type still acked with 200 + handled:false");

  const res2 = await stripeWebhookHandler(await makeSignedRequest(body), env);
  const body2 = await res2.json();
  expect(body2.deduped === true,
    "duplicate delivery of an unknown-type event is deduped (no Stripe retry storms)");
}

// ---------------------------------------------------------------------------
console.log("\nwebhook idempotency — failure semantics\n");
// ---------------------------------------------------------------------------

// 5. Handler failure (5xx) → dedup row NOT written → next retry processes.
{
  // Make the FIRST D1 INSERT fail to simulate a transient backend hiccup.
  // The handler will throw → 500 → we rely on Stripe to retry. After the
  // throw, the wrapper restores normal D1 behavior and re-delivery must
  // actually create the user.
  const env = makeEnv({ DB: makeFailingD1({ failOn: 1 }) });

  const body = JSON.stringify({
    id: "evt_retry_me",
    type: "checkout.session.completed",
    data: {
      object: {
        id: "cs_retry",
        customer: "cus_RETRY",
        customer_details: { email: "retry@example.com" },
        payment_status: "paid",
        status: "complete",
      },
    },
  });

  const res1 = await stripeWebhookHandler(await makeSignedRequest(body), env);
  expect(res1.status === 500, "handler failure surfaces as 500 (so Stripe retries)");

  const dedupKey = "stripeEvent:evt_retry_me";
  expect(!env.SESSIONS._store.has(dedupKey),
    "failed handler did NOT write the dedup row (next retry is allowed through)");

  // Stripe's retry: same event id, fresh request. Should now succeed.
  const res2 = await stripeWebhookHandler(await makeSignedRequest(body), env);
  expect(res2.status === 200, "retry of the same event id processes successfully");
  expect((await getUserByEmail(env, "retry@example.com"))?.subStatus === "active",
    "retry actually created the user (idempotency did not block recovery)");
  expect(env.SESSIONS._store.has(dedupKey),
    "successful retry now wrote the dedup row");
}

// 6. Bad signatures don't poison the dedup table.
{
  const env = makeEnv();
  const body = JSON.stringify({
    id: "evt_attacker_1",
    type: "checkout.session.completed",
    data: { object: {} },
  });
  const req = new Request("http://x/api/stripe/webhook", {
    method: "POST",
    headers: { "Stripe-Signature": "t=1,v1=deadbeef", "Content-Type": "application/json" },
    body,
  });
  const res = await stripeWebhookHandler(req, env);
  expect(res.status === 400, "bad signature still rejected with 400");
  expect(!env.SESSIONS._store.has("stripeEvent:evt_attacker_1"),
    "bad-signature delivery did NOT write a dedup row (no KV pollution attack)");
}

// ---------- summary ----------
console.log("");
if (failures === 0) {
  console.log("\x1b[32m  all webhook-idempotency tests passed\x1b[0m\n");
  process.exit(0);
} else {
  console.log(`\x1b[31m  ${failures} webhook-idempotency test(s) failed\x1b[0m\n`);
  process.exit(1);
}
