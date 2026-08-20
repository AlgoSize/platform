// Pricing data — an ES module, NOT a .json file, and deliberately so.
//
// This is data, not code: a single default-exported frozen literal, with no
// imports, no functions and nothing computed. scripts/test-estimator.mjs
// asserts that structurally, so the guarantee JSON gave us syntactically is
// now given by a test instead.
//
// WHY NOT .json: importing JSON from an ES module requires an import
// attribute, and there is no spelling of that attribute which works in both
// places this code has to run. Node 22 accepts only `with { type: "json" }`
// (it removed `assert`); the esbuild bundled with wrangler 3.78 accepts only
// `assert` (it predates `with`). A plain attribute-less import works in
// esbuild and throws in Node. So the catalog would build for the Worker or
// run under the tests, never both — until the estimator was actually wired
// into the router, nothing imported it and the conflict stayed invisible.
// Exporting the same literal from a .js module needs no attribute anywhere.

export default Object.freeze({
  "providerId": "vultr",
  "providerName": "Vultr",
  "category": "cloud",
  "billingModel": "plan",
  "currency": "USD",
  "catalogVersion": "2026.08.20-1",
  "effectiveDate": "2026-08-01",
  "lastVerified": "2026-08-19",
  "verificationStatus": "unverified-seed",
  "verificationNotes": "Added from a secondhand pricing pull dated 2026-08-19, not independently opened by a human against the source URL. Only two plans arrived as clean, unambiguous official-page rows — the pull's other Vultr figures conflicted with each other across several distinct Vultr product lines (Regular Cloud Compute, High Performance, High Frequency, Optimized, VX1, bare metal) and were discarded rather than guessed at. This is deliberately a minimal 2-SKU catalog pending more official rows; do not treat its thinness as a bug to silently pad with unconfirmed numbers.",
  "sourceUrl": "https://www.vultr.com/pricing/",
  "regions": [
    "global"
  ],
  "defaultRegion": "global",
  "limitations": [
    "Only two Cloud Compute plans are modelled — this is a partial catalog, not a representative slice of Vultr's full lineup. Optimized Cloud Compute, High Frequency Compute, High Performance, VX1, and bare metal are entirely absent.",
    "Vultr sells whole instances, not vCPU-hours. There is NO published per-vCPU or per-GiB price, so none is invented here — the plan price is billed and any CPU/RAM split is allocated by the estimator.",
    "The exact hourly-billing monthly cap has not been confirmed for Vultr from an official source, so planBillingCapHours is left unset and the engine's 730-hour default applies. This is an assumption, not a confirmed figure.",
    "minimumBillableSeconds has not been confirmed from an official source and is left unset, so no minimum-duration floor is applied to Vultr estimates.",
    "Region-specific pricing is not modelled; a single global figure is used regardless of the region requested.",
    "Storage and egress overage beyond the plan's included amounts have no confirmed per-GiB price and are not modelled — no `dimensions` block is present."
  ],
  "plans": [
    {
      "sku": "vc2-1c-1gb",
      "displayName": "Cloud Compute — 1 vCPU / 1 GiB",
      "resourceType": "compute",
      "vcpu": 1,
      "memoryGiB": 1,
      "includedStorageGiB": 25,
      "includedEgressGiB": 1024,
      "priceMicroUsdPerMonth": 6000000,
      "sourceUrl": "https://www.vultr.com/pricing/"
    },
    {
      "sku": "vc2-4c-8gb",
      "displayName": "Cloud Compute — 4 vCPU / 8 GiB",
      "resourceType": "compute",
      "vcpu": 4,
      "memoryGiB": 8,
      "includedStorageGiB": 150,
      "includedEgressGiB": 4096,
      "priceMicroUsdPerMonth": 75000000,
      "sourceUrl": "https://www.vultr.com/pricing/"
    }
  ]
});
