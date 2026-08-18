---
name: Stripe checkout API contract
description: createCheckoutSession signature and POST /api/checkout field names after the generalisation refactor
---

## createCheckoutSession (worker/src/stripe.js)

Accepts `{ priceId, seatPriceId, quantity, orgId, trialDays, successUrl, cancelUrl, customerEmail }`.
Does NOT accept `plan` or `interval` — callers must resolve prices first with `resolvePrice()`.

**Why:** Separating resolution from session creation lets the checkout handler validate and reject bad tiers with a precise 400 before making any outbound call. A function that accepts plan+interval internally could silently fall through to a wrong price.

Always includes `automatic_tax[enabled]=true` and `customer_update[address]=auto` (required for Stripe Tax).

## POST /api/checkout request body

Canonical field: `tier` (e.g. `"solo"`, `"practice"`, `"firm"`).
Legacy alias: `plan` — accepted for backward compat via `body.tier ?? body.plan`.
Other fields: `seats` (integer), `interval` (`"monthly"` | `"annual"`), `orgId` (optional string).

Unknown or unconfigured tiers always return 400 `plan_not_available` — never 503, never silent fallthrough.

## resolvePrice (worker/src/stripe.js)

Reads env vars `STRIPE_PRICE_<PLAN>_<INTERVAL>` and `STRIPE_PRICE_<PLAN>_<INTERVAL>_SEAT`.
Interval key suffix is `MONTHLY` or `ANNUAL` (not YEARLY).
Returns `{ base, seat, perSeat }` or `null` for unconfigured/unknown.

## Test-mode product catalog (created 2026-08-18)

Products: Solo prod_V5vJByyVzDuaen | Practice prod_V5vJcC1hpf72yW (14d trial) | Firm prod_V5vJen7tpRrIe5 (14d trial)

Prices (account acct_1TcPgVFA2hGHNbZ5):
- SOLO_MONTHLY          price_1U5jTEFA2hGHNbZ5NfvGfNfk  $49/mo
- SOLO_ANNUAL           price_1U5jTFFA2hGHNbZ5Un2v2HwX  $490/yr
- PRACTICE_MONTHLY      price_1U5jTHFA2hGHNbZ5YE2aj50K  $149/mo
- PRACTICE_ANNUAL       price_1U5jTIFA2hGHNbZ5XFx4ldqK  $1490/yr
- PRACTICE_MONTHLY_SEAT price_1U5jTKFA2hGHNbZ5b14jztio  $39/mo
- PRACTICE_ANNUAL_SEAT  price_1U5jTLFA2hGHNbZ5XlBm9Nia  $390/yr
- FIRM_MONTHLY          price_1U5jTNFA2hGHNbZ50LekndBp  $599/mo
- FIRM_ANNUAL           price_1U5jTOFA2hGHNbZ5T38KlYFr  $5990/yr
- FIRM_MONTHLY_SEAT     price_1U5jTQFA2hGHNbZ5q6xmEDjY  $29/mo
- FIRM_ANNUAL_SEAT      price_1U5jTRFA2hGHNbZ5NeqO6SWq  $290/yr

Webhook endpoints — STRIPE_WEBHOOK_SECRET uploaded to both Workers:
- Production we_1U5jUFFA2hGHNbZ5Fb0CzTIf → https://algosize.com/api/stripe/webhook
- Staging    we_1U5jUNFA2hGHNbZ51h7rg7b3 → https://staging.algosize.com/api/stripe/webhook

Customer Portal default config NOT created yet in test mode.
Must visit https://dashboard.stripe.com/test/settings/billing/portal and Save
before /api/billing/portal can create sessions.

## Test files

- `worker/scripts/test-stripe.mjs` — 28 tests, covers sig verification, body shape, per-seat lines, org metadata, tax params, unknown-tier rejection.
- `worker/scripts/test-orgs.mjs` — also calls createCheckoutSession directly; must pass `priceId` explicitly.
