// Wiring tests for the Monitors & CI screen's multi-analyzer additions.
//
// dash-monitors.js is vanilla JS with no build step, so its characteristic
// failure is silent: getElementById returns null, a branch quietly does
// nothing, and the screen renders without the feature. These tests close the
// seams where the module meets dashboard.html, main.css and the Worker's
// routes, and pin the analyzer-picker commitments that are easy to lose in a
// refactor precisely because losing them doesn't throw.
//
// Run with:  node scripts/test-monitors-frontend.mjs

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SITE = join(__dirname, "..", "..", "site");

const html   = readFileSync(join(SITE, "dashboard.html"), "utf8");
const js     = readFileSync(join(SITE, "assets", "js", "dash-monitors.js"), "utf8");
const css    = readFileSync(join(SITE, "assets", "css", "main.css"), "utf8");
const worker = readFileSync(join(__dirname, "..", "src", "index.js"), "utf8");

let failures = 0;
const ok   = (msg) => console.log(`  \x1b[32m✓\x1b[0m ${msg}`);
const fail = (msg) => { console.log(`  \x1b[31m✗\x1b[0m ${msg}`); failures++; };
const expect = (cond, label) => (cond ? ok(label) : fail(label));
const group  = (name) => console.log(`\n\x1b[1m${name}\x1b[0m\n`);

const matchAll = (src, re) => [...src.matchAll(re)].map((m) => m[1]);
const uniq = (a) => [...new Set(a)];

// ===========================================================================
group("selectors resolve — the silent-null failure");
// ===========================================================================
{
  const htmlIds = new Set(matchAll(html, /\sid="([^"]+)"/g));
  const wanted = uniq(matchAll(js, /getElementById\("([^"]+)"\)/g));
  const missing = wanted.filter((id) => !htmlIds.has(id));
  expect(missing.length === 0,
    `every id the JS queries exists in dashboard.html${
      missing.length ? " — missing: " + missing.join(", ") : ` (${wanted.length} checked)`}`);

  // The analyzer picker's buttons are reached by data-analyzer, not id: every
  // key the form state tracks must have a button, and vice versa.
  const stateKeys = ["arch", "estimate", "algo"];
  const formBtns = matchAll(html, /data-analyzer="([a-z]+)"/g);
  expect(stateKeys.every((k) => formBtns.includes(k)) && formBtns.length === stateKeys.length,
    `the form has exactly one toggle per secondary analyzer (got ${formBtns.join(", ") || "none"})`);
  expect(!formBtns.includes("vuln"),
    "and NO toggle for the audit — it is rendered as a locked fact, not a control");
  expect(/<span class="analyzer-opt analyzer-opt-on analyzer-opt-locked">/.test(html),
    "the locked audit entry is a span, so it cannot be focused or clicked as if it were a choice");
}

// ===========================================================================
group("every endpoint the screen calls is a route the Worker declares");
// ===========================================================================
{
  const declared = matchAll(worker, /router\.(?:get|post|put|patch|delete|all)\(\s*"([^"]+)"/g);
  const patterns = declared.map((p) => ({
    re: new RegExp("^" + p.replace(/:[A-Za-z0-9_]+/g, "[^/]+").replace(/\*/g, ".*") + "$"),
  }));
  // Static callApi paths, plus concatenated ones ("/api/monitors/" + id +
  // "/analyzers") rebuilt with the dynamic segment normalised to a literal.
  const called = uniq(matchAll(js, /callApi\("([^"?]+?)[?"]/g));
  const concat = [...js.matchAll(/callApi\("([^"]+?)"\s*\+\s*encodeURIComponent\([^)]+\)(?:\s*\+\s*"([^"]*?)")?\s*,/g)]
    .map((m) => m[1] + "x" + (m[2] || ""));
  const all = uniq(called.concat(concat)).map((p) => (p.endsWith("/") ? p + "x" : p));
  const unrouted = all.filter((path) => !patterns.some((p) => p.re.test(path)));
  expect(unrouted.length === 0,
    `every path dash-monitors.js calls is routed${
      unrouted.length ? " — unrouted: " + unrouted.join(", ") : ` (${all.length} checked)`}`);
  expect(concat.some((p) => /\/api\/monitors\/x\/analyzers$/.test(p)),
    "including the per-monitor analyzers toggle");
  expect(all.includes("/api/ci/optimizer-snippet"),
    "and the optimizer snippet fetch");
}

// ===========================================================================
group("the new classes are styled, and none are dead");
// ===========================================================================
{
  const NEW_PREFIXES = /^(analyzer-|chip-toggle|monitor-analyzers)/;
  const applied = uniq([
    ...matchAll(js, /class:\s*"([^"]+)"/g).flatMap((c) => c.split(/\s+/)),
    ...matchAll(js, /classList\.toggle\("([^"]+)"/g),
    ...matchAll(html, /class="([^"]+)"/g).flatMap((c) => c.split(/\s+/)),
  ]).filter((c) => NEW_PREFIXES.test(c));
  const styled = new Set(matchAll(css, /\.((?:analyzer-|chip-toggle|monitor-analyzers)[a-zA-Z0-9-]*)/g));
  const unstyled = applied.filter((c) => !styled.has(c));
  expect(unstyled.length === 0,
    `every analyzer/toggle class has a CSS rule${
      unstyled.length ? " — unstyled: " + unstyled.join(", ") : ` (${applied.length} checked)`}`);
  const orphans = [...styled].filter((c) => !applied.includes(c));
  expect(orphans.length === 0,
    `no new rule is dead${orphans.length ? " — orphaned: " + orphans.join(", ") : ""}`);
}

// ===========================================================================
group("the analyzer commitments hold in the source");
// ===========================================================================
{
  // 1. The create POST sends the full set, with the audit always in it.
  expect(/var out = \["vuln"\];/.test(js) && /analyzers: formAnalyzers\(\)/.test(js),
    "creation sends {analyzers} with \"vuln\" always present");

  // 2. The per-row toggle POSTs an explicit full set — the same reason the
  //    pause endpoint takes {paused}: a toggle races itself.
  expect(/var next = \["vuln"\];/.test(js) && /\{ analyzers: next \}/.test(js),
    "the row toggle sends the whole desired set, never a delta");

  // 3. Switching OFF asks first, because it clears the baseline.
  expect(/enabled && !window\.confirm\(/.test(js) && /baseline is cleared/.test(js),
    "disabling an analyzer confirms, naming the baseline cost; enabling never nags");

  // 4. Null-vs-zero: "never ran" renders as pending, not as a clean bill.
  expect(/first run pending/.test(js) &&
         /archFindingCount === null \|\| m\.archFindingCount === undefined/.test(js),
    "a null arch count renders 'first run pending', never 0 findings");
  expect(/if \(!m\.lastEstimate\) return "first run pending";/.test(js) &&
         /no compose file/.test(js),
    "a null estimate is pending; an EMPTY one says why (no compose file)");

  // 5. The optimizer panel: config + workflow, both copyable, loaded with
  //    the same first-load batch as the audit snippet.
  expect(/data-copy-target="ci-opt-config"/.test(html) &&
         /data-copy-target="ci-opt-yaml"/.test(html),
    "the optimizer config and workflow both have copy buttons");
  expect(/loadSnippet\(\), loadOptimizerSnippet\(\)/.test(js),
    "the optimizer snippet loads on first view, alongside the audit snippet");
  expect(/res\.configExample/.test(js) && /res\.configFilename/.test(js),
    "and the config example + filename come from the endpoint, not hardcoded copy");

  // 6. The lede tells the truth about scope.
  expect(/architecture, cost, and complexity checks/.test(html),
    "the screen's lede names the multi-tool watch, not just the audit");
}

// ---------- summary ----------
// ---------------------------------------------------------------------------
console.log("\nevery CI snippet endpoint the Worker registers has a card that fetches it\n");
// ---------------------------------------------------------------------------
//
// The cloud-spend gate shipped complete on the server — handler, workflow
// generator, and GET /api/ci/cost-snippet registered in index.js — and with no
// card and no loader. So the endpoint was reachable by curl and by nothing
// else, and the Cloud cost analyzer was the only tool in the product with no
// CI section while every other one had one. Nothing failed; the feature was
// simply invisible, which is the failure mode a route-registration test cannot
// see and a screenshot can.
//
// Derived from the Worker's own routes rather than a hand-written list, so the
// next gate added server-side fails here until it is reachable in the product.
{
  const registered = [...worker.matchAll(/"\/api\/ci\/([a-z-]*snippet)"/g)].map((m) => m[1]);
  const uniq = [...new Set(registered)];
  expect(uniq.length >= 5,
    `index.js registers the CI snippet endpoints (found ${uniq.length}: ${uniq.join(", ")})`);

  for (const ep of uniq) {
    expect(js.includes(`/api/ci/${ep}`),
      `dash-monitors.js fetches /api/ci/${ep} — an endpoint no card calls is invisible`);
  }

  // Fetching it is not enough: the response has to land somewhere on the page.
  // Each loader writes into ids, so the ids have to exist in the markup.
  for (const id of ["ci-cost-yaml", "ci-cost-config", "ci-cost-filename", "ci-cost-config-filename"]) {
    expect(js.includes(id), `the cost loader targets #${id}`);
    expect(html.includes(`id="${id}"`), `…and dashboard.html actually has #${id}`);
  }
  expect(/id="panel-ci-cost"/.test(html),
    "the cloud-spend gate has its own card, like the other four");
}

console.log("");
if (failures === 0) {
  console.log("\x1b[32m  all monitors-frontend tests passed\x1b[0m\n");
  process.exit(0);
} else {
  console.log(`\x1b[31m  ${failures} monitors-frontend test(s) failed\x1b[0m\n`);
  process.exit(1);
}
