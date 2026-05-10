// Algosize Worker — request router.
//
// Real handlers wired so far:
//   POST /api/checkout            → Stripe Checkout Session creator
//   GET  /api/checkout/success    → Stripe success_url callback (sets cookie)
//   POST /api/stripe/webhook      → signature-verified webhook
//   POST /api/analyze/cost        → cloud cost-savings analyzer (Task #5)
//   POST /api/analyze/vuln        → vulnerability scanner (Task #6)
//   POST /api/analyze/algo        → algorithm optimizer (Task #7)
//   POST /api/logout              → revoke session + clear cookie (Task #8)
//   GET  /api/me                  → dashboard hydration (Task #11)

import { Router } from "itty-router";
import { handlePreflight, withCors, corsHeaders } from "./cors.js";
import { requireAuth } from "./auth.js";
import { checkoutHandler, checkoutSuccessHandler } from "./handlers/checkout.js";
import { stripeWebhookHandler } from "./handlers/webhook.js";
import { analyzeCostHandler, analyzeVulnHandler, analyzeAlgoHandler } from "./handlers/analyze.js";
import { logoutHandler } from "./handlers/logout.js";
import { meHandler } from "./handlers/me.js";
import { listRunsHandler, getRunHandler } from "./handlers/runs.js";
import { billingPortalHandler } from "./handlers/billing.js";
import { requestMagicLinkHandler, verifyMagicLinkHandler } from "./handlers/auth_magic.js";
import { googleStartHandler, googleCallbackHandler } from "./handlers/auth_google.js";
import { adminListUsersHandler, adminUsersCsvHandler, requireAdmin } from "./handlers/admin.js";
import { pageviewPixelHandler } from "./handlers/pageview.js";
import { seedHandler } from "./handlers/_seed.js";
import { enforceQuota } from "./quota.js";
import { makeRateLimit } from "./middleware/rate-limit.js";
import { captureException } from "./observability.js";

const router = Router();

// ---- CORS preflight (must run before any other handler) --------------------
router.all("*", handlePreflight);

// ---- Helpers ---------------------------------------------------------------
const json = (body, status = 200, extraHeaders = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...extraHeaders },
  });

// ---- Per-IP rate limiters (Task #21) --------------------------------------
// Stops bots from hammering the public-facing endpoints — e.g. flooding
// /api/checkout with thousands of empty Stripe customer objects, or
// burning Worker CPU on /api/analyze/* before requireAuth even runs.
// Quotas (Task #19) handle the post-auth abuse case; this is the
// pre-auth brake. Limiters are applied BEFORE requireAuth so even
// invalid-cookie traffic gets throttled cheaply.
//
// /api/checkout + /api/signup share their per-endpoint buckets at 10/min
// per IP; the three /api/analyze/* routes share a single "analyze"
// bucket at 30/min per IP (combined across cost/vuln/algo).
const checkoutRateLimit = makeRateLimit({ keyName: "checkout", limit: 10, windowSec: 60 });
const signupRateLimit   = makeRateLimit({ keyName: "signup",   limit: 10, windowSec: 60 });
const analyzeRateLimit  = makeRateLimit({ keyName: "analyze",  limit: 30, windowSec: 60 });

// ---- Real routes (Task #4) -------------------------------------------------
router.post("/api/checkout",          checkoutRateLimit, checkoutHandler);
router.get( "/api/checkout/success",  checkoutSuccessHandler);
router.post("/api/stripe/webhook",    stripeWebhookHandler);

// ---- Analyzer routes (Task #5+) — all behind requireAuth ------------------
// Wrapped with enforceQuota (Task #19) so free-tier users hit a 402 after
// 5 successful runs in the current calendar month; paid users bypass.
// Rate-limit middleware runs FIRST so flood traffic doesn't even read the
// auth KV row.
router.post("/api/analyze/cost",    analyzeRateLimit, requireAuth, enforceQuota(analyzeCostHandler));
router.post("/api/analyze/vuln",    analyzeRateLimit, requireAuth, enforceQuota(analyzeVulnHandler));
router.post("/api/analyze/algo",    analyzeRateLimit, requireAuth, enforceQuota(analyzeAlgoHandler));

// ---- Magic-link auth — email-verified sign-in/sign-up ---------------------
// Replaces the old /api/signup endpoint (which issued a session immediately
// without verifying email ownership). Request endpoint shares the signup
// rate-limit bucket so an attacker can't flood email sends. Verify endpoint
// is GET so it can be clicked from email; given a generous per-IP cap to
// keep KV reads bounded under a click-storm even though tokens are 32-byte
// random and unbruteforceable.
router.post("/api/auth/request-link", signupRateLimit, requestMagicLinkHandler);
router.get( "/api/auth/verify",       makeRateLimit({ keyName: "verify", limit: 30, windowSec: 60 }), verifyMagicLinkHandler);

// ---- Google OAuth — second sign-in option (email verified by Google) ------
// /start redirects to Google's consent screen; /callback exchanges the code,
// requires `email_verified: true` from Google's userinfo endpoint, then
// finds/creates the user and issues the same session cookie magic-link does.
// Both endpoints are GET (browser-driven redirects), share the signup rate-
// limit bucket so they can't be used to flood Google's token endpoint.
router.get( "/api/auth/google/start",    signupRateLimit, googleStartHandler);
router.get( "/api/auth/google/callback", makeRateLimit({ keyName: "google_cb", limit: 30, windowSec: 60 }), googleCallbackHandler);

// ---- Admin endpoints — gated by env.ADMIN_EMAILS allowlist ----------------
router.get( "/api/admin/users",      requireAdmin, adminListUsersHandler);
router.get( "/api/admin/users.csv",  requireAdmin, adminUsersCsvHandler);

// ---- Session routes (Task #8) ---------------------------------------------
router.post("/api/logout",          requireAuth, logoutHandler);

// ---- Dashboard hydration (Task #11) ---------------------------------------
router.get( "/api/me",              requireAuth, meHandler);

// ---- Run history (Task #17) — list + read past analyzer runs --------------
router.get( "/api/runs",            requireAuth, listRunsHandler);
router.get( "/api/runs/:id",        requireAuth, getRunHandler);

// ---- Stripe Customer Portal (Task #18) — manage card / cancel / invoices --
router.post("/api/billing/portal",  requireAuth, billingPortalHandler);

// ---- Analytics noscript pixel (Task #26) ----------------------------------
// Forwards a GET <img> request to Plausible's POST events API so visitors
// with JavaScript disabled still get a pageview count. No auth, no cookies,
// fire-and-forget. Rate-limited per IP so it can't be abused as a relay.
const pageviewRateLimit = makeRateLimit({ keyName: "pageview", limit: 60, windowSec: 60 });
router.get( "/api/pageview",        pageviewRateLimit, pageviewPixelHandler);

// ---- Test-only seed endpoint (Task #13) -----------------------------------
// Lets the Playwright e2e suite write a synthetic SESSIONS + USERS row pair
// without going through Stripe. Gated by env.E2E_TEST_SECRET — when unset
// (i.e. in production) the handler returns 404, making the route invisible
// to anyone but the local test runner. See tests/e2e/global-setup.mjs.
router.post("/api/_test/seed",      seedHandler);

// ---- 404 fallthrough -------------------------------------------------------
router.all("*", (request) => {
  const url = new URL(request.url);
  return json({ error: "not_found", path: url.pathname }, 404);
});

// ---- Worker entry ----------------------------------------------------------
export default {
  async fetch(request, env, ctx) {
    try {
      const response = await router.fetch(request, env, ctx);
      return withCors(response, request, env);
    } catch (err) {
      // Last-resort error handler — never leak internals to the user.
      // Observability (Task #22): capture every uncaught exception that
      // bubbles past every per-handler try/catch. Includes the request
      // URL/method, user id (if requireAuth set request.user before
      // throwing), release tag, and stack trace. Network IO to Sentry
      // is queued onto ctx.waitUntil so it never delays the 500 we
      // return below.
      await captureException(env, ctx, err, {
        request,
        userId:  request.user && request.user.userId,
        tags:    { source: "worker_top_level" },
      });
      return new Response(
        JSON.stringify({ error: "internal_error" }),
        { status: 500, headers: { "content-type": "application/json", ...corsHeaders(request, env) } },
      );
    }
  },
};
