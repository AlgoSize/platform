// Tests for POST /api/billing/portal (Task #18 — Stripe Customer Portal).
//
// Covers:
//   1. Happy path: signed-in user with a stripeCustomerId → 200 { url } and
//      Stripe was called with { customer, return_url } body.
//   2. Defensive 400: signed-in user with NO stripeCustomerId on file
//      (legacy/orphan record) → 400 no_stripe_customer, Stripe NOT called.
//   3. Auth gating: unauthenticated request short-circuits at requireAuth
//      (we exercise the full router chain, not just the bare handler).
//   4. Stripe API rejection (e.g. portal not configured) bubbles up as a
//      4xx/5xx with portal_failed and never returns a fake URL.
//
// Run with:  node scripts/test-billing-portal.mjs

import { issueJWT, requireAuth } from "../src/auth.js";
import { billingPortalHandler } from "../src/handlers/billing.js";
import { upsertUserFromCheckout, createFreeUser } from "../src/handlers/_users.js";
import { makeD1 } from "./_d1-stub.mjs";

const JWT_SECRET = "billing-portal-test-secret-32-or-more-chars-ok";

let failures = 0;
const ok   = (msg) => console.log(`  \x1b[32m✓\x1b[0m ${msg}`);
const fail = (msg) => { console.log(`  \x1b[31m✗\x1b[0m ${msg}`); failures++; };

// ---- KV stub mirroring the parts of Cloudflare KV we use ------------------
function makeKV() {
  const store = new Map();
  return {
    async get(key)            { return store.has(key) ? store.get(key) : null; },
    async put(key, val, opts) { store.set(key, val); },
    async delete(key)         { store.delete(key); },
    _store: store,
  };
}

function makeEnv() {
  return {
    JWT_SECRET,
    SITE_ORIGIN:        "http://localhost:5000",
    COOKIE_NAME:        "algosize_session",
    STRIPE_SECRET_KEY:  "sk_test_FAKE_FOR_PORTAL",
    SESSIONS:           makeKV(),
    USERS:              makeKV(),
    DB:                 makeD1(),
  };
}

// Run requireAuth → billingPortalHandler the way the router would.
async function callPortal(req, env) {
  const guard = await requireAuth(req, env);
  if (guard) return guard;
  return billingPortalHandler(req, env);
}

console.log("\nPOST /api/billing/portal — happy path\n");

// 1. Happy path: returns the Stripe-hosted URL and called Stripe with the
//    user's stored stripeCustomerId + a return_url back to /dashboard/.
{
  const env  = makeEnv();
  const user = await upsertUserFromCheckout(env, {
    email:            "buyer@example.com",
    stripeCustomerId: "cus_BUYER_123",
    subStatus:        "active",
  });
  const token = await issueJWT(env, user.userId, user.email, user.subStatus);

  let stripeCalls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    stripeCalls.push({ url, init });
    if (!url.endsWith("/v1/billing_portal/sessions")) {
      throw new Error("unexpected fetch url: " + url);
    }
    if (init.method !== "POST") throw new Error("expected POST to Stripe");
    if (!init.headers.Authorization?.startsWith("Bearer sk_test_")) {
      throw new Error("missing Bearer auth on Stripe call");
    }
    return new Response(
      JSON.stringify({
        id:  "bps_test_abc",
        url: "https://billing.stripe.com/p/session/bps_test_abc",
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };

  try {
    const req = new Request("http://localhost/api/billing/portal", {
      method:  "POST",
      headers: { "Cookie": `algosize_session=${encodeURIComponent(token)}` },
    });
    const res = await callPortal(req, env);
    if (res.status !== 200) { fail(`expected 200, got ${res.status}`); }
    else {
      const body = await res.json();
      if (body.url === "https://billing.stripe.com/p/session/bps_test_abc") {
        ok("returns 200 { url } pointing at Stripe-hosted portal");
      } else {
        fail(`wrong url in response: ${JSON.stringify(body)}`);
      }
    }
    if (stripeCalls.length === 1) {
      ok("called Stripe exactly once");
      const sentBody = stripeCalls[0].init.body;
      if (sentBody.includes("customer=cus_BUYER_123")) {
        ok("sent customer=<stripeCustomerId> in form body");
      } else {
        fail(`Stripe body missing customer: ${sentBody}`);
      }
      if (sentBody.includes("return_url=") && sentBody.includes("%2Fdashboard%2F")) {
        ok("sent return_url back to /dashboard/");
      } else {
        fail(`Stripe body missing return_url: ${sentBody}`);
      }
    } else {
      fail(`expected 1 Stripe call, got ${stripeCalls.length}`);
    }
  } finally { globalThis.fetch = realFetch; }
}

console.log("\nPOST /api/billing/portal — defensive guards\n");

// 2. User with NO stripeCustomerId on file → 400, Stripe NOT called.
{
  const env = makeEnv();
  // Free-tier signup creates a user row with NULL stripe_customer_id —
  // exactly the legacy/orphan case we want to guard against here.
  const { user: orphan } = await createFreeUser(env, { email: "free@example.com" });
  const token = await issueJWT(env, orphan.userId, orphan.email, orphan.subStatus);

  let stripeCalled = false;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => { stripeCalled = true; return new Response("{}"); };

  try {
    const req = new Request("http://localhost/api/billing/portal", {
      method:  "POST",
      headers: { "Cookie": `algosize_session=${encodeURIComponent(token)}` },
    });
    const res = await callPortal(req, env);
    if (res.status !== 400) { fail(`expected 400, got ${res.status}`); }
    else {
      const body = await res.json();
      if (body.error === "no_stripe_customer") {
        ok("400 no_stripe_customer when user has no stripeCustomerId");
      } else {
        fail(`wrong error code: ${JSON.stringify(body)}`);
      }
    }
    if (!stripeCalled) ok("Stripe was NOT called for the no-customer case");
    else fail("Stripe was called even though user has no stripeCustomerId");
  } finally { globalThis.fetch = realFetch; }
}

// 3. Auth gating: unauthenticated request → 401, never reaches handler.
{
  const env = makeEnv();
  let stripeCalled = false;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => { stripeCalled = true; return new Response("{}"); };

  try {
    const req = new Request("http://localhost/api/billing/portal", { method: "POST" });
    const res = await callPortal(req, env);
    if (res.status === 401) ok("unauthenticated request → 401 at requireAuth");
    else fail(`expected 401, got ${res.status}`);
    if (!stripeCalled) ok("Stripe not called on unauthenticated request");
    else fail("Stripe called despite missing auth");
  } finally { globalThis.fetch = realFetch; }
}

// 4. Stripe rejected the call (e.g. operator forgot to enable the portal in
//    Stripe Settings → Billing → Customer Portal): the handler must NOT
//    invent a fake URL — it surfaces a portal_failed error.
{
  const env  = makeEnv();
  const user = await upsertUserFromCheckout(env, {
    email:            "needs@portal.example.com",
    stripeCustomerId: "cus_NEEDS_PORTAL",
    subStatus:        "active",
  });
  const token = await issueJWT(env, user.userId, user.email, user.subStatus);

  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(
    JSON.stringify({ error: { message: "No configuration provided and your test mode default configuration has not been created. Provide a configuration or create your default by saving your customer portal settings in test mode at https://dashboard.stripe.com/test/settings/billing/portal." } }),
    { status: 400, headers: { "content-type": "application/json" } },
  );

  try {
    const req = new Request("http://localhost/api/billing/portal", {
      method:  "POST",
      headers: { "Cookie": `algosize_session=${encodeURIComponent(token)}` },
    });
    const res = await callPortal(req, env);
    if (res.status === 400 || res.status === 502) {
      const body = await res.json();
      if (body.error === "portal_failed") {
        ok("Stripe API rejection surfaces as portal_failed (no fake URL leaked)");
      } else {
        fail(`wrong error code: ${JSON.stringify(body)}`);
      }
    } else {
      fail(`expected 4xx/5xx on Stripe rejection, got ${res.status}`);
    }
  } finally { globalThis.fetch = realFetch; }
}

console.log("");
if (failures === 0) {
  console.log("\x1b[32m  all billing-portal tests passed\x1b[0m\n");
  process.exit(0);
} else {
  console.log(`\x1b[31m  ${failures} billing-portal test(s) failed\x1b[0m\n`);
  process.exit(1);
}
