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
  "providerId": "aws",
  "providerName": "Amazon Web Services",
  "category": "cloud",
  "billingModel": "metered",
  "currency": "USD",
  "catalogVersion": "2026.08.20-1",
  "effectiveDate": "2026-08-01",
  "lastVerified": "2026-08-19",
  "verificationStatus": "unverified-seed",
  "verificationNotes": "Fargate dimension prices (below) are unchanged from the prior catalog version and remain unverified. A secondhand pull added EC2 on-demand billing metadata and one exact EC2 instance-type sample (referenceSamples.t3Small) from aws.amazon.com/ec2/pricing/on-demand/ and aws.amazon.com/ec2/instance-types/t3/ — nobody on this side opened either page directly. That sample is recorded for reference only; it is NOT wired into pricing (see referenceSamples note) and its presence must not be read as AWS being more verified than before. Do not mark AWS verified from this pass; EC2 instance-type SKUs still are not modelled by the engine at all.",
  "sourceUrl": "https://aws.amazon.com/fargate/pricing/",
  "regions": [
    "us-east-1"
  ],
  "defaultRegion": "us-east-1",
  "limitations": [
    "Priced on the AWS Fargate dimension model, which bills vCPU and memory separately — this is why AWS has real per-vCPU-hour and per-GiB-hour prices while the plan-billed providers in this catalog do not.",
    "EC2 instance-type SKUs are not modelled. An estimate here answers 'what would this cost run as containers on Fargate', not 'which EC2 instance should I buy'. Fargate's per-second minimum-duration billing (minimumBillableSeconds below) does not necessarily describe EC2 instance billing, which is a separate product with its own per-second/full-hour rules by operating system (see referenceSamples).",
    "Savings Plans, Reserved Instances, Spot and the free tier are not modelled; every price is on-demand list.",
    "Data transfer IN is free on AWS and is priced at zero here, which is a real provider term rather than a missing dimension.",
    "Regional pricing varies; only us-east-1 is present.",
    "T-family (T2/T3/T4g) instances are reported to bill additional CPU-credit charges in \"unlimited\" mode; not modelled."
  ],
  "dimensions": {
    "vcpuHour": {
      "priceMicroUsd": 40480,
      "unit": "vCPU-hour",
      "sourceUrl": "https://aws.amazon.com/fargate/pricing/",
      "note": "Fargate Linux/x86 per-vCPU-hour, us-east-1."
    },
    "memoryGiBHour": {
      "priceMicroUsd": 4445,
      "unit": "GiB-hour",
      "sourceUrl": "https://aws.amazon.com/fargate/pricing/",
      "note": "Fargate Linux/x86 per-GiB-hour, us-east-1."
    },
    "storageGiBMonth": {
      "priceMicroUsd": 80000,
      "unit": "GiB-month",
      "sourceUrl": "https://aws.amazon.com/ebs/pricing/",
      "note": "EBS gp3 provisioned storage, us-east-1."
    },
    "egressGiB": {
      "priceMicroUsd": 90000,
      "unit": "GiB",
      "sourceUrl": "https://aws.amazon.com/ec2/pricing/on-demand/",
      "note": "Internet data transfer out beyond the monthly free allowance."
    },
    "ingressGiB": {
      "priceMicroUsd": 0,
      "unit": "GiB",
      "sourceUrl": "https://aws.amazon.com/ec2/pricing/on-demand/",
      "note": "Data transfer in is free."
    }
  },
  "includedAllowances": {
    "egressGiBPerMonth": 100
  },
  "minimumBillableSeconds": 60,
  "referenceSamples": {
    "note": "Catalog reference data only, from a secondhand pull, not independently opened by a human on this side. NOT priced by the engine: engine.js dispatches a provider by its single billingModel (\"metered\" here), so an EC2 instance-type row placed alongside Fargate's dimensions would never be selected by pricePlan()/priceMetered() — pricing EC2 instance types for real would need a separate provider entry with an uncapped hourly plan-billing mode, which does not exist yet. Kept here so the number isn't lost, not because it does anything.",
    "verificationStatus": "unverified-seed",
    "pricedByEngine": false,
    "t3Small": {
      "sku": "t3.small",
      "region": "us-east-1",
      "operatingSystem": "linux",
      "tenancy": "shared",
      "vcpu": 2,
      "memoryGiB": 2,
      "storage": "ebs-only",
      "hourlyUsd": 0.0209,
      "pricingType": "on-demand",
      "sourceUrl": "https://aws.amazon.com/ec2/instance-types/t3/",
      "notes": [
        "Price is for Linux/Unix in US East (Northern Virginia).",
        "T3 unlimited-mode CPU-credit charges may apply beyond the baseline.",
        "Most operating systems (Linux, Windows, RHEL, Ubuntu Pro) are reported to bill partial hours per-second with the same 60-second minimum as Fargate; SLES is reported to bill the full hour regardless of actual usage."
      ]
    }
  }
});
