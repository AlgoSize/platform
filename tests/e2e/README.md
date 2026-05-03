# Algosize end-to-end tests

Playwright suite that walks the full landing → checkout → dashboard →
analyzers → logout → blocked happy path against a locally booted Jekyll
site + wrangler dev Worker. It's the automated counterpart to the manual
checklist in [`TESTING.md`](../../TESTING.md) — see the
"automated coverage" notes there for which steps are covered.

## What it covers

| TESTING.md step | Spec                                | Notes |
|-----------------|-------------------------------------|-------|
| 1               | `tests/landing.spec.js`             | Landing renders, CTA form is wired to `/api/checkout` |
| 2               | `tests/landing.spec.js`             | CTA POSTs and follows the returned URL — **Stripe stubbed via `page.route()`** |
| 3               | _not covered_                       | Real Stripe Checkout — kept as a manual step |
| 4               | `tests/dashboard.spec.js`           | Synthetic session cookie unlocks `/dashboard/`; `/api/me` hydrates email + active pill |
| 5               | `tests/dashboard.spec.js`           | Cost analyzer Load sample → Run → stat cards + suggestion list |
| 6               | `tests/dashboard.spec.js`           | Vuln scanner Load sample → Run → AWS key + SQL + eval findings |
| 7               | `tests/dashboard.spec.js`           | Algo optimizer Load sample → Optimize → O(n²) detected |
| 8               | `tests/dashboard.spec.js`           | Sign out clears the cookie and bounces to `/` |
| 9               | `tests/dashboard.spec.js`           | Visiting `/dashboard/` without a session redirects to `/` |

## Run it locally

You need Ruby 3.2 + bundler (for Jekyll) and Node 20 + npm.

```bash
# one-time setup
cd worker && npm install && cd -
cd site   && bundle install && cd -
cd tests/e2e && npm install && npx playwright install --with-deps chromium

# run
cd tests/e2e && npm test
```

Playwright boots the Jekyll site on `http://localhost:5000` and the
Worker on `http://127.0.0.1:8787` automatically (see `playwright.config.js`
→ `webServer`). It also seeds a fresh local KV state into
`tests/e2e/.wrangler-state/` before the Worker starts (see
`global-setup.mjs`) so the dashboard can be unlocked with a synthetic
session cookie — no real Stripe round trip required.

## Running just one spec

```bash
cd tests/e2e
npx playwright test tests/landing.spec.js
npx playwright test tests/dashboard.spec.js
```

Add `--headed` to watch the browser, `--debug` to step through.

## CI

`.github/workflows/e2e.yml` runs this suite on every push to `main` and
on pull requests touching `site/**` or `worker/**`.

## Why not test real Stripe?

Stripe Checkout itself is third-party and rate-limited; running a full
test-mode round trip on every push would be flaky and slow. The Worker's
own Stripe wiring is covered by `worker/scripts/test-stripe.mjs` (sig
verification + checkout creation against a stubbed Stripe API). The
browser layer here only needs to prove the form intercepts, the POST
goes out, the JSON body is parsed, and `window.location.assign` follows
`body.url` — all of which are covered with a `page.route()` stub.
