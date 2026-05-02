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

## Deployment

See `DEPLOY.md` (added by Task #10) for the production checklist.
