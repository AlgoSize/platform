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
  "providerId": "hetzner",
  "providerName": "Hetzner Cloud",
  "category": "cloud",
  "billingModel": "plan",
  "currency": "USD",
  "catalogVersion": "2026.08.20-1",
  "effectiveDate": "2026-08-01",
  "lastVerified": "2026-08-19",
  "verificationStatus": "unverified-seed",
  "verificationNotes": "Plan prices are unchanged and remain unverified — a secondhand pull did not expose the full official plan table reliably, so no plan row below was touched. Only the billing-rule bullets in `limitations` were updated, sourced from docs.hetzner.com/cloud/billing/faq/ via the same secondhand pull; nobody on this side opened that page directly, so these remain claims to confirm, not verified facts.",
  "sourceUrl": "https://www.hetzner.com/cloud/",
  "regions": [
    "ash"
  ],
  "defaultRegion": "ash",
  "limitations": [
    "Hetzner sells whole servers, not vCPU-hours. There is NO published per-vCPU or per-GiB price, so none is invented here — the plan price is billed and any CPU/RAM split is allocated by the estimator.",
    "Hetzner lists prices in EUR for EU locations and USD for US locations. Only the USD-listed US location (Ashburn) is modelled, so no currency conversion is performed anywhere in this catalog.",
    "Hetzner applies a separate per-server IPv4 charge that is not modelled; primary IPv6 is reported to be free.",
    "Billing is hourly up to a monthly cap, like DigitalOcean; a partial hour is reported to round up to a full hour, which matches this catalog's existing minimumBillableSeconds of 3600.",
    "Servers are reported to continue billing while powered off.",
    "Only outgoing traffic is reported to be billable; incoming and internal traffic are free. Overage is reported to round up in 100MB blocks — this catalog does not yet model that rounding granularity, only a flat per-GiB overage rate.",
    "Backups are reported to cost 20% of the server's monthly plan price; not modelled as a priceable resource.",
    "Shared-vCPU (CX/CPX) lines only. Dedicated-vCPU (CCX) servers, volumes beyond the included disk, load balancers and snapshots are not modelled."
  ],
  "planBillingCapHours": 730,
  "plans": [
    {
      "sku": "cpx11",
      "displayName": "CPX11 — 2 vCPU / 2 GiB",
      "resourceType": "compute",
      "vcpu": 2,
      "memoryGiB": 2,
      "includedStorageGiB": 40,
      "includedEgressGiB": 20000,
      "priceMicroUsdPerMonth": 5590000,
      "sourceUrl": "https://www.hetzner.com/cloud/"
    },
    {
      "sku": "cpx21",
      "displayName": "CPX21 — 3 vCPU / 4 GiB",
      "resourceType": "compute",
      "vcpu": 3,
      "memoryGiB": 4,
      "includedStorageGiB": 80,
      "includedEgressGiB": 20000,
      "priceMicroUsdPerMonth": 9590000,
      "sourceUrl": "https://www.hetzner.com/cloud/"
    },
    {
      "sku": "cpx31",
      "displayName": "CPX31 — 4 vCPU / 8 GiB",
      "resourceType": "compute",
      "vcpu": 4,
      "memoryGiB": 8,
      "includedStorageGiB": 160,
      "includedEgressGiB": 20000,
      "priceMicroUsdPerMonth": 17490000,
      "sourceUrl": "https://www.hetzner.com/cloud/"
    },
    {
      "sku": "cpx41",
      "displayName": "CPX41 — 8 vCPU / 16 GiB",
      "resourceType": "compute",
      "vcpu": 8,
      "memoryGiB": 16,
      "includedStorageGiB": 240,
      "includedEgressGiB": 20000,
      "priceMicroUsdPerMonth": 30490000,
      "sourceUrl": "https://www.hetzner.com/cloud/"
    }
  ],
  "dimensions": {
    "storageGiBMonth": {
      "priceMicroUsd": 52000,
      "unit": "GiB-month",
      "sourceUrl": "https://www.hetzner.com/cloud/",
      "note": "Cloud Volumes, charged beyond the server's included disk."
    },
    "egressGiB": {
      "priceMicroUsd": 1200,
      "unit": "GiB",
      "sourceUrl": "https://www.hetzner.com/cloud/",
      "note": "Overage beyond the generous included transfer."
    },
    "ingressGiB": {
      "priceMicroUsd": 0,
      "unit": "GiB",
      "sourceUrl": "https://www.hetzner.com/cloud/",
      "note": "Inbound transfer is free."
    }
  },
  "minimumBillableSeconds": 3600
});
