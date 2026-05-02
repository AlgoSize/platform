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
- **Storage:** Cloudflare KV namespaces — `SESSIONS` (JWT TTL store), `USERS` (subscriber records).
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

## Status
Task #1 (monorepo init) complete: hello-world Jekyll page on port 5000 and a hello-world Worker handler in `worker/src/index.js`. Real product features arrive in tasks #2–#10.
