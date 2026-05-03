# Algosize

Cut cloud spend, find vulnerabilities, and optimize critical algorithms.

## Layout

```
algosize/
├── site/      # Jekyll marketing site + dashboard (vanilla CSS, no frameworks)
├── worker/    # Cloudflare Worker API (auth, Stripe, analyzers)
├── shared/    # Constants and types used by both sides
└── README.md
```

## Local development

Run each side in its own terminal.

### Frontend (Jekyll)

```bash
cd site
bundle install
bundle exec jekyll serve --host 0.0.0.0 --port 5000 --livereload
```

The Replit `Start application` workflow runs this for you on port 5000.

### Worker (Cloudflare)

```bash
cd worker
npm install
npx wrangler dev    # http://localhost:8787
```

## Configuration

Copy `.env.example` to `.env` (for local notes — Cloudflare secrets are set
via `wrangler secret put`, not env files).

## Testing

- **Manual smoke test** — `TESTING.md` is the human-driven happy-path
  walkthrough (landing → checkout → dashboard → analyzers → logout).
- **Automated end-to-end** — `tests/e2e/` is a Playwright suite that runs
  the same happy path headlessly against `bundle exec jekyll serve` and
  `wrangler dev` (both spawned by the test runner). Run it locally with:

  ```bash
  cd tests/e2e
  npm install
  npx playwright install --with-deps chromium   # first run only
  npx playwright test
  ```

  The suite also runs in CI on every push / PR that touches `site/**`,
  `worker/**`, or `tests/e2e/**` — see `.github/workflows/e2e.yml`.

## Deployment

See `DEPLOY.md` (added by Task #10) for the production checklist.
