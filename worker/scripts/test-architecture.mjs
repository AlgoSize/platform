// Tests for the architecture analyzer — Task #P-10.
//
// The four the task named:
//   1. this repo's own worker/ + site/ yield >= 2 clusters, with the D1 and KV
//      bindings present as edges
//   2. a fixture with a 4-deep synchronous chain flags speed
//   3. a compose fixture with a world-reachable database flags security
//   4. the microservice rule stays silent when ANY of its three evidence legs
//      is missing
//
// Plus the property the whole thing rests on: every finding carries real
// `file:line` evidence. A diagram that asserts a relationship it cannot point
// at is indistinguishable from a guess, so there is a test that walks every
// emitted finding and checks the evidence resolves to a line that exists in
// the submitted file.
//
// Run with:  node scripts/test-architecture.mjs

import { validateArchitectureInput, analyzeArchitecture } from "../src/analyzers/architecture.js";
import { analyzeArchitectureHandler } from "../src/handlers/analyze.js";
import { RULE_CATALOG, UNIMPLEMENTED_RULES, LENSES, ruleCoverage }
  from "../src/analyzers/architecture/rules.js";
import { summarize } from "../src/handlers/runs.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { fakeStripeLiveKey } from "./_fake-secrets.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, "..", "..");

let failures = 0;
const ok   = (msg) => console.log(`  \x1b[32m✓\x1b[0m ${msg}`);
const fail = (msg) => { console.log(`  \x1b[31m✗\x1b[0m ${msg}`); failures++; };
const expect = (cond, label) => cond ? ok(label) : fail(label);

const run = (files) => {
  const v = validateArchitectureInput({ files });
  if (!v.ok) throw new Error(`fixture rejected: ${v.error} ${v.message}`);
  return { result: analyzeArchitecture(v.value), files: v.value.files };
};
const repoFile = (p) => ({ path: p, content: readFileSync(join(REPO, p), "utf8") });
const has = (findings, rule) => findings.some((f) => f.rule === rule);
const of  = (findings, rule) => findings.filter((f) => f.rule === rule);

// ---------------------------------------------------------------------------
console.log("\nthis repository maps to its real shape\n");
// ---------------------------------------------------------------------------

{
  const { result } = run([
    repoFile("worker/wrangler.toml"),
    repoFile("worker-sandbox/wrangler.toml"),
    repoFile("site/_config.yml"),
    repoFile("worker/src/index.js"),
  ]);
  const { graph } = result;

  expect(graph.clusters.length >= 2,
    `worker/ + site/ produce at least 2 clusters (got ${graph.clusters.length}: ${graph.clusters.map((c) => c.id).join(", ")})`);

  const kinds = new Set(graph.clusters.map((c) => c.kind));
  expect(kinds.has("worker") && kinds.has("static_site"),
    "the Worker and the static site are separate deployable units");

  // The D1 and KV bindings must appear as edges, not merely as nodes — the
  // relationship is the thing a diagram draws.
  const bindingEdges = graph.edges.filter((e) => e.kind === "binding");
  const d1Edge = bindingEdges.find((e) => e.to.startsWith("d1:"));
  const kvEdge = bindingEdges.find((e) => e.to.startsWith("kv:"));

  expect(!!d1Edge, "the D1 database appears as a binding edge");
  expect(!!kvEdge, "the KV namespaces appear as binding edges");
  expect(d1Edge && d1Edge.from === "worker:algosize",
    "the D1 edge runs from the algosize Worker");

  // Evidence has to be a real line in the real file, or the diagram is
  // decorative.
  const wranglerLines = readFileSync(join(REPO, "worker/wrangler.toml"), "utf8").split("\n").length;
  const [file, line] = (d1Edge ? d1Edge.evidence : ":0").split(":");
  expect(file === "worker/wrangler.toml" && Number(line) > 0 && Number(line) <= wranglerLines,
    `the D1 edge cites a line that exists in wrangler.toml (${d1Edge && d1Edge.evidence})`);
  expect(readFileSync(join(REPO, "worker/wrangler.toml"), "utf8").split("\n")[Number(line) - 1].includes("DB"),
    "and that line is the actual DB binding declaration");

  // The service binding to the sandbox Worker is a real cross-unit edge.
  expect(graph.edges.some((e) => e.to === "worker:algosize-sandbox"),
    "the SANDBOX service binding is an edge between the two Workers");

  expect(result.summary.complete === true,
    "every submitted file was understood, so the result reports itself complete");
}

{
  // Coverage must be honest about what it could not read.
  const { result } = run([
    repoFile("worker/wrangler.toml"),
    { path: "ops/mystery.rb", content: "puts 'hello'" },
  ]);
  expect(result.limits.filesSkipped === 1, `an unparseable file is counted as skipped (got ${result.limits.filesSkipped})`);
  expect(result.limits.skipped.includes("ops/mystery.rb"), "and named, not just counted");
  expect(result.summary.complete === false,
    "and the summary stops claiming completeness — a partial map must say so");
}

// ---------------------------------------------------------------------------
console.log("\nspeed — a deep synchronous chain\n");
// ---------------------------------------------------------------------------

const DEEP_CHAIN = `
services:
  edge:
    image: nginx:1.25
    ports:
      - "80:80"
    depends_on:
      - api
  api:
    image: myorg/api:1.2.3
    depends_on:
      - orders
  orders:
    image: myorg/orders:1.0.0
    depends_on:
      - billing
  billing:
    image: myorg/billing:2.1.0
    depends_on:
      - ledger
  ledger:
    image: myorg/ledger:1.4.0
`;

{
  const { result } = run([{ path: "docker-compose.yml", content: DEEP_CHAIN }]);
  const chain = of(result.findings, "sync_chain_depth");

  expect(chain.length === 1, `a 4-deep synchronous chain produces a speed finding (got ${chain.length})`);
  expect(chain[0] && chain[0].lens === "speed", "under the speed lens");
  expect(chain[0] && chain[0].severity === "high",
    `and 4 hops is high severity rather than medium (got ${chain[0] && chain[0].severity})`);
  expect(chain[0] && /4 synchronous hops/.test(chain[0].why),
    "the explanation states the actual depth it measured");
  expect(chain[0] && chain[0].relatedEvidence && chain[0].relatedEvidence.length === 4,
    "and cites every hop, so the reader can check the chain rather than trust it");

  // A two-hop chain is normal and must stay quiet.
  const shallow = run([{
    path: "docker-compose.yml",
    content: `
services:
  edge:
    image: nginx:1.25
    depends_on:
      - api
  api:
    image: myorg/api:1.0.0
`,
  }]);
  expect(!has(shallow.result.findings, "sync_chain_depth"),
    "a single hop does not flag — the rule fires on depth, not on the existence of a call");
}

// ---------------------------------------------------------------------------
console.log("\nsecurity — a world-reachable database\n");
// ---------------------------------------------------------------------------

const EXPOSED_DB = `
services:
  api:
    image: myorg/api:1.0.0
    depends_on:
      - db
  db:
    image: postgres:16
    ports:
      - "5432:5432"
`;

{
  const { result } = run([{ path: "docker-compose.yml", content: EXPOSED_DB }]);
  const exposed = of(result.findings, "datastore_publicly_published");

  expect(exposed.length === 1, `a published database port is flagged (got ${exposed.length})`);
  expect(exposed[0] && exposed[0].lens === "security", "under the security lens");
  expect(exposed[0] && exposed[0].severity === "critical",
    `at critical severity (got ${exposed[0] && exposed[0].severity})`);
  expect(exposed[0] && exposed[0].evidence === "docker-compose.yml:10",
    `citing the ports line that published it (got ${exposed[0] && exposed[0].evidence})`);
  expect(exposed[0] && /5432:5432/.test(exposed[0].why),
    "and naming the mapping, so the fix is unambiguous");

  // Bound to loopback, the same database is NOT world-reachable.
  const loopback = run([{
    path: "docker-compose.yml",
    content: EXPOSED_DB.replace('"5432:5432"', '"127.0.0.1:5432:5432"'),
  }]);
  expect(!has(loopback.result.findings, "datastore_publicly_published"),
    "binding the same port to 127.0.0.1 does not flag — the rule reads the interface, not the port");
}

// ---------------------------------------------------------------------------
console.log("\nrecommendations — the microservice rule stays silent\n");
// ---------------------------------------------------------------------------

// All three legs: reached from two clusters, owns a datastore nothing else
// touches, and declares its own replica count.
const ALL_THREE_LEGS = `
services:
  web:
    image: myorg/web:1.0.0
    depends_on:
      - reports
  worker:
    image: myorg/worker:1.0.0
    depends_on:
      - reports
  reports:
    image: myorg/reports:1.0.0
    deploy:
      replicas: 4
    depends_on:
      - reportsdb
  reportsdb:
    image: postgres:16
`;

const microRecs = (result) =>
  result.recommendations.flatMap((g) => g.recommendations).filter((r) => /^Extract /.test(r.change));

{
  const { result } = run([{ path: "docker-compose.yml", content: ALL_THREE_LEGS }]);
  const recs = microRecs(result);

  expect(recs.length === 1, `with all three legs present, one extraction is recommended (got ${recs.length})`);
  const rec = recs[0];
  expect(rec && /reports/.test(rec.change), "naming the right service");
  expect(rec && Array.isArray(rec.legs) && rec.legs.length === 3, "and carrying all three legs");
  expect(rec && rec.legs.every((l) => typeof l.evidence === "string" && l.evidence.includes(":")),
    "each leg citing its own evidence — the evidence IS the argument");
  const legNames = (rec ? rec.legs : []).map((l) => l.leg).sort().join(",");
  expect(legNames === "distinct scaling profile,fan-in,own datastore",
    `the three legs are fan-in, own datastore and scaling profile (got ${legNames})`);

  // Every recommendation names the node (or file) it is about, so the
  // dashboard can scope its card list to a pinned node rather than always
  // widening to the whole cluster. On a deduplicated card this is the first
  // occurrence, which is enough to scope by.
  expect(rec && typeof rec.target === "string" && rec.target.length > 0,
    "the extraction names its target node");
  const allRecs = result.recommendations.flatMap((g) => g.recommendations);
  expect(allRecs.every((r) => typeof r.target === "string" && r.target.length > 0),
    "every recommendation carries a target for selection-scoped display");
}

{
  // Leg 1 removed: only one caller. A service its single parent calls gains
  // nothing from a network hop.
  const oneCaller = ALL_THREE_LEGS.replace(
    `  worker:
    image: myorg/worker:1.0.0
    depends_on:
      - reports
`, "");
  const { result } = run([{ path: "docker-compose.yml", content: oneCaller }]);
  expect(microRecs(result).length === 0, "no fan-in → silent");
}

{
  // Leg 2 removed: the datastore is shared, so `reports` is a second front
  // end on someone else's tables rather than a separable service.
  const sharedDb = ALL_THREE_LEGS.replace(
    `  web:
    image: myorg/web:1.0.0
    depends_on:
      - reports
`,
    `  web:
    image: myorg/web:1.0.0
    depends_on:
      - reports
      - reportsdb
`);
  const { result } = run([{ path: "docker-compose.yml", content: sharedDb }]);
  expect(microRecs(result).length === 0, "no exclusively-owned datastore → silent");
}

{
  // Leg 3 removed: no replica count, no queue, no schedule — nothing shows it
  // needs to scale differently from its host.
  const noScaling = ALL_THREE_LEGS.replace(
    `    deploy:
      replicas: 4
`, "");
  const { result } = run([{ path: "docker-compose.yml", content: noScaling }]);
  expect(microRecs(result).length === 0, "no distinct scaling signal → silent");
}

// ---------------------------------------------------------------------------
console.log("\nevidence discipline\n");
// ---------------------------------------------------------------------------

{
  // Walk every finding from every fixture and confirm its evidence points at
  // a line that genuinely exists in the file it names.
  const fixtures = [
    [{ path: "docker-compose.yml", content: DEEP_CHAIN }],
    [{ path: "docker-compose.yml", content: EXPOSED_DB }],
    [{ path: "docker-compose.yml", content: ALL_THREE_LEGS }],
    [{ path: "Dockerfile", content: "FROM node\nRUN npm ci\n" }],
    [{ path: ".env", content: `API_KEY=${fakeStripeLiveKey()}\n` }],
  ];

  let checked = 0, bad = 0;
  for (const files of fixtures) {
    const { result } = run(files);
    const byPath = new Map(files.map((f) => [f.path, f.content.split("\n").length]));
    for (const f of result.findings) {
      checked++;
      const idx = f.evidence.lastIndexOf(":");
      const path = f.evidence.slice(0, idx);
      const line = Number(f.evidence.slice(idx + 1));
      const total = byPath.get(path);
      if (!total || !Number.isInteger(line) || line < 1 || line > total) {
        bad++;
        fail(`evidence out of range: ${f.rule} → ${f.evidence}`);
      }
    }
  }
  expect(checked > 0, `findings were produced to check (${checked})`);
  expect(bad === 0, "every finding cites a line that exists in the file it names");
}

{
  // Committed secrets: a real-looking value flags, a placeholder does not.
  const real = run([{ path: ".env", content: "DATABASE_PASSWORD=hunter2correcthorsebattery\n" }]);
  expect(has(real.result.findings, "committed_secret"), "a literal credential in .env is flagged");
  expect(of(real.result.findings, "committed_secret")[0].severity === "critical", "at critical severity");

  const placeholder = run([{
    path: ".env.example",
    content: "DATABASE_PASSWORD=\nAPI_KEY=your-key-here\nSECRET_TOKEN=${SECRET_TOKEN}\n",
  }]);
  expect(!has(placeholder.result.findings, "committed_secret"),
    "placeholders in a .env.example are not flagged — a template is not a leak");
}

{
  // Unpinned base images.
  const unpinned = run([{ path: "Dockerfile", content: "FROM node\n" }]);
  expect(has(unpinned.result.findings, "unpinned_base_image"), "`FROM node` is flagged as unpinned");

  const latest = run([{ path: "Dockerfile", content: "FROM node:latest\n" }]);
  expect(has(latest.result.findings, "unpinned_base_image"), "`:latest` is flagged too");

  const pinned = run([{ path: "Dockerfile", content: "FROM node:20.11.1-alpine\n" }]);
  expect(!has(pinned.result.findings, "unpinned_base_image"), "an explicit version tag is not flagged");

  const digest = run([{
    path: "Dockerfile",
    content: "FROM node@sha256:aaaabbbbccccddddeeeeffff0000111122223333444455556666777788889999\n",
  }]);
  expect(!has(digest.result.findings, "unpinned_base_image"), "a digest pin is not flagged");
}

// ---------------------------------------------------------------------------
console.log("\nthe endpoint\n");
// ---------------------------------------------------------------------------

function analyzeRequest(body) {
  const req = new Request("https://algosize.com/api/analyze/architecture", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  req.user = { userId: "usr_arch", email: "arch@example.com" };
  return req;
}

{
  const res = await analyzeArchitectureHandler(
    analyzeRequest({ files: [{ path: "docker-compose.yml", content: EXPOSED_DB }] }), {}, {},
  );
  const body = await res.json();
  expect(res.status === 200, `POST /api/analyze/architecture → 200 (got ${res.status})`);
  expect(body.graph && Array.isArray(body.graph.nodes) && Array.isArray(body.graph.edges) && Array.isArray(body.graph.clusters),
    "returns a graph with nodes, edges and clusters — the shape the diagram consumes");
  expect(Array.isArray(body.findings) && Array.isArray(body.recommendations),
    "plus findings and recommendations");
  expect(body.limits && Array.isArray(body.limits.notImplemented) && body.limits.notImplemented.length > 0,
    "and names the rules it does NOT implement, rather than implying full coverage");
}

{
  const bad = await analyzeArchitectureHandler(analyzeRequest({ files: [] }), {}, {});
  expect(bad.status === 400, `an empty file list is a 400 (got ${bad.status})`);

  const notJson = new Request("https://algosize.com/api/analyze/architecture", { method: "POST", body: "{oops" });
  notJson.user = { userId: "usr_arch" };
  const res = await analyzeArchitectureHandler(notJson, {}, {});
  expect(res.status === 400, `malformed JSON is a 400 (got ${res.status})`);
}

{
  // The run-history headline has to say something for the new analyzer, or
  // every architecture run shows a blank row in the dashboard.
  const { result } = run([{ path: "docker-compose.yml", content: EXPOSED_DB }]);
  const headline = summarize("arch", result);
  expect(typeof headline === "string" && headline.length > 0, `arch runs get a history headline (got "${headline}")`);
  expect(/cluster/.test(headline) && /finding/.test(headline),
    "naming clusters and findings, like the other analyzers name their verdict");
}

// ---------------------------------------------------------------------------
console.log("\na URL is a dependency only when something actually calls it\n");
// ---------------------------------------------------------------------------
//
// Every quoted URL in every scanned file used to become an `external_api` node
// and an http edge tagged `via: "fetch"`. On this repository that produced 21
// of 25 findings: 174 "call sites" to algosize.com, 96 to a host literally
// named `x` (the `http://x/…` origin its own test scripts use), 8 to
// www.hetzner.com (a `sourceUrl` in a frozen pricing table), 6 to claude.ai (a
// CORS allowlist in a file containing no request primitive at all).
//
// Both directions are asserted. A filter that removed the noise by also
// removing the real edges would be a worse analyzer that merely looks calmer.
{
  const hostsOf = (result) =>
    (result.graph.nodes || []).filter((n) => n.kind === "external_api").map((n) => n.name);

  // Kept: the URL is built then fetched, which is how real call sites in this
  // codebase are written — the literal is never inside the call parentheses.
  // A deployable unit has to exist for an edge to start from, so every
  // fixture below carries the wrangler.toml that declares one.
  const WRANGLER = { path: "worker/wrangler.toml", content: 'name = "app"\nmain = "src/index.js"\n' };
  const withApp = (file) => run([WRANGLER, file]).result;

  const REAL_CALL = `
    const url = \`https://api.github.com/repos/\${owner}/\${repo}/git/trees/main\`;
    export async function load() { return fetch(url, { headers: {} }); }
  `;
  expect(hostsOf(withApp({ path: "worker/src/gh.js", content: REAL_CALL })).includes("api.github.com"),
    "a URL assigned to a variable and then fetched is still an outbound dependency");

  // Dropped: data, not a call. The file has no request primitive at all.
  const PRICING_DATA = `
    export default Object.freeze({
      "sourceUrl": "https://www.hetzner.com/cloud/",
      "plans": [{ "sourceUrl": "https://www.hetzner.com/cloud/" }]
    });
  `;
  expect(hostsOf(withApp({ path: "worker/pricing/hetzner.js", content: PRICING_DATA })).length === 0,
    "a pricing table's sourceUrl is a citation, not a service this system calls");

  // Dropped: an allowlist is a list of origins we ACCEPT, not ones we call.
  const ALLOWLIST = `export const ORIGINS = ["https://claude.ai", "https://www.claude.ai"];`;
  expect(hostsOf(withApp({ path: "worker/src/transport.js", content: ALLOWLIST })).length === 0,
    "a CORS allowlist in a file with no request primitive is not an outbound call");

  // Dropped: test scenarios describe inputs, not the system's architecture.
  const TEST_FIXTURE = `await fetch("http://x/api/stripe/webhook", { method: "POST" });`;
  expect(hostsOf(withApp({ path: "worker/scripts/test-stripe.mjs", content: TEST_FIXTURE })).length === 0,
    "a stand-in origin inside a test script is not part of the architecture");

  // Dropped: the reserved documentation domain, including its subdomains —
  // the anchored ignore-list matched example.com but not cdn.example.com.
  const DOC_DOMAIN = `await fetch("https://cdn.example.com/x.js"); await fetch("https://api.example.com/y");`;
  expect(hostsOf(withApp({ path: "worker/src/doc.js", content: DOC_DOMAIN })).length === 0,
    "subdomains of the reserved documentation domain are ignored too");

  // Dropped: prose. A quoted URL inside a doc block is still prose.
  const IN_COMMENT = `
    /*
     * See "https://www.digitalocean.com/pricing" for the table this mirrors.
     */
    export const N = 1;
  `;
  expect(hostsOf(withApp({ path: "worker/src/note.js", content: IN_COMMENT })).length === 0,
    "a URL quoted inside a block comment is documentation, not a call");
}

// ---------------------------------------------------------------------------
console.log("\na committed placeholder is not a leaked credential\n");
// ---------------------------------------------------------------------------
//
// The placeholder rule was anchored, so it only matched a value that was
// EXACTLY "placeholder". Real placeholders are compound, and all four of these
// were reported CRITICAL with "rotate the credential now" against a CI
// workflow that boots a local test Worker. Telling someone to rotate
// `whsec_placeholder` is how a security rule gets skimmed past.
{
  const WORKFLOW = [
    "env:",
    "  JWT_SECRET: local-dev-only-jwt-secret-32-chars-min-not-for-prod-xxxxx",
    "  STRIPE_SECRET_KEY: sk_test_placeholder_set_real_key_in_local_only",
    "  STRIPE_WEBHOOK_SECRET: whsec_placeholder",
    "  E2E_TEST_SECRET: local-e2e-seed-secret-do-not-use-in-prod",
  ].join("\n");
  const placeholders = of(run([{ path: ".github/workflows/e2e.yml", content: WORKFLOW }]).result.findings,
                          "committed_secret");
  expect(placeholders.length === 0,
    `four self-describing placeholders raise nothing (got ${placeholders.length})`);

  // The other direction, and the one that matters more: a value with none of
  // those markers is still a leak, and must still be critical. A rule that
  // went quiet everywhere would pass the assertion above on its own.
  // Deliberately NOT shaped like any provider's real key format. The first
  // draft of this fixture used a convincing `sk_live_51…` and GitHub's push
  // protection blocked the push — correctly, and it is the same judgement this
  // rule is being taught to make. A generic high-entropy value exercises the
  // rule without minting something a scanner has to reason about.
  const REAL = "env:\n  DATABASE_PASSWORD: 3f9a1c7e5b2d8046af13c9e2b7d4508e\n";
  const leaked = of(run([{ path: ".github/workflows/deploy.yml", content: REAL }]).result.findings,
                    "committed_secret");
  expect(leaked.length === 1 && leaked[0].severity === "critical",
    `a real committed credential is still one critical finding (got ${leaked.length})`);
}

// ===========================================================================
console.log("\nthe rule catalogue is the real list of rules, not a stale copy of it\n");
// ===========================================================================
{
  // A lens count of 0 is ambiguous without a denominator, and the denominator
  // is RULE_CATALOG. A catalogue that has drifted from the code is worse than
  // none: it would state coverage the analyzer no longer has, on the panel
  // whose entire job is to make a clean result trustworthy.
  //
  // Read from the source rather than from an export, because the thing being
  // checked is that the DECLARATION matches what the rule functions can
  // actually emit. An export could only ever agree with itself.
  const src = readFileSync(join(REPO, "worker/src/analyzers/architecture/rules.js"), "utf8");

  // Every `rule: "..."` the file mentions, minus the ones inside the two
  // declarative blocks (UNIMPLEMENTED_RULES and RULE_CATALOG itself), is a
  // rule some function can emit.
  const declaredIds = new Set([
    ...RULE_CATALOG.map((r) => r.rule),
    ...UNIMPLEMENTED_RULES.map((r) => r.rule),
  ]);
  const emitted = new Set();
  for (const m of src.matchAll(/rule:\s*"([a-z0-9_]+)"/g)) emitted.add(m[1]);
  // Subtract the ids that appear only because the two blocks declare them.
  const emittedByRules = [...emitted].filter((id) =>
    !UNIMPLEMENTED_RULES.some((r) => r.rule === id));

  const uncatalogued = emittedByRules.filter((id) => !RULE_CATALOG.some((r) => r.rule === id));
  expect(uncatalogued.length === 0,
    `every rule the analyzer can emit is catalogued${uncatalogued.length ? " — missing: " + uncatalogued.join(", ") : ` (${emittedByRules.length} checked)`}`);

  const stale = RULE_CATALOG.filter((r) => !emitted.has(r.rule)).map((r) => r.rule);
  expect(stale.length === 0,
    `and nothing is catalogued that the analyzer no longer emits${stale.length ? " — stale: " + stale.join(", ") : ""}`);

  expect([...declaredIds].length === RULE_CATALOG.length + UNIMPLEMENTED_RULES.length,
    "no rule id is declared twice across the catalogue and the not-implemented list");

  // The coverage object the explorer renders from.
  const cov = ruleCoverage();
  expect(LENSES.every((l) => cov[l] && cov[l].ran === cov[l].rules.length && cov[l].ran > 0),
    "every lens reports how many rules ran, and no lens reports zero rules");
  expect(LENSES.reduce((n, l) => n + cov[l].ran, 0) === RULE_CATALOG.length,
    "the per-lens totals add up to the catalogue");
  expect(cov.speed.rules.every((r) => r.what && r.what.length > 10),
    "and each rule says what it looks for, so 'covered' is checkable rather than asserted");

  // The unimplemented half of the same statement travels with it.
  expect(cov.cost.notImplemented.length + cov.speed.notImplemented.length +
         cov.security.notImplemented.length === UNIMPLEMENTED_RULES.length,
    "what a lens does NOT look for is attached to that lens, not to a footnote");
}

// ---------- summary ----------
console.log("");
if (failures === 0) {
  console.log("\x1b[32m  all architecture tests passed\x1b[0m\n");
  process.exit(0);
} else {
  console.log(`\x1b[31m  ${failures} architecture test(s) failed\x1b[0m\n`);
  process.exit(1);
}
