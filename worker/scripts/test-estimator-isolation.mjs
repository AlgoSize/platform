// Static isolation checks for the estimator runtime path.
//
// These are the "definition of done" items that a behavioural test cannot
// prove: you can run the engine a thousand times and never demonstrate that it
// CANNOT reach the network — you can only demonstrate that it did not this
// time. So this suite reads the source instead, and fails on the presence of
// the capability rather than on its use.
//
// Run with:  node scripts/test-estimator-isolation.mjs

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const ESTIMATOR_DIR = join(ROOT, "src/estimator");

let failures = 0;
const ok   = (m) => console.log(`  \x1b[32m✓\x1b[0m ${m}`);
const fail = (m) => { console.log(`  \x1b[31m✗\x1b[0m ${m}`); failures++; };
const expect = (c, m) => c ? ok(m) : fail(m);

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (p.endsWith(".js")) out.push(p);
  }
  return out;
}

const FILES = walk(ESTIMATOR_DIR).map((p) => ({ path: p, rel: relative(ROOT, p), src: readFileSync(p, "utf8") }));

console.log("\nestimator isolation — forbidden dependencies\n");

expect(FILES.length >= 6, `found the estimator sources (${FILES.length} files)`);

// Cloud SDKs, credential libraries, HTTP clients, LLM clients, schedulers.
const FORBIDDEN_MODULES = [
  "aws-sdk", "@aws-sdk", "boto3", "@azure/", "@google-cloud/", "googleapis",
  "@kubernetes/client-node", "kubernetes-client", "node-fetch", "axios", "got",
  "undici", "openai", "@anthropic-ai", "node-cron", "cron", "bullmq", "agenda",
  "dockerode", "child_process", "node:child_process", "node:fs", "node:net",
  "node:http", "node:https", "node:dns", "fs", "net", "http", "https", "dns",
];
for (const mod of FORBIDDEN_MODULES) {
  const hits = FILES.filter((f) =>
    new RegExp(`(?:import\\s[^;]*from\\s*|require\\s*\\(\\s*)["']${mod.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`).test(f.src));
  expect(hits.length === 0, `no estimator file imports "${mod}"${hits.length ? ` (found in ${hits.map((h) => h.rel).join(", ")})` : ""}`);
}

console.log("\nestimator isolation — no runtime capability to reach outside\n");

// Global calls that would constitute IO or code execution.
const FORBIDDEN_CALLS = [
  ["fetch(", /(^|[^.\w])fetch\s*\(/],
  ["XMLHttpRequest", /\bXMLHttpRequest\b/],
  ["WebSocket", /\bWebSocket\b/],
  ["eval(", /(^|[^.\w])eval\s*\(/],
  ["new Function(", /new\s+Function\s*\(/],
  ["setTimeout", /(^|[^.\w])setTimeout\s*\(/],
  ["setInterval", /(^|[^.\w])setInterval\s*\(/],
  ["process.env", /\bprocess\s*\.\s*env\b/],
  ["process.exit", /\bprocess\s*\.\s*exit\b/],
  ["Deno.", /\bDeno\s*\./],
];
for (const [label, re] of FORBIDDEN_CALLS) {
  const hits = FILES.filter((f) => re.test(f.src));
  expect(hits.length === 0, `no estimator file uses ${label}${hits.length ? ` (found in ${hits.map((h) => h.rel).join(", ")})` : ""}`);
}

console.log("\nestimator isolation — no credential environment names\n");

const FORBIDDEN_NAMES = [
  "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN",
  "AZURE_CLIENT_SECRET", "GOOGLE_APPLICATION_CREDENTIALS",
  "KUBECONFIG", "DIGITALOCEAN_TOKEN", "HCLOUD_TOKEN", "refresh_token",
];
for (const name of FORBIDDEN_NAMES) {
  // spec.js legitimately NAMES some of these as things to reject, via the
  // shared detector's banned-key list — so only a reference outside a string
  // used for rejection would be a finding. We assert none appear at all in the
  // estimator, since the banned list lives in analyzers/secrets.js.
  const hits = FILES.filter((f) => f.src.includes(name));
  expect(hits.length === 0, `no estimator file references ${name}${hits.length ? ` (found in ${hits.map((h) => h.rel).join(", ")})` : ""}`);
}

console.log("\nestimator isolation — engine purity\n");

const engine = FILES.find((f) => f.rel.endsWith("engine.js"));
expect(!!engine, "engine.js is present");
if (engine) {
  // The engine must receive catalog data, never import it. catalog.js is the
  // only module allowed to know where prices live.
  expect(!/pricing\//.test(engine.src),
    "engine.js does not import the pricing catalog — catalog data arrives as an argument");
  expect(!/\bDate\s*\.\s*now\s*\(/.test(engine.src),
    "engine.js does not read the clock (generatedAt is passed in, so output is reproducible)");
  expect(!/Math\s*\.\s*random/.test(engine.src),
    "engine.js is deterministic (no Math.random)");
}

const catalog = FILES.find((f) => f.rel.endsWith("catalog.js"));
if (catalog) {
  expect(/import .* from "\.\.\/\.\.\/pricing\//.test(catalog.src),
    "catalog.js loads pricing by static import — bundled at build time, no runtime fetch or fs");
}

console.log("\nestimator isolation — no scheduler or persistence\n");

for (const [label, re] of [
  ["a cron/schedule registration", /\b(?:scheduled|cron|addEventListener\s*\(\s*["']scheduled)/],
  ["a D1/KV/R2 binding", /\benv\s*\.\s*(?:DB|SESSIONS|USERS|REPORTS|SCAN_QUEUE|AI)\b/],
  ["a persistRun call", /\bpersistRun\s*\(/],
]) {
  const hits = FILES.filter((f) => re.test(f.src));
  expect(hits.length === 0, `no estimator file contains ${label}${hits.length ? ` (found in ${hits.map((h) => h.rel).join(", ")})` : ""}`);
}

console.log("");
if (failures === 0) {
  console.log("\x1b[32m  all estimator isolation checks passed\x1b[0m\n");
  process.exit(0);
} else {
  console.log(`\x1b[31m  ${failures} estimator isolation check(s) failed\x1b[0m\n`);
  process.exit(1);
}
