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
  "providerId": "akamai-linode",
  "providerName": "Akamai Connected Cloud (Linode)",
  "category": "cloud",
  "billingModel": "plan",
  "currency": "USD",
  "catalogVersion": "2026.08.20-1",
  "effectiveDate": "2026-08-01",
  "lastVerified": "2026-08-20",
  "verificationStatus": "unverified-seed",
  "verificationNotes": "Added from a secondhand pricing pull dated 2026-08-19, not independently opened by a human against the source URL. One plan row (a purported 32 GiB tier) was visibly truncated/corrupted in that first pull — it arrived containing non-Latin garbage characters where a number should be — and was dropped rather than guessed at. A second, independent pull dated 2026-08-20 gave IDENTICAL figures for every row the first pull got intact (linode-1gb through linode-16gb), and additionally supplied linode-32gb and linode-64gb following the same doubling pattern (price, vCPU and memory each roughly double per tier) — consistent enough to add those two rows below. This is cross-pull corroboration, not verification: nobody on this side has opened akamai.com/cloud/pricing and checked a row against it, so verificationStatus stays unverified-seed. The same second pull's Vultr figures directly CONTRADICTED its own first pull for an equivalent-looking SKU (4 vCPU/8 GiB: $75/mo vs $48/mo) — a concrete reminder that agreement across two pulls is reassuring but not proof, and that this whole pipeline can still be wrong. planBillingCapHours is deliberately UNSET (see limitations): the pulled hourly-rate figures did not divide cleanly out of the monthly prices at any consistent cap-hours value the way DigitalOcean's do, which is a sign those hourly figures may themselves be unreliable — so they were discarded rather than stored, and the engine's default 730-hour (full calendar month) cap is used instead, pending real verification.",
  "sourceUrl": "https://www.akamai.com/cloud/pricing/north-america",
  "regions": [
    "north-america"
  ],
  "defaultRegion": "north-america",
  "limitations": [
    "Akamai/Linode sells whole instances ('Linodes'), not vCPU-hours. There is NO published per-vCPU or per-GiB price, so none is invented here — the plan price is billed and any CPU/RAM split is allocated by the estimator.",
    "The exact hourly-billing monthly cap (DigitalOcean's is 672 hours, Hetzner's is 730) has not been confirmed for Linode from an official source, so planBillingCapHours is left unset and the engine's 730-hour default applies. This is an assumption, not a confirmed figure.",
    "minimumBillableSeconds has not been confirmed from an official source and is left unset, so no minimum-duration floor is applied to Linode estimates. This likely understates true cost on a very short run.",
    "Pricing is shown for the North America region grouping only; Linode's actual pricing varies by specific region within that grouping, which is not modelled.",
    "Only standard shared-CPU plans are modelled. Dedicated CPU, High Memory, and Premium plans are absent.",
    "Storage and egress overage beyond the plan's included amounts have no confirmed per-GiB price and are not modelled — no `dimensions` block is present, so an estimate that exceeds the included transfer will not show an overage line for this provider.",
    "GPU plan rates (see gpuPlans below) are catalog reference data only. engine.js unconditionally reports any GPU resource as unsupported regardless of catalog content — these rows are not yet priced by an estimate."
  ],
  "plans": [
    {
      "sku": "linode-1gb",
      "displayName": "Linode 1 GB — 1 vCPU / 1 GiB",
      "resourceType": "compute",
      "vcpu": 1,
      "memoryGiB": 1,
      "includedStorageGiB": 25,
      "includedEgressGiB": 1024,
      "priceMicroUsdPerMonth": 5000000,
      "sourceUrl": "https://www.akamai.com/cloud/pricing/north-america"
    },
    {
      "sku": "linode-2gb",
      "displayName": "Linode 2 GB — 1 vCPU / 2 GiB",
      "resourceType": "compute",
      "vcpu": 1,
      "memoryGiB": 2,
      "includedStorageGiB": 50,
      "includedEgressGiB": 2048,
      "priceMicroUsdPerMonth": 12000000,
      "sourceUrl": "https://www.akamai.com/cloud/pricing/north-america"
    },
    {
      "sku": "linode-4gb",
      "displayName": "Linode 4 GB — 2 vCPU / 4 GiB",
      "resourceType": "compute",
      "vcpu": 2,
      "memoryGiB": 4,
      "includedStorageGiB": 80,
      "includedEgressGiB": 4096,
      "priceMicroUsdPerMonth": 24000000,
      "sourceUrl": "https://www.akamai.com/cloud/pricing/north-america"
    },
    {
      "sku": "linode-8gb",
      "displayName": "Linode 8 GB — 4 vCPU / 8 GiB",
      "resourceType": "compute",
      "vcpu": 4,
      "memoryGiB": 8,
      "includedStorageGiB": 160,
      "includedEgressGiB": 5120,
      "priceMicroUsdPerMonth": 48000000,
      "sourceUrl": "https://www.akamai.com/cloud/pricing/north-america"
    },
    {
      "sku": "linode-16gb",
      "displayName": "Linode 16 GB — 6 vCPU / 16 GiB",
      "resourceType": "compute",
      "vcpu": 6,
      "memoryGiB": 16,
      "includedStorageGiB": 320,
      "includedEgressGiB": 8192,
      "priceMicroUsdPerMonth": 96000000,
      "sourceUrl": "https://www.akamai.com/cloud/pricing/north-america"
    },
    {
      "sku": "linode-32gb",
      "displayName": "Linode 32 GB — 8 vCPU / 32 GiB",
      "resourceType": "compute",
      "vcpu": 8,
      "memoryGiB": 32,
      "includedStorageGiB": 640,
      "includedEgressGiB": 16384,
      "priceMicroUsdPerMonth": 192000000,
      "sourceUrl": "https://www.akamai.com/cloud/pricing/north-america"
    },
    {
      "sku": "linode-64gb",
      "displayName": "Linode 64 GB — 16 vCPU / 64 GiB",
      "resourceType": "compute",
      "vcpu": 16,
      "memoryGiB": 64,
      "includedStorageGiB": 1280,
      "includedEgressGiB": 20480,
      "priceMicroUsdPerMonth": 384000000,
      "sourceUrl": "https://www.akamai.com/cloud/pricing/north-america"
    }
  ],
  "gpuPlans": {
    "note": "Reference data only. engine.js currently treats every GPU resource as unsupported regardless of catalog content — these rows are not yet priced by an estimate.",
    "verificationStatus": "unverified-seed",
    "pricedByEngine": false,
    "plans": [
      {
        "id": "gpu-rtx4000-ada-small",
        "gpuType": "NVIDIA RTX 4000 Ada",
        "gpuCount": 1,
        "vcpu": 4,
        "memoryGiB": 16,
        "gpuMemoryGiB": 20,
        "storageGiB": 512,
        "monthlyUsd": 350,
        "hourlyUsd": 0.52
      },
      {
        "id": "gpu-quadro-rtx6000-small",
        "gpuType": "NVIDIA Quadro RTX 6000",
        "gpuCount": 1,
        "vcpu": 8,
        "memoryGiB": 32,
        "gpuMemoryGiB": 24,
        "storageGiB": 640,
        "monthlyUsd": 1000,
        "hourlyUsd": 1.5
      },
      {
        "id": "gpu-rtx-pro-6000-blackwell",
        "gpuType": "NVIDIA RTX PRO 6000 Blackwell Server Edition",
        "gpuCount": 1,
        "vcpu": 16,
        "memoryGiB": 176,
        "gpuMemoryGiB": 96,
        "storageGiB": 1024,
        "monthlyUsd": 1665,
        "hourlyUsd": 2.5
      }
    ]
  }
});
