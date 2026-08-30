// Algosize Worker — request router.
//
// Real handlers wired so far:
//   POST /api/checkout            → Stripe Checkout Session creator
//   GET  /api/checkout/success    → Stripe success_url callback (sets cookie)
//   POST /api/stripe/webhook      → signature-verified webhook
//   POST /api/analyze/cost        → cloud cost-savings analyzer (Task #5)
//   POST /api/analyze/vuln        → vulnerability scanner (Task #6)
//   POST /api/analyze/profile     → repository language profiler (pre-scan)
//   POST /api/analyze/algo        → algorithm optimizer (Task #7)
//   POST /api/logout              → revoke session + clear cookie (Task #8)
//   GET  /api/me                  → dashboard hydration (Task #11)

import { Router } from "itty-router";
import { handlePreflight, withCors, corsHeaders } from "./cors.js";
import { requireAuth, requireAuthSoft } from "./auth.js";
import { checkoutHandler, checkoutSuccessHandler } from "./handlers/checkout.js";
import { stripeWebhookHandler } from "./handlers/webhook.js";
import {
  getOrgHandler,
  inviteMemberHandler,
  acceptInviteHandler,
  revokeInviteHandler,
  removeMemberHandler,
  updateOrgBrandingHandler,
} from "./handlers/org.js";
import {
  setOrgDomainHandler,
  verifyOrgDomainHandler,
  removeOrgDomainHandler,
} from "./handlers/org_domain.js";
import {
  getAccountHandler,
  updateProfileHandler,
  requestEmailChangeHandler,
  confirmEmailChangeHandler,
  cancelEmailChangeHandler,
  listSessionsHandler,
  revokeSessionHandler,
  revokeOtherSessionsHandler,
  listLoginsHandler,
  getNotificationsHandler,
  updateNotificationsHandler,
} from "./handlers/account.js";
import {
  exportAccountHandler,
  deletePreviewHandler,
  deleteOrgHandler,
} from "./handlers/account_danger.js";
import {
  getReferralsHandler,
  inviteReferralHandler,
  referralLandingHandler,
} from "./handlers/referrals.js";
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
  analyzeProfileHandler,
} from "./handlers/analyze.js";
import {
  listMonitorsHandler,
  createMonitorHandler,
  deleteMonitorHandler,
  pauseMonitorHandler,
  setMonitorAnalyzersHandler,
  setMonitorScheduleHandler,
  runMonitorNowHandler,
  monitorRouteHandler,
  monitorResultHandler,
} from "./handlers/monitors.js";
import { scorecardHandler } from "./handlers/scorecard.js";
import {
  listArchSnapshotsHandler,
  getArchSnapshotHandler,
  archDiffHandler,
} from "./handlers/arch_snapshots.js";
import { sweepDueMonitors, handleMonitorQueue, handleMonitorDlq } from "./monitors/run.js";
import { logoutHandler } from "./handlers/logout.js";
import { meHandler } from "./handlers/me.js";
import {
  listRunsHandler,
  getRunHandler,
  getRunReportHandler,
  createRunShareHandler,
  listRunSharesHandler,
  revokeRunShareHandler,
  sharedReportHandler,
} from "./handlers/runs.js";
import { ciRunHandler, ciSnippetHandler, ciOptimizerSnippetHandler,
         ciEstimateSnippetHandler, ciArchitectureSnippetHandler,
         ciCostSnippetHandler } from "./handlers/ci.js";
import {
  billingPortalHandler,
  billingSummaryHandler,
  billingInvoicesHandler,
  updateBillingEmailHandler,
} from "./handlers/billing.js";
import { requestMagicLinkHandler, verifyMagicLinkHandler } from "./handlers/auth_magic.js";
import { googleStartHandler, googleCallbackHandler } from "./handlers/auth_google.js";
import {
  adminListUsersHandler,
  adminUsersCsvHandler,
  adminSchemaCheckHandler,
  adminStripeCheckHandler,
  adminSandboxCheckHandler,
  requireAdmin,
} from "./handlers/admin.js";
import {
  adminOverviewHandler,
  adminAccountsHandler,
  adminAccountDetailHandler,
  adminAccountInvoicesHandler,
  adminUserDetailHandler,
  adminRevokeSessionHandler,
  adminBillingHandler,
  adminAutomationHandler,
  adminAuditHandler,
  adminFlagsHandler,
  adminSetFlagHandler,
  adminListFlagOverridesHandler,
  adminSetFlagOverrideHandler,
  adminDeleteFlagOverrideHandler,
  adminSettingsHandler,
} from "./handlers/admin_panel.js";
import { pageviewPixelHandler } from "./handlers/pageview.js";
import { seedHandler } from "./handlers/_seed.js";
import { enforceQuota } from "./quota.js";
import {
  mcpPostHandler, mcpGetHandler, mcpDeleteHandler, mcpManifestHandler,
  mcpUsageHandler, mcpListClientsHandler, mcpRevokeClientHandler,
} from "./handlers/mcp.js";
import { mcpAuth } from "./mcp/auth.js";
import { mcpPreflight } from "./mcp/transport.js";
import {
  authorizationServerMetadata, protectedResourceMetadata, metadataResponse,
} from "./mcp/metadata.js";
import {
  mcpRegisterClientHandler, mcpAuthorizeHandler, mcpAuthorizeConsentHandler,
  mcpTokenHandler, mcpRevokeHandler,
} from "./mcp/oauth.js";
import { makeRateLimit, makeApiKeyRateLimit } from "./middleware/rate-limit.js";
import { captureException } from "./observability.js";
import { generateFixHandler, proposeFixHandler, validateFixHandler, explainRuleHandler, importSarifHandler } from "./handlers/fix.js";
import { estimateHandler, estimateProvidersHandler } from "./handlers/estimate.js";
import { withEstimateHistory } from "./handlers/estimate_history.js";
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
// Deliberately NOT quota-enforced: one tree listing, no file reads, and its
// purpose is to answer "would a scan cover my repository?" before you buy one.
router.post("/api/analyze/profile", analyzeRateLimit, requireAuth, analyzeProfileHandler);

// Per-finding fix generation ("Generate fix" on vuln + architecture
// findings). Rate-limited and authenticated, but deliberately NOT behind
// enforceQuota: quota counts analyzer RUNS, and a fix request is an add-on
// to a run that was already counted — double-charging it would make the
// button feel broken on the last run of a free month.
router.post("/api/fix", analyzeRateLimit, requireAuth, generateFixHandler);
// The structured pipeline: FixProposal + static validation + patch. Rate
// limited like every AI-backed route; not quota-metered — a fix is follow-up
// work on a run already paid for, and validate consumes no AI at all.
router.post("/api/fix/propose",  analyzeRateLimit, requireAuth, proposeFixHandler);
router.post("/api/fix/validate", analyzeRateLimit, requireAuth, validateFixHandler);
router.get("/api/fix/rule", requireAuth, explainRuleHandler);
router.post("/api/import/sarif", analyzeRateLimit, requireAuth, importSarifHandler);

// ---- Infrastructure Cost Estimator ----------------------------------------
// No cloud-account connector and no credential storage, ever: the estimate is
// computed from configuration handed to us and the bundled pricing catalog,
// and nothing else is contacted. Two ways configuration reaches it: this
// route (upload or manual entry), and a scheduled monitor pricing the
// repository's COMMITTED compose file (monitors/analyzers.js) — the same
// no-credentials posture, on a schedule. See handlers/estimate.js for the
// sanitizing boundary both paths share.
//
// Metered like the other analyzers — an estimate is a run.
// The history wrapper sits OUTSIDE the estimator's own handler on purpose.
// handlers/estimate.js is a sanitizing boundary whose module header forbids
// persisting anything derived from a submitted configuration, and a test
// asserts that file contains no persistence reach at all — a structural
// guarantee rather than a careful one. So the filing happens here, from a
// module that sees only the sanitized response the boundary chose to return,
// and copies an allowlisted aggregate of it. See handlers/estimate_history.js.
router.post("/api/estimate", analyzeRateLimit, requireAuth, apiKeyAnalyzeRateLimit,
            enforceQuota(withEstimateHistory(estimateHandler)));
// Catalog metadata for the provider picker. Not quota-metered: it is a page
// load, not a run, and charging for it would make the form cost a run to open.
router.get("/api/estimate/providers", requireAuth, estimateProvidersHandler);

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
// Stripe ACCOUNT configuration the code depends on but cannot carry in the
// repo — the portal default and the webhook endpoint both live in the Stripe
// dashboard, and both fail only once a real customer hits them.
router.get( "/api/admin/stripe-check", requireAdmin, adminStripeCheckHandler);
router.get( "/api/admin/sandbox-check", requireAdmin, adminSandboxCheckHandler);

// The control panel's own read surface. Everything below is behind the same
// requireAdmin allowlist; there is no second, weaker gate anywhere on it.
//
// Ordering matters for the two-segment routes: itty-router matches in
// declaration order, so a literal path has to be declared before the
// parameterised one that would also match it.
router.get(   "/api/admin/overview",                 requireAdmin, adminOverviewHandler);
router.get(   "/api/admin/accounts",                 requireAdmin, adminAccountsHandler);
router.get(   "/api/admin/accounts/:orgId/invoices", requireAdmin, adminAccountInvoicesHandler);
router.get(   "/api/admin/accounts/:orgId",          requireAdmin, adminAccountDetailHandler);
router.get(   "/api/admin/users/:userId",            requireAdmin, adminUserDetailHandler);
// Signing another person out of their own account — one of only two writes
// on this surface, and audited for that reason.
router.delete("/api/admin/users/:userId/sessions/:sessionId", requireAdmin, adminRevokeSessionHandler);
router.get(   "/api/admin/billing",                  requireAdmin, adminBillingHandler);
router.get(   "/api/admin/automation",               requireAdmin, adminAutomationHandler);
router.get(   "/api/admin/audit",                    requireAdmin, adminAuditHandler);
router.get(   "/api/admin/flags",                    requireAdmin, adminFlagsHandler);
router.patch( "/api/admin/flags/:key",               requireAdmin, adminSetFlagHandler);
router.get(   "/api/admin/flags/:key/overrides",              requireAdmin, adminListFlagOverridesHandler);
router.put(   "/api/admin/flags/:key/overrides/:subject",     requireAdmin, adminSetFlagOverrideHandler);
router.delete("/api/admin/flags/:key/overrides/:subject",     requireAdmin, adminDeleteFlagOverrideHandler);
router.get(   "/api/admin/settings",                 requireAdmin, adminSettingsHandler);

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
// The links already minted for this report. Registered before /api/runs/:id so
// the literal segment wins over the id pattern.
router.get(   "/api/runs/:id/shares",         requireAuth, listRunSharesHandler);
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
// The optimizer's per-PR gate: workflow + optimizer.config.json example. The
// same manifest drives the scheduled monitors' optimizer pass, so the
// nightly sweep and the CI gate watch the same functions by construction.
router.get( "/api/ci/optimizer-snippet", requireAuth, ciOptimizerSnippetHandler);
// The remaining two gates. The architecture endpoint has accepted `files`
// since the X-ray shipped, but with no workflow and no snippet nobody could
// reach it without hand-writing YAML against an undocumented body.
router.get( "/api/ci/estimate-snippet",     requireAuth, ciEstimateSnippetHandler);
router.get( "/api/ci/architecture-snippet", requireAuth, ciArchitectureSnippetHandler);
router.get( "/api/ci/cost-snippet",         requireAuth, ciCostSnippetHandler);

// ---- Stripe Customer Portal (Task #18) — manage card / cancel / invoices --
router.post("/api/billing/portal",  requireAuth, billingPortalHandler);
// The read side of the same subject. Everything that is money is fetched from
// Stripe live on each request — there is no cached price anywhere in this
// codebase, deliberately (see migrations/0003), so these cannot go stale.
router.get( "/api/billing/summary",  requireAuth, billingSummaryHandler);
router.get( "/api/billing/invoices", requireAuth, billingInvoicesHandler);
// Where invoices go. Owner-only, and additive — the owner keeps receiving
// dunning regardless, because a finance inbox nobody reads is how a card
// decline becomes a lapsed account.
router.put( "/api/billing/email",    requireAuth, updateBillingEmailHandler);

// ---- Account management ---------------------------------------------------
// The settings area. Every route here requires a SESSION: an API key has no
// human behind it, and a leaked key must not be able to move the account's
// login address. The refusal is made explicitly in handlers/account.js rather
// than assumed, because requireAuth accepts both credential types.
//
// Team and API-key management are deliberately NOT re-implemented here — the
// settings page calls the existing /api/org and /api/keys routes, so there is
// one set of rules for seats and roles rather than two that can drift.
router.get(   "/api/account",                  requireAuth, getAccountHandler);
router.patch( "/api/account/profile",          requireAuth, updateProfileHandler);
// Changing the login email is an authentication change: it is staged, mailed
// to the NEW address to prove control, and announced to the OLD one so a
// hijacked session cannot silently lock the owner out. Shares the signup
// rate-limit bucket because it, too, sends mail to an attacker-chosen address.
router.post(  "/api/account/email",            signupRateLimit, requireAuth, requestEmailChangeHandler);
router.delete("/api/account/email",            requireAuth, cancelEmailChangeHandler);
// Deliberately UNauthenticated and a GET: it is clicked from an email, by
// someone proving control of the new mailbox, possibly on a device that has
// never signed in. The token is the authorisation, exactly as for a magic link.
router.get(   "/api/account/email/confirm",
  makeRateLimit({ keyName: "email_confirm", limit: 30, windowSec: 60 }), confirmEmailChangeHandler);
// Literal path before the parameterised one that would also match it.
router.post(  "/api/account/sessions/revoke-others", requireAuth, revokeOtherSessionsHandler);
router.get(   "/api/account/sessions",         requireAuth, listSessionsHandler);
router.delete("/api/account/sessions/:sessionId", requireAuth, revokeSessionHandler);
router.get(   "/api/account/logins",           requireAuth, listLoginsHandler);
router.get(   "/api/account/notifications",    requireAuth, getNotificationsHandler);
router.put(   "/api/account/notifications",    requireAuth, updateNotificationsHandler);
// Danger zone. Owner-only, both of them; the delete additionally requires the
// organisation's name typed back and cancels Stripe before touching any data.
router.get(   "/api/account/export",           requireAuth, exportAccountHandler);
router.get(   "/api/account/delete-preview",   requireAuth, deletePreviewHandler);
router.delete("/api/account/org",              requireAuth, deleteOrgHandler);

// ---- Referrals and credit -------------------------------------------------
// Credit only. There is no payout path here or anywhere else — see
// src/credits.js for why that is a decision rather than a gap.
router.get( "/api/referrals",        requireAuth, getReferralsHandler);
router.post("/api/referrals/invite", requireAuth, inviteReferralHandler);
// The public link. Unauthenticated by design — it is followed by someone who
// does not have an account yet. An unknown code still redirects to the site
// rather than 404ing at a stranger who was recommended the product.
router.get( "/api/r/:code",          publicReadRateLimit, referralLandingHandler);

// ---- Organisations, seats and roles ---------------------------------------
// Role enforcement lives inside the handlers rather than in middleware: the
// caller's role is a property of the org they're acting as, so it can't be
// known until that org is resolved. The invite endpoint shares the signup
// rate-limit bucket because it, too, sends mail to an attacker-chosen address.
router.get(   "/api/org",                  requireAuth, getOrgHandler);
router.post(  "/api/org/invite",           signupRateLimit, requireAuth, inviteMemberHandler);
router.post(  "/api/org/invite/accept",    requireAuth, acceptInviteHandler);
// Withdraw an unaccepted invite. POST rather than DELETE because the target is
// an email address, and putting one in a path segment invites encoding bugs
// for exactly the addresses (plus-tags, unicode domains) most likely to be
// mistyped and need revoking.
router.post(  "/api/org/invite/revoke",    requireAuth, revokeInviteHandler);
router.delete("/api/org/members/:userId",  requireAuth, removeMemberHandler);
// White-label report branding. Owner/admin AND top tier — the tier check is
// inside the handler, where the org is already resolved.
router.put(   "/api/org/branding",         requireAuth, updateOrgBrandingHandler);
// Custom report hostname. Same Firm-tier + owner/admin gate as branding.
// "Verified" here means the CNAME resolves to us — serving from the hostname
// is a separate operator step, and the response says which of the two is
// done rather than implying both. See handlers/org_domain.js.
router.put(   "/api/org/domain",           requireAuth, setOrgDomainHandler);
router.post(  "/api/org/domain/verify",    requireAuth, verifyOrgDomainHandler);
router.delete("/api/org/domain",           requireAuth, removeOrgDomainHandler);

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
// Which analyzers a monitor runs on its schedule (migrations/0016). All of
// them read only committed repository files — see monitors/analyzers.js for
// the rule that keeps them inside the no-credentials posture.
router.post(  "/api/monitors/:id/analyzers", requireAuth, setMonitorAnalyzersHandler);
// When a monitor runs (migrations/0017). Separate from /analyzers because
// changing WHAT is watched clears baselines and changing WHEN must not.
router.post(  "/api/monitors/:id/schedule",  requireAuth, setMonitorScheduleHandler);
// Run one now. Enqueues onto the same queue the cron sweep uses and answers
// 202 — the manual path and the scheduled path are the same code, so "works
// when I click it, not overnight" cannot happen.
router.post(  "/api/monitors/:id/run",       requireAuth, runMonitorNowHandler);
// Where the next alert actually goes. Served by the resolver the sweep
// itself calls, so the card and the delivery cannot drift apart.
router.get(   "/api/monitors/route",         requireAuth, monitorRouteHandler);
// The full current result of one analyzer on one monitored repo, in the same
// shape the analyzer's manual endpoint returns. This is the link between the
// monitors and the tool pages: an alert saying "3 new findings" now leads to
// a screen that can show them. Re-runs the analyzer against COMMITTED files
// and never advances a baseline — see monitors/inspect.js.
router.get(   "/api/monitors/:id/result/:analyzer", requireAuth, monitorResultHandler);

// ---- Scorecard — every monitored repo, every analyzer, one grid ----------
// Read entirely from stored monitor baselines; nothing is computed on demand
// and nothing is defaulted. A repo with no baseline reports "not measured",
// never a passing grade. See handlers/scorecard.js.
router.get(   "/api/scorecard",              requireAuth, scorecardHandler);

// ---- Architecture history (migrations/0018) ------------------------------
// Every X-ray run — manual, CI or nightly — records a versioned snapshot of
// the graph it built. These read that history back. Phase 1 ships the reads
// with nothing rendering them yet, so the drift view has an endpoint to build
// against rather than a schema to guess at. See src/arch/snapshots.js.
router.get(   "/api/arch/snapshots",         requireAuth, listArchSnapshotsHandler);
router.get(   "/api/arch/diff",              requireAuth, archDiffHandler);
router.get(   "/api/arch/snapshots/:id",     requireAuth, getArchSnapshotHandler);

// ---- Model Context Protocol server (migrations/0019) ----------------------
// One endpoint speaking Streamable HTTP, so an MCP host — Claude Code, Claude
// Desktop, Claude.ai, Cursor — can drive the analyzers as tools. Every tool is
// an adapter over a handler registered above; see src/mcp/chains.js, which
// carries the same middleware chains these routes use.
//
// The whole surface is gated behind MCP_ENABLED / the `mcp.enabled` flag and
// fails SHUT, so merging this changes nothing until the runbook flips it.
//
// mcpAuth composes AFTER requireAuth rather than replacing it: an ask_live_
// key or a cookie is resolved by exactly the code every other route uses, and
// mcpAuth only adds the ask_mcp_ OAuth token type on top. `requireAuthSoft`
// lets an unauthenticated request reach mcpAuth so it can answer with the
// WWW-Authenticate header that starts the OAuth dance — a bare 401 from
// requireAuth would leave a spec-compliant host with nowhere to go.
// 120 envelopes a minute per credential. Generous — one conversational turn
// can legitimately fan out to a dozen reads — but bounded, because an MCP
// client is a program and a loop in it would otherwise be unbounded.
const mcpEnvelopeRateLimit = makeApiKeyRateLimit({ keyName: "mcp", limit: 120, windowSec: 60 });

// Dynamic client registration creates a row with no credential presented, so
// it is the one MCP endpoint an anonymous caller can make write to the
// database. Limited per IP rather than per credential, since there is none.
const mcpRegisterRateLimit = makeRateLimit({ keyName: "mcp_register", limit: 5, windowSec: 3600 });

// The token endpoint is where a stolen code or refresh token would be
// redeemed, and where an attacker would brute-force one. Per IP, and tighter
// than the envelope limit because a legitimate client calls it once an hour.
const mcpTokenRateLimit = makeRateLimit({ keyName: "mcp_token", limit: 30, windowSec: 60 });

// The two discovery documents. Thin wrappers rather than handlers of their
// own: the documents are pure functions of the request origin, and giving
// them a handler file would be a file that exists to call one function.
const mcpProtectedResourceHandler = (request, env) =>
  metadataResponse(protectedResourceMetadata(request, env));
const mcpAuthServerHandler = (request, env) =>
  metadataResponse(authorizationServerMetadata(request, env));

router.options("/api/mcp",  mcpPreflight);
router.post(   "/api/mcp",  mcpEnvelopeRateLimit, requireAuthSoft, mcpAuth, mcpPostHandler);
router.get(    "/api/mcp",  mcpEnvelopeRateLimit, requireAuthSoft, mcpAuth, mcpGetHandler);
router.delete( "/api/mcp",  mcpEnvelopeRateLimit, requireAuthSoft, mcpAuth, mcpDeleteHandler);

// Public and cacheable: the catalog describes what the tools ARE and carries
// no customer data, so it is readable before anything is connected.
router.get(   "/api/mcp/manifest",   mcpManifestHandler);

router.get(   "/api/mcp/usage",      requireAuth, mcpUsageHandler);
router.get(   "/api/mcp/clients",    requireAuth, mcpListClientsHandler);
router.delete("/api/mcp/clients/:id", requireAuth, mcpRevokeClientHandler);

// OAuth 2.1 discovery. Served from the apex (see worker/wrangler.toml's
// routes) AND from under /api/ — the apex path is what the spec requires and
// what the WWW-Authenticate header advertises; the /api/ alias is what makes
// the flow exercisable under `wrangler dev`, which has no zone routes at all,
// and before new zone routes finish propagating.
// OAuth 2.1, for hosts that cannot take a pasted API key (Claude.ai's remote
// connectors). PKCE S256 only, exact redirect-URI matching, single-use codes
// whose replay revokes the whole token chain — see src/mcp/oauth.js.
//
// `authorize` (GET) is NOT behind requireAuth: it renders a sign-in prompt of
// its own when there is no session, because a bare 401 mid-OAuth leaves the
// user staring at a dead popup with no way forward. It resolves the session
// internally instead. The POST that records the decision IS behind
// requireAuth — approving a grant is an authenticated action.
//
// Registration is rate-limited per IP: it is the one endpoint here that
// creates rows without any credential at all.
router.post("/api/mcp/oauth/register",  mcpRegisterRateLimit, mcpRegisterClientHandler);
router.get( "/api/mcp/oauth/authorize", mcpAuthorizeHandler);
router.post("/api/mcp/oauth/authorize", requireAuth, mcpAuthorizeConsentHandler);
router.post("/api/mcp/oauth/token",     mcpTokenRateLimit, mcpTokenHandler);
router.post("/api/mcp/oauth/revoke",    mcpTokenRateLimit, mcpRevokeHandler);

router.get("/.well-known/oauth-protected-resource",    mcpProtectedResourceHandler);
router.get("/.well-known/oauth-authorization-server",  mcpAuthServerHandler);
router.get("/api/.well-known/oauth-protected-resource",   mcpProtectedResourceHandler);
router.get("/api/.well-known/oauth-authorization-server", mcpAuthServerHandler);

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
      const summary = await sweepDueMonitors(env, ctx, { cron: event && event.cron });
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
   *
   * ONE entrypoint serves every bound queue, so it must dispatch on which
   * queue the batch came from. Sending a dead-lettered batch to
   * handleMonitorQueue would re-run the exact sweep that already failed three
   * times — the DLQ's whole purpose is that those attempts are over — and,
   * because that handler retries on failure, it would bounce the message back
   * into the DLQ it just came from, indefinitely. Match on the suffix rather
   * than the exact name so production and staging (`algosize-scans-dlq` and
   * `algosize-scans-staging-dlq`) both route correctly from one rule.
   */
  async queue(batch, env, ctx) {
    if (String(batch.queue || "").endsWith("-dlq")) {
      await handleMonitorDlq(batch, env, ctx);
      return;
    }
    await handleMonitorQueue(batch, env, ctx);
  },
};
