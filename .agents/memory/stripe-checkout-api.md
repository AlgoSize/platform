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

## Stripe catalog

The earlier `price_1U5j...` catalog was mislabeled as test mode; Stripe
confirmed those IDs are live-mode objects. Never use them for staging.

The actual test-mode staging catalog is on account `acct_1TcPgVFA2hGHNbZ5`:

Products: Solo `prod_V5yOyeK8wzCUe5` | Practice `prod_V5yObV5ha2k7mY` |
Firm `prod_V5yOS0F9p8HPJ2`

Prices:
- SOLO_MONTHLY          `price_1U5mRHFA2hGHNbZ5nmUfOxyB`  $49/mo
- SOLO_ANNUAL           `price_1U5mRHFA2hGHNbZ5RDEPWnjk`  $490/yr
- PRACTICE_MONTHLY      `price_1U5mRIFA2hGHNbZ5bf0PMVbE`  $149/mo
- PRACTICE_MONTHLY_SEAT `price_1U5mRIFA2hGHNbZ5McTbHSTw`  $39/mo
- PRACTICE_ANNUAL       `price_1U5mRIFA2hGHNbZ5fpaWFKKR`  $1490/yr
- PRACTICE_ANNUAL_SEAT  `price_1U5mRJFA2hGHNbZ5SP0TKVfG`  $390/yr
- FIRM_MONTHLY          `price_1U5mRJFA2hGHNbZ5ziFb85Gd`  $599/mo
- FIRM_ANNUAL           `price_1U5mRJFA2hGHNbZ5SSmcquE9`  $5990/yr

The staging Worker uses the eight tier bindings above plus
`STRIPE_PRICE_ID`, which aliases Solo monthly. The optional Firm seat prices
from the old note are not part of the established eight-binding staging set.

Webhook endpoints — STRIPE_WEBHOOK_SECRET uploaded to both Workers:
- Production we_1U5jUFFA2hGHNbZ5Fb0CzTIf → https://algosize.com/api/stripe/webhook
- Staging    we_1U5jUNFA2hGHNbZ51h7rg7b3 → https://staging.algosize.com/api/stripe/webhook

Customer Portal default config NOT created yet in test mode.
Must visit https://dashboard.stripe.com/test/settings/billing/portal and Save
before /api/billing/portal can create sessions.

## Test files

- `worker/scripts/test-stripe.mjs` — 28 tests, covers sig verification, body shape, per-seat lines, org metadata, tax params, unknown-tier rejection.
- `worker/scripts/test-orgs.mjs` — also calls createCheckoutSession directly; must pass `priceId` explicitly.
