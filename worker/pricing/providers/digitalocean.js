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
  "providerId": "digitalocean",
  "providerName": "DigitalOcean",
  "category": "cloud",
  "billingModel": "plan",
  "currency": "USD",
  "catalogVersion": "2026.08.20-1",
  "effectiveDate": "2026-08-01",
  "lastVerified": "2026-08-19",
  "verificationStatus": "unverified-seed",
  "verificationNotes": "Not independently fetched by a human against the source URL in this pass — this session's egress to digitalocean.com is blocked. The six Basic Droplet monthly prices below were cross-checked against a secondhand pricing pull dated 2026-08-19: every hourly figure in that pull divides out of the monthly price at exactly 672 hours (e.g. $24.00 / 672h = $0.03571/hr), which matches this catalog's existing planBillingCapHours and is internally consistent rather than arbitrary — real corroboration, but not a substitute for someone opening digitalocean.com/pricing/droplets and checking. Do not flip verificationStatus to \"verified\" on this basis alone.",
  "sourceUrl": "https://www.digitalocean.com/pricing/droplets",
  "regions": [
    "nyc3"
  ],
  "defaultRegion": "nyc3",
  "limitations": [
    "DigitalOcean sells whole Droplets, not vCPU-hours. There is NO published per-vCPU or per-GiB price, so this catalog does not invent one — the plan price is the billed figure and the CPU/RAM split shown against it is allocated by the estimator, not charged by DigitalOcean.",
    "Billing is hourly up to a monthly cap: a Droplet running the whole month costs the monthly price, never more, which is why hourly here is the monthly price divided by the cap hours.",
    "Only Basic (shared-CPU) Droplets are modelled. Premium Intel/AMD, CPU-Optimized, Memory-Optimized and Storage-Optimized lines are absent.",
    "Included transfer is pooled across all Droplets on the account; this catalog applies it per-estimate, which is conservative for a single Droplet and optimistic for many.",
    "Managed databases, load balancers, Spaces and snapshots are not modelled.",
    "DigitalOcean is reported to bill per-second (minimum 60 seconds or $0.01, whichever is higher) effective 2026-01-01, and to keep billing a Droplet while it is powered off. This catalog's engine models the 60-second duration floor via minimumBillableSeconds, but does NOT yet model a separate $0.01-per-resource dollar floor — an estimate for a very short, very cheap run could fall below that floor unflagged. Not independently confirmed against docs.digitalocean.com; treat as unverified pending a direct check.",
    "Snapshot and backup pricing (see additionalProducts below) are recorded as catalog reference data only. There is no snapshot/backup resource type in the normalized spec, so the engine does not price them — they cannot appear on an estimate today.",
    "GPU Droplet rates (see gpuPlans below) are recorded as catalog reference data only. engine.js unconditionally reports any GPU resource as unsupported regardless of catalog content, so these rows are not yet priced by an estimate — wiring them up is a separate, not-yet-done engine change."
  ],
  "planBillingCapHours": 672,
  "plans": [
    {
      "sku": "basic-512mb",
      "displayName": "Basic Droplet — 1 vCPU / 0.5 GiB",
      "resourceType": "compute",
      "vcpu": 1,
      "memoryGiB": 0.5,
      "includedStorageGiB": 10,
      "includedEgressGiB": 500,
      "priceMicroUsdPerMonth": 4000000,
      "sourceUrl": "https://www.digitalocean.com/pricing/droplets"
    },
    {
      "sku": "s-1vcpu-1gb",
      "displayName": "Basic Droplet — 1 vCPU / 1 GiB",
      "resourceType": "compute",
      "vcpu": 1,
      "memoryGiB": 1,
      "includedStorageGiB": 25,
      "includedEgressGiB": 1000,
      "priceMicroUsdPerMonth": 6000000,
      "sourceUrl": "https://www.digitalocean.com/pricing/droplets"
    },
    {
      "sku": "basic-2gb",
      "displayName": "Basic Droplet — 1 vCPU / 2 GiB",
      "resourceType": "compute",
      "vcpu": 1,
      "memoryGiB": 2,
      "includedStorageGiB": 50,
      "includedEgressGiB": 2000,
      "priceMicroUsdPerMonth": 12000000,
      "sourceUrl": "https://www.digitalocean.com/pricing/droplets"
    },
    {
      "sku": "s-2vcpu-2gb",
      "displayName": "Basic Droplet — 2 vCPU / 2 GiB",
      "resourceType": "compute",
      "vcpu": 2,
      "memoryGiB": 2,
      "includedStorageGiB": 60,
      "includedEgressGiB": 3000,
      "priceMicroUsdPerMonth": 18000000,
      "sourceUrl": "https://www.digitalocean.com/pricing/droplets"
    },
    {
      "sku": "s-2vcpu-4gb",
      "displayName": "Basic Droplet — 2 vCPU / 4 GiB",
      "resourceType": "compute",
      "vcpu": 2,
      "memoryGiB": 4,
      "includedStorageGiB": 80,
      "includedEgressGiB": 4000,
      "priceMicroUsdPerMonth": 24000000,
      "sourceUrl": "https://www.digitalocean.com/pricing/droplets"
    },
    {
      "sku": "s-4vcpu-8gb",
      "displayName": "Basic Droplet — 4 vCPU / 8 GiB",
      "resourceType": "compute",
      "vcpu": 4,
      "memoryGiB": 8,
      "includedStorageGiB": 160,
      "includedEgressGiB": 5000,
      "priceMicroUsdPerMonth": 48000000,
      "sourceUrl": "https://www.digitalocean.com/pricing/droplets"
    },
    {
      "sku": "s-8vcpu-16gb",
      "displayName": "Basic Droplet — 8 vCPU / 16 GiB",
      "resourceType": "compute",
      "vcpu": 8,
      "memoryGiB": 16,
      "includedStorageGiB": 320,
      "includedEgressGiB": 6000,
      "priceMicroUsdPerMonth": 96000000,
      "sourceUrl": "https://www.digitalocean.com/pricing/droplets"
    }
  ],
  "dimensions": {
    "storageGiBMonth": {
      "priceMicroUsd": 100000,
      "unit": "GiB-month",
      "sourceUrl": "https://www.digitalocean.com/pricing/block-storage",
      "note": "Block Storage volumes, charged beyond the Droplet's included disk."
    },
    "egressGiB": {
      "priceMicroUsd": 10000,
      "unit": "GiB",
      "sourceUrl": "https://www.digitalocean.com/pricing/droplets",
      "note": "Overage beyond the plan's included transfer."
    },
    "ingressGiB": {
      "priceMicroUsd": 0,
      "unit": "GiB",
      "sourceUrl": "https://www.digitalocean.com/pricing/droplets",
      "note": "Inbound transfer is free."
    }
  },
  "minimumBillableSeconds": 60,
  "additionalProducts": {
    "note": "Reference data only — not modelled as a priceable resource in the normalized spec, so none of this is wired into estimateInfrastructureCost().",
    "verificationStatus": "unverified-seed",
    "snapshotPriceMicroUsdPerGiBMonth": 60000,
    "backupWeeklyPercentOfDropletPrice": 20,
    "backupDailyPercentOfDropletPrice": 30
  },
  "gpuPlans": {
    "note": "Reference data only. engine.js currently treats every GPU resource as unsupported regardless of catalog content (see estimateInfrastructureCost) — these rows are not yet priced by an estimate.",
    "verificationStatus": "unverified-seed",
    "pricedByEngine": false,
    "plans": [
      {
        "id": "gpu-amd-mi300x-1x",
        "gpuType": "AMD MI300X",
        "gpuCount": 1,
        "hourlyUsd": 2.59
      },
      {
        "id": "gpu-amd-mi300x-8x",
        "gpuType": "AMD MI300X",
        "gpuCount": 8,
        "hourlyUsd": 20.72
      },
      {
        "id": "gpu-amd-mi325x-1x",
        "gpuType": "AMD MI325X",
        "gpuCount": 1,
        "hourlyUsd": 3.8
      },
      {
        "id": "gpu-amd-mi325x-8x",
        "gpuType": "AMD MI325X",
        "gpuCount": 8,
        "hourlyUsd": 30.4
      },
      {
        "id": "gpu-nvidia-h100-1x",
        "gpuType": "NVIDIA H100",
        "gpuCount": 1,
        "hourlyUsd": 4.41
      },
      {
        "id": "gpu-nvidia-h100-8x",
        "gpuType": "NVIDIA H100",
        "gpuCount": 8,
        "hourlyUsd": 35.28
      },
      {
        "id": "gpu-nvidia-l40s-1x",
        "gpuType": "NVIDIA L40S",
        "gpuCount": 1,
        "hourlyUsd": 1.57
      },
      {
        "id": "gpu-nvidia-rtx4000-1x",
        "gpuType": "NVIDIA RTX 4000",
        "gpuCount": 1,
        "hourlyUsd": 0.76
      },
      {
        "id": "gpu-nvidia-rtx6000-1x",
        "gpuType": "NVIDIA RTX 6000",
        "gpuCount": 1,
        "hourlyUsd": 1.57
      },
      {
        "id": "gpu-nvidia-h200-1x",
        "gpuType": "NVIDIA H200",
        "gpuCount": 1,
        "hourlyUsd": 4.47
      },
      {
        "id": "gpu-nvidia-h200-8x",
        "gpuType": "NVIDIA H200",
        "gpuCount": 8,
        "hourlyUsd": 35.76
      }
    ]
  }
});
