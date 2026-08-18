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
import {
  getOrgHandler,
  inviteMemberHandler,
  acceptInviteHandler,
  removeMemberHandler,
  updateOrgBrandingHandler,
} from "./handlers/org.js";
import {
  createApiKeyHandler,
  listApiKeysHandler,
  revokeApiKeyHandler,
} from "./handlers/keys.js";
import {
  analyzeCostHandler,
  analyzeVulnHandler,
  analyzeAlgoHandler,
  analyzeArchitectureHandler,
} from "./handlers/analyze.js";
import {
  listMonitorsHandler,
  createMonitorHandler,
  deleteMonitorHandler,
  pauseMonitorHandler,
} from "./handlers/monitors.js";
import { sweepDueMonitors, handleMonitorQueue } from "./monitors/run.js";
import { logoutHandler } from "./handlers/logout.js";
import { meHandler } from "./handlers/me.js";
import {
  listRunsHandler,
  getRunHandler,
  getRunReportHandler,
  createRunShareHandler,
  revokeRunShareHandler,
  sharedReportHandler,
} from "./handlers/runs.js";
import { ciRunHandler, ciSnippetHandler } from "./handlers/ci.js";
import { billingPortalHandler } from "./handlers/billing.js";
import { requestMagicLinkHandler, verifyMagicLinkHandler } from "./handlers/auth_magic.js";
import { googleStartHandler, googleCallbackHandler } from "./handlers/auth_google.js";
import {
  adminListUsersHandler,
  adminUsersCsvHandler,
  adminSchemaCheckHandler,
  requireAdmin,
} from "./handlers/admin.js";
import { pageviewPixelHandler } from "./handlers/pageview.js";
import { seedHandler } from "./handlers/_seed.js";
import { enforceQuota } from "./quota.js";
import { makeRateLimit, makeApiKeyRateLimit } from "./middleware/rate-limit.js";
import { captureException } from "./observability.js";
export { UsageCounter } from "./usage-counter.js";

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

// Shared report links (/api/share/:token) are the only unauthenticated read
// path in the product, so they get their own bucket. Generous enough that a
// client refreshing a report they were sent never notices, tight enough that
// the endpoint cannot be used to sweep for valid tokens or to bounce traffic
// off the origin.
const publicReadRateLimit = makeRateLimit({ keyName: "share", limit: 60, windowSec: 60 });

// API-key traffic gets a SECOND limiter, keyed by org rather than IP (Task
// #P-4) — a key called from many CI runners or shared egress IPs is one
// customer either way, which per-IP limiting can't see. Runs AFTER
// requireAuth (it reads request.org) and is a no-op for cookie-session
// traffic, which the per-IP limiter above and the free-tier quota already
// cover. 300/min comfortably covers a CI fleet; it exists to stop a leaked
// or scripted-abuse key, not to ration normal use.
const apiKeyAnalyzeRateLimit = makeApiKeyRateLimit({ keyName: "analyze-key", limit: 300, windowSec: 60 });

// ---- Real routes (Task #4) -------------------------------------------------
router.post("/api/checkout",          checkoutRateLimit, checkoutHandler);
router.get( "/api/checkout/success",  checkoutSuccessHandler);
router.post("/api/stripe/webhook",    stripeWebhookHandler);

// ---- Analyzer routes (Task #5+) — all behind requireAuth ------------------
// Wrapped with enforceQuota (Task #19) so free-tier users hit a 402 after
// 5 successful runs in the current calendar month; paid users bypass.
// Rate-limit middleware runs FIRST so flood traffic doesn't even read the
// auth KV row.
router.post("/api/analyze/cost",    analyzeRateLimit, requireAuth, apiKeyAnalyzeRateLimit, enforceQuota(analyzeCostHandler));
router.post("/api/analyze/vuln",    analyzeRateLimit, requireAuth, apiKeyAnalyzeRateLimit, enforceQuota(analyzeVulnHandler));
router.post("/api/analyze/algo",    analyzeRateLimit, requireAuth, apiKeyAnalyzeRateLimit, enforceQuota(analyzeAlgoHandler));
// Architecture X-ray. Same gate as the other three — an architecture
// submission is a whole repository, so it is metered like any other run
// rather than being cheaper because it makes no upstream calls.
router.post("/api/analyze/architecture", analyzeRateLimit, requireAuth, apiKeyAnalyzeRateLimit, enforceQuota(analyzeArchitectureHandler));

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
// Which migrations the live database actually has. The deploy pipeline does
// not run `wrangler d1 execute`, so this is the only way to confirm from
// outside the Cloudflare account that production has the schema the code
// expects — see adminSchemaCheckHandler for what it can and cannot prove.
router.get( "/api/admin/schema-check", requireAdmin, adminSchemaCheckHandler);

// ---- Session routes (Task #8) ---------------------------------------------
router.post("/api/logout",          requireAuth, logoutHandler);

// ---- Dashboard hydration (Task #11) ---------------------------------------
router.get( "/api/me",              requireAuth, meHandler);

// ---- Run history (Task #17) — list + read past analyzer runs --------------
// Scoped to the ORG since migrations/0007, so a CI run — which has no user
// behind it — is visible to the team it belongs to. The report route is
// registered before /:id purely for readability; the paths don't overlap.
router.get(   "/api/runs",                    requireAuth, listRunsHandler);
router.get(   "/api/runs/:id/report",         requireAuth, getRunReportHandler);
// Share links: minting one requires a session that can already read the run;
// following one requires nothing at all, which is the point — the reader is
// the customer's client and will never have an account here.
router.post(  "/api/runs/:id/share",          requireAuth, createRunShareHandler);
router.delete("/api/runs/:id/share/:token",   requireAuth, revokeRunShareHandler);
router.get(   "/api/runs/:id",                requireAuth, getRunHandler);

// ---- Shared reports — DELIBERATELY UNAUTHENTICATED ------------------------
// The token IS the authorisation. It names exactly one run, is read-only, and
// expires; see src/reports/share.js for why there is no signature to verify.
// Rate-limited on the same bucket as other public reads so a stolen link, or
// a token-guessing sweep, cannot be used to hammer the origin.
router.get(   "/api/share/:token",            publicReadRateLimit, sharedReportHandler);

// ---- CI ingestion (Task #P-9) — a build pipeline posting an audit --------
// /runs is API-key only (enforced inside the handler, not here — requireAuth
// deliberately accepts both credentials and the handler is where the stricter
// rule belongs). Quota-wrapped like every other analyzer: a CI run is a run,
// and leaving it unmetered would make the free tier unlimited for anyone
// willing to call it from a build.
router.post("/api/ci/runs",    analyzeRateLimit, requireAuth, apiKeyAnalyzeRateLimit, enforceQuota(ciRunHandler));
// The setup snippet is dashboard-facing, so either credential may read it.
router.get( "/api/ci/snippet", requireAuth, ciSnippetHandler);

// ---- Stripe Customer Portal (Task #18) — manage card / cancel / invoices --
router.post("/api/billing/portal",  requireAuth, billingPortalHandler);

// ---- Organisations, seats and roles ---------------------------------------
// Role enforcement lives inside the handlers rather than in middleware: the
// caller's role is a property of the org they're acting as, so it can't be
// known until that org is resolved. The invite endpoint shares the signup
// rate-limit bucket because it, too, sends mail to an attacker-chosen address.
router.get(   "/api/org",                  requireAuth, getOrgHandler);
router.post(  "/api/org/invite",           signupRateLimit, requireAuth, inviteMemberHandler);
router.post(  "/api/org/invite/accept",    requireAuth, acceptInviteHandler);
router.delete("/api/org/members/:userId",  requireAuth, removeMemberHandler);
// White-label report branding. Owner/admin AND top tier — the tier check is
// inside the handler, where the org is already resolved.
router.put(   "/api/org/branding",         requireAuth, updateOrgBrandingHandler);

// ---- API keys (Task #P-4) — CI and other machine callers -----------------
// Management (create/list/revoke) requires a human owner/admin session —
// requireKeyManager in handlers/keys.js refuses a request authenticated by
// an API key itself. Machine use of a minted key is the requireAuth branch
// above, on the SAME /api/analyze/* routes a browser session already uses.
router.post(  "/api/keys",       requireAuth, createApiKeyHandler);
router.get(   "/api/keys",       requireAuth, listApiKeysHandler);
router.delete("/api/keys/:id",   requireAuth, revokeApiKeyHandler);

// ---- Scheduled monitors — continuous re-scanning -------------------------
// Any member of the org can manage these (see handlers/monitors.js for why
// they aren't owner/admin-gated like keys are). Both credential types work,
// so CI that can trigger a scan can also manage what gets scanned.
router.get(   "/api/monitors",           requireAuth, listMonitorsHandler);
router.post(  "/api/monitors",           requireAuth, createMonitorHandler);
router.delete("/api/monitors/:id",       requireAuth, deleteMonitorHandler);
router.post(  "/api/monitors/:id/pause", requireAuth, pauseMonitorHandler);

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

  /**
   * Cron Trigger entry point — daily at 03:00 UTC (see wrangler.toml).
   *
   * Only decides which monitors are due and enqueues one message each; the
   * scans themselves happen in `queue` below. See src/monitors/run.js for
   * why the two are split.
   */
  async scheduled(event, env, ctx) {
    try {
      const summary = await sweepDueMonitors(env, ctx);
      console.log("monitors: sweep", JSON.stringify({ cron: event && event.cron, ...summary }));
    } catch (err) {
      // A cron handler that throws is a sweep that silently didn't happen —
      // capture so a broken nightly run is visible rather than just absent.
      await captureException(env, ctx, err, { tags: { source: "worker_scheduled" } });
      throw err;
    }
  },

  /**
   * Queue consumer — one batch of monitor-check messages. Each message is
   * acked or retried individually inside handleMonitorQueue, so one slow or
   * failing repo can't redeliver (and re-email) its batch-mates.
   */
  async queue(batch, env, ctx) {
    await handleMonitorQueue(batch, env, ctx);
  },
};
