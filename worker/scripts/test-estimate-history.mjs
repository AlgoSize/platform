// What an estimate is allowed to leave behind.
//
// handlers/estimate.js may persist nothing — test-estimate-api.mjs asserts
// that structurally, by checking the file contains no persistence reach at
// all. This suite covers the other half: the recorder that files an estimate
// from OUTSIDE that boundary may persist only an aggregate, and this is where
// "only an aggregate" is given teeth.
//
// The threat is not malice, it is drift. Someone adds `region` to a provider
// entry for a good reason; someone returns the normalized spec so the UI can
// avoid a second call. Each is defensible in isolation and each puts customer
// topology into a 90-day history table. So the test is written as a DENY
// list checked against the whole serialized record, not as a spot check of
// the fields we happen to remember.
//
// Run with:  node scripts/test-estimate-history.mjs

import { aggregateOf, withEstimateHistory } from "../src/handlers/estimate_history.js";

let failures = 0;
const ok   = (m) => console.log(`  \x1b[32m✓\x1b[0m ${m}`);
const fail = (m) => { console.log(`  \x1b[31m✗\x1b[0m ${m}`); failures++; };
const expect = (c, l) => (c ? ok(l) : fail(l));
const group  = (n) => console.log(`\n\x1b[1m${n}\x1b[0m\n`);

// A response with every field the estimator can return, and with identifying
// strings chosen so they are easy to search for in the serialized output.
const FULL = {
  normalizedSpec: {
    name: "acme-production-topology",
    resources: [
      { name: "payments-db", quantity: 1, cpuMilli: 2000, memoryMilliGiB: 4096,
        storageMilliGiB: 100000, region: "eu-central-1", image: "internal.registry.acme.corp/pg:15" },
      { name: "checkout-api", quantity: 3, cpuMilli: 500, memoryMilliGiB: 1024 },
    ],
  },
  providers: [
    { providerId: "hetzner", providerName: "Hetzner Cloud", currency: "USD",
      estimatedTotalMicroUsd: 12_400_000, confidence: "medium",
      region: "eu-central-1", assumptions: ["priced against nbg1"] },
    { providerId: "aws", providerName: "Amazon Web Services", currency: "USD",
      estimatedTotalMicroUsd: 41_000_000,
      lowerBoundMicroUsd: 36_000_000, upperBoundMicroUsd: 48_500_000, confidence: "low" },
  ],
  warnings: [
    "resource 'payments-db' has no storage class; standard block storage was priced",
    "internal.registry.acme.corp is not a known image source",
  ],
  duration: "1mo", currency: "USD", pricingCatalogVersion: "2026-08",
  inputType: "compose", requestId: "req_abc",
  disclaimer: "List prices against the submitted specification. Not a quote, and not your bill.",
};

// ===========================================================================
group("the aggregate carries no parsed resource value");
// ===========================================================================
{
  const agg = aggregateOf(FULL);
  const serialized = JSON.stringify(agg);

  // Every one of these is something the estimator's module header names as
  // unrecordable, or something that would identify the customer.
  const FORBIDDEN = [
    ["payments-db",                 "a resource name"],
    ["checkout-api",                "a second resource name"],
    ["acme-production-topology",    "the stack's own name"],
    ["internal.registry.acme.corp", "an internal hostname"],
    ["eu-central-1",                "a region"],
    ["nbg1",                        "a datacentre named in a provider assumption"],
    ["storage class",               "a warning that quotes a resource"],
    ["normalizedSpec",              "the spec container itself"],
  ];
  for (const [needle, what] of FORBIDDEN) {
    expect(!serialized.includes(needle), `no ${what} survives into the stored record`);
  }

  expect(!("normalizedSpec" in agg) && !("warnings" in agg) && !("requestId" in agg),
    "and none of normalizedSpec / warnings / requestId survive at all");
}

// ===========================================================================
group("…while keeping enough to be worth having");
// ===========================================================================
{
  const agg = aggregateOf(FULL);
  expect(agg.providers.length === 2, "both priced providers are kept");
  expect(agg.providers[0].estimatedTotalMicroUsd === 12_400_000 &&
         agg.providers[0].providerName === "Hetzner Cloud",
    "with their totals and names");
  expect(agg.providers[1].lowerBoundMicroUsd === 36_000_000 &&
         agg.providers[1].upperBoundMicroUsd === 48_500_000,
    "and their bounds, where the engine produced any");
  expect(agg.resourceCount === 2, "a resource COUNT is kept — how many, never which");
  expect(agg.warningCount === 2, "a warning COUNT is kept, never the warnings");
  expect(agg.pricingCatalogVersion === "2026-08" && agg.duration === "1mo",
    "and what the number means: which rate card, over what period");
  expect(agg.specRetained === false && typeof agg.specNote === "string",
    "the record says of itself that the spec was not kept, so an exported " +
    "JSON still explains its own gaps");
}

// ===========================================================================
group("the allowlist excludes by default");
// ===========================================================================
{
  // The property that makes this hold up over time: a field nobody has
  // thought about yet is dropped, rather than kept until someone notices.
  const withNewFields = {
    ...FULL,
    providers: [{ ...FULL.providers[0], vpcId: "vpc-0a1b2c3d", accountId: "934571100284" }],
    tenancy: "dedicated",
    sourceDocument: "version: '3'\\nservices:\\n  payments-db:\\n",
  };
  const serialized = JSON.stringify(aggregateOf(withNewFields));
  expect(!serialized.includes("vpc-0a1b2c3d") && !serialized.includes("934571100284"),
    "unknown provider fields are dropped, not copied");
  expect(!serialized.includes("dedicated") && !serialized.includes("sourceDocument"),
    "unknown top-level fields are dropped, not copied");
}

// ===========================================================================
group("nothing is filed when there is nothing to file");
// ===========================================================================
{
  expect(aggregateOf({ providers: [] }) === null,
    "an estimate that priced no provider produces no record");
  expect(aggregateOf(null) === null && aggregateOf("nope") === null,
    "and a malformed payload produces no record rather than throwing");
}

// ===========================================================================
group("the wrapper never changes the response");
// ===========================================================================
{
  const calls = [];
  // No DB binding, and the request carries an org so runScopeFor resolves
  // without touching one. Persistence is then a clean no-op rather than an
  // exception, which keeps this test about the wrapper's contract instead of
  // about what happens when the database is missing.
  const env = {};
  const handler = async () => new Response(JSON.stringify(FULL), {
    status: 200, headers: { "content-type": "application/json" },
  });
  const wrapped = withEstimateHistory(handler);

  const req = new Request("https://algosize.com/api/estimate", { method: "POST" });
  req.org = { orgId: "org_1" };
  const res = await wrapped(req, env, { waitUntil: (p) => calls.push(p) });

  expect(res.status === 200, "a 200 stays a 200");
  const body = await res.json();
  expect(body.normalizedSpec && body.normalizedSpec.resources.length === 2,
    "and the CALLER still receives the full estimate — only the stored copy is narrowed");
  expect(calls.length === 1, "the filing is handed to waitUntil, not awaited in the request");

  const failing = withEstimateHistory(async () =>
    new Response(JSON.stringify({ error: "invalid_input" }), { status: 400 }));
  const bad = await failing(req, env, null);
  expect(bad.status === 400, "a non-200 is passed straight through, unread");
}

console.log("");
if (failures) {
  console.log(`\x1b[31m  ${failures} estimate-history test(s) failed\x1b[0m`);
  process.exit(1);
}
console.log("\x1b[32m  all estimate-history tests passed\x1b[0m");
