// Infrastructure Cost Estimator — HTTP boundary tests.
//
// Run with:  node scripts/test-estimate-api.mjs
//
// The behavioural tests matter, but the ones that matter MOST are the leak
// tests near the bottom. The estimator's whole security posture is "the
// configuration you upload is never written down anywhere", and that is a
// property of this boundary, not of the pure core. So the strongest test here
// does not inspect internals at all: it plants a distinctive marker string
// inside a hostile payload, captures every byte written to console during the
// request, and asserts the marker never appears. That catches a leak through
// any path — a log line, an error message, a stack, a Sentry event — including
// paths added after this test was written.

import { estimateHandler, estimateProvidersHandler, sanitizedFailure, INPUT_TYPES, DISCLAIMER } from "../src/handlers/estimate.js";
import { adaptCompose, parseComposeMemoryToMilliGiB } from "../src/estimator/adapters/compose.js";
import { adaptManual } from "../src/estimator/adapters/manual.js";
import { validateSpec } from "../src/estimator/spec.js";

let failures = 0;
const ok = (m) => console.log(`  \x1b[32m✓\x1b[0m ${m}`);
const fail = (m) => { console.log(`  \x1b[31m✗\x1b[0m ${m}`); failures++; };
const expect = (c, m) => c ? ok(m) : fail(m);

const post = (body) => new Request("https://x/api/estimate", {
  method: "POST",
  headers: { "content-type": "application/json", "cf-ray": "test-ray-001" },
  body: typeof body === "string" ? body : JSON.stringify(body),
});

const call = async (body, env = {}) => {
  const res = await estimateHandler(post(body), env, null);
  let json = null;
  try { json = await res.clone().json(); } catch { /* non-JSON body */ }
  return { res, json };
};

/** Run `fn` with every console channel captured. Returns [result, output]. */
async function captureConsole(fn) {
  const chunks = [];
  const orig = { log: console.log, warn: console.warn, error: console.error, info: console.info };
  const grab = (...args) => {
    for (const a of args) {
      try { chunks.push(typeof a === "string" ? a : JSON.stringify(a)); }
      catch { chunks.push(String(a)); }
    }
  };
  console.log = grab; console.warn = grab; console.error = grab; console.info = grab;
  try {
    const result = await fn();
    return [result, chunks.join("\n")];
  } finally {
    Object.assign(console, orig);
  }
}

const K8S = `
apiVersion: apps/v1
kind: Deployment
metadata:
  name: api
spec:
  replicas: 2
  template:
    spec:
      containers:
        - name: web
          resources:
            requests:
              cpu: "500m"
              memory: "1Gi"
`;

const COMPOSE = `
services:
  web:
    image: nginx
    deploy:
      replicas: 2
      resources:
        limits:
          cpus: "1.0"
          memory: 2G
`;

// ---------------------------------------------------------------------------
console.log("\ncompose adapter — units and shapes\n");
// ---------------------------------------------------------------------------
{
  // The trap this adapter exists for: Compose byte units are 1024-based, so
  // 512M is 512 MiB. The Kubernetes parser would read it as 512 MB (decimal)
  // and under-report by ~4.8%.
  expect(parseComposeMemoryToMilliGiB("512M") === 500, "Compose 512M is 512 MiB (0.5 GiB), not 512 MB");
  expect(parseComposeMemoryToMilliGiB("1g") === 1000, "Compose 1g is 1 GiB");
  expect(parseComposeMemoryToMilliGiB("536870912") === 500, "a bare Compose memory value is bytes");
  expect(parseComposeMemoryToMilliGiB("") === null && parseComposeMemoryToMilliGiB(undefined) === null,
    "absent memory is null, not zero");
  let threw = null;
  try { parseComposeMemoryToMilliGiB("2 gigs"); } catch (e) { threw = e; }
  expect(threw && threw.code === "invalid_memory_quantity", "an unreadable memory value throws rather than pricing at zero");

  const r = adaptCompose(COMPOSE, { capacityBasis: "limits" });
  expect(r.resources.length === 1 && r.resources[0].quantity === 2, "compose replicas become quantity");
  expect(r.resources[0].cpuMilli === 1000 && r.resources[0].memoryMilliGiB === 2000, "compose limits parsed");
  expect(r.warnings.some((w) => w.code === "compose_has_no_infrastructure"),
    "compose estimate states that volumes/databases/egress are not in the file");

  const legacy = adaptCompose(`
services:
  db:
    mem_limit: 1g
    cpus: 2
`);
  expect(legacy.resources[0].cpuMilli === 2000 && legacy.resources[0].memoryMilliGiB === 1000,
    "legacy v2 cpus/mem_limit are read");
  expect(legacy.warnings.some((w) => w.code === "legacy_compose_limits"), "and the legacy spelling is called out");

  const bare = adaptCompose(`
services:
  redis:
    image: redis
`);
  expect(bare.resources[0].cpuMilli === undefined && bare.warnings.some((w) => w.code === "service_without_resources"),
    "a service with no limits is unsupported, never free");

  let noSvc = null;
  try { adaptCompose("version: '3'\nvolumes:\n  data:\n"); } catch (e) { noSvc = e; }
  expect(noSvc && noSvc.code === "malformed_document", "a file with no services block is rejected");
}

// ---------------------------------------------------------------------------
console.log("\nmanual adapter — the form-string trap\n");
// ---------------------------------------------------------------------------
{
  // validateSpec reads a STRING memoryGiB with the Kubernetes rule, where a
  // bare number is bytes. A form posts strings. Without this adapter a user
  // typing 4 into a box labelled GiB is priced at 4 bytes.
  const { spec: unsafe } = validateSpec({
    duration: { value: 1, unit: "month" },
    resources: [{ id: "api", type: "container", memoryGiB: "4", cpuCores: 2 }],
  });
  expect(unsafe.resources[0].memoryMilliGiB === 0,
    "confirmed: raw form strings into validateSpec price 4 GiB as 4 bytes (~0)");

  const out = adaptManual({ resources: [{ name: "api", cpuCores: "2", memoryGiB: "4", quantity: "3" }] });
  const { spec } = validateSpec({ duration: { value: 1, unit: "month" }, resources: out.resources });
  expect(spec.resources[0].memoryMilliGiB === 4000, "the manual adapter reads a bare 4 in a GiB box as 4 GiB");
  expect(spec.resources[0].cpuMilli === 2000 && spec.resources[0].quantity === 3, "and coerces cpu/quantity strings");

  const suffixed = adaptManual({ resources: [{ name: "c", memoryGiB: "512Mi" }] });
  expect(suffixed.resources[0].memoryMilliGiB === 500, "an explicitly suffixed 512Mi is still honoured as written");

  const blanks = adaptManual({ resources: [
    { name: "real", cpuCores: "1" },
    { name: "", cpuCores: "", memoryGiB: "" },
  ]});
  expect(blanks.resources.length === 1, "trailing blank form rows are skipped, not errors");
  expect(blanks.warnings.some((w) => w.code === "blank_rows_skipped"), "and the skip is reported");

  let allBlank = null;
  try { adaptManual({ resources: [{ name: "", cpuCores: "" }] }); } catch (e) { allBlank = e; }
  expect(allBlank && allBlank.code === "empty_input", "an entirely empty form is rejected");

  let junk = null;
  try { adaptManual({ resources: [{ name: "x", cpuCores: "abc" }] }); } catch (e) { junk = e; }
  expect(junk && junk.code, "non-numeric input throws rather than becoming a silent zero");
}

// ---------------------------------------------------------------------------
console.log("\nPOST /api/estimate — happy paths\n");
// ---------------------------------------------------------------------------
{
  const { res, json } = await call({ inputType: "kubernetes", content: K8S, options: { providers: ["aws"], egressGiB: 0 } });
  expect(res.status === 200, `kubernetes input returns 200 (got ${res.status})`);
  expect(Array.isArray(json.providers) && json.providers.length === 1, "one provider was priced");
  expect(json.providers[0].estimatedTotalMicroUsd > 0, "and produced a non-zero total");
  expect(json.disclaimer && /not a bill/i.test(json.disclaimer.estimate), "response carries the estimate disclaimer");
  expect(/do not connect to or access your cloud account/i.test(json.disclaimer.privacy),
    "and the required privacy sentence, verbatim");
  expect(json.requestId === "test-ray-001", "cf-ray is used as the request id");
  expect(json.catalogFreshness && json.catalogFreshness.aws, "per-provider catalog freshness is returned");

  const compose = await call({ inputType: "compose", content: COMPOSE, options: { providers: ["digitalocean"], egressGiB: 0 } });
  expect(compose.res.status === 200 && compose.json.providers[0].providerId === "digitalocean", "compose input prices");

  const manual = await call({
    inputType: "manual",
    content: { resources: [{ name: "api", cpuCores: "2", memoryGiB: "4" }] },
    options: { providers: ["aws"], duration: { value: 1, unit: "month" }, egressGiB: 0 },
  });
  expect(manual.res.status === 200, "manual input prices");
  expect(manual.json.normalizedSpec.resources[0].memoryMilliGiB === 4000, "manual memory survives the boundary as 4 GiB");

  const multi = await call({ inputType: "kubernetes", content: K8S, options: { egressGiB: 0 } });
  expect(multi.json.providers.length >= 3, "omitting providers compares the whole catalog");
}

// ---------------------------------------------------------------------------
console.log("\nPOST /api/estimate — rejections are bounded\n");
// ---------------------------------------------------------------------------
{
  const bad = await estimateHandler(post("{not json"), {}, null);
  expect(bad.status === 400, "malformed JSON is a 400");

  const type = await call({ inputType: "helm", content: "x" });
  expect(type.res.status === 400 && type.json.error === "unsupported_input_type", "an unknown inputType is refused");
  expect(Array.isArray(type.json.supported) && type.json.supported.length === INPUT_TYPES.length,
    "and the refusal lists what IS supported");

  const empty = await call({ inputType: "kubernetes" });
  expect(empty.res.status === 400 && empty.json.error === "empty_input", "missing content is a 400");

  const big = await call({ inputType: "kubernetes", content: "x".repeat(2 * 1024 * 1024 + 1) });
  expect(big.res.status === 413 && big.json.error === "input_too_large", "oversized input is a 413");

  const provider = await call({ inputType: "kubernetes", content: K8S, options: { providers: ["azure"] } });
  expect(provider.res.status === 400 && provider.json.error === "unknown_provider", "an unknown provider is refused by name");
}

// ---------------------------------------------------------------------------
console.log("\nsecret rejection — reported without the value\n");
// ---------------------------------------------------------------------------
{
  const SECRET = "AKIAIOSFODNN7EXAMPLE";
  const withSecret = `
apiVersion: v1
kind: Pod
metadata:
  name: leaky
spec:
  containers:
    - name: app
      env:
        - name: AWS_ACCESS_KEY_ID
          value: ${SECRET}
      resources:
        requests:
          cpu: "1"
          memory: "1Gi"
`;
  const { res, json } = await call({ inputType: "kubernetes", content: withSecret });
  expect(res.status === 400 && json.error === "secrets_detected", "a manifest containing a credential is refused");
  const serialized = JSON.stringify(json);
  expect(!serialized.includes(SECRET), "and the response does NOT echo the credential back");
  expect(Array.isArray(json.detected) && json.detected.length > 0 && json.detected[0].line,
    "but does say which line to fix");
}

// ---------------------------------------------------------------------------
console.log("\nthe log line carries only the permitted fields\n");
// ---------------------------------------------------------------------------
{
  const [, output] = await captureConsole(() =>
    call({ inputType: "kubernetes", content: K8S, options: { providers: ["aws"], egressGiB: 0 } }));

  const line = output.split("\n").find((l) => l.trim().startsWith("{"));
  expect(Boolean(line), "the endpoint emits a structured log line");
  const parsed = JSON.parse(line);
  const permitted = ["requestId", "inputType", "resourceCount", "providerIds", "durationMs", "parserStatus", "errorCategory"];
  const actual = Object.keys(parsed).sort();
  expect(JSON.stringify(actual) === JSON.stringify([...permitted].sort()),
    `log line has exactly the permitted keys (got ${actual.join(",")})`);
  expect(parsed.inputType === "kubernetes" && parsed.resourceCount === 1 && parsed.parserStatus === "ok",
    "and reports input type, resource count and parser status");
  expect(Array.isArray(parsed.providerIds) && parsed.providerIds[0] === "aws", "and the provider ids");
  expect(typeof parsed.durationMs === "number", "and an execution duration");
}

// ---------------------------------------------------------------------------
console.log("\nleak sweep — uploaded content never reaches any console channel\n");
// ---------------------------------------------------------------------------
{
  // Markers chosen to look like the things that actually leak: an internal
  // hostname, a service name, a region, and a credential.
  const MARKERS = ["payments-db-prod-internal", "acme-secret-topology", "AKIAIOSFODNN7EXAMPLE"];
  const hostile = `
apiVersion: apps/v1
kind: Deployment
metadata:
  name: ${MARKERS[0]}
  labels:
    project: ${MARKERS[1]}
spec:
  replicas: 2
  template:
    spec:
      containers:
        - name: ${MARKERS[1]}
          env:
            - name: AWS_ACCESS_KEY_ID
              value: ${MARKERS[2]}
          resources:
            requests:
              cpu: "500m"
              memory: "1Gi"
`;
  const [, secretOut] = await captureConsole(() => call({ inputType: "kubernetes", content: hostile }));
  for (const m of MARKERS) {
    expect(!secretOut.includes(m), `rejected upload: "${m.slice(0, 24)}" never appears in console output`);
  }

  // Same sweep on the SUCCESS path — a clean document still contains names
  // and topology that must not be logged just because it parsed.
  const clean = hostile.replace(/\n          env:\n(.*\n){2}/, "\n");
  const [, okOut] = await captureConsole(() =>
    call({ inputType: "kubernetes", content: clean, options: { providers: ["aws"], egressGiB: 0 } }));
  for (const m of [MARKERS[0], MARKERS[1]]) {
    expect(!okOut.includes(m), `successful estimate: "${m.slice(0, 24)}" never appears in console output`);
  }

  // A Sentry DSN being configured must not change the answer: captureException
  // emits a structured log on every call regardless of transport.
  const [, sentryOut] = await captureConsole(() =>
    call({ inputType: "kubernetes", content: hostile }, { SENTRY_DSN: "https://k@o0.ingest.sentry.io/1" }));
  for (const m of MARKERS) {
    expect(!sentryOut.includes(m), `with Sentry configured: "${m.slice(0, 24)}" still never appears`);
  }
}

// ---------------------------------------------------------------------------
console.log("\nsanitizedFailure — a bug is reportable without the request\n");
// ---------------------------------------------------------------------------
{
  const leaky = new TypeError('Unexpected token } in JSON at position 42 near "payments-db-prod"');
  const safe = sanitizedFailure(leaky, "parse_failed");
  expect(!safe.message.includes("payments-db-prod"), "the original message is discarded");
  expect(safe.message === "estimate failed: parse_failed", "and replaced by a bounded category");
  expect(!String(safe.stack).includes("payments-db-prod"),
    "the stack HEADER is rebuilt too — V8 puts the message on stack line 1");
  expect(safe.name === "TypeError", "the error type is kept, since it names a code path not a value");
  expect(/\bat\b/.test(String(safe.stack)) || String(safe.stack).split("\n").length >= 1,
    "stack frames survive, so the bug is still diagnosable");

  const noStack = sanitizedFailure({ name: "Error" }, "engine_failed");
  expect(noStack.message === "estimate failed: engine_failed", "an error with no stack still sanitizes cleanly");
}

// ---------------------------------------------------------------------------
console.log("\nGET /api/estimate/providers — metadata without a rate card\n");
// ---------------------------------------------------------------------------
{
  const res = await estimateProvidersHandler(new Request("https://x/api/estimate/providers"), {}, null);
  const body = await res.json();
  expect(res.status === 200 && Array.isArray(body.providers), "provider list returns 200");
  const serialized = JSON.stringify(body);
  expect(!/priceMicroUsd/.test(serialized) && !/priceMicroUsdPerMonth/.test(serialized),
    "and carries NO prices — the picker needs identity and caveats, not the rate card");
  expect(body.providers.every((p) => p.billingModel && Array.isArray(p.assumptions)),
    "each provider states its billing model and its caveats");
  expect(body.providers.every((p) => p.freshness && typeof p.freshness.stale === "boolean"),
    "and whether its pricing is stale");
  expect(/do not connect to or access your cloud account/i.test(body.disclaimer.privacy),
    "the privacy notice is available to the UI from this endpoint too");
}

// ---------------------------------------------------------------------------
console.log("\nhandler isolation — the boundary itself has no reach\n");
// ---------------------------------------------------------------------------
{
  // scripts/test-estimator-isolation.mjs covers src/estimator/*. The HTTP
  // handler sits outside that glob and is the file with the most reach, so the
  // same guarantees are asserted here rather than assumed.
  const fs = await import("node:fs");
  const path = await import("node:path");
  const src = fs.readFileSync(path.join(import.meta.dirname, "..", "src", "handlers", "estimate.js"), "utf8");

  const FORBIDDEN_DEPS = [
    "aws-sdk", "@aws-sdk", "@azure/", "@google-cloud/", "googleapis",
    "@kubernetes/client-node", "dockerode", "openai", "@anthropic-ai",
  ];
  for (const dep of FORBIDDEN_DEPS) {
    expect(!src.includes(`"${dep}`) && !src.includes(`'${dep}`),
      `estimate.js does not import "${dep}"`);
  }

  const FORBIDDEN_ENV = [
    "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN",
    "AZURE_CLIENT_SECRET", "GOOGLE_APPLICATION_CREDENTIALS", "KUBECONFIG",
    "DIGITALOCEAN_TOKEN", "HCLOUD_TOKEN",
  ];
  for (const name of FORBIDDEN_ENV) {
    expect(!src.includes(name), `estimate.js never references ${name}`);
  }

  // No LLM anywhere on this path: parsing and estimation are deterministic.
  expect(!/llmChat|getRefactorSuggestion|analyzers\/llm/.test(src),
    "estimate.js never routes user input through an LLM");
  // No pricing fetched at request time — the catalog is bundled at build time.
  expect(!/\bfetch\s*\(/.test(src), "estimate.js makes no outbound fetch of its own");
  // No persistence of the submitted configuration.
  expect(!/persistRun|maybePersist|\.put\(|R2|BUCKET/.test(src),
    "estimate.js writes the submitted configuration nowhere");
  // The one log call is the audited one.
  const logCalls = (src.match(/console\.(log|warn|error|info)/g) || []).length;
  expect(logCalls === 1, `estimate.js has exactly one console call, the audited log line (found ${logCalls})`);
  expect(/logEstimate\(/.test(src), "and it is emitted through logEstimate()");
  // captureException must never be handed the raw error. Checked by counting:
  // every call site must pass sanitizedFailure(...) as its error argument, so
  // the safe-call count has to equal the total call count.
  const flat = src.replace(/\s+/g, " ");
  const allCalls = (flat.match(/captureException\(/g) || []).length;
  const safeCalls = (flat.match(/captureException\( *env, *ctx, *sanitizedFailure\(/g) || []).length;
  expect(allCalls > 0, "estimate.js does report unexpected failures (it is not silently swallowing bugs)");
  expect(allCalls === safeCalls,
    `every captureException passes sanitizedFailure() output, never the raw error (${safeCalls}/${allCalls})`);
  // And the raw error object is never attached as Sentry `extra`, which is the
  // other way request-derived data reaches the reporter.
  expect(!/extra: *\{[^}]*\berr\b/.test(flat),
    "the raw error is never attached as Sentry `extra` either");
}

console.log("");
if (failures === 0) {
  console.log("\x1b[32m  all estimate API tests passed\x1b[0m\n");
  process.exit(0);
} else {
  console.log(`\x1b[31m  ${failures} estimate API test(s) failed\x1b[0m\n`);
  process.exit(1);
}
