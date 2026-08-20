---
name: algosize.com infrastructure reference
description: Zone ID, Worker URLs, KV/D1 IDs, and routing architecture for the algosize project
---

## Cloudflare zone
- Zone ID: `fea17c77098e9db12200ab73acbc25f1`
- Nameservers: carter.ns.cloudflare.com / joan.ns.cloudflare.com (active)

## Worker
- Script name: `algosize` (both default env and [env.production] share the same name)
- workers.dev: `https://algosize.guillaumelauzier.workers.dev`
- Zone route: `algosize.com/api/*` → script `algosize`
- Cron: `0 3 * * *`; Queue consumer: `algosize-scans`

## Origin architecture
- `algosize.com/*` (non-API) → GitHub Pages (proxied through Cloudflare orange-cloud)
- `algosize.com/api/*` → Cloudflare Workers zone route

**Why:** The root wrangler.jsonc defines `algosize-site` (Workers Assets for the Jekyll build) — this is a separate site Worker, NOT the API Worker. The API Worker lives in worker/wrangler.toml. Every wrangler command for the API Worker must be run from worker/ with --config wrangler.toml to avoid the root wrangler.jsonc shadow.

## Key IDs
- D1 production: `cfe388b1-8423-48ec-b1ec-358e3a8127d8` (database name: algosize)
- SESSIONS KV: `2a67b8b8fa4444f2b04b4ee7b98407dc`
- USERS KV: `b321f8eeccf0422694b87f719fa0d70c`
- R2: `algosize-reports` (production), `algosize-reports-staging` (staging)
- Queues: `algosize-scans` / `algosize-scans-staging` (+ -dlq variants)

## Deploy gotcha — propagation delay
After `wrangler deploy --env production`, the zone route takes ~2 minutes to propagate. A bare Cloudflare 404 immediately post-deploy is normal; wait and retry before diagnosing further.

## Workers Builds recovery state
The Workers Builds triggers attached to the `algosize` external script have been removed after they repeatedly replaced or attempted to replace the API service. The account-level GitHub connection remains separate and was not modified.

**Why:** A correct `algosize.com/api/*` route can still serve static-site HTML when the `algosize` service's active code version has been replaced; route specificity alone does not protect against a wrong bundle deployed into the API service.

**How to apply:** Before relying on Workers Builds, verify the per-script trigger list rather than assuming the account-level connection is harmless. After any API recovery deploy, verify several unauthenticated `/api/me` responses, not just one.

## Secrets on the production Worker
JWT_SECRET, STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, STRIPE_PRICE_ID, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET — all set as of 2026-08-18.

Replit's current secret store can serve as the recovery source for existing Stripe
values: pass `$STRIPE_SECRET_KEY`, `$STRIPE_WEBHOOK_SECRET`, and `$STRIPE_PRICE_ID`
to `wrangler secret put` without printing them. A newly uploaded JWT may briefly
produce a 500 at the API route before propagation; retrying after propagation
returned the expected 401 for a request without a token.

The configured Wrangler token cannot list or delete production KV keys, but the
added Cloudflare connector can read them. Use the connector for temporary admin
magic-token discovery; do not print the token. The verification session cleanup
path may return `invalid_token`, so confirm the session state before reusing this
flow.

Stripe's API does not return an existing webhook endpoint's signing secret.
Production secret health can be checked without exposing it by signing a harmless
unknown event with the configured secret and confirming the Worker returns 200.

Workers Builds metadata and logs may return Cloudflare code 10000 to the
workspace API token even when the added Cloudflare connector can read the same
build routes. Use the connector for build-log diagnosis when direct API access
is denied.

## Secret binding names
Price IDs must be Cloudflare secrets rather than `[env.*.vars]` entries. Cloudflare rejects `secret put` when a deployed plaintext var already uses the same binding name, so remove the vars and redeploy before uploading same-named secrets.

**Why:** The API Worker needs the eight tier price IDs protected as secrets, and Cloudflare treats a plaintext binding and secret with the same name as a conflict.

**How to apply:** Always pass `--config wrangler.toml` for API Worker secret operations; the parent config can target the separate site Worker.
