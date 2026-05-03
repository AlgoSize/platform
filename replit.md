# Algosize

## Project Overview
Algosize helps engineering teams cut cloud spend, find vulnerabilities, and optimize critical algorithms. The product is a Jekyll marketing site + dashboard backed by a Cloudflare Worker API (auth, Stripe, analyzer endpoints).

## Repository layout
- `site/` — Jekyll project for the marketing site and dashboard. Vanilla CSS only, no JS frameworks.
- `worker/` — Cloudflare Worker API. Auth (JWT in KV), Stripe checkout + webhook, three analyzer endpoints.
- `shared/` — Cross-cutting constants/types imported by both sides without a build step.
- `.env.example` — Documents every secret and config value the project needs.

## Tech stack
- **Frontend:** Jekyll ~> 4.3.2 (Ruby 3.2), vanilla HTML/CSS, plain `fetch` for API calls.
- **Backend:** Cloudflare Worker on Node.js 20 tooling (wrangler), Web Crypto for JWT and Stripe webhook signature verification.
- **Storage:** Cloudflare KV namespaces — `SESSIONS` (JWT TTL store), `USERS` (subscriber records), `RUNS` (per-user analyzer history with 90-day TTL).
- **Payments:** Stripe (Checkout + webhooks), called via `fetch` — no Node SDK.

## Running locally
The Replit `Start application` workflow runs the Jekyll site:
```
cd site && bundle exec jekyll serve --host 0.0.0.0 --port 5000 --livereload
```
Run the Worker separately when you need the API:
```
cd worker && npx wrangler dev    # listens on http://localhost:8787
```

## Deployment
- **Site:** static deploy from `site/_site` (`cd site && bundle exec jekyll build`).
- **Worker:** `cd worker && wrangler deploy` to Cloudflare. See `DEPLOY.md` (added by Task #10) for the full production checklist.
- **Environments:** two named Cloudflare envs in `worker/wrangler.toml` — `production` (`algosize.com/api/*`, Stripe live mode) and `staging` (`staging.algosize.com/api/*`, Stripe test mode, separate KV namespaces, separate sandbox sibling `algosize-sandbox-staging`). Staging setup is documented in `DEPLOY.md` §7 (Task #23). Use `--env staging` for risky-change rehearsal before promoting to prod.
- **CI auto-deploy (Task #24):** `.github/workflows/worker.yml` runs the full worker test suite then deploys to Cloudflare on every push touching `worker/**`, `worker-sandbox/**`, `shared/**`, or the workflow itself. Branch-based env routing: `main` → `--env production`, `staging` → `--env staging`. A failed test blocks the deploy. Sandbox sibling deploys first (the main Worker's service binding requires it). Repo secrets needed: `CLOUDFLARE_API_TOKEN` (scoped) and `CLOUDFLARE_ACCOUNT_ID`. See `DEPLOY.md` §2.6.

## Status
All 11 build tasks complete:
- #1 monorepo init, #2 auth/JWT in KV, #3 CORS, #4 Stripe Checkout + webhook,
- #5 cost analyzer, #6 vulnerability scanner, #7 algorithm optimizer,
- #8 dashboard page (`/dashboard/`) with three analyzer panels, Chart.js cost-savings
  bar chart (CDN with SRI sha384), `Sign out` button → `POST /api/logout` (revokes
  KV session + clears cookie), all fetches send `credentials:"include"` and
  redirect to `/` on 401,
- #9 manual end-to-end smoke checklist at `TESTING.md` (9 steps from landing →
  Stripe checkout → dashboard → cost/vuln/algo runs → logout → `/dashboard`
  blocked); appendix records the dynamic probe results (CORS, 401 gates,
  Stripe error path, 404, 501) captured against `wrangler dev`,
- #10 deployment runbook at `DEPLOY.md` covering site → GH Pages w/ custom
  domain, `wrangler deploy` (login + KV namespace create + binding), 4
  Cloudflare secrets, DNS + Worker route on `algosize.com/api/*`, Stripe
  webhook signing-secret round trip, and Stripe test → live key swap,
- #11 dashboard hydration: `GET /api/me` (gated by `requireAuth`, reads USERS
  KV via `getUserById`, falls back to session payload) returns `{email,
  subStatus}`; dashboard JS calls it on `DOMContentLoaded` and updates the
  header pill text/colour + shows the real signed-in email,
- #18 Stripe Customer Portal link: new `POST /api/billing/portal`
  (worker/src/handlers/billing.js) gated by `requireAuth`, reads
  `stripeCustomerId` from USERS KV, calls Stripe `/v1/billing_portal/sessions`
  with `return_url=${SITE_ORIGIN}/dashboard/`, returns `{url}`. Returns
  `400 no_stripe_customer` when the row has no Stripe customer attached
  (defensive). Dashboard header gains a **Manage billing** button next
  to the status pill — hidden by default, revealed once `/api/me` confirms
  a `subStatus`. State changes (cancel, card swap) flow back through the
  existing `customer.subscription.deleted` webhook (Task #4) and surface
  on the next page load via `/api/me` (Task #11). One-time Stripe
  dashboard setup documented in `DEPLOY.md` §6.5. Coverage:
  `worker/scripts/test-billing-portal.mjs` (happy path, no-customer 400,
  unauthed 401, Stripe-rejection 4xx/5xx),
- #17 persist analyzer history: new `RUNS` KV namespace stores
  `run:<userId>:<id>` JSON `{analyzer, input, result, ms, headline,
  createdAt}` with 90-day TTL plus a per-user `runs:<userId>` index capped at
  100 entries. Persistence fires from each analyzer handler via
  `ctx.waitUntil(queuePersist(...))` on a successful 200 (never on errors).
  CUR uploads (cost) persist with an `_omitted` input marker so re-run is
  greyed out. New routes `GET /api/runs` (paginated, list-view shape) and
  `GET /api/runs/:id` (full record) gated by `requireAuth` + per-user
  scoping. Dashboard "Recent runs" panel above the analyzers shows the last
  20 with Re-run (POSTs the persisted input) and CSV export (per-analyzer
  tabular shape: cost→suggestions, vuln→advisories, algo→Big-O probe),
- #19 free tier with per-user monthly quota: user records gain
  `plan: "free"|"paid"` (`worker/src/handlers/_users.js` —
  `upsertUserFromCheckout` always sets `paid`; pre-#19 records normalize
  to `paid` on read). New `worker/src/quota.js` exposes
  `currentMonthKey/quotaKey/getMonthlyUsage/incrementMonthlyUsage` plus
  `enforceQuota(handler)` wrapper. Counters live in `USERS` KV at
  `quota:<userId>:<YYYY-MM>` with a 35-day TTL — calendar reset is
  automatic, increment fires only after a 200 via `ctx.waitUntil`, and
  paid users bypass entirely. Free limit: **5 runs / month** shared
  across cost+vuln+algo. Over-limit returns `402 quota_exceeded`
  `{message, monthlyRunsUsed, monthlyRunsLimit, upgradeUrl}`. New
  `POST /api/signup` (`worker/src/handlers/signup.js`) accepts
  `{email}`, validates, creates a free user (no Stripe customer), issues
  a 30-day session JWT, returns `201 {ok, email, plan,
  monthlyRunsUsed, monthlyRunsLimit, redirectUrl: "/dashboard/"}` with
  `Set-Cookie`. Duplicate emails return `409 email_taken` and never
  issue a session (signup is intentionally not a login mechanism;
  magic-link auth is a follow-up). `GET /api/me` extended with `plan`,
  `monthlyRunsUsed`, `monthlyRunsLimit` (null/null for paid). Marketing
  pricing section becomes a two-card grid (Starter free signup form +
  existing Pro/$29 Stripe CTA) wired through `site/assets/js/checkout.js`.
  Dashboard header gains a quota pill (`X / 5` or `Unlimited`) and an
  inline upgrade banner that shows automatically on `402` and links to
  `/api/checkout`. Coverage: `worker/scripts/test-quota.mjs` (47
  assertions: helpers, increment+TTL, wrapper paid-bypass,
  free-under-limit, validation-doesn't-consume, 402-at-limit,
  calendar-boundary reset, end-to-end via the live `analyzeAlgoHandler`,
  `/api/signup` happy/duplicate/invalid, `/api/me` quota fields).

Branding: brand mark is the typographic `[as]` (no gradient box) plus the
"Algosize" wordmark; styled in `site/assets/css/main.css` (`.brand-mark`,
`.brand-word`); used in both header and footer of `site/index.html` and
`site/dashboard.html`. Master SVG of the mark lives at
`site/assets/img/brand-mark.svg` and is reused for the browser favicon
(`site/favicon.svg`), the 180×180 `site/apple-touch-icon.png`, and the
1200×630 `site/og-image.png` (built from `site/assets/img/og-image.svg`
via `convert`/rsvg). `site/_layouts/default.html` wires in the `<link>`
icon tags plus full Open Graph + Twitter `summary_large_image` meta.

Task #20 — Stripe webhook idempotency. Stripe is at-least-once
delivery; the same `event.id` can arrive twice (network retries on
5xx, or the rare duplicate from Stripe's side). `stripeWebhookHandler`
(`worker/src/handlers/webhook.js`) now dedups on `event.id` BEFORE
dispatch (after signature verification, so an attacker can't pollute
the dedup table). Helpers `hasProcessed` / `markProcessed` write a
key `stripeEvent:<id>` into the existing `SESSIONS` KV namespace with
a 7-day TTL (longer than Stripe's documented retry window of ~3
days). The dedup row is written ONLY after the handler succeeds — if
KV/handler errors, we return 500 and let Stripe retry into a still-
empty slot. Duplicate deliveries get `200 {received:true,
deduped:true, type}`. Unknown event types are also deduped (so Stripe
stops retrying things we choose to ignore). Coverage:
`worker/scripts/test-webhook-idempotency.mjs` (30 assertions:
duplicate short-circuits, USERS-write count unchanged on replay, TTL
604800s, per-event-not-per-customer dedup, unknown-type dedup, 5xx
does NOT mark processed, bad-signature does NOT poison dedup table).
Existing `test-stripe.mjs` still passes unchanged.

Task #21 — Per-IP rate limiting. New
`worker/src/middleware/rate-limit.js` exposes a `makeRateLimit({keyName,
limit, windowSec})` factory that returns an itty-router middleware.
Counters live in the existing `SESSIONS` KV under
`rl:<ip>:<endpoint>:<minute>` with a 2-window TTL. IP comes from
`CF-Connecting-IP` (then `X-Forwarded-For` first hop, then `"unknown"`
so a header-stripping bot doesn't get a free per-request bucket). Over
limit returns `429 {error:"rate_limited", retryAfterSec}` with a
matching `Retry-After` header (seconds until window rollover). Wired
in `worker/src/index.js` BEFORE `requireAuth` so flood traffic doesn't
read the auth row: `/api/checkout` and `/api/signup` at 10/min/IP each
(separate buckets); the three `/api/analyze/*` routes at 30/min/IP
SHARED across cost/vuln/algo (`keyName: "analyze"`). Fails open if the
SESSIONS binding is missing (logs a warning rather than 500ing every
request). Coverage: `worker/scripts/test-rate-limit.mjs` (22
assertions: clientIp resolution, first-N-pass / N+1-blocks, body+
header shape, window rollover reset, IP independence, endpoint
independence, KV write hygiene + 120s TTL, fail-open on missing
binding, factory input validation).

Task #22 — Error tracking + structured logs. New
`worker/src/observability.js` exposes `captureException(env, ctx,
error, context)` and `captureMessage(env, ctx, message, context)` plus
a tested `parseDsn` / `buildEvent` for unit testing. Two sinks fire on
every event: (1) **always-on** structured JSON line to console.error/
.log (visible in `wrangler tail`, free), (2) **optional** POST to a
Sentry project envelope endpoint when `env.SENTRY_DSN` is set, queued
via `ctx.waitUntil` so it never delays the user response. Stack
parsing yields proper Sentry frames; raw stack is also kept in
`extra.stack`. PII safety: cookies / Authorization header / query
string / request body are NEVER forwarded — only URL pathname, method,
User-Agent, CF-Connecting-IP, CF-Ray, plus `user.id` (opaque JWT
subject) and a `release` tag from `env.RELEASE_TAG`. Sentry transport
fails soft on outage / 5xx / unparseable DSN — never throws, never
recurses. Wired in: (a) `worker/src/index.js` top-level catch (every
uncaught exception, tag `source: "worker_top_level"`); (b)
`worker/src/handlers/webhook.js` — missing `STRIPE_WEBHOOK_SECRET`
captured fatal, signature failures captured warning with
`verdict_reason`, handler exceptions captured with `stripe_event_id`
+ `event_type` tags; (c) `worker/src/handlers/analyze.js` — every
analyzer engine throw captured with per-analyzer label tag (cost,
vuln, algo, plus the CUR-csv, lockfile-fetch upstream-github, and OSV
upstream sub-paths — both the tagged `github_unavailable` 502 path
and the generic `fetch_failed` catch are instrumented, with
`request` + `userId` threaded through `runLockfileAudit`). DEPLOY.md
§3.5 documents Sentry setup, the captured-event matrix, and the
"never sent" PII list. `worker/.dev.vars` adds blank `SENTRY_DSN=`
and `RELEASE_TAG=local-dev` placeholders. Coverage in two layers:
1. `worker/scripts/test-observability.mjs` (60 unit assertions: DSN
   parsing incl. malformed inputs, event shape incl. PII stripping,
   transport incl. envelope format + X-Sentry-Auth header,
   Sentry-disabled fast-path, Sentry-outage fail-soft, captureMessage
   parity, ctx.waitUntil non-blocking).
2. `worker/scripts/test-observability-handlers.mjs` (42 integration
   assertions added in response to first- and second-pass code review:
   forces real handler error paths — vuln lockfile-fetch
   github_unavailable, vuln lockfile-fetch generic fetch_failed (via
   a Response whose `text()` throws — exploits the gap that the inner
   try/catch only wraps `fetchImpl`, not body decode), vuln OSV
   upstream failure, webhook signature failure, webhook handler
   KV-throw exception, Sentry-disabled fast-path — and asserts the
   tracker POST is queued onto ctx.waitUntil with the right tags +
   user id + request URL/method + parsed stack frames, while the
   user-facing HTTP response is unchanged).

Worker test suites (run with `cd worker && npm test`):
- `test-auth.mjs`, `test-stripe.mjs`, `test-cost.mjs`, `test-vuln.mjs`,
  `test-algo.mjs`, `test-logout.mjs`, `test-me.mjs`, `test-history.mjs`,
  `test-billing-portal.mjs`, `test-quota.mjs`,
  `test-webhook-idempotency.mjs`, `test-rate-limit.mjs`,
  `test-observability.mjs`, `test-observability-handlers.mjs` — all
  green (628 assertions across 14 files).
