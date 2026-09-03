// Infrastructure Cost Estimator — behavioural tests.
//
// Run with:  node scripts/test-estimator.mjs

import {
  validateSpec, parseCpuToMilli, parseMemoryToMilliGiB, durationToMilliHours,
  EstimatorError, MILLI, mulDiv, formatMicroUsd, UNCERTAINTY_CAUSES,
  UNKNOWN_EGRESS_CEILING_GIB,
} from "../src/estimator/spec.js";
import { loadCatalog, resolveProviders, catalogFreshness, listProviders } from "../src/estimator/catalog.js";
import { estimateInfrastructureCost, deriveConfidence } from "../src/estimator/engine.js";
import { adaptKubernetes } from "../src/estimator/adapters/k8s.js";
import { adaptTerraformPlan } from "../src/estimator/adapters/terraform-plan.js";
import { adaptNormalized } from "../src/estimator/adapters/normalized.js";
import { SecretDetectedError } from "../src/analyzers/secrets.js";

let failures = 0;
const ok   = (m) => console.log(`  \x1b[32m✓\x1b[0m ${m}`);
const fail = (m) => { console.log(`  \x1b[31m✗\x1b[0m ${m}`); failures++; };
const expect = (c, m) => c ? ok(m) : fail(m);

const CATALOG = loadCatalog();
const FRESH = {};        // treat the catalog as verified, so tests isolate one cause at a time
for (const id of Object.keys(CATALOG.providers)) FRESH[id] = { stale: false, reason: null };
const STALE = {};
for (const id of Object.keys(CATALOG.providers)) STALE[id] = { stale: true, reason: "catalog has not been verified" };

const MONTH = { value: 1, unit: "month" };
const providersFor = (...ids) => resolveProviders(CATALOG, ids);

function estimate(specInput, ids = ["aws"], opts = {}, freshness = FRESH) {
  const { spec } = validateSpec(specInput);
  return estimateInfrastructureCost(spec, providersFor(...ids), {
    catalogVersion: CATALOG.catalogVersion,
    freshnessByProvider: freshness,
    options: opts,
    generatedAt: "2026-08-19T00:00:00Z",
  });
}

const throws = (fn, code, label) => {
  let e = null;
  try { fn(); } catch (err) { e = err; }
  expect(e && (e.code === code || e.name === code), `${label} (got ${e ? e.code || e.name : "no error"})`);
  return e;
};

// ---------------------------------------------------------------------------
console.log("\nunit conversion\n");
// ---------------------------------------------------------------------------
{
  expect(parseCpuToMilli("100m") === 100, "CPU 100m -> 100 milli-cores");
  expect(parseCpuToMilli("2") === 2000, "CPU 2 -> 2000 milli-cores");
  expect(parseCpuToMilli("0.5") === 500, "CPU 0.5 -> 500 milli-cores");
  expect(parseCpuToMilli(1.5) === 1500, "CPU numeric 1.5 -> 1500 milli-cores");
  expect(parseCpuToMilli(undefined) === null, "absent CPU -> null, not 0");
  throws(() => parseCpuToMilli("2 cores"), "invalid_cpu_quantity", "unparseable CPU is rejected");

  expect(parseMemoryToMilliGiB("1Gi") === 1000, "memory 1Gi -> 1000 milli-GiB");
  expect(parseMemoryToMilliGiB("256Mi") === 250, "memory 256Mi -> 250 milli-GiB");
  expect(parseMemoryToMilliGiB("512Mi") === 500, "memory 512Mi -> 500 milli-GiB");
  expect(parseMemoryToMilliGiB(1073741824) === 1000, "memory as raw bytes -> 1000 milli-GiB");
  // 1G (decimal) is NOT 1Gi (binary) — conflating them understates by ~7%.
  expect(parseMemoryToMilliGiB("1G") === 931, "memory 1G (decimal) -> 931 milli-GiB, distinct from 1Gi");
  throws(() => parseMemoryToMilliGiB("512Zz"), "invalid_memory_quantity", "unknown memory suffix is rejected");

  expect(durationToMilliHours({ value: 1, unit: "month" }) === 730000, "1 month -> 730 hours");
  expect(durationToMilliHours({ value: 24, unit: "hour" }) === 24000, "24 hours -> 24 hours");
  throws(() => durationToMilliHours({ value: 0, unit: "hour" }), "invalid_duration", "zero duration is rejected");
  throws(() => durationToMilliHours({ value: 5, unit: "fortnight" }), "invalid_duration", "unknown duration unit is rejected");
}

// ---------------------------------------------------------------------------
console.log("\nexact money arithmetic\n");
// ---------------------------------------------------------------------------
{
  expect(mulDiv(40480, 1500, MILLI) === 60720, "mulDiv keeps integer micro-USD exact");
  expect(Number.isInteger(mulDiv(3, 1, 7)), "mulDiv always returns an integer");
  expect(formatMicroUsd(24_000_000) === "$24.00", "micro-USD formats to dollars");
  expect(formatMicroUsd(60720) === "$0.06", "sub-dollar amounts round to cents");
  // The float trap this representation exists to avoid.
  expect(0.1 + 0.2 !== 0.3 && mulDiv(100_000, 3, 1) === 300_000, "integer path avoids the 0.1+0.2 class of error");
}

// ---------------------------------------------------------------------------
console.log("\nKubernetes adapter\n");
// ---------------------------------------------------------------------------
const K8S_DEPLOY = `
apiVersion: apps/v1
kind: Deployment
metadata:
  name: web
spec:
  replicas: 3
  template:
    spec:
      containers:
        - name: app
          image: nginx:1.27
          resources:
            requests:
              cpu: 500m
              memory: 512Mi
            limits:
              cpu: "2"
              memory: 2Gi
`;
{
  const { resources, warnings } = adaptKubernetes(K8S_DEPLOY);
  expect(resources.length === 1, "one container becomes one resource");
  const r = resources[0];
  expect(r.quantity === 3, "replicas are carried as quantity (3)");
  expect(r.cpuMilli === 500, "requests.cpu 500m is the default basis");
  expect(r.memoryMilliGiB === 500, "requests.memory 512Mi -> 500 milli-GiB");
  expect(r.capacityBasis === "requests", "capacityBasis records which bucket was used");
  expect(Array.isArray(warnings), "warnings array is returned");
}
{
  const { resources } = adaptKubernetes(K8S_DEPLOY, { capacityBasis: "limits" });
  expect(resources[0].cpuMilli === 2000, "limits basis selects cpu 2 -> 2000 milli");
  expect(resources[0].memoryMilliGiB === 2000, "limits basis selects memory 2Gi");
}
{
  // Every supported kind is recognised.
  for (const [kind, extra] of [
    ["StatefulSet", "  replicas: 2\n"], ["DaemonSet", ""], ["Job", "  parallelism: 4\n"],
    ["CronJob", ""], ["Pod", ""],
  ]) {
    const doc = `
apiVersion: v1
kind: ${kind}
metadata:
  name: thing
spec:
${extra}  template:
    spec:
      containers:
        - name: c
          resources:
            requests:
              cpu: 100m
              memory: 128Mi
`;
    let out = null;
    try { out = adaptKubernetes(doc); } catch { /* reported below */ }
    expect(out && out.resources.length === 1, `${kind} is parsed into a priceable resource`);
  }
}
{
  const { resources } = adaptKubernetes(`
apiVersion: batch/v1
kind: Job
metadata:
  name: batch
spec:
  parallelism: 4
  template:
    spec:
      containers:
        - name: c
          resources:
            requests: { }
`);
  expect(resources[0].quantity === 4, "Job parallelism is read as the replica count");
}
{
  // Multi-document streams, and a kind we do not price.
  const { resources, warnings } = adaptKubernetes(`${K8S_DEPLOY}\n---\napiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: cm\ndata:\n  a: b\n`);
  expect(resources.length === 1, "multi-document stream is split and only workloads are priced");
  expect(warnings.some((w) => w.code === "unsupported_kind"), "an unpriceable kind produces a warning rather than silence");
}
{
  const { resources, warnings } = adaptKubernetes(`
kind: Deployment
metadata:
  name: nores
spec:
  replicas: 1
  template:
    spec:
      containers:
        - name: c
          image: busybox
`);
  expect(warnings.some((w) => w.code === "container_without_resources"),
    "a container with no resources block warns instead of pricing at zero");
  expect(resources.length === 1 && !resources[0].cpuMilli,
    "and is still surfaced, so it can be reported as unsupported");
}
{
  // One live workload plus one scaled to zero: the zero-replica one is
  // reported and skipped, while the live one still prices.
  const mixed = `${K8S_DEPLOY}\n---\n${K8S_DEPLOY.replace("replicas: 3", "replicas: 0").replace("name: web", "name: idle")}`;
  const { resources, warnings } = adaptKubernetes(mixed);
  expect(warnings.some((w) => w.code === "scaled_to_zero"), "replicas: 0 is reported, not priced");
  expect(resources.length === 1, "and the scaled-to-zero workload contributes no resource");
  // A manifest whose ONLY workload is scaled to zero has nothing to price at
  // all, which is an error rather than a silent empty estimate.
  throws(() => adaptKubernetes(K8S_DEPLOY.replace("replicas: 3", "replicas: 0")),
    "empty_input", "a manifest scaled entirely to zero is rejected rather than estimated at $0");
}
throws(() => adaptKubernetes(""), "empty_input", "empty Kubernetes input is rejected");
throws(() => adaptKubernetes("kind: ConfigMap\nmetadata:\n  name: x\n"), "empty_input",
  "a manifest with no priceable workload is rejected with an actionable error");

// ---------------------------------------------------------------------------
console.log("\nTerraform plan adapter\n");
// ---------------------------------------------------------------------------
const TF_PLAN = JSON.stringify({
  format_version: "1.2",
  planned_values: {
    root_module: {
      resources: [
        { address: "aws_instance.web", type: "aws_instance", name: "web", values: { instance_type: "t3.medium", region: "us-east-1" } },
        { address: "aws_ebs_volume.data", type: "aws_ebs_volume", name: "data", values: { size: 100, iops: 3000 } },
      ],
      child_modules: [
        {
          address: "module.db",
          resources: [
            { address: "module.db.aws_instance.primary", type: "aws_instance", name: "primary", values: { instance_type: "m5.xlarge" } },
          ],
          child_modules: [
            {
              address: "module.db.module.replica",
              resources: [
                { address: "module.db.module.replica.aws_instance.r", type: "aws_instance", name: "r", values: { instance_type: "t3.large" } },
              ],
            },
          ],
        },
      ],
    },
  },
});
{
  const { resources, warnings } = adaptTerraformPlan(TF_PLAN);
  const ids = resources.map((r) => r.id);
  expect(resources.length === 4, `all four resources found across nesting (got ${resources.length})`);
  expect(ids.includes("module.db.aws_instance.primary"), "a child-module resource is traversed");
  expect(ids.includes("module.db.module.replica.aws_instance.r"), "a grandchild-module resource is traversed");
  const web = resources.find((r) => r.id === "aws_instance.web");
  expect(web.cpuMilli === 2000 && web.memoryMilliGiB === 4000, "t3.medium maps to 2 vCPU / 4 GiB");
  const vol = resources.find((r) => r.id === "aws_ebs_volume.data");
  expect(vol.storageGiB === 100 && vol.iops === 3000, "EBS volume size and IOPS are read");
  expect(Array.isArray(warnings), "warnings array is returned");
}
{
  // Unknown / computed values must warn, never be guessed.
  const plan = JSON.stringify({
    planned_values: { root_module: { resources: [
      { address: "aws_instance.x", type: "aws_instance", name: "x", values: { instance_type: null } },
      { address: "aws_ebs_volume.y", type: "aws_ebs_volume", name: "y", values: { size: {} } },
    ] } },
  });
  const { resources, warnings } = adaptTerraformPlan(plan);
  expect(warnings.some((w) => w.code === "unknown_instance_type"), "a computed instance_type warns");
  expect(warnings.some((w) => w.code === "unknown_volume_size"), "a computed volume size warns");
  expect(resources.every((r) => !r.cpuMilli && !r.storageGiB), "and neither is given an invented size");
}
{
  const e = throws(() => adaptTerraformPlan('resource "aws_instance" "web" {\n  instance_type = "t3.micro"\n}\n'),
    "terraform_hcl_not_supported", "HCL is rejected");
  expect(e && /terraform show -json/.test(e.message), "and the message tells the user exactly what to run instead");
}
throws(() => adaptTerraformPlan("{not json"), "malformed_document", "malformed plan JSON is rejected");
throws(() => adaptTerraformPlan("{}"), "malformed_document", "plan JSON without planned_values is rejected");
throws(() => adaptTerraformPlan(""), "empty_input", "empty Terraform input is rejected");

// ---------------------------------------------------------------------------
console.log("\nnormalized JSON adapter\n");
// ---------------------------------------------------------------------------
const NORMALIZED = {
  name: "api-tier",
  duration: MONTH,
  resources: [
    { id: "api", type: "compute", quantity: 2, cpuCores: 2, memoryGiB: 4, storageGiB: 50, egressGiB: 200 },
  ],
};
{
  const out = adaptNormalized(JSON.stringify(NORMALIZED));
  expect(out.resources.length === 1, "normalized JSON string is accepted");
  const { spec } = validateSpec({ duration: MONTH, resources: out.resources });
  expect(spec.resources[0].cpuMilli === 2000, "cpuCores 2 -> 2000 milli");
  expect(spec.resources[0].memoryMilliGiB === 4000, "memoryGiB 4 -> 4000 milli-GiB");
}
{
  const out = adaptNormalized({ ...NORMALIZED, resources: [{ ...NORMALIZED.resources[0], metadata: { owner: "team-a" } }] });
  expect(out.warnings.some((w) => w.code === "metadata_dropped"), "free-form metadata is dropped and reported");
  expect(out.resources[0].metadata === undefined, "and does not survive into the spec");
}
throws(() => adaptNormalized(""), "empty_input", "empty normalized input is rejected");
throws(() => adaptNormalized("{bad"), "malformed_document", "malformed normalized JSON is rejected");
throws(() => adaptNormalized({ resources: [] }), "empty_input", "a resources array with no entries is rejected");

// ---------------------------------------------------------------------------
console.log("\nsecret rejection\n");
// ---------------------------------------------------------------------------
{
  const AWS_KEY = "AKIA" + "IOSFODNN7EXAMPLE";
  const withKey = `${K8S_DEPLOY}\n          env:\n            - name: AWS_KEY\n              value: "${AWS_KEY}"\n`;
  const e = throws(() => adaptKubernetes(withKey), "SecretDetectedError", "a manifest containing an AWS key is rejected");
  const serialized = JSON.stringify(e ? e.toSafeJSON() : {}) + String(e && e.message);
  expect(!serialized.includes(AWS_KEY), "and neither the error nor its safe JSON contains the key value");

  for (const [label, doc] of [
    ["kubeconfig", "kubeconfig: |\n  apiVersion: v1\n"],
    ["private_key", "private_key: some-private-material-here\n"],
    ["aws_secret_access_key", "aws_secret_access_key: abcdefghijklmnopqrst\n"],
  ]) {
    let err = null;
    try { adaptNormalized(`{"duration":{"value":1,"unit":"month"},"resources":[],"${label}":"x"}\n${doc}`); }
    catch (x) { err = x; }
    expect(err instanceof SecretDetectedError, `a document containing ${label} is rejected before parsing`);
  }
}
{
  // Terraform plans routinely contain credential-shaped fields.
  const planWithSecret = JSON.stringify({
    planned_values: { root_module: { resources: [
      { address: "aws_instance.x", type: "aws_instance", name: "x", values: { instance_type: "t3.micro", private_key: "example:-----BEGIN KEY-----" } },
    ] } },
  });
  const e = throws(() => adaptTerraformPlan(planWithSecret), "SecretDetectedError", "a plan containing private_key is rejected");
  expect(e && !String(e.message).includes("BEGIN KEY"), "and the material is not echoed in the error");
}

// ---------------------------------------------------------------------------
console.log("\nAWS — metered pricing\n");
// ---------------------------------------------------------------------------
{
  const res = estimate({ duration: MONTH, resources: [
    { id: "api", type: "container", quantity: 2, cpuCores: 1, memoryGiB: 2 },
  ] }, ["aws"], { egressGiB: 0 });
  const aws = res.providers[0];
  // 1 vCPU x 2 replicas x 730h = 1460 vCPU-hours @ 40480 micro-USD
  const vcpu = aws.lineItems.find((li) => li.category === "compute-vcpu");
  expect(vcpu && vcpu.quantity === 1460, `vCPU-hours = 1 x 2 replicas x 730h = 1460 (got ${vcpu && vcpu.quantity})`);
  expect(vcpu && vcpu.estimatedCostMicroUsd === 59_100_800, `vCPU cost is exact integer micro-USD (got ${vcpu && vcpu.estimatedCostMicroUsd})`);
  const mem = aws.lineItems.find((li) => li.category === "compute-memory");
  expect(mem && mem.quantity === 2920, "memory GiB-hours = 2 x 2 x 730 = 2920");
  expect(aws.estimatedTotalMicroUsd === vcpu.estimatedCostMicroUsd + mem.estimatedCostMicroUsd,
    "total is the sum of the line items");
  expect(aws.consumption.replicas === 2, "consumption reports replica count");
}
{
  const res = estimate({ duration: MONTH, resources: [
    { id: "vol", type: "storage", quantity: 1, storageGiB: 100 },
  ] }, ["aws"], { egressGiB: 0 });
  const item = res.providers[0].lineItems.find((li) => li.category === "storage");
  expect(item && item.quantity === 100, "storage GiB-months = 100 over one month");
  expect(item && item.estimatedCostMicroUsd === 8_000_000, "gp3 100 GiB-month = $8.00");
}
{
  // Included allowance consumed before anything is billed.
  const res = estimate({ duration: MONTH, resources: [
    { id: "api", type: "container", quantity: 1, cpuCores: 1, memoryGiB: 1, egressGiB: 150 },
  ] }, ["aws"], { egressGiB: 150 });
  const egress = res.providers[0].lineItems.find((li) => li.category === "egress");
  expect(egress && egress.quantity === 50, "AWS's 100 GiB allowance is deducted, leaving 50 GiB billable");
  expect(res.providers[0].assumptions.some((a) => a.cause === "unsupported_managed_service_overhead"),
    "and the allowance consumption is stated as an assumption");
}

// ---------------------------------------------------------------------------
console.log("\nDigitalOcean and Hetzner — plan pricing, no fabricated unit prices\n");
// ---------------------------------------------------------------------------
{
  const res = estimate({ duration: MONTH, resources: [
    { id: "app", type: "compute", quantity: 1, cpuCores: 2, memoryGiB: 4 },
  ] }, ["digitalocean"], { egressGiB: 0 });
  const dop = res.providers[0];
  const plan = dop.lineItems.find((li) => li.category === "compute-plan");
  expect(plan && plan.sku === "s-2vcpu-4gb", `smallest fitting Droplet chosen (got ${plan && plan.sku})`);
  expect(dop.estimatedTotalMicroUsd === 24_000_000, `a full month costs exactly the $24 list price (got ${formatMicroUsd(dop.estimatedTotalMicroUsd)})`);

  const allocated = dop.lineItems.filter((li) => li.allocated);
  expect(allocated.length === 2, "CPU and memory appear as allocated line items");
  expect(allocated.every((li) => li.unitPriceMicroUsd === 0),
    "allocated components carry NO invented unit price — DigitalOcean publishes none");
  expect(allocated.every((li) => li.estimatedCostMicroUsd === 0),
    "and contribute nothing to the total, so the plan line is not double-counted");
  expect(dop.assumptions.some((a) => a.cause === "bundled_plan_allocation"),
    "a bundled_plan_allocation assumption explains the split");
}
{
  const res = estimate({ duration: MONTH, resources: [
    { id: "app", type: "compute", quantity: 1, cpuCores: 2, memoryGiB: 2 },
  ] }, ["hetzner"], { egressGiB: 0 });
  const h = res.providers[0];
  expect(h.lineItems.find((li) => li.category === "compute-plan").sku === "cpx11", "smallest fitting Hetzner server chosen");
  expect(h.estimatedTotalMicroUsd === 5_590_000, `a full month costs the CPX11 list price (got ${formatMicroUsd(h.estimatedTotalMicroUsd)})`);
}
{
  // bundled_plan_allocation must NOT widen the total: the plan price is exact.
  const res = estimate({ duration: MONTH, resources: [
    { id: "app", type: "compute", quantity: 1, cpuCores: 2, memoryGiB: 4 },
  ] }, ["digitalocean"], { egressGiB: 0 });
  const a = res.providers[0].assumptions.find((x) => x.cause === "bundled_plan_allocation");
  expect(a && a.effect.lowerMicroUsd === 0 && a.effect.upperMicroUsd === 0,
    "bundled_plan_allocation contributes 0/0 — a plan price is exact, only its split is inferred");
}
{
  // Nothing large enough -> unsupported, never a silent zero.
  const res = estimate({ duration: MONTH, resources: [
    { id: "huge", type: "compute", quantity: 1, cpuCores: 64, memoryGiB: 256 },
  ] }, ["hetzner"], { egressGiB: 0 });
  expect(res.providers[0].unsupportedResources.some((u) => u.reason === "no_plan_large_enough"),
    "a resource larger than every plan is reported unsupported");
  expect(res.providers[0].confidence === "low", "and drags confidence to low");
}

// ---------------------------------------------------------------------------
console.log("\nuncertainty — every bound has a named cause\n");
// ---------------------------------------------------------------------------
{
  // THE core invariant, checked across a matrix of option combinations.
  const matrix = [
    [["aws"], { egressGiB: 0 }], [["aws"], {}], [["aws"], { cpuUtilization: 0.5 }],
    [["digitalocean"], { egressGiB: 0 }], [["hetzner"], {}],
    [["aws", "digitalocean", "hetzner"], { cpuUtilization: 0.4 }],
  ];
  let bad = null;
  for (const [ids, opts] of matrix) {
    for (const fresh of [FRESH, STALE]) {
      const res = estimate({ duration: MONTH, resources: [
        { id: "a", type: "compute", quantity: 2, cpuCores: 2, memoryGiB: 4 },
      ] }, ids, opts, fresh);
      for (const p of res.providers) {
        const hasBounds = p.lowerBoundMicroUsd !== undefined || p.upperBoundMicroUsd !== undefined;
        const hasCause = p.assumptions.some((a) => a.effect.lowerMicroUsd !== 0 || a.effect.upperMicroUsd !== 0);
        if (hasBounds !== hasCause) { bad = `${p.providerId} bounds=${hasBounds} cause=${hasCause}`; break; }
        if (hasBounds && !(p.lowerBoundMicroUsd <= p.estimatedTotalMicroUsd && p.estimatedTotalMicroUsd <= p.upperBoundMicroUsd)) {
          bad = `${p.providerId} bounds do not bracket the total`; break;
        }
        if (p.assumptions.some((a) => !UNCERTAINTY_CAUSES.includes(a.cause))) { bad = `${p.providerId} has an unnamed cause`; break; }
      }
      if (bad) break;
    }
    if (bad) break;
  }
  expect(bad === null, `a range exists if and only if an assumption caused it${bad ? ` — ${bad}` : ""}`);
}
{
  const res = estimate({ duration: MONTH, resources: [
    { id: "a", type: "compute", quantity: 1, cpuCores: 1, memoryGiB: 1 },
  ] }, ["aws"], { egressGiB: 0 }, STALE);
  const p = res.providers[0];
  expect(p.assumptions.some((a) => a.cause === "stale_pricing_catalog"), "a stale catalog adds its own assumption");
  expect(p.lowerBoundMicroUsd < p.estimatedTotalMicroUsd && p.upperBoundMicroUsd > p.estimatedTotalMicroUsd,
    "which widens the estimate in both directions");
  expect(p.confidence === "low", "and forces confidence to low");
}
{
  const res = estimate({ duration: MONTH, resources: [
    { id: "a", type: "compute", quantity: 1, cpuCores: 1, memoryGiB: 1 },
  ] }, ["aws"], {});     // egress deliberately unspecified
  const a = res.providers[0].assumptions.find((x) => x.cause === "unknown_egress");
  expect(!!a, "unspecified egress produces an unknown_egress assumption");
  expect(a && a.effect.lowerMicroUsd === 0 && a.effect.upperMicroUsd > 0,
    "which only raises the ceiling — zero egress is the floor");
  expect(a && new RegExp(String(UNKNOWN_EGRESS_CEILING_GIB)).test(a.statement),
    "and names the assumed ceiling instead of being unbounded");
}
{
  // Minimum billable duration raises the floor only.
  const res = estimate({ duration: { value: 1, unit: "hour" }, resources: [
    { id: "a", type: "compute", quantity: 1, cpuCores: 2, memoryGiB: 2 },
  ] }, ["hetzner"], { egressGiB: 0 });    // Hetzner minimum is 3600s == the duration
  const short = estimate({ duration: { value: 0.25, unit: "hour" }, resources: [
    { id: "a", type: "compute", quantity: 1, cpuCores: 2, memoryGiB: 2 },
  ] }, ["hetzner"], { egressGiB: 0 });
  const a = short.providers[0].assumptions.find((x) => x.cause === "minimum_billable_duration");
  expect(!!a, "a run shorter than the provider minimum produces a minimum_billable_duration assumption");
  expect(a && a.effect.lowerMicroUsd > 0, "which RAISES the floor rather than widening symmetrically");
  expect(short.providers[0].lowerBoundMicroUsd > short.providers[0].estimatedTotalMicroUsd,
    "so the lower bound exceeds the naive pro-rata total");
  expect(!res.providers[0].assumptions.some((x) => x.cause === "minimum_billable_duration"),
    "and a run at or above the minimum does not");
}
{
  const res = estimate({ duration: MONTH, resources: [
    { id: "a", type: "compute", quantity: 1, cpuCores: 1, memoryGiB: 1 },
  ] }, ["aws"], { egressGiB: 0, cpuUtilization: 0.5 });
  const a = res.providers[0].assumptions.find((x) => x.cause === "utilization_assumption");
  expect(!!a, "a utilization assumption is recorded when one is supplied");
  expect(a && a.effect.lowerMicroUsd < 0 && a.effect.upperMicroUsd > 0, "and widens symmetrically");
}
{
  const noRegion = estimate({ duration: MONTH, resources: [
    { id: "a", type: "compute", quantity: 1, cpuCores: 1, memoryGiB: 1 },
  ] }, ["aws"], { egressGiB: 0 });
  expect(noRegion.providers[0].assumptions.some((a) => a.cause === "missing_region"),
    "a spec with no region records missing_region");
}

// ---------------------------------------------------------------------------
console.log("\nresult completeness and comparison\n");
// ---------------------------------------------------------------------------
{
  const res = estimate({ duration: MONTH, resources: [
    { id: "a", type: "compute", quantity: 1, cpuCores: 2, memoryGiB: 4 },
  ] }, ["aws", "digitalocean", "hetzner"], { egressGiB: 0 });

  expect(res.providers.length === 3, "all three providers are compared");
  for (const p of res.providers) {
    const complete = Array.isArray(p.lineItems) && p.consumption && Array.isArray(p.assumptions) &&
      Array.isArray(p.unsupportedResources) && p.confidence && p.pricingCatalogVersion &&
      p.pricingLastVerified && p.pricingSourceUrl && Array.isArray(p.limitations);
    expect(complete, `${p.providerId} returns line items, consumption, assumptions, confidence, catalog version, verification date, source and limitations`);
  }
  const totals = res.providers.map((p) => p.estimatedTotalMicroUsd);
  expect(totals.every((t, i) => i === 0 || totals[i - 1] <= t), `providers are ordered cheapest-first (${totals.map(formatMicroUsd).join(" ≤ ")})`);
  expect(res.pricingCatalogVersion === CATALOG.catalogVersion, "the result names the catalog version it was priced from");
  expect(res.currency === "USD", "currency is explicit");
}
{
  // A provider that can price nothing must never win on $0.
  const res = estimate({ duration: MONTH, resources: [
    { id: "gpu", type: "gpu", quantity: 1, gpuCount: 1, gpuType: "A100", cpuCores: 8, memoryGiB: 64 },
  ] }, ["aws", "hetzner"], { egressGiB: 0 });
  expect(res.providers.every((p) => p.unsupportedResources.length === 1), "a GPU resource is unsupported in every catalog");
  expect(res.providers.every((p) => p.estimatedTotalMicroUsd === 0), "and is priced at nothing");
  expect(res.providers.every((p) => p.confidence === "low"), "with confidence forced low so $0 cannot read as cheap");
}
{
  const { warnings } = validateSpec({ duration: MONTH, resources: [{ id: "ghost", type: "compute", quantity: 1 }] });
  expect(warnings.some((w) => w.code === "resource_without_capacity"),
    "a resource with no capacity warns at validation time");
  const res = estimate({ duration: MONTH, resources: [{ id: "ghost", type: "compute", quantity: 1 }] }, ["aws"], { egressGiB: 0 });
  expect(res.providers[0].unsupportedResources.some((u) => u.reason === "no_capacity_declared"),
    "and is reported unsupported rather than counted as free");
}

// ---------------------------------------------------------------------------
console.log("\ncatalog integrity\n");
// ---------------------------------------------------------------------------
{
  expect(CATALOG.catalogVersion && CATALOG.currency === "USD", "catalog loads with a version and an explicit currency");
  for (const p of Object.values(CATALOG.providers)) {
    const required = ["providerId", "providerName", "billingModel", "currency", "catalogVersion",
                      "effectiveDate", "lastVerified", "sourceUrl", "limitations", "regions"];
    expect(required.every((f) => p[f] !== undefined), `${p.providerId} carries every required catalog field`);
    expect(p.limitations.length > 0, `${p.providerId} states its limitations`);
    expect(/^https:\/\//.test(p.sourceUrl), `${p.providerId} cites a public https source`);
  }
  const dop = CATALOG.providers.digitalocean;
  expect(!dop.dimensions.vcpuHour && !dop.dimensions.memoryGiBHour,
    "DigitalOcean's catalog declares NO per-vCPU or per-GiB price — none is published, so none is invented");
  expect(!CATALOG.providers.hetzner.dimensions.vcpuHour,
    "Hetzner's catalog likewise declares no per-vCPU price");
  expect(CATALOG.providers.aws.dimensions.vcpuHour.priceMicroUsd > 0,
    "AWS does have a real per-vCPU-hour price (Fargate), so it is priced by dimension");

  const fresh = catalogFreshness(CATALOG.providers.aws, Date.parse("2026-08-19T00:00:00Z"));
  expect(fresh.stale === true && /not been verified/.test(fresh.reason),
    "an unverified seed catalog reports itself stale rather than claiming accuracy");
  expect(listProviders(CATALOG).length === Object.keys(CATALOG.providers).length, "listProviders returns descriptors for the UI without prices");
}
{
  expect(deriveConfidence([]) === "high", "no assumptions -> high confidence");
  expect(deriveConfidence([{ cause: "utilization_assumption", effect: {} }]) === "medium", "utilization -> medium");
  expect(deriveConfidence([{ cause: "stale_pricing_catalog", effect: {} }]) === "low", "stale catalog -> low");
  expect(deriveConfidence([], [{ resourceId: "x" }]) === "low", "any unsupported resource -> low");
}

// ---------------------------------------------------------------------------
console.log("\nmalformed and hostile input\n");
// ---------------------------------------------------------------------------
{
  throws(() => validateSpec(null), "invalid_payload", "null spec is rejected");
  throws(() => validateSpec({ duration: MONTH, resources: [] }), "empty_input", "no resources is rejected");
  throws(() => validateSpec({ duration: MONTH, resources: Array.from({ length: 501 }, () => ({ cpuCores: 1 })) }),
    "too_many_resources", "an oversized resource list is rejected");
  throws(() => validateSpec({ duration: { value: 100, unit: "month" }, resources: [{ cpuCores: 1 }] }),
    "invalid_duration", "a duration beyond one year is rejected");
  throws(() => validateSpec({ duration: MONTH, resources: [{ cpuCores: 1, quantity: 0 }] }),
    "invalid_quantity", "quantity 0 is rejected");
  throws(() => resolveProviders(CATALOG, ["not-a-provider"]), "unknown_provider", "an unknown provider id is rejected");

  // Error objects must stay free of user content.
  let e = null;
  try { validateSpec({ duration: MONTH, resources: [{ cpuCores: "sensitive-value-here" }] }); } catch (err) { e = err; }
  expect(e && !String(e.message).includes("sensitive-value-here"),
    "a validation error never echoes the offending value back");
  expect(e && e.field, "but does name the field, so the user can find it");
}
{
  // Determinism: the same inputs must produce byte-identical output.
  const build = () => JSON.stringify(estimate({ duration: MONTH, resources: [
    { id: "a", type: "compute", quantity: 3, cpuCores: 2, memoryGiB: 4, storageGiB: 40, egressGiB: 500 },
  ] }, ["aws", "digitalocean", "hetzner"], { cpuUtilization: 0.6 }, STALE));
  expect(build() === build(), "estimation is deterministic across runs");
}

// ---------------------------------------------------------------------------
console.log("\nAkamai/Linode and Vultr — new plan-billed providers, same rules as DO/Hetzner\n");
// ---------------------------------------------------------------------------
{
  const res = estimate({ duration: MONTH, resources: [
    { id: "app", type: "compute", quantity: 1, cpuCores: 0.5, memoryGiB: 0.5 },
  ] }, ["digitalocean"], { egressGiB: 0 });
  const plan = res.providers[0].lineItems.find((li) => li.category === "compute-plan");
  expect(plan && plan.sku === "basic-512mb", `smallest-fitting Droplet is the new basic-512mb tier (got ${plan && plan.sku})`);
  expect(res.providers[0].estimatedTotalMicroUsd === 4_000_000, `a full month of basic-512mb costs exactly $4.00 (got ${formatMicroUsd(res.providers[0].estimatedTotalMicroUsd)})`);
}
{
  const res = estimate({ duration: MONTH, resources: [
    { id: "app", type: "compute", quantity: 1, cpuCores: 2, memoryGiB: 4 },
  ] }, ["akamai-linode"], { egressGiB: 0 });
  const p = res.providers[0];
  const plan = p.lineItems.find((li) => li.category === "compute-plan");
  expect(plan && plan.sku === "linode-4gb", `smallest fitting Linode plan chosen (got ${plan && plan.sku})`);
  expect(p.estimatedTotalMicroUsd === 24_000_000, `a full month costs exactly the $24 Linode 4 GB list price (got ${formatMicroUsd(p.estimatedTotalMicroUsd)})`);
  expect(p.assumptions.some((a) => a.cause === "bundled_plan_allocation"), "Akamai/Linode also gets a bundled_plan_allocation assumption, not an invented per-vCPU price");
  const allocated = p.lineItems.filter((li) => li.allocated);
  expect(allocated.length === 2 && allocated.every((li) => li.unitPriceMicroUsd === 0),
    "Linode's CPU/RAM split is allocated at zero unit price — no per-vCPU rate is published, so none is fabricated");
}
{
  const res = estimate({ duration: MONTH, resources: [
    { id: "app", type: "compute", quantity: 1, cpuCores: 1, memoryGiB: 1 },
  ] }, ["vultr"], { egressGiB: 0 });
  const p = res.providers[0];
  const plan = p.lineItems.find((li) => li.category === "compute-plan");
  expect(plan && plan.sku === "vc2-1c-1gb", `smallest fitting Vultr plan chosen (got ${plan && plan.sku})`);
  expect(p.estimatedTotalMicroUsd === 6_000_000, `a full month costs exactly the $6 Vultr Cloud Compute list price (got ${formatMicroUsd(p.estimatedTotalMicroUsd)})`);
}
{
  // GPU catalog data (DigitalOcean and Akamai/Linode both carry gpuPlans) must
  // stay inert: engine.js has no code path that reads gpuPlans, so a GPU
  // resource must still come back unsupported rather than silently priced
  // from reference-only data.
  const res = estimate({ duration: MONTH, resources: [
    { id: "gpu-box", type: "gpu", quantity: 1, gpuCount: 1, gpuType: "NVIDIA H100" },
  ] }, ["digitalocean", "akamai-linode"], { egressGiB: 0 });
  for (const p of res.providers) {
    expect(p.unsupportedResources.some((u) => u.reason === "gpu_not_in_catalog"),
      `${p.providerId} still reports GPU as unsupported — gpuPlans is reference data, not wired into pricing`);
    expect(p.lineItems.length === 0, `${p.providerId} priced no line items for a GPU-only resource`);
  }
}
{
  // Every provider file in the index must agree on catalogVersion with the
  // index itself — loadCatalog() already enforces this at import time (the
  // whole test file would have thrown on load if it didn't), but assert it
  // explicitly so the invariant has a named test rather than an implicit one.
  const allMatch = Object.values(CATALOG.providers).every((p) => p.catalogVersion === CATALOG.catalogVersion);
  expect(allMatch, `every bundled provider agrees with the catalog index on catalogVersion (${CATALOG.catalogVersion})`);
}
{
  // Providers that were deliberately NOT added must not exist on disk. This
  // guards against one being dropped in later without going through
  // catalog.js's PROVIDER_FILES wiring, catalog.json's provider list, and
  // this test file — i.e. without a currency check (Scaleway is EUR-only)
  // or real sourced pricing (the rest have none yet).
  const fs = await import("node:fs");
  const path = await import("node:path");
  const providersDir = path.join(import.meta.dirname, "..", "pricing", "providers");
  const excluded = ["scaleway", "ovhcloud", "cloudflare-workers", "flyio", "render", "railway", "lambda", "runpod"];
  for (const id of excluded) {
    expect(!fs.existsSync(path.join(providersDir, `${id}.js`)),
      `${id}.js does not exist yet — no verified USD pricing has been sourced for it (Scaleway is EUR-only and blocked on currency conversion)`);
  }
}
{
  // The pricing modules are .js only because no import-attribute spelling
  // works in both Node and wrangler's esbuild (see pricing/catalog.js). That
  // is a packaging workaround, NOT permission to put logic in the catalog —
  // so the "inert data" property JSON used to give us syntactically is
  // asserted here instead. A price is data; anything that computes one is a
  // rate nobody can review by reading the file.
  const fs = await import("node:fs");
  const path = await import("node:path");
  const pricingDir = path.join(import.meta.dirname, "..", "pricing");
  const files = [
    path.join(pricingDir, "catalog.js"),
    ...fs.readdirSync(path.join(pricingDir, "providers"))
      .filter((f) => f.endsWith(".js"))
      .map((f) => path.join(pricingDir, "providers", f)),
  ];
  expect(files.length >= 6, `found the pricing modules (${files.length} files)`);

  for (const file of files) {
    const name = path.basename(file);
    // Strip the comment header before checking, so the explanatory prose that
    // mentions `import`/`assert` does not read as code.
    const body = fs.readFileSync(file, "utf8").replace(/^\s*\/\/.*$/gm, "").trim();
    expect(/^export default Object\.freeze\(/.test(body),
      `${name} is a single frozen default export`);
    expect(!/\bfunction\b|=>|\brequire\(|\bimport\b|\beval\b/.test(body),
      `${name} contains no functions, imports or eval — it is data, not code`);
    // The real guarantee, and it subsumes every hand-rolled pattern check:
    // if the unwrapped literal parses as JSON then it is data by definition —
    // JSON has no syntax for a template literal, a function, or a computed
    // value, so none can be hiding in it. (A backtick INSIDE a string value is
    // fine and does occur — several limitations quote config keys like
    // `mem_limit` — which is why this is a parse check, not a grep.)
    const literal = body.replace(/^export default Object\.freeze\(/, "").replace(/\);?$/, "");
    let parsed = null;
    try { parsed = JSON.parse(literal); } catch { /* stays null */ }
    expect(parsed !== null, `${name} is valid JSON once unwrapped — data by construction, not by convention`);
  }
}

console.log("");
if (failures === 0) {
  console.log("\x1b[32m  all estimator tests passed\x1b[0m\n");
  process.exit(0);
} else {
  console.log(`\x1b[31m  ${failures} estimator test(s) failed\x1b[0m\n`);
  process.exit(1);
}
