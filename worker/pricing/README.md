# Pricing catalog

Every price the Infrastructure Cost Estimator uses lives here, and nowhere else.
No module under `src/estimator/` may contain a number denominated in money — a
rate inlined into business logic is a rate nobody updates when the provider
changes it, and the first symptom is a customer quoting our stale estimate back
at us.

## Current status: unverified seed

`verificationStatus` is `"unverified-seed"` in every file. These prices were
transcribed from the providers' public pricing pages but have **not** been
machine-verified against them, so nothing here should be presented as a quote.

The estimator already knows this. Any provider whose `verificationStatus` is not
`"verified"` gets a `stale_pricing_catalog` assumption attached to every estimate,
which widens the bounds by ±15% and forces `confidence` to `low`. Publishing an
unverified catalog is therefore visible to the user rather than silent.

**Before this feature is shown to customers, someone must verify each file and
flip its status.** That is the release gate, not a nice-to-have.

## Layout

```
pricing/
  catalog.js          index: catalog version, currency, provider list
  providers/
    aws.js            metered — real per-vCPU-hour and per-GiB-hour prices
    digitalocean.js   plan-billed — whole Droplets, no unit prices published
    hetzner.js        plan-billed — whole servers, no unit prices published
    akamai-linode.js  plan-billed — whole Linodes, no unit prices published
    vultr.js          plan-billed — two Cloud Compute SKUs only, deliberately thin
```

### Why these are `.js` and not `.json`

They were `.json` until the estimator was wired into the router, at which point
`wrangler dev` refused to build: importing JSON from an ES module needs an
import attribute, and there is no spelling that works in both places this code
runs. Node 22 accepts only `with { type: "json" }` (it removed `assert`); the
esbuild inside wrangler 3.78 accepted only `assert` (it predated `with`). A
plain attribute-less import works in esbuild and throws in Node.

That specific conflict is gone — wrangler 4 bundles an esbuild that speaks
`with`, so both sides would now agree on one spelling. The files stay `.js`
anyway, because the reason they are worth keeping was never the attribute: a
frozen object literal is what lets `scripts/test-estimator.mjs` prove the
catalog holds no logic, and `.json` would trade that proof for a file
extension.

So each file exports one frozen object literal instead, which needs no
attribute anywhere. **This is a packaging workaround, not permission to put
logic in the catalog.** `scripts/test-estimator.mjs` asserts every pricing
module is a single `export default Object.freeze(...)` whose contents parse as
JSON once unwrapped — if it parses as JSON it cannot contain a function or a
computed value, so the "inert data" property survives as a test rather than as
a file extension. Editing them is unchanged: they are still plain data, still
diff cleanly, still reviewable line by line.

### Providers deliberately NOT in this catalog

- **Scaleway** — the only pricing data sourced for it is EUR-denominated, and
  this catalog performs no currency conversion (see below). It stays out until
  a USD-priced page is found for it, the way `hetzner.js` only models
  Hetzner's one USD-listed US region and skips its EUR ones.
- **OVHcloud, Cloudflare Workers, Fly.io, Render, Railway, Lambda, RunPod** —
  no real sourced pricing has been added for any of these yet; only schema
  requirements have been discussed. Do not add a provider file with invented
  numbers or as an empty stub — wait until real prices are sourced.
- GPU pricing that DOES appear in `digitalocean.js` and `akamai-linode.js`
  (as `gpuPlans`) is catalog reference data only. `engine.js` unconditionally
  reports every GPU resource as unsupported regardless of what the catalog
  contains — pricing GPUs for real needs an engine change, not just data, and
  that change has not been made. Treat `gpuPlans` as inert until it has.

### `verificationNotes` — provenance, not a verification tier

Some provider files carry an optional `verificationNotes` string. It exists to
say *how* a number arrived without inflating `verificationStatus`, which stays
binary (`"verified"` or anything else) by design — see "Current status" above.
A cross-check (e.g. a pulled hourly rate that divides cleanly out of the
monthly price at the catalog's own cap-hours) is evidence, not verification;
`verificationNotes` is where that nuance is written down instead of being lost
or, worse, expressed by quietly flipping the status.

### Metered vs plan-billed — the distinction that matters

AWS Fargate genuinely publishes a per-vCPU-hour and a per-GiB-hour price, so
`aws.js` carries a `dimensions` block and the engine multiplies consumption by
those rates.

DigitalOcean and Hetzner sell **whole machines**. Neither publishes a per-vCPU or
per-GiB price, so neither file contains one. The engine prices the plan, then
emits the CPU and memory lines as `allocated: true` with a unit price of **zero**
and a `bundled_plan_allocation` assumption explaining that the plan line is the
billed figure.

> Do not "helpfully" add a derived per-vCPU rate to a plan-billed provider by
> dividing the plan price by its vCPU count. That number does not exist, the
> provider will not honour it, and a comparison table containing it invites a
> customer to size a fleet against a price nobody sells.

The catalog loader enforces the shape: a `plan`-billed provider must have
`plans`, a `metered` one must have `dimensions`, and a test asserts that neither
plan-billed file has acquired a `vcpuHour` key.

## Required fields

**`catalog.js`** — `schemaVersion`, `catalogVersion`, `currency`,
`effectiveDate`, `lastVerified`, `verificationStatus`, `providers`, `notice`.

**Each provider file** — `providerId`, `providerName`, `category`,
`billingModel`, `currency`, `catalogVersion`, `effectiveDate`, `lastVerified`,
`verificationStatus`, `sourceUrl`, `regions`, `defaultRegion`, `limitations`,
`minimumBillableSeconds`, and then either `plans` or `dimensions`.

**Each plan** — `sku`, `displayName`, `resourceType`, `vcpu`, `memoryGiB`,
`includedStorageGiB`, `includedEgressGiB`, `priceMicroUsdPerMonth`, `sourceUrl`.

**Each dimension** — `priceMicroUsd`, `unit`, `sourceUrl`, `note`.

All money is **integer micro-USD** (millionths of a dollar). `$0.04048` is
`40480`. Floating point is never used for money anywhere in this subsystem;
`$24.00/month` is `24000000`, exactly.

`currency` must be `"USD"`. The loader rejects anything else rather than
converting — a converted price is a price plus an exchange rate we did not
source, dated at a moment we did not record. This is why only Hetzner's
USD-listed US location is modelled and its EUR locations are not.

## Updating a price

1. Open the provider's public pricing page — the one in `sourceUrl`. Do not use
   a third-party aggregator or a cached copy.
2. Update the affected `priceMicroUsd*` values. Convert carefully: dollars ×
   1,000,000, and check the magnitude (a $24/month plan is `24000000`, not
   `24000` or `24000000000`).
3. Set `effectiveDate` to the date the provider's price took effect, and
   `lastVerified` to today.
4. Set `verificationStatus` to `"verified"` **only** if you actually opened the
   page and compared every entry in the file.
5. Bump `catalogVersion` in **both** `catalog.js` and every provider file. The
   loader refuses to start when they disagree, because a partially-updated
   catalog would mix price vintages inside a single comparison table.
6. Update `limitations` if the provider changed what is and is not included.
7. Run `node scripts/test-estimator.mjs`. Several tests assert exact totals
   (a full month of a `s-2vcpu-4gb` Droplet is exactly `$24.00`); a price change
   will fail them, and updating those expected values is part of the change.
8. Get the diff reviewed by someone who re-checks at least one price against the
   source URL independently. A silent typo here becomes a number a customer
   plans a budget around.

## What is deliberately not modelled

Committed-use discounts, reserved instances, savings plans, spot/preemptible
pricing, free tiers, support plans, per-account negotiated rates, currency
conversion, tax, and every managed service beyond raw compute/storage/egress.

Each provider file states its own gaps in `limitations`, and those strings are
returned with every estimate — so a caveat that is not written down is a caveat
the user never sees.
