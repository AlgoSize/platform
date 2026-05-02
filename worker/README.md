# worker/

Cloudflare Worker that powers the Algosize API: auth, Stripe, and the analyzer endpoints.

## Run locally

```bash
cd worker
npm install
npx wrangler dev
```

Worker listens on `http://localhost:8787`. The `Start application` Replit
workflow runs the Jekyll site on port 5000 — start the Worker separately
in a terminal when you need the API.

## Secrets

Set with `wrangler secret put <NAME>`:

- `STRIPE_SECRET_KEY`
- `STRIPE_WEBHOOK_SECRET`
- `STRIPE_PRICE_ID`
- `JWT_SECRET`
