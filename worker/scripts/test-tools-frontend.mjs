// Wiring tests for the Optimizer (#/optimizer) and Estimator (#/estimate)
// pages — the two tools promoted from workspace panels to full views that
// pair the interactive bench with its CI and nightly automation.
//
// Vanilla JS with no build step fails silently: getElementById returns null,
// a branch quietly does nothing, and the page renders without the feature.
// These tests close the seams between dash-optimizer.js / dash-estimate.js /
// dashboard.js and dashboard.html, main.css, and the Worker's routes — and
// pin the commitments that are easy to lose precisely because losing them
// doesn't throw.
//
// Run with:  node scripts/test-tools-frontend.mjs

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SITE = join(__dirname, "..", "..", "site");

const html   = readFileSync(join(SITE, "dashboard.html"), "utf8");
const optJs  = readFileSync(join(SITE, "assets", "js", "dash-optimizer.js"), "utf8");
const estJs  = readFileSync(join(SITE, "assets", "js", "dash-estimate.js"), "utf8");
const dashJs = readFileSync(join(SITE, "assets", "js", "dashboard.js"), "utf8");
const router = readFileSync(join(SITE, "assets", "js", "dash-router.js"), "utf8");
const wsJs   = readFileSync(join(SITE, "assets", "js", "dash-workspace.js"), "utf8");
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
group("the views exist, are routed, and own their panels");
// ===========================================================================
{
  expect(/id="view-optimizer"/.test(html) && /id="view-estimate"/.test(html),
    "both views exist in dashboard.html");
  expect(/"optimizer", "estimate"/.test(router) &&
         /#\/optimizer/.test(router) && /#\/estimate/.test(router),
    "the router knows both views and both hashes");
  // Both dispatches now check for a #/<tool>/watch/<monitorId> deep link
  // before falling back to load(). Widened by exactly that branch and no
  // more: this still fails if entering the bare view stops calling load().
  const entersView = (mod) => new RegExp(
    "window\\.Dash" + mod + "\\)\\s*\\{?\\s*(?:if \\(route\\.monitorId\\)[\\s\\S]{0,90}?else\\s+)?" +
    "window\\.Dash" + mod + "\\.load\\(\\)").test(router);
  expect(entersView("Optimizer") && entersView("Estimate"),
    "entering each view calls its module's load()");
  // Neither has a tab any more (D-8): the strip is Workspace + Monitors & CI,
  // and these two are reached from their card on the Workspace grid. The
  // routes still resolve, so a bookmark saved before the change still lands.
  expect(!/data-view="optimizer"/.test(html) && !/data-view="estimate"/.test(html),
    "neither tool holds a nav tab any more — the strip is down to two");
  expect(/route: "#\/optimizer"/.test(wsJs) && /route: "#\/estimate"/.test(wsJs),
    "both are reachable from the Workspace tool grid instead");
  expect(/UNDER_WORKSPACE\s*=\s*\[[^\]]*"optimizer"[^\]]*"estimate"/.test(router),
    "and the tab strip marks Workspace current while you are on one of them");

  // The panels moved WITH their ids, so dashboard.js and dash-estimate.js
  // keep driving them unmodified.
  const optView = html.split('id="view-optimizer"')[1].split("/view-optimizer")[0];
  const estView = html.split('id="view-estimate"')[1].split("/view-estimate")[0];
  const workspace = html.split('id="view-workspace"')[1].split("/view-workspace")[0];
  expect(optView.includes('id="panel-algo"') && optView.includes('id="input-algo"'),
    "the algo bench lives inside the optimizer view");
  expect(estView.includes('id="panel-estimate"') && estView.includes('id="output-estimate"'),
    "the estimator panel lives inside the estimator view");
  expect(!workspace.includes('id="panel-algo"') && !workspace.includes('id="panel-estimate"'),
    "and neither panel is duplicated back in the workspace");
  expect(/dash-optimizer\.js/.test(html), "dash-optimizer.js is loaded by the page");
}

// ===========================================================================
group("selectors resolve — the silent-null failure");
// ===========================================================================
{
  const htmlIds = new Set(matchAll(html, /\sid="([^"]+)"/g));
  for (const [name, src] of [["dash-optimizer.js", optJs], ["dash-estimate.js", estJs]]) {
    const wanted = uniq([
      ...matchAll(src, /getElementById\("([^"]+)"\)/g),
      ...matchAll(src, /\$\("([a-z-]+)"\)/g),
    ]).filter((id) => !id.startsWith("est-prov-"));   // built per provider at runtime
    const missing = wanted.filter((id) => !htmlIds.has(id));
    expect(missing.length === 0,
      `every id ${name} queries exists${missing.length ? " — missing: " + missing.join(", ") : ` (${wanted.length} checked)`}`);
  }
}

// ===========================================================================
group("every endpoint the pages call is a route the Worker declares");
// ===========================================================================
{
  const declared = matchAll(worker, /router\.(?:get|post|put|patch|delete|all)\(\s*"([^"]+)"/g);
  const patterns = declared.map((p) => ({
    re: new RegExp("^" + p.replace(/:[A-Za-z0-9_]+/g, "[^/]+").replace(/\*/g, ".*") + "$"),
  }));
  const called = uniq([
    ...matchAll(optJs, /callApi\("([^"?]+?)[?"]/g),
    ...matchAll(estJs, /callApi\("([^"?]+?)[?"]/g),
  ]);
  const unrouted = called.filter((path) => !patterns.some((p) => p.re.test(path)));
  expect(unrouted.length === 0,
    `every called path is routed${unrouted.length ? " — unrouted: " + unrouted.join(", ") : ` (${called.length} checked)`}`);
  expect(called.includes("/api/ci/optimizer-snippet") && called.includes("/api/keys") &&
         called.includes("/api/monitors"),
    "the gate card reads the real snippet, key, and monitor endpoints");
}

// ===========================================================================
group("the new classes are styled, and none are dead");
// ===========================================================================
{
  const PREFIX = /^(flow-|opt-|watch-|night-|rewrite-|est-grid|est-col|opt-card-hub)/;
  const applied = uniq([
    ...matchAll(optJs, /class:\s*"([^"]+)"/g).flatMap((c) => c.split(/\s+/)),
    ...matchAll(estJs, /class:\s*"([^"]+)"/g).flatMap((c) => c.split(/\s+/)),
    ...matchAll(dashJs, /class:\s*"([^"]+)"/g).flatMap((c) => c.split(/\s+/)),
    ...matchAll(html, /class="([^"]+)"/g).flatMap((c) => c.split(/\s+/)),
  ]).filter((c) => PREFIX.test(c));
  const styled = new Set(matchAll(css,
    /\.((?:flow-|opt-|watch-|night-|rewrite-|est-grid|est-col|opt-card-hub)[a-zA-Z0-9-]*)/g));
  // Dynamic tone suffix: "rewrite-" + tone assembled at runtime is matched
  // by its literal variants below; the concatenation base is not a class.
  const unstyled = applied.filter((c) => !styled.has(c));
  expect(unstyled.length === 0,
    `every new class has a CSS rule${unstyled.length ? " — unstyled: " + unstyled.join(", ") : ` (${applied.length} checked)`}`);
  const sources = optJs + estJs + dashJs + html;
  const orphans = [...styled].filter((c) => !sources.includes(c));
  expect(orphans.length === 0,
    `no new rule is dead${orphans.length ? " — orphaned: " + orphans.join(", ") : ""}`);
}

// ===========================================================================
group("optimizer commitments");
// ===========================================================================
{
  // 1. Both Big-O spellings rank identically — the bug class the backend
  //    fixed must not reappear in the page's own comparison logic.
  expect(/"O\(n²\)": 4, "O\(n\^2\)": 4/.test(optJs) && /"O\(n³\)": 5, "O\(n\^3\)": 5/.test(optJs),
    "superscript and caret spellings rank identically in the page's rank table");

  // 2. The handoff ceiling is one bucket above the measured grade.
  expect(/Math\.min\(r \+ 1, BUCKETS\.length - 1\)/.test(optJs),
    "ceilingAbove picks the next bucket up — the noise-safe default");

  // 3. The config JSON matches what the CI workflow and the nightly sweep
  //    parse: entries with file / functionName / baseline.
  expect(/entries: state\.entries\.map/.test(optJs) &&
         /functionName: e\.functionName, baseline: e\.baseline/.test(optJs),
    "the drafted JSON carries the exact keys optimizer.config.json consumers read");

  // 4. The watch button renders only when a function name is parseable.
  expect(/var fnName = bench \? opt\.parseFunctionName\(bench\.code\) : null;/.test(dashJs) &&
         /if \(opt && fnName\)/.test(dashJs),
    "\"Watch this function\" is not rendered when the name can't be parsed");

  // 5. Measuring the rewrite reports worse and same outcomes as plainly as
  //    better ones — the honesty is the product.
  expect(/the rewrite made it worse/.test(dashJs) &&
         /the suggestion was wrong and the measurement says so/.test(dashJs),
    "a rewrite that measures worse says so with equal prominence");
  expect(/same complexity class/.test(dashJs),
    "a same-class rewrite is reported as constant factors, not a win");

  // 6. The nightly card renders null as pending, never as zero.
  expect(/!m\.lastAlgo\b/.test(optJs) && /first run pending/.test(optJs) &&
         /no config in repo/.test(optJs),
    "null baseline → pending; empty baseline → the no-config fact — never conflated");

  // 7. No invented gate feed: the card renders setup steps and the real
  //    workflow, and never fabricates armed/firing history.
  expect(!/PR #\d/.test(optJs), "no fabricated PR results anywhere in the module");
  expect(/skips itself with a notice/.test(optJs),
    "the skip-with-notice safety posture is stated on the card");

  // 8. The nightly cap is surfaced when the list passes it.
  expect(/NIGHTLY_CAP = 12/.test(optJs) && /entries\.length > NIGHTLY_CAP/.test(optJs),
    "the 12-entry nightly cap renders inline when it bites");
}

// ===========================================================================
group("estimator commitments");
// ===========================================================================
{
  // 1. The unverified banner is driven by the providers response.
  expect(/verificationStatus !== "verified"/.test(estJs) &&
         /banner\.hidden = !anyUnverified/.test(estJs),
    "the amber banner follows the catalog's real verification state");
  expect(/id="est-unverified-banner"[^>]*hidden/.test(html),
    "and starts hidden in the markup — never hardcoded on");

  // 2. Null-vs-empty on the watch card: pending ≠ no compose ≠ paused.
  expect(/first run pending/.test(estJs) && /no compose file/.test(estJs) &&
         /a fact, not an error/.test(estJs),
    "the watch card keeps 'never priced' and 'nothing to price' distinct");

  // 3. The no-credentials line appears on the automation card too.
  expect(/no cloud account, no credentials/.test(estJs),
    "the trust boundary is repeated where the automation is offered");

  // 4. The secrets refusal keeps its honest copy.
  expect(/secrets_detected/.test(estJs) && /Nothing was stored/.test(estJs),
    "a refused credential still says nothing was stored");
}

// ---------- summary ----------
console.log("");
if (failures === 0) {
  console.log("\x1b[32m  all tools-frontend tests passed\x1b[0m\n");
  process.exit(0);
} else {
  console.log(`\x1b[31m  ${failures} tools-frontend test(s) failed\x1b[0m\n`);
  process.exit(1);
}
