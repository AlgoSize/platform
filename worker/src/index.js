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
import { signupHandler } from "./handlers/signup.js";
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

// ---- Free-tier signup (Task #19) — no auth, creates a session cookie -----
router.post("/api/signup",          signupRateLimit, signupHandler);

// ---- Session routes (Task #8) ---------------------------------------------
router.post("/api/logout",          requireAuth, logoutHandler);

// ---- Dashboard hydration (Task #11) ---------------------------------------
router.get( "/api/me",              requireAuth, meHandler);

// ---- Run history (Task #17) — list + read past analyzer runs --------------
router.get( "/api/runs",            requireAuth, listRunsHandler);
router.get( "/api/runs/:id",        requireAuth, getRunHandler);

// ---- Stripe Customer Portal (Task #18) — manage card / cancel / invoices --
router.post("/api/billing/portal",  requireAuth, billingPortalHandler);

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
