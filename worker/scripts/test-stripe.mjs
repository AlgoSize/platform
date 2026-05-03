// Tests for the Stripe layer:
//   - signature verification (good, tampered body, tampered v1, old timestamp,
//     missing/malformed header)
//   - checkoutHandler with mocked fetch (returns JSON for fetch, 303 for form)
//   - stripeWebhookHandler with mocked KV: rejects bad sig, creates user on
//     checkout.session.completed, flips subStatus on customer.subscription.deleted

import {
  verifyStripeSignature,
  buildSignatureHeader,
  createCheckoutSession,
  buildFormBody,
} from "../src/stripe.js";
import { checkoutHandler, checkoutSuccessHandler } from "../src/handlers/checkout.js";
import { stripeWebhookHandler } from "../src/handlers/webhook.js";
import { makeD1 } from "./_d1-stub.mjs";
import { getUserByEmail, getUserByCustomerId } from "../src/handlers/_users.js";

const SECRET     = "whsec_test_secret_for_unit_tests_only_xxxxx";   // 32+ chars
const JWT_SECRET = "jwt-test-secret-32-or-more-chars-please-okay";

let failures = 0;
const ok   = (msg) => console.log(`  \x1b[32m✓\x1b[0m ${msg}`);
const fail = (msg) => { console.log(`  \x1b[31m✗\x1b[0m ${msg}`); failures++; };

// ---------- KV stub mirroring the parts of Cloudflare KV we use ----------
function makeKV() {
  const store = new Map();
  return {
    async get(key)            { return store.has(key) ? store.get(key) : null; },
    async put(key, val, opts) { store.set(key, val); },
    async delete(key)         { store.delete(key); },
    _store: store,
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
    USERS: makeKV(),
    DB: makeD1(),
    ...overrides,
  };
}

console.log("\nStripe signature verification\n");

// 1. Good signature passes
{
  const body = '{"id":"evt_1","type":"checkout.session.completed"}';
  const t = 1700000000;
  const header = await buildSignatureHeader(body, SECRET, t);
  const r = await verifyStripeSignature(body, header, SECRET, { now: t });
  if (r.ok) ok("good signature passes"); else fail(`good signature failed: ${r.reason}`);
}

// 2. Tampered body fails
{
  const t = 1700000000;
  const header = await buildSignatureHeader('{"a":1}', SECRET, t);
  const r = await verifyStripeSignature('{"a":2}', header, SECRET, { now: t });
  if (!r.ok && r.reason === "signature_mismatch") ok("tampered body rejected (signature_mismatch)");
  else fail(`tampered body verdict: ${JSON.stringify(r)}`);
}

// 3. Tampered v1 hash fails
{
  const body = '{"x":42}';
  const t = 1700000000;
  const header = await buildSignatureHeader(body, SECRET, t);
  // Flip last char of the v1 hex
  const flipped = header.slice(-1) === "0" ? "1" : "0";
  const tampered = header.slice(0, -1) + flipped;
  const r = await verifyStripeSignature(body, tampered, SECRET, { now: t });
  if (!r.ok && r.reason === "signature_mismatch") ok("tampered v1 hash rejected");
  else fail(`tampered v1 verdict: ${JSON.stringify(r)}`);
}

// 4. Wrong secret fails
{
  const body = '{"x":42}';
  const t = 1700000000;
  const header = await buildSignatureHeader(body, SECRET, t);
  const r = await verifyStripeSignature(body, header, "different-secret-32-chars-needed-here", { now: t });
  if (!r.ok && r.reason === "signature_mismatch") ok("wrong webhook secret rejected");
  else fail(`wrong-secret verdict: ${JSON.stringify(r)}`);
}

// 5. Old timestamp rejected (outside default 5-min tolerance)
{
  const body = '{"x":42}';
  const t = 1700000000;
  const header = await buildSignatureHeader(body, SECRET, t);
  const r = await verifyStripeSignature(body, header, SECRET, { now: t + 600 });  // 10 min later
  if (!r.ok && r.reason === "timestamp_outside_tolerance") ok("old timestamp rejected (replay protection)");
  else fail(`old-timestamp verdict: ${JSON.stringify(r)}`);
}

// 6. Missing header rejected
{
  const r = await verifyStripeSignature("{}", null, SECRET);
  if (!r.ok && r.reason === "missing_or_malformed_header") ok("missing Stripe-Signature header rejected");
  else fail(`missing-header verdict: ${JSON.stringify(r)}`);
}

// 7. Malformed header rejected
{
  const r = await verifyStripeSignature("{}", "garbage,nothing=here", SECRET);
  if (!r.ok && r.reason === "missing_or_malformed_header") ok("malformed header rejected");
  else fail(`malformed-header verdict: ${JSON.stringify(r)}`);
}

console.log("\nForm-encoded body builder\n");

// 8. Nested form body shape matches Stripe expectations
{
  const body = buildFormBody({
    mode: "subscription",
    "line_items[0][price]": "price_xxx",
    "line_items[0][quantity]": "1",
    metadata: { user_id: "u_1" },
  });
  if (
    body.includes("mode=subscription") &&
    body.includes("line_items%5B0%5D%5Bprice%5D=price_xxx") &&
    body.includes("metadata%5Buser_id%5D=u_1")
  ) ok("buildFormBody produces Stripe-style nested params");
  else fail(`buildFormBody output: ${body}`);
}

console.log("\nPOST /api/checkout (mocked Stripe)\n");

// 9. checkoutHandler returns JSON when caller asks for it
{
  const env = makeEnv();
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (!url.startsWith("https://api.stripe.com/v1/checkout/sessions")) throw new Error("unexpected fetch: " + url);
    if (init.method !== "POST") throw new Error("expected POST to stripe");
    if (!init.headers.Authorization?.startsWith("Bearer sk_test_")) throw new Error("missing bearer auth");
    if (!init.body.includes("price_test_monthly")) throw new Error("price id not in body");
    return new Response(JSON.stringify({
      id: "cs_test_abc", url: "https://checkout.stripe.com/c/pay/cs_test_abc",
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    const req = new Request("http://x/api/checkout", {
      method: "POST",
      headers: { Accept: "application/json" },
    });
    const res = await checkoutHandler(req, env);
    if (res.status !== 200) { fail(`expected 200, got ${res.status}`); }
    else {
      const body = await res.json();
      if (body.url === "https://checkout.stripe.com/c/pay/cs_test_abc" && body.id === "cs_test_abc") {
        ok("checkoutHandler returns JSON {url, id} for Accept: application/json");
      } else {
        fail(`unexpected json body: ${JSON.stringify(body)}`);
      }
    }
  } finally { globalThis.fetch = realFetch; }
}

// 10. checkoutHandler 303-redirects for plain form POST
{
  const env = makeEnv();
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    id: "cs_form_xyz", url: "https://checkout.stripe.com/c/pay/cs_form_xyz",
  }), { status: 200 });
  try {
    const req = new Request("http://x/api/checkout", {
      method: "POST",
      headers: { Accept: "text/html", "Content-Type": "application/x-www-form-urlencoded" },
      body: "",
    });
    const res = await checkoutHandler(req, env);
    if (res.status === 303 && res.headers.get("Location") === "https://checkout.stripe.com/c/pay/cs_form_xyz") {
      ok("checkoutHandler 303-redirects to Stripe for plain form POST");
    } else {
      fail(`expected 303 redirect, got ${res.status} loc=${res.headers.get("Location")}`);
    }
  } finally { globalThis.fetch = realFetch; }
}

// 11. checkoutHandler returns 4xx on Stripe API error
{
  const env = makeEnv();
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    error: { message: "No such price: price_test_monthly" },
  }), { status: 400 });
  try {
    const req = new Request("http://x/api/checkout", { method: "POST", headers: { Accept: "application/json" } });
    const res = await checkoutHandler(req, env);
    if (res.status === 400 || res.status === 502) ok("checkoutHandler surfaces Stripe error as 4xx/5xx");
    else fail(`expected 4xx/5xx, got ${res.status}`);
  } finally { globalThis.fetch = realFetch; }
}

console.log("\nPOST /api/stripe/webhook\n");

// 12. Webhook rejects bad signature with 400
{
  const env = makeEnv();
  const body = JSON.stringify({ id: "evt_x", type: "checkout.session.completed", data: {} });
  const req = new Request("http://x/api/stripe/webhook", {
    method: "POST",
    headers: { "Stripe-Signature": "t=1,v1=deadbeef", "Content-Type": "application/json" },
    body,
  });
  const res = await stripeWebhookHandler(req, env);
  if (res.status === 400) {
    const j = await res.json();
    if (j.error === "invalid_signature") ok("webhook rejects bad signature with 400 invalid_signature");
    else fail(`expected invalid_signature error, got ${JSON.stringify(j)}`);
  } else { fail(`expected 400, got ${res.status}`); }
}

// 13. Webhook handles checkout.session.completed → creates user record
{
  const env = makeEnv();
  const t = Math.floor(Date.now() / 1000);
  const body = JSON.stringify({
    id: "evt_complete_1",
    type: "checkout.session.completed",
    data: {
      object: {
        id: "cs_test_complete",
        customer: "cus_TEST_123",
        customer_details: { email: "buyer@example.com" },
        payment_status: "paid",
        status: "complete",
      },
    },
  });
  const sig = await buildSignatureHeader(body, SECRET, t);
  const req = new Request("http://x/api/stripe/webhook", {
    method: "POST",
    headers: { "Stripe-Signature": sig, "Content-Type": "application/json" },
    body,
  });
  const res = await stripeWebhookHandler(req, env);
  if (res.status !== 200) { fail(`expected 200, got ${res.status} body=${await res.text()}`); }
  else {
    const user = await getUserByEmail(env, "buyer@example.com");
    if (user && user.subStatus === "active" && user.stripeCustomerId === "cus_TEST_123") {
      ok("webhook checkout.session.completed creates active user in USERS KV");
    } else {
      fail(`user not created correctly: ${JSON.stringify(user)}`);
    }
  }
}

// 14. Webhook is idempotent — replaying same event doesn't duplicate user
{
  const env = makeEnv();
  const body = JSON.stringify({
    id: "evt_dup",
    type: "checkout.session.completed",
    data: {
      object: {
        id: "cs_dup",
        customer: "cus_DUP",
        customer_details: { email: "dup@example.com" },
        payment_status: "paid",
        status: "complete",
      },
    },
  });
  const t = Math.floor(Date.now() / 1000);
  const sig = await buildSignatureHeader(body, SECRET, t);
  for (let i = 0; i < 3; i++) {
    const req = new Request("http://x/api/stripe/webhook", {
      method: "POST",
      headers: { "Stripe-Signature": sig, "Content-Type": "application/json" },
      body,
    });
    await stripeWebhookHandler(req, env);
  }
  // Count rows in the D1 users table.
  const countRow = await env.DB.prepare("SELECT COUNT(*) AS n FROM users").first();
  const userCount = countRow ? countRow.n : 0;
  if (userCount === 1) ok("webhook is idempotent across replays (one user record)");
  else fail(`expected 1 user, got ${userCount}`);
}

// 15. Webhook customer.subscription.deleted flips status to inactive
{
  const env = makeEnv();
  // Seed an active user first.
  const body1 = JSON.stringify({
    id: "evt_seed",
    type: "checkout.session.completed",
    data: {
      object: {
        id: "cs_seed",
        customer: "cus_CANCEL_ME",
        customer_details: { email: "canceller@example.com" },
        payment_status: "paid",
        status: "complete",
      },
    },
  });
  const t = Math.floor(Date.now() / 1000);
  const sig1 = await buildSignatureHeader(body1, SECRET, t);
  await stripeWebhookHandler(
    new Request("http://x/api/stripe/webhook", {
      method: "POST", headers: { "Stripe-Signature": sig1 }, body: body1,
    }),
    env,
  );

  // Now cancel.
  const body2 = JSON.stringify({
    id: "evt_cancel",
    type: "customer.subscription.deleted",
    data: { object: { id: "sub_x", customer: "cus_CANCEL_ME", status: "canceled" } },
  });
  const sig2 = await buildSignatureHeader(body2, SECRET, t);
  const res = await stripeWebhookHandler(
    new Request("http://x/api/stripe/webhook", {
      method: "POST", headers: { "Stripe-Signature": sig2 }, body: body2,
    }),
    env,
  );
  const user = await getUserByCustomerId(env, "cus_CANCEL_ME");
  if (res.status === 200 && user && user.subStatus === "inactive") {
    ok("webhook customer.subscription.deleted flips subStatus to inactive");
  } else {
    fail(`cancel did not flip status: status=${res.status} user=${JSON.stringify(user)}`);
  }
}

console.log("\nGET /api/checkout/success (paid-status enforcement)\n");

// helper: stub Stripe's session retrieval endpoint
function withStripeSessionStub(sessionResponse, fn) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (!url.includes("/v1/checkout/sessions/")) throw new Error("unexpected fetch: " + url);
    return new Response(JSON.stringify(sessionResponse), {
      status: 200, headers: { "content-type": "application/json" },
    });
  };
  return fn().finally(() => { globalThis.fetch = realFetch; });
}

// 16a. Unpaid session → 402, no user created, no Set-Cookie
{
  const env = makeEnv();
  await withStripeSessionStub(
    {
      id: "cs_unpaid",
      payment_status: "unpaid",
      status: "complete",
      customer: "cus_UNPAID",
      customer_details: { email: "unpaid@example.com" },
    },
    async () => {
      const req = new Request("http://x/api/checkout/success?session_id=cs_unpaid");
      const res = await checkoutSuccessHandler(req, env);
      const cookie = res.headers.get("Set-Cookie");
      const user = await getUserByEmail(env, "unpaid@example.com");
      if (res.status === 402 && !cookie && !user) {
        ok("checkout/success refuses unpaid session (402, no cookie, no user)");
      } else {
        fail(`unpaid session leaked: status=${res.status} cookie=${cookie} user=${JSON.stringify(user)}`);
      }
    },
  );
}

// 16b. Incomplete session (paid but not complete) → 402, no user created
{
  const env = makeEnv();
  await withStripeSessionStub(
    {
      id: "cs_incomplete",
      payment_status: "paid",
      status: "open",
      customer: "cus_OPEN",
      customer_details: { email: "open@example.com" },
    },
    async () => {
      const req = new Request("http://x/api/checkout/success?session_id=cs_incomplete");
      const res = await checkoutSuccessHandler(req, env);
      const user = await getUserByEmail(env, "open@example.com");
      if (res.status === 402 && !user) {
        ok("checkout/success refuses incomplete session (paid but status!=complete)");
      } else {
        fail(`incomplete session leaked: status=${res.status} user=${JSON.stringify(user)}`);
      }
    },
  );
}

// 16c. Paid + complete → 303 redirect to /dashboard/ with session cookie set
{
  const env = makeEnv();
  await withStripeSessionStub(
    {
      id: "cs_good",
      payment_status: "paid",
      status: "complete",
      customer: "cus_PAID",
      customer_details: { email: "paid@example.com" },
    },
    async () => {
      const req = new Request("http://x/api/checkout/success?session_id=cs_good");
      const res = await checkoutSuccessHandler(req, env);
      const cookie = res.headers.get("Set-Cookie") || "";
      const user = await getUserByEmail(env, "paid@example.com");
      const okStatus = res.status === 303;
      const okLoc    = res.headers.get("Location") === "http://localhost:5000/dashboard/";
      const okCookie = cookie.startsWith("algosize_session=") &&
                       cookie.includes("HttpOnly") &&
                       cookie.includes("SameSite=Lax");
      const okUser   = user && user.subStatus === "active" && user.stripeCustomerId === "cus_PAID";
      if (okStatus && okLoc && okCookie && okUser) {
        ok("checkout/success on paid+complete: 303 → /dashboard/, sets HttpOnly SameSite=Lax cookie, creates user");
      } else {
        fail(`paid path failed: status=${res.status} loc=${res.headers.get("Location")} cookie=${cookie} user=${JSON.stringify(user)}`);
      }
    },
  );
}

// 16d. Missing session_id → 400
{
  const env = makeEnv();
  const res = await checkoutSuccessHandler(new Request("http://x/api/checkout/success"), env);
  if (res.status === 400) ok("checkout/success rejects missing session_id with 400");
  else fail(`expected 400 for missing session_id, got ${res.status}`);
}

console.log("\nWebhook miscellaneous\n");

// 17. Webhook acks unknown event types with 200
{
  const env = makeEnv();
  const body = JSON.stringify({ id: "evt_x", type: "invoice.paid", data: { object: {} } });
  const t = Math.floor(Date.now() / 1000);
  const sig = await buildSignatureHeader(body, SECRET, t);
  const res = await stripeWebhookHandler(
    new Request("http://x/api/stripe/webhook", {
      method: "POST", headers: { "Stripe-Signature": sig }, body,
    }),
    env,
  );
  if (res.status === 200) {
    const j = await res.json();
    if (j.handled === false) ok("webhook acks unknown event types with 200");
    else fail(`unexpected ack body: ${JSON.stringify(j)}`);
  } else { fail(`expected 200, got ${res.status}`); }
}

console.log();
if (failures === 0) {
  console.log("\x1b[32mAll Stripe tests passed.\x1b[0m\n");
  process.exit(0);
} else {
  console.log(`\x1b[31m${failures} Stripe test(s) failed.\x1b[0m\n`);
  process.exit(1);
}
