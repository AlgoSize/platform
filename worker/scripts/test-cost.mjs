// Tests for the cost analyzer:
//   - validateCostInput rejects malformed inputs cleanly
//   - analyzeCost flags each of the four waste patterns on representative
//     inputs and produces sensible savings totals
//   - analyzeCostHandler returns proper HTTP responses (4xx for bad input,
//     200 with the expected shape for good input)
//   - Router-level requireAuth gates the route (no token → 401)

import { validateCostInput, analyzeCost } from "../src/analyzers/cost.js";
import { parseCsv, analyzeCur, MAX_CUR_ROWS } from "../src/analyzers/cur.js";
import { analyzeCostHandler } from "../src/handlers/analyze.js";
import worker from "../src/index.js";
import { issueJWT } from "../src/auth.js";

import { makeD1 } from "./_d1-stub.mjs";

let failures = 0;
const ok   = (msg) => console.log(`  \x1b[32m✓\x1b[0m ${msg}`);
const fail = (msg) => { console.log(`  \x1b[31m✗\x1b[0m ${msg}`); failures++; };

function makeKV() {
  const store = new Map();
  return {
    async get(key)            { return store.has(key) ? store.get(key) : null; },
    async put(key, val)       { store.set(key, val); },
    async delete(key)         { store.delete(key); },
    _store: store,
  };
}

function makeEnv(overrides = {}) {
  return {
    JWT_SECRET: "jwt-test-secret-32-or-more-chars-please-okay",
    SITE_ORIGIN: "http://localhost:5000",
    COOKIE_NAME: "algosize_session",
    SESSIONS: makeKV(),
    USERS: makeKV(),
    DB: makeD1(),
    ...overrides,
  };
}

console.log("\nvalidateCostInput\n");

// 1. Non-object payload rejected
{
  const r = validateCostInput(null);
  if (!r.ok && r.error === "invalid_payload") ok("null payload rejected");
  else fail(`null payload verdict: ${JSON.stringify(r)}`);
}
{
  const r = validateCostInput([1, 2, 3]);
  if (!r.ok && r.error === "invalid_payload") ok("array payload rejected");
  else fail(`array payload verdict: ${JSON.stringify(r)}`);
}

// 2. Missing services rejected
{
  const r = validateCostInput({});
  if (!r.ok && r.error === "invalid_payload") ok("missing services rejected");
  else fail(`missing-services verdict: ${JSON.stringify(r)}`);
}

// 3. Empty services array rejected
{
  const r = validateCostInput({ services: [] });
  if (!r.ok && r.error === "invalid_payload") ok("empty services rejected");
  else fail(`empty-services verdict: ${JSON.stringify(r)}`);
}

// 4. Bad service shape rejected
{
  const r = validateCostInput({ services: [{ name: "EC2" /* no spend */ }] });
  if (!r.ok && r.error === "invalid_service") ok("service missing monthlySpend rejected");
  else fail(`bad-service verdict: ${JSON.stringify(r)}`);
}
{
  const r = validateCostInput({ services: [{ name: "EC2", monthlySpend: -5 }] });
  if (!r.ok && r.error === "invalid_service") ok("negative monthlySpend rejected");
  else fail(`negative-spend verdict: ${JSON.stringify(r)}`);
}
{
  const r = validateCostInput({ services: [{ name: "EC2", monthlySpend: 100, utilization: 1.5 }] });
  if (!r.ok && r.error === "invalid_service") ok("utilization > 1 rejected");
  else fail(`utilization verdict: ${JSON.stringify(r)}`);
}
{
  const r = validateCostInput({ services: [{ name: "EC2", monthlySpend: 100, category: "bogus" }] });
  if (!r.ok && r.error === "invalid_service") ok("unknown category rejected");
  else fail(`category verdict: ${JSON.stringify(r)}`);
}
{
  const r = validateCostInput({ services: [{ name: "  ", monthlySpend: 100 }] });
  if (!r.ok && r.error === "invalid_service") ok("blank name rejected");
  else fail(`blank-name verdict: ${JSON.stringify(r)}`);
}

// 5. Valid input passes and normalizes
{
  const r = validateCostInput({
    services: [
      { name: "EC2 web tier", monthlySpend: 1000 },
      { name: "S3 cold archive", monthlySpend: 50, category: "storage" },
    ],
  });
  if (r.ok &&
      r.value.services.length === 2 &&
      r.value.services[0].category === "compute" &&    // inferred
      r.value.services[1].category === "storage" &&    // explicit
      r.value.services[0].reserved === false) {
    ok("valid input normalizes (category inference, defaults)");
  } else {
    fail(`normalization verdict: ${JSON.stringify(r)}`);
  }
}

console.log("\nanalyzeCost — detectors\n");

// 6. Idle resource detected
{
  const out = analyzeCost({
    services: [{ name: "EC2 batch", monthlySpend: 800, utilization: 0.05, category: "compute", reserved: false }],
  });
  const idle = out.suggestions.find((s) => s.rule === "idle_resources");
  if (idle && idle.savingsEstimate > 0 && idle.service === "EC2 batch") {
    ok(`idle resource flagged ($${idle.savingsEstimate}/mo)`);
  } else {
    fail(`idle verdict: ${JSON.stringify(out)}`);
  }
}

// 7. Oversized instance detected
{
  const out = analyzeCost({
    services: [{ name: "EC2 api", monthlySpend: 600, utilization: 0.3, instanceSize: "m5.4xlarge", category: "compute", reserved: false }],
  });
  const ov = out.suggestions.find((s) => s.rule === "oversized_instances");
  if (ov && ov.savingsEstimate > 0 && /m5\.4xlarge/.test(ov.title)) {
    ok(`oversized instance flagged ($${ov.savingsEstimate}/mo)`);
  } else {
    fail(`oversized verdict: ${JSON.stringify(out)}`);
  }
}

// 8. Expensive egress detected
{
  const out = analyzeCost({
    services: [{ name: "Data transfer out", monthlySpend: 1200, category: "egress" }],
  });
  const eg = out.suggestions.find((s) => s.rule === "expensive_egress");
  if (eg && eg.savingsEstimate > 0 && /CDN/.test(eg.title)) {
    ok(`expensive egress flagged ($${eg.savingsEstimate}/mo)`);
  } else {
    fail(`egress verdict: ${JSON.stringify(out)}`);
  }
}

// 9. Unreserved compute detected
{
  const out = analyzeCost({
    services: [{ name: "EC2 web", monthlySpend: 2000, utilization: 0.7, category: "compute", reserved: false }],
  });
  const ur = out.suggestions.find((s) => s.rule === "unreserved_compute");
  if (ur && ur.savingsEstimate > 0 && /Savings Plan|Reserved/i.test(ur.title)) {
    ok(`unreserved compute flagged ($${ur.savingsEstimate}/mo)`);
  } else {
    fail(`unreserved verdict: ${JSON.stringify(out)}`);
  }
}

// 10. Reserved compute is NOT flagged for reservation
{
  const out = analyzeCost({
    services: [{ name: "EC2 web", monthlySpend: 2000, utilization: 0.7, category: "compute", reserved: true }],
  });
  if (!out.suggestions.some((s) => s.rule === "unreserved_compute")) {
    ok("reserved=true skips unreserved_compute detector");
  } else {
    fail(`reserved still got unreserved suggestion: ${JSON.stringify(out)}`);
  }
}

// 11. Idle service is not double-billed for reservation
{
  const out = analyzeCost({
    services: [{ name: "EC2 idle", monthlySpend: 500, utilization: 0.05, category: "compute", reserved: false }],
  });
  const hasUnreserved = out.suggestions.some((s) => s.rule === "unreserved_compute");
  if (!hasUnreserved) ok("idle compute not also flagged as unreserved (avoids double-counting)");
  else fail(`double-counted: ${JSON.stringify(out)}`);
}

console.log("\nanalyzeCost — aggregation\n");

// 12. currentSpend is sum of inputs
{
  const out = analyzeCost({
    services: [
      { name: "A", monthlySpend: 100, utilization: 0.5, category: "other", reserved: false },
      { name: "B", monthlySpend: 250, utilization: 0.5, category: "other", reserved: false },
    ],
  });
  if (out.currentSpend === 350) ok("currentSpend = sum of monthlySpend");
  else fail(`currentSpend = ${out.currentSpend}`);
}

// 13. Per-service savings cap (no service can have > 80% of its spend recovered)
{
  // A 5%-utilized unreserved compute service hits the idle detector (80%).
  // Without the cap, idle (80%) + any other rule could exceed 100%. Verify
  // the aggregate-per-service stays at 80% max.
  const out = analyzeCost({
    services: [{ name: "EC2 ghost", monthlySpend: 1000, utilization: 0.05, category: "compute", reserved: false, instanceSize: "m5.large" }],
  });
  const totalForService = out.suggestions
    .filter((s) => s.service === "EC2 ghost")
    .reduce((sum, s) => sum + s.savingsEstimate, 0);
  if (totalForService <= 800) ok(`per-service savings capped at 80% (got $${totalForService}/$1000)`);
  else fail(`per-service cap violated: $${totalForService}/$1000`);
}

// 14. totalSavingsPct reflects suggestions/spend
{
  const out = analyzeCost({
    services: [{ name: "EC2 idle", monthlySpend: 1000, utilization: 0.05, category: "compute", reserved: false }],
  });
  // Idle alone → 80% savings on a single $1000 service = 80.0
  if (out.totalSavingsPct === 80 || out.totalSavingsPct === 80.0) {
    ok(`totalSavingsPct = ${out.totalSavingsPct}% on a fully-idle workload`);
  } else {
    fail(`totalSavingsPct = ${out.totalSavingsPct}, expected 80`);
  }
}

// 15. Sample realistic payload returns multiple suggestions
{
  const out = analyzeCost({
    services: [
      { name: "EC2 web tier",      monthlySpend: 4000, utilization: 0.6, instanceSize: "m5.2xlarge", category: "compute", reserved: false },
      { name: "EC2 batch jobs",    monthlySpend: 1500, utilization: 0.08, category: "compute", reserved: false },
      { name: "S3 cold archive",   monthlySpend: 200,  category: "storage" },
      { name: "Data transfer out", monthlySpend: 800,  category: "egress" },
      { name: "RDS prod",          monthlySpend: 600,  category: "database", reserved: true },
    ],
  });
  const rules = new Set(out.suggestions.map((s) => s.rule));
  const expectedSubset = ["idle_resources", "expensive_egress", "unreserved_compute"];
  const allPresent = expectedSubset.every((r) => rules.has(r));
  const sortedDesc = out.suggestions.every(
    (s, i, arr) => i === 0 || arr[i - 1].savingsEstimate >= s.savingsEstimate,
  );
  if (allPresent && sortedDesc && out.totalSavingsPct > 5 && out.totalSavingsPct < 70) {
    ok(`realistic payload → ${out.suggestions.length} suggestions, ${out.totalSavingsPct}% projected savings, sorted desc`);
  } else {
    fail(`realistic payload verdict: rules=${[...rules].join(",")} pct=${out.totalSavingsPct} sorted=${sortedDesc}`);
  }
}

// 16. Payload with no waste returns empty suggestions, totalSavingsPct=0
{
  const out = analyzeCost({
    services: [
      { name: "RDS prod",       monthlySpend: 600, category: "database", reserved: true },
      { name: "S3 hot bucket",  monthlySpend: 80,  category: "storage" },
    ],
  });
  if (out.suggestions.length === 0 && out.totalSavingsPct === 0) {
    ok("no-waste payload → 0 suggestions, 0% savings");
  } else {
    fail(`no-waste verdict: ${JSON.stringify(out)}`);
  }
}

console.log("\nanalyzeCostHandler — HTTP layer\n");

// 17. Invalid JSON → 400
{
  const req = new Request("http://x/api/analyze/cost", { method: "POST", body: "not-json" });
  const res = await analyzeCostHandler(req, makeEnv());
  const body = await res.json();
  if (res.status === 400 && body.error === "invalid_json") ok("invalid JSON → 400 invalid_json");
  else fail(`invalid-json verdict: ${res.status} ${JSON.stringify(body)}`);
}

// 18. Validation failure → 400 with same error code as validator
{
  const req = new Request("http://x/api/analyze/cost", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  });
  const res = await analyzeCostHandler(req, makeEnv());
  const body = await res.json();
  if (res.status === 400 && body.error === "invalid_payload") ok("missing services → 400 invalid_payload");
  else fail(`validation-failure verdict: ${res.status} ${JSON.stringify(body)}`);
}

// 19. Good payload → 200 with the expected shape
{
  const req = new Request("http://x/api/analyze/cost", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      services: [
        { name: "EC2 web", monthlySpend: 1000, utilization: 0.7, category: "compute", reserved: false },
        { name: "EC2 idle", monthlySpend: 400, utilization: 0.05, category: "compute", reserved: false },
      ],
    }),
  });
  const res = await analyzeCostHandler(req, makeEnv());
  const body = await res.json();
  const shapeOk = typeof body.currentSpend === "number" &&
                  Array.isArray(body.suggestions) &&
                  typeof body.totalSavingsPct === "number" &&
                  body.suggestions.every((s) => typeof s.title === "string" &&
                                                 typeof s.impact === "string" &&
                                                 typeof s.savingsEstimate === "number");
  if (res.status === 200 && shapeOk && body.suggestions.length >= 2) {
    ok(`good payload → 200 with ${body.suggestions.length} suggestions, $${body.currentSpend}/mo current spend, ${body.totalSavingsPct}% projected savings`);
  } else {
    fail(`good-payload verdict: ${res.status} ${JSON.stringify(body)}`);
  }
}

console.log("\nRouter — auth gate on /api/analyze/cost\n");

// 20. No token → 401 (gate works at the router level)
{
  const env = makeEnv();
  const req = new Request("http://x/api/analyze/cost", {
    method: "POST",
    headers: { "content-type": "application/json", "Origin": "http://localhost:5000" },
    body: JSON.stringify({ services: [{ name: "EC2", monthlySpend: 100 }] }),
  });
  const res = await worker.fetch(req, env, {});
  const body = await res.json();
  if (res.status === 401 && body.error === "unauthorized" && body.reason === "missing_token") {
    ok("no token → 401 unauthorized (route is gated)");
  } else {
    fail(`no-token verdict: ${res.status} ${JSON.stringify(body)}`);
  }
}

// 21. Valid token → 200 (full pipeline)
{
  const env = makeEnv();
  const token = await issueJWT(env, "user_1", "alice@example.com", "active");
  const req = new Request("http://x/api/analyze/cost", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "Origin": "http://localhost:5000",
      "Authorization": `Bearer ${token}`,
    },
    body: JSON.stringify({
      services: [{ name: "EC2 web", monthlySpend: 2000, utilization: 0.7, category: "compute", reserved: false }],
    }),
  });
  const res = await worker.fetch(req, env, {});
  const body = await res.json();
  if (res.status === 200 && body.suggestions.length > 0 && body.currentSpend === 2000) {
    ok("valid token + good payload → 200 with suggestions");
  } else {
    fail(`auth+payload verdict: ${res.status} ${JSON.stringify(body)}`);
  }
}

// 22. Tampered token → 401
{
  const env = makeEnv();
  const token = await issueJWT(env, "user_1", "alice@example.com", "active");
  const tampered = token.slice(0, -2) + (token.slice(-2) === "AA" ? "BB" : "AA");
  const req = new Request("http://x/api/analyze/cost", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "Origin": "http://localhost:5000",
      "Authorization": `Bearer ${tampered}`,
    },
    body: JSON.stringify({ services: [{ name: "EC2", monthlySpend: 100 }] }),
  });
  const res = await worker.fetch(req, env, {});
  if (res.status === 401) ok("tampered token → 401 unauthorized");
  else fail(`tampered-token verdict: ${res.status}`);
}

// ---------------------------------------------------------------------------
// Task #14 — CUR (AWS Cost & Usage Report) ingest
// ---------------------------------------------------------------------------

console.log("\nparseCsv — RFC 4180 edge cases\n");

// 23. Plain rows
{
  const rows = parseCsv("a,b,c\n1,2,3\n4,5,6\n");
  if (rows.length === 3 && rows[0].join("|") === "a|b|c" && rows[2].join("|") === "4|5|6") {
    ok("parseCsv handles plain rows");
  } else fail(`plain rows: ${JSON.stringify(rows)}`);
}

// 24. Quoted field with embedded comma
{
  const rows = parseCsv('a,"b,c",d\n');
  if (rows.length === 1 && rows[0].length === 3 && rows[0][1] === "b,c") {
    ok("parseCsv handles embedded commas in quoted fields");
  } else fail(`quoted comma: ${JSON.stringify(rows)}`);
}

// 25. Escaped double-quote inside quoted field
{
  const rows = parseCsv('a,"he said ""hi""",b\n');
  if (rows[0][1] === 'he said "hi"') ok("parseCsv handles escaped \"\" inside quoted fields");
  else fail(`escaped quote: ${JSON.stringify(rows)}`);
}

// 26. CRLF line endings
{
  const rows = parseCsv("a,b\r\n1,2\r\n");
  if (rows.length === 2 && rows[0].join("|") === "a|b" && rows[1].join("|") === "1|2") {
    ok("parseCsv handles CRLF line endings");
  } else fail(`CRLF: ${JSON.stringify(rows)}`);
}

// 27. Trailing row without newline
{
  const rows = parseCsv("a,b\n1,2");
  if (rows.length === 2 && rows[1].join("|") === "1|2") ok("parseCsv handles missing trailing newline");
  else fail(`no trailing newline: ${JSON.stringify(rows)}`);
}

// 27b. UTF-8 BOM is stripped (regression: many CSV exporters emit a BOM)
{
  const rows = parseCsv("\uFEFFa,b\n1,2\n");
  if (rows[0][0] === "a" && rows[0][1] === "b") ok("parseCsv strips UTF-8 BOM");
  else fail(`BOM not stripped: first header = ${JSON.stringify(rows[0][0])}`);
}

// (BOM-prefixed CUR end-to-end test 39b lives below, after the fixture
// declaration, since it depends on CUR_SAMPLE.)

// ---------------------------------------------------------------------------
// CUR fixture — small synthetic Cost & Usage Report exercising all 3 heuristics
// ---------------------------------------------------------------------------
//
// EC2 OnDemand: $1450 + $640 = $2090
// RDS OnDemand: $1180 + $42  = $1222
//   → on-demand compute = $3312, savings ~30% = $994
// gp2 EBS: $310 → savings ~20% = $62
// Oversized RDS (db.r5.4xlarge): $1180 → savings ~40% = $472
// EC2 Reserved (c6i.2xlarge $820), gp3 ($90), S3 ($210), DataTransfer ($470)
// Tax row ($180) is filtered out.
// Total Usage spend: $1450+640+820+1180+42+310+90+210+470 = $5212

const CUR_SAMPLE = [
  "identity/LineItemId,bill/PayerAccountId,lineItem/UsageStartDate,lineItem/ProductCode,lineItem/UsageType,lineItem/LineItemType,lineItem/UnblendedCost,pricing/term",
  "1,123456789012,2024-01-01T00:00:00Z,AmazonEC2,USE1-BoxUsage:m5.xlarge,Usage,1450.00,OnDemand",
  "2,123456789012,2024-01-01T00:00:00Z,AmazonEC2,USE1-BoxUsage:m5.large,Usage,640.00,OnDemand",
  "3,123456789012,2024-01-01T00:00:00Z,AmazonEC2,USE1-BoxUsage:c6i.2xlarge,Usage,820.00,Reserved",
  "4,123456789012,2024-01-01T00:00:00Z,AmazonRDS,USE1-InstanceUsage:db.r5.4xlarge,Usage,1180.00,OnDemand",
  "5,123456789012,2024-01-01T00:00:00Z,AmazonRDS,USE1-InstanceUsage:db.t3.medium,Usage,42.00,OnDemand",
  "6,123456789012,2024-01-01T00:00:00Z,AmazonEBS,USE1-EBS:VolumeUsage.gp2,Usage,310.00,OnDemand",
  "7,123456789012,2024-01-01T00:00:00Z,AmazonEBS,USE1-EBS:VolumeUsage.gp3,Usage,90.00,OnDemand",
  "8,123456789012,2024-01-01T00:00:00Z,AmazonS3,USE1-TimedStorage-ByteHrs,Usage,210.00,",
  "9,123456789012,2024-01-01T00:00:00Z,AWSDataTransfer,USE1-EUC1-AWS-Out-Bytes,Usage,470.00,",
  "10,123456789012,2024-01-01T00:00:00Z,AmazonEC2,Tax,Tax,180.00,",
  ""
].join("\n");

console.log("\nanalyzeCur — heuristics + aggregation\n");

// 28. Empty / null input
{
  let threw = false;
  try { analyzeCur(""); } catch (e) { threw = e?.curError === true; }
  if (threw) ok("empty CUR throws curError");
  else fail("empty CUR did not throw curError");
}

// 29. Header-only CSV
{
  let threw = false;
  try { analyzeCur("lineItem/ProductCode,lineItem/UsageType,lineItem/UnblendedCost\n"); }
  catch (e) { threw = e?.curError === true; }
  if (threw) ok("header-only CSV throws curError");
  else fail("header-only CSV did not throw");
}

// 30. Missing required column
{
  let threw = false;
  let msg = "";
  try { analyzeCur("foo,bar\n1,2\n"); } catch (e) { threw = e?.curError === true; msg = e?.message || ""; }
  if (threw && /required column/.test(msg)) ok("missing required column throws curError with helpful message");
  else fail(`missing column verdict: threw=${threw} msg=${msg}`);
}

// 31. Sample CUR — currentSpend (Usage rows only, Tax filtered)
{
  const out = analyzeCur(CUR_SAMPLE);
  if (out.currentSpend === 5212) ok(`currentSpend = $${out.currentSpend} (Tax filtered)`);
  else fail(`currentSpend = ${out.currentSpend} (expected 5212)`);
}

// 32. Sample CUR — all three heuristics fire
{
  const out = analyzeCur(CUR_SAMPLE);
  const rules = new Set(out.suggestions.map((s) => s.rule));
  const expected = ["ri_sp_coverage_gap", "legacy_ebs_storage", "oversized_rds"];
  const missing = expected.filter((r) => !rules.has(r));
  if (missing.length === 0) ok(`all 3 heuristics fire (${[...rules].join(", ")})`);
  else fail(`missing heuristics: ${missing.join(", ")} — got ${[...rules].join(", ")}`);
}

// 33. Sample CUR — RI/SP savings is roughly 30% of on-demand compute spend
{
  const out = analyzeCur(CUR_SAMPLE);
  const ri = out.suggestions.find((s) => s.rule === "ri_sp_coverage_gap");
  // EC2 on-demand $2090 + RDS on-demand $1222 = $3312 → 30% = $994
  if (ri && ri.savingsEstimate >= 990 && ri.savingsEstimate <= 1000) {
    ok(`RI/SP coverage gap savings ~$${ri.savingsEstimate} (~30% of $3312)`);
  } else fail(`ri_sp savings = ${ri?.savingsEstimate} (expected ~$994)`);
}

// 34. Sample CUR — gp2 savings is roughly 20% of gp2 spend
{
  const out = analyzeCur(CUR_SAMPLE);
  const gp = out.suggestions.find((s) => s.rule === "legacy_ebs_storage");
  // gp2 spend $310 → 20% = $62
  if (gp && gp.savingsEstimate >= 60 && gp.savingsEstimate <= 64) {
    ok(`gp2→gp3 savings ~$${gp.savingsEstimate} (~20% of $310)`);
  } else fail(`gp2 savings = ${gp?.savingsEstimate} (expected ~$62)`);
}

// 35. Sample CUR — oversized RDS savings is roughly 40% of big-RDS spend
{
  const out = analyzeCur(CUR_SAMPLE);
  const ov = out.suggestions.find((s) => s.rule === "oversized_rds");
  // db.r5.4xlarge $1180 → 40% = $472
  if (ov && ov.savingsEstimate >= 470 && ov.savingsEstimate <= 475) {
    ok(`oversized RDS savings ~$${ov.savingsEstimate} (~40% of $1180)`);
  } else fail(`oversized_rds savings = ${ov?.savingsEstimate} (expected ~$472)`);
}

// 36. Sample CUR — topItems is 10 items max, sorted desc, with the right shape
{
  const out = analyzeCur(CUR_SAMPLE);
  if (!Array.isArray(out.topItems) || out.topItems.length === 0) {
    fail(`topItems missing: ${JSON.stringify(out.topItems)}`);
  } else {
    const sortedDesc = out.topItems.every(
      (it, i, arr) => i === 0 || arr[i - 1].monthlySpend >= it.monthlySpend,
    );
    const shapeOk = out.topItems.every(
      (it) =>
        typeof it.service === "string" &&
        typeof it.usageType === "string" &&
        typeof it.term === "string" &&
        typeof it.monthlySpend === "number",
    );
    if (out.topItems.length <= 10 && sortedDesc && shapeOk) {
      ok(`topItems: ${out.topItems.length} items, sorted desc, correct shape`);
    } else {
      fail(`topItems verdict: len=${out.topItems.length} sorted=${sortedDesc} shape=${shapeOk}`);
    }
  }
}

// 37. Sample CUR — top item is m5.xlarge ($1450)
{
  const out = analyzeCur(CUR_SAMPLE);
  const top = out.topItems[0];
  if (top.service === "EC2" && /m5\.xlarge/.test(top.usageType) && top.monthlySpend === 1450) {
    ok(`top line item is EC2 m5.xlarge at $${top.monthlySpend}`);
  } else fail(`top item: ${JSON.stringify(top)}`);
}

// 38. Pretty service names map productCode → short name
{
  const out = analyzeCur(CUR_SAMPLE);
  const services = out.topItems.map((it) => it.service);
  if (services.includes("EC2") && services.includes("RDS") && services.includes("EBS")) {
    ok(`productCode → short name (EC2, RDS, EBS present)`);
  } else fail(`pretty names: ${services.join(", ")}`);
}

// 38b. analyzeCur succeeds on BOM-prefixed CUR (the bug architect caught)
{
  const withBom = "\uFEFF" + CUR_SAMPLE;
  let succeeded = false;
  try {
    const out = analyzeCur(withBom);
    succeeded = out.currentSpend === 5212 && out.suggestions.length >= 3;
  } catch (e) { /* fall through */ }
  if (succeeded) ok("analyzeCur accepts BOM-prefixed CUR (real-world Excel/S3 exports)");
  else fail("analyzeCur rejected a valid BOM-prefixed CUR");
}

// 39. Reserved EC2 line is not double-counted in RI/SP gap
{
  const out = analyzeCur(CUR_SAMPLE);
  const ri = out.suggestions.find((s) => s.rule === "ri_sp_coverage_gap");
  // If c6i.2xlarge ($820 Reserved) leaked into the RI gap, savings would be
  // ~30% of $4132 = ~$1240 instead of ~$994.
  if (ri && ri.savingsEstimate < 1100) ok("Reserved-term line items skipped by RI/SP detector");
  else fail(`Reserved leak: ri_sp savings = ${ri?.savingsEstimate}`);
}

console.log("\nanalyzeCostHandler — CUR upload paths\n");

// 40. text/csv POST → 200 with full result
{
  const req = new Request("http://x/api/analyze/cost", {
    method: "POST",
    headers: { "content-type": "text/csv" },
    body: CUR_SAMPLE,
  });
  const res = await analyzeCostHandler(req, makeEnv());
  const body = await res.json();
  if (
    res.status === 200 &&
    typeof body.currentSpend === "number" &&
    Array.isArray(body.suggestions) &&
    Array.isArray(body.topItems) &&
    body.suggestions.length >= 3
  ) {
    ok(`text/csv POST → 200 with ${body.suggestions.length} suggestions, ${body.topItems.length} top items`);
  } else fail(`text/csv verdict: ${res.status} ${JSON.stringify(body).slice(0, 200)}`);
}

// 41. multipart/form-data POST → 200
{
  const fd = new FormData();
  fd.append("file", new Blob([CUR_SAMPLE], { type: "text/csv" }), "my.csv");
  const req = new Request("http://x/api/analyze/cost", { method: "POST", body: fd });
  const res = await analyzeCostHandler(req, makeEnv());
  const body = await res.json();
  if (res.status === 200 && body.suggestions.length >= 3 && body.topItems.length >= 1) {
    ok(`multipart upload → 200 with ${body.suggestions.length} suggestions`);
  } else fail(`multipart verdict: ${res.status} ${JSON.stringify(body).slice(0, 200)}`);
}

// 42. multipart with no `file` field → 400 missing_file
{
  const fd = new FormData();
  fd.append("notfile", "foo");
  const req = new Request("http://x/api/analyze/cost", { method: "POST", body: fd });
  const res = await analyzeCostHandler(req, makeEnv());
  const body = await res.json();
  if (res.status === 400 && body.error === "missing_file") ok("multipart with no file → 400 missing_file");
  else fail(`missing_file verdict: ${res.status} ${JSON.stringify(body)}`);
}

// 43. Malformed CSV (missing required column) → 400 invalid_cur with helpUrl
{
  const req = new Request("http://x/api/analyze/cost", {
    method: "POST",
    headers: { "content-type": "text/csv" },
    body: "foo,bar\n1,2\n",
  });
  const res = await analyzeCostHandler(req, makeEnv());
  const body = await res.json();
  if (
    res.status === 400 &&
    body.error === "invalid_cur" &&
    typeof body.helpUrl === "string" &&
    /docs\.aws\.amazon\.com/.test(body.helpUrl)
  ) {
    ok("malformed CUR → 400 invalid_cur with AWS docs helpUrl");
  } else fail(`invalid_cur verdict: ${res.status} ${JSON.stringify(body)}`);
}

// 43b. Oversized text/csv WITHOUT Content-Length → 413 file_too_large
//      (the bug architect caught: post-read size guard, not just header check)
{
  // Build a payload that exceeds the 100 MB cap. We use a 101 MB string of
  // 'x' characters (no commas/newlines so it parses as a single 1-row 1-col
  // CSV if it ever reached the parser — but it shouldn't).
  const oversize = "x".repeat(101 * 1024 * 1024);
  const req = new Request("http://x/api/analyze/cost", {
    method: "POST",
    headers: { "content-type": "text/csv" }, // no Content-Length
    body: oversize,
  });
  const res = await analyzeCostHandler(req, makeEnv());
  const body = await res.json();
  if (res.status === 413 && body.error === "file_too_large") {
    ok("oversized text/csv (no Content-Length) → 413 file_too_large");
  } else fail(`oversize verdict: ${res.status} ${JSON.stringify(body).slice(0, 120)}`);
}

// 43c. Row-count safety cap fires before the parser runs out of memory
//      (defense-in-depth alongside the byte cap)
{
  // Build a CSV with header + (MAX_CUR_ROWS + 1) tiny data rows. Each row is
  // ~50 bytes, so this stays well under the 100 MB byte cap and exercises
  // ONLY the row-count cap — exactly what we want to test.
  const header = "lineItem/ProductCode,lineItem/UsageType,lineItem/UnblendedCost";
  const dataRow = "AmazonS3,USE1-TimedStorage-ByteHrs,0.01";
  const big = header + "\n" + (dataRow + "\n").repeat(MAX_CUR_ROWS + 1);
  let threw = false;
  let msg = "";
  try { analyzeCur(big); } catch (e) { threw = e?.curError === true; msg = e?.message || ""; }
  if (threw && /safety cap|row-count|rows/i.test(msg)) {
    ok(`row-count cap fires at >${MAX_CUR_ROWS.toLocaleString("en-US")} rows`);
  } else fail(`row-cap verdict: threw=${threw} msg=${msg.slice(0, 120)}`);
}

// 44. Empty CSV body → 400 invalid_cur
{
  const req = new Request("http://x/api/analyze/cost", {
    method: "POST",
    headers: { "content-type": "text/csv" },
    body: "",
  });
  const res = await analyzeCostHandler(req, makeEnv());
  const body = await res.json();
  if (res.status === 400 && body.error === "invalid_cur") ok("empty CSV → 400 invalid_cur");
  else fail(`empty-csv verdict: ${res.status} ${JSON.stringify(body)}`);
}

// 45. JSON path still works after CUR dispatch was added (regression guard)
{
  const req = new Request("http://x/api/analyze/cost", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      services: [{ name: "EC2 web", monthlySpend: 1000, utilization: 0.7, category: "compute", reserved: false }],
    }),
  });
  const res = await analyzeCostHandler(req, makeEnv());
  const body = await res.json();
  if (res.status === 200 && Array.isArray(body.suggestions) && body.topItems === undefined) {
    ok("JSON path unchanged after CUR dispatch (no topItems leak)");
  } else fail(`JSON regression: ${res.status} ${JSON.stringify(body).slice(0, 200)}`);
}

console.log("\nRouter — auth gate on CUR upload\n");

// 46. CUR upload requires auth (no token → 401)
{
  const env = makeEnv();
  const req = new Request("http://x/api/analyze/cost", {
    method: "POST",
    headers: { "content-type": "text/csv", "Origin": "http://localhost:5000" },
    body: CUR_SAMPLE,
  });
  const res = await worker.fetch(req, env, {});
  const body = await res.json();
  if (res.status === 401 && body.error === "unauthorized") {
    ok("CUR upload without token → 401 (router gates the route)");
  } else fail(`CUR auth verdict: ${res.status} ${JSON.stringify(body)}`);
}

// 47. CUR upload with valid token → 200 (full pipeline)
{
  const env = makeEnv();
  const token = await issueJWT(env, "user_1", "alice@example.com", "active");
  const req = new Request("http://x/api/analyze/cost", {
    method: "POST",
    headers: {
      "content-type": "text/csv",
      "Origin": "http://localhost:5000",
      "Authorization": `Bearer ${token}`,
    },
    body: CUR_SAMPLE,
  });
  const res = await worker.fetch(req, env, {});
  const body = await res.json();
  if (res.status === 200 && body.currentSpend === 5212 && body.topItems.length > 0) {
    ok("CUR upload + valid token → 200 with full result");
  } else fail(`CUR auth+payload verdict: ${res.status} ${JSON.stringify(body).slice(0, 200)}`);
}

// ---- Done ----
console.log();
if (failures === 0) console.log("All cost-analyzer tests passed.");
else { console.log(`${failures} test(s) failed.`); process.exit(1); }
