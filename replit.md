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
- **Storage:** Cloudflare D1 (`DB`, db `algosize`) holds the canonical `users` and `runs` rows (per-user analyzer history). Cloudflare KV is used only for `SESSIONS` (rotating JWT store + Stripe-event dedup) and `USERS` (monthly quota counters at `quota:<userId>:<YYYY-MM>` — high write-rate workload). The legacy `RUNS` KV namespace was retired when run history moved to D1 (Task #25).
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

## Production live (2026-05-03)

The Worker `algosize` is now live on `algosize.com/api/*` (zone `algosize.com`).
Resolution chain for the long-standing 404/405 outage:

1. `worker/wrangler.toml` did not have a production route — added
   `[[env.production.routes]] pattern = "algosize.com/api/*"` (commit
   `01ce181`, Task #54).
2. A stale root-level `wrangler.jsonc` from the
   `cloudflare/workers-autoconfig` autoconfig branch was overriding
   `worker/wrangler.toml` when `wrangler` ran from `worker/`. Removed it
   (same commit).
3. Production D1 had never been created — `database_id` in
   `wrangler.toml` was the placeholder `00000000-…-000000000000`,
   so every CI deploy of `algosize` failed with Cloudflare error
   `10181 D1 binding 'DB' references database … which was not found`,
   which is why the route never bound. Created the D1 via the CF API
   (uuid `cfe388b1-8423-48ec-b1ec-358e3a8127d8`), applied
   `worker/migrations/0001_init.sql` against it (`users`, `runs`,
   indexes), and patched `wrangler.toml` with the real uuid (commit
   `6be379b`).
4. Worker had zero secrets set in production. Generated a 64-char
   `JWT_SECRET` and uploaded via `wrangler secret put`. The "Secret
   Change" deploy unbound runtime config briefly; a fresh
   `wrangler deploy --env production` re-bound everything in one step
   (D1, KV, SANDBOX service, route).

Verified live (cookie-jar end-to-end):
- `POST /api/signup` (free) → 201 + session cookie + D1 row
- `POST /api/signup` (duplicate email) → 409 `email_taken`
- `GET  /api/me` → 200 with plan/quota
- `GET  /api/runs` → 200 `{items:[],nextCursor:null}`
- `POST /api/analyze/vuln` → 200 with findings
- `POST /api/analyze/cost` / `/algo` → 400 with proper input-validation
  errors (correct behaviour for malformed input — the gating works)

## Magic-link auth + admin email list (2026-05-10)

Replaced the immediate-session free signup with verified email auth and added an
admin-only roster page.

- **Magic-link auth.** New `worker/src/handlers/auth_magic.js` with two routes:
  - `POST /api/auth/request-link` — accepts `{email}`, mints a 32-byte
    base64url token, stores `magic:<token>` in `SESSIONS` KV (15-min TTL,
    payload `{email, createdAt}`), and emails a sign-in link via the existing
    `sendTransactional` pipe (fire-and-forget on `ctx.waitUntil`). Always
    returns `200 {ok, message, ttlMinutes}` regardless of whether the email
    is on file (no account enumeration). Rate-limited via the existing
    `signupRateLimit` bucket (10/min/IP).
  - `GET /api/auth/verify?token=…` — single-use: deletes the token before
    issuing the session so a re-clicked link can never mint two cookies.
    Calls `getUserByEmail` → `createFreeUser` if missing → `issueJWT` +
    `buildSessionCookie` → `302 /dashboard/`. Bad/expired/missing tokens
    `302 /?auth=expired_or_invalid|missing_token|server_error` with NO
    cookie set.
  - New `magicLinkEmail({email, verifyUrl, ttlMinutes})` template in
    `worker/src/email/templates.js` (text + HTML, same `shellHtml` shell as
    the welcome email).
- **Admin endpoints + middleware.** New `worker/src/handlers/admin.js`:
  - `requireAdmin` composes on top of `requireAuth`; non-admins get 403.
    Allowlist parsed from `env.ADMIN_EMAILS` (comma-separated, trim +
    lowercase, tolerates whitespace and casing).
  - `GET /api/admin/users` — JSON `{count, items[]}` with userId, email,
    plan, subStatus, stripeCustomerId, createdAt, updatedAt, ordered by
    `created_at DESC`.
  - `GET /api/admin/users.csv` — `text/csv; charset=utf-8` with
    `content-disposition: attachment; filename="algosize-users-YYYY-MM-DD.csv"`.
    CSV escaping handles commas, quotes, and newlines per RFC 4180. Timestamps
    rendered as ISO 8601 UTC.
- **Frontend.** `site/index.html` Starter form now reads "Email me a sign-in
  link →" and "We'll email you a one-time link to verify your address."
  `site/assets/js/checkout.js` posts to `/api/auth/request-link` and shows
  "Check your inbox" in place of the old immediate redirect. New
  `site/admin.html` (permalink `/admin/`, `sitemap: false`) renders the user
  table with Refresh + Download CSV buttons; `site/assets/js/admin.js` calls
  `/api/admin/users`, bounces 401 → `/?auth=required`, shows a friendly
  "Access denied" panel on 403, and points the CSV button at
  `/api/admin/users.csv`.
- **Config.** `worker/wrangler.toml` adds `ADMIN_EMAILS =
  "guillaumelauzier@gmail.com"` to `[vars]`, `[env.production.vars]`, and
  `[env.staging.vars]`. No new KV namespace, no new D1 table — magic tokens
  reuse `SESSIONS` KV with the `magic:` prefix.
- **Coverage.** `worker/scripts/test-magic-link.mjs` (29 assertions: input
  validation, token storage shape + TTL, KV key prefix, email normalization,
  enumeration safety, single-use deletion, replay rejection, cookie issuance,
  user create-or-reuse) and `worker/scripts/test-admin.mjs` (22 assertions:
  401/403/passthrough gating, allowlist parsing, JSON shape + ordering, CSV
  headers + escaping + ISO timestamps + filename). Full suite now 16 files,
  679 assertions, all green.
- **Note on prod.** This is Cloudflare-only — to go live: redeploy the worker
  (`cd worker && wrangler deploy --env production`), then verify
  `GOOGLE_SERVICE_ACCOUNT_JSON` is set as a Worker secret so the magic-link
  send goes out through Gmail. Without it, `sendTransactional` no-ops and
  the user sees "check your inbox" but never receives the email.

## Google OAuth sign-in (2026-05-10)

Added "Sign in with Google" alongside the magic-link flow. Both options
co-exist on the Starter pricing card; either one mints the same session
cookie via `issueJWT` + `buildSessionCookie`.

- **Worker:** new `worker/src/handlers/auth_google.js` exposes
  `GET /api/auth/google/start` (mints a 32-byte CSRF state, stores
  `gstate:<state>` in `SESSIONS` KV with a 10-min TTL, redirects to
  Google's consent screen with `scope=openid email profile`,
  `prompt=select_account`) and `GET /api/auth/google/callback`
  (validates+consumes the state, exchanges the auth code at
  `oauth2.googleapis.com/token`, fetches `openidconnect.googleapis.com/v1/userinfo`,
  HARD-BLOCKS unverified emails with `?auth=email_not_verified`,
  finds-or-creates the user via `getUserByEmail`/`createFreeUser`,
  issues the session cookie, 302s to `/dashboard/`). Wired in
  `worker/src/index.js` behind the existing `signupRateLimit`
  (10/min/IP) for `/start` and a dedicated `google_cb` bucket
  (30/min/IP) for `/callback`.
- **Frontend:** `site/index.html` Starter card gets a divider +
  white "Sign in with Google" button (`href="/api/auth/google/start"`)
  below the magic-link form. New `site/assets/js/auth-banner.js`
  reads `?auth=<code>` on the homepage and renders a friendly
  banner mapping each error code (e.g. `email_not_verified`,
  `google_token_failed`, `expired_or_invalid`) to user-facing copy,
  then strips the param via `history.replaceState`. Banner styles
  + button styles in `site/assets/css/main.css`
  (`.signup-divider`, `.btn-google`, `.auth-banner.error/info`).
- **Secrets.** New required secrets `GOOGLE_CLIENT_ID` +
  `GOOGLE_CLIENT_SECRET` (documented at the bottom of
  `worker/wrangler.toml`). When unset, `/api/auth/google/start`
  redirects to `/?auth=google_not_configured` and the rest of the
  worker keeps working — only the Google option is disabled.
- **Production routing.** Worker is now exposed at
  `https://algosize.guillaumelauzier.workers.dev` (the default
  workers.dev subdomain). `[env.production.vars] SITE_ORIGIN`
  updated to match so OAuth `redirect_uri` round-trips through
  the same origin and CORS / cookie scope line up. The
  `algosize.com/api/*` route binding is kept in case the custom
  domain is reactivated — when that happens, swap `SITE_ORIGIN`
  back to `https://algosize.com` and add that hostname as an
  authorized redirect URI in Google Cloud Console.
- **Coverage.** `worker/scripts/test-google-oauth.mjs` (23
  assertions: state stored in KV, state is single-use,
  `email_verified=false` is hard-blocked, no cookie issued on
  unverified email, error-param passthrough, missing-code rejection,
  not-configured fast-path, successful flow mints the cookie and
  redirects to `/dashboard/`). Wired into `cd worker && npm test`.

## Deploy steps for the workers.dev rollout

1. In **https://console.cloud.google.com/apis/credentials**, create
   an OAuth 2.0 Client ID (Web application) and add this exact
   authorized redirect URI:
   ```
   https://algosize.guillaumelauzier.workers.dev/api/auth/google/callback
   ```
2. Set the secrets on the production Worker:
   ```
   cd worker
   wrangler secret put GOOGLE_CLIENT_ID     --env production
   wrangler secret put GOOGLE_CLIENT_SECRET --env production
   ```
3. Deploy:
   ```
   wrangler deploy --env production
   ```
4. Smoke-test:
   ```
   curl -sI https://algosize.guillaumelauzier.workers.dev/api/auth/google/start
   # → 302 Location: https://accounts.google.com/o/oauth2/v2/auth?…
   ```

Still TODO (not blocking the dashboard):
- `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_ID` —
  required only for paid signup + the Stripe webhook.
- `OPENAI_API_KEY` — analyzers fall back to a stub when missing
  (per `worker/src/analyzers/llm.js`); set this to enable AI savings
  suggestions on the cost/vuln/algo pages.
- `SENTRY_DSN` — observability only; everything works without it.
