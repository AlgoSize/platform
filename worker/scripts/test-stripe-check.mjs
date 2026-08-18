// Tests for GET /api/admin/stripe-check.
//
// The endpoint reports two pieces of Stripe ACCOUNT state that live outside
// the repo — the Customer Portal default configuration and the webhook
// endpoint — and both fail in ways that are invisible until a real customer
// hits them. So the tests below care most about the cases where something
// exists but is subtly wrong: a portal configuration that is present but not
// default, a webhook endpoint that is present but disabled, or enabled but not
// subscribed to the events the worker actually handles. A check that only
// asked "does a webhook exist?" would pass all three.
//
// Stripe is stubbed at globalThis.fetch, the same seam src/stripe.js uses.
//
// Run with:  node scripts/test-stripe-check.mjs

import worker from "../src/index.js";
import { adminStripeCheckHandler, stripeKeyMode } from "../src/handlers/admin.js";
import { issueJWT } from "../src/auth.js";

let failures = 0;
const ok   = (msg) => console.log(`  \x1b[32m✓\x1b[0m ${msg}`);
const fail = (msg) => { console.log(`  \x1b[31m✗\x1b[0m ${msg}`); failures++; };
const expect = (cond, label) => cond ? ok(label) : fail(label);

const ADMIN_EMAIL = "admin@algosize.com";
const JWT_SECRET  = "stripe-check-test-secret-32-or-more-chars";
const ORIGIN      = "https://algosize.com";
const HOOK_URL    = `${ORIGIN}/api/stripe/webhook`;

const ALL_EVENTS = [
  "checkout.session.completed",
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "customer.subscription.trial_will_end",
  "invoice.paid",
  "invoice.payment_failed",
];

function makeKV() {
  const store = new Map();
  return {
    async get(k) { return store.has(k) ? store.get(k) : null; },
    async put(k, v) { store.set(k, v); },
    async delete(k) { store.delete(k); },
    _store: store,
  };
}

function makeEnv(overrides = {}) {
  return {
    JWT_SECRET,
    SITE_ORIGIN: ORIGIN,
    COOKIE_NAME: "algosize_session",
    ADMIN_EMAILS: ADMIN_EMAIL,
    STRIPE_SECRET_KEY: "sk_live_abc123",
    SESSIONS: makeKV(),
    USERS: makeKV(),
    ...overrides,
  };
}

function adminRequest() {
  const req = new Request(`${ORIGIN}/api/admin/stripe-check`);
  req.user = { userId: "usr_admin", email: ADMIN_EMAIL };
  req.authMethod = "session";
  return req;
}

/**
 * Stub Stripe's two list endpoints.
 *
 * Returns the URLs that were requested so a test can assert the handler asked
 * for what it claims to check, rather than trusting a hardcoded response.
 */
async function withStripe({ configurations = [], endpoints = [], throwStatus = null }, fn) {
  const realFetch = globalThis.fetch;
  const requested = [];
  globalThis.fetch = async (url) => {
    requested.push(String(url));
    if (throwStatus) {
      return {
        ok: false,
        status: throwStatus,
        json: async () => ({ error: { message: "Invalid API Key provided: sk_live_***" } }),
      };
    }
    const data = String(url).includes("/billing_portal/configurations")
      ? configurations
      : endpoints;
    return { ok: true, status: 200, json: async () => ({ object: "list", data }) };
  };
  try { return await fn(requested); }
  finally { globalThis.fetch = realFetch; }
}

const enabledHook = (over = {}) => ({
  id: "we_123", url: HOOK_URL, status: "enabled", enabled_events: ALL_EVENTS, ...over,
});
const defaultConfig = (over = {}) => ({
  id: "bpc_123", is_default: true, active: true, ...over,
});

// ===========================================================================
console.log("\nkey mode is read from the prefix\n");
// ===========================================================================
{
  expect(stripeKeyMode("sk_live_51abc") === "live", "sk_live_ → live");
  expect(stripeKeyMode("sk_test_51abc") === "test", "sk_test_ → test");
  // Restricted keys carry the mode in the same position as standard ones.
  expect(stripeKeyMode("rk_live_51abc") === "live", "rk_live_ (restricted) → live");
  expect(stripeKeyMode("rk_test_51abc") === "test", "rk_test_ (restricted) → test");
  // Never guessed — a wrong mode label is worse than an absent one, because
  // the whole response is scoped to whichever mode this names.
  expect(stripeKeyMode("pk_live_51abc") === "unknown", "a publishable key is not claimed as live");
  expect(stripeKeyMode("") === "unknown", "empty string → unknown");
  expect(stripeKeyMode(undefined) === "unknown", "undefined → unknown");
}

// ===========================================================================
console.log("\na correctly configured account\n");
// ===========================================================================
{
  const env = makeEnv();
  const res = await withStripe(
    { configurations: [defaultConfig()], endpoints: [enabledHook()] },
    (requested) => adminStripeCheckHandler(adminRequest(), env).then(async (r) => {
      expect(requested.some((u) => u.includes("/billing_portal/configurations")),
        "it actually asked Stripe for portal configurations");
      expect(requested.some((u) => u.includes("/webhook_endpoints")),
        "it actually asked Stripe for webhook endpoints");
      return r;
    }),
  );
  const body = await res.json();
  expect(res.status === 200, "200 when Stripe answered");
  expect(body.ok === true, "ok:true when both checks pass");
  expect(body.mode === "live", "reports the mode it checked");
  expect(body.checks.portalConfiguration.ok === true, "portal configuration passes");
  expect(body.checks.webhookEndpoint.ok === true, "webhook endpoint passes");
  expect(!JSON.stringify(body).includes("sk_live_abc123"),
    "the secret key never appears in the response");
}

// ===========================================================================
console.log("\nthe portal configuration cases\n");
// ===========================================================================
{
  const env = makeEnv();
  const res = await withStripe({ configurations: [], endpoints: [enabledHook()] },
    () => adminStripeCheckHandler(adminRequest(), env));
  const body = await res.json();
  expect(body.ok === false, "no portal configuration at all → ok:false");
  expect(/No Customer Portal configuration/.test(body.checks.portalConfiguration.detail),
    "and says none exists");
  expect(/settings\/billing\/portal/.test(body.checks.portalConfiguration.fix || ""),
    "and points at the dashboard page that fixes it");
}
{
  // The subtle one: configurations exist, but none is the default. Stripe's
  // portal session call needs a DEFAULT, so "some config exists" is not enough.
  const env = makeEnv();
  const res = await withStripe(
    { configurations: [{ id: "bpc_x", is_default: false, active: true }], endpoints: [enabledHook()] },
    () => adminStripeCheckHandler(adminRequest(), env),
  );
  const body = await res.json();
  expect(body.checks.portalConfiguration.ok === false,
    "a non-default configuration does NOT count as configured");
  expect(/none is both default and active/.test(body.checks.portalConfiguration.detail),
    "and the detail explains why the one that exists doesn't count");
}
{
  const env = makeEnv();
  const res = await withStripe(
    { configurations: [defaultConfig({ active: false })], endpoints: [enabledHook()] },
    () => adminStripeCheckHandler(adminRequest(), env),
  );
  const body = await res.json();
  expect(body.checks.portalConfiguration.ok === false,
    "a default-but-inactive configuration does NOT count either");
}

// ===========================================================================
console.log("\nthe webhook endpoint cases\n");
// ===========================================================================
{
  const env = makeEnv();
  const res = await withStripe({ configurations: [defaultConfig()], endpoints: [] },
    () => adminStripeCheckHandler(adminRequest(), env));
  const body = await res.json();
  expect(body.checks.webhookEndpoint.ok === false, "no endpoints → fails");
  expect(body.checks.webhookEndpoint.expected === HOOK_URL,
    "and reports the URL it was looking for");
}
{
  // An endpoint for a DIFFERENT deployment must not satisfy this one —
  // staging's webhook existing says nothing about production's.
  const env = makeEnv();
  const res = await withStripe(
    { configurations: [defaultConfig()],
      endpoints: [enabledHook({ url: "https://staging.algosize.com/api/stripe/webhook" })] },
    () => adminStripeCheckHandler(adminRequest(), env),
  );
  const body = await res.json();
  expect(body.checks.webhookEndpoint.ok === false,
    "an endpoint pointed at another origin does not count");
  expect(/staging\.algosize\.com/.test(body.checks.webhookEndpoint.detail),
    "and the detail lists what WAS found, so the mismatch is visible");
}
{
  // Host case and a trailing slash are the same endpoint to Stripe; flagging
  // them would be a false alarm that trains people to ignore this check.
  const env = makeEnv();
  const res = await withStripe(
    { configurations: [defaultConfig()],
      endpoints: [enabledHook({ url: "https://ALGOSIZE.com/api/stripe/webhook/" })] },
    () => adminStripeCheckHandler(adminRequest(), env),
  );
  const body = await res.json();
  expect(body.checks.webhookEndpoint.ok === true,
    "host case and a trailing slash still match");
}
{
  const env = makeEnv();
  const res = await withStripe(
    { configurations: [defaultConfig()], endpoints: [enabledHook({ status: "disabled" })] },
    () => adminStripeCheckHandler(adminRequest(), env),
  );
  const body = await res.json();
  expect(body.checks.webhookEndpoint.ok === false,
    "an endpoint that exists but is disabled fails");
  expect(/status is "disabled"/.test(body.checks.webhookEndpoint.detail),
    "and says so explicitly rather than just 'not found'");
}
{
  // The failure this check exists for: the endpoint is there and enabled, so
  // it looks fine in the dashboard, but a cancellation never reaches us.
  const env = makeEnv();
  const res = await withStripe(
    { configurations: [defaultConfig()],
      endpoints: [enabledHook({ enabled_events: ["checkout.session.completed"] })] },
    () => adminStripeCheckHandler(adminRequest(), env),
  );
  const body = await res.json();
  expect(body.checks.webhookEndpoint.ok === false,
    "an enabled endpoint missing subscribed events still fails");
  expect(body.checks.webhookEndpoint.missingEvents.includes("customer.subscription.deleted"),
    "and names the missing event that would silently break cancellations");
  expect(body.checks.webhookEndpoint.missingEvents.length === ALL_EVENTS.length - 1,
    "listing every event the worker handles but is not subscribed to");
}
{
  const env = makeEnv();
  const res = await withStripe(
    { configurations: [defaultConfig()], endpoints: [enabledHook({ enabled_events: ["*"] })] },
    () => adminStripeCheckHandler(adminRequest(), env),
  );
  const body = await res.json();
  expect(body.checks.webhookEndpoint.ok === true,
    "Stripe's ['*'] wildcard satisfies every required event");
}

// ===========================================================================
console.log("\nmisconfiguration of the deployment itself\n");
// ===========================================================================
{
  const env = makeEnv({ STRIPE_SECRET_KEY: undefined });
  const res = await adminStripeCheckHandler(adminRequest(), env);
  const body = await res.json();
  expect(res.status === 500 && body.error === "not_configured",
    "no STRIPE_SECRET_KEY → 500 not_configured");
}
{
  const env = makeEnv({ SITE_ORIGIN: "" });
  const res = await withStripe({ configurations: [defaultConfig()], endpoints: [enabledHook()] },
    () => adminStripeCheckHandler(adminRequest(), env));
  const body = await res.json();
  expect(body.checks.webhookEndpoint.ok === false,
    "without SITE_ORIGIN there is no expected URL, so the check fails rather than guessing");
  expect(/SITE_ORIGIN is not set/.test(body.checks.webhookEndpoint.detail),
    "and says that is the reason");
}
{
  // A rejected key is a broken deployment, not a failed check — same
  // distinction schema-check draws, so `curl -f` separates the two.
  const env = makeEnv();
  const res = await withStripe({ throwStatus: 401 },
    () => adminStripeCheckHandler(adminRequest(), env));
  const body = await res.json();
  expect(res.status === 500 && body.error === "stripe_unreachable",
    "a 401 from Stripe → 500 stripe_unreachable, not a 200 with ok:false");
  expect(body.mode === "live",
    "and the mode is still reported — it comes from the prefix, not from Stripe");
  expect(!JSON.stringify(body).includes("sk_live_abc123"),
    "the key is not echoed back even in the error path");
}

// ===========================================================================
console.log("\nadmin gating — routed through the real middleware\n");
// ===========================================================================
{
  const env = makeEnv();
  const res = await withStripe({ configurations: [defaultConfig()], endpoints: [enabledHook()] },
    async () => {
      const r = await worker.fetch(
        new Request(`${ORIGIN}/api/admin/stripe-check`), env, { waitUntil() {} });
      return r;
    });
  expect(res.status === 401, `no session → 401 (got ${res.status})`);
}
{
  const env = makeEnv();
  const token = await issueJWT(env, "usr_other", "someone@else.com", null);
  const res = await withStripe({ configurations: [defaultConfig()], endpoints: [enabledHook()] },
    () => worker.fetch(
      new Request(`${ORIGIN}/api/admin/stripe-check`, {
        headers: { cookie: `algosize_session=${token}` },
      }), env, { waitUntil() {} }));
  const body = await res.json();
  expect(res.status === 403 && body.error === "forbidden",
    `a non-admin session → 403 forbidden (got ${res.status} ${body.error})`);
}
{
  const env = makeEnv();
  const token = await issueJWT(env, "usr_admin", ADMIN_EMAIL, null);
  const res = await withStripe({ configurations: [defaultConfig()], endpoints: [enabledHook()] },
    () => worker.fetch(
      new Request(`${ORIGIN}/api/admin/stripe-check`, {
        headers: { cookie: `algosize_session=${token}` },
      }), env, { waitUntil() {} }));
  const body = await res.json();
  expect(res.status === 200 && body.ok === true,
    `an admin session reaches the report (got ${res.status})`);
}

console.log(
  failures === 0
    ? "\n\x1b[32m  all stripe-check tests passed\x1b[0m\n"
    : `\n\x1b[31m  ${failures} stripe-check test(s) failed\x1b[0m\n`,
);
process.exit(failures === 0 ? 0 : 1);
