// Wiring tests for the Architecture X-ray explorer's frontend.
//
// site/assets/js/dash-arch.js is vanilla JS with no build step, so its
// characteristic failure is silent: getElementById returns null, a branch
// quietly does nothing, and the map renders without the feature. These tests
// close the seams where the module meets something else, and pin the design
// commitments the X-ray was rebuilt around — the ones that are easy to lose
// in a refactor precisely because losing them doesn't throw.
//
// Run with:  node scripts/test-arch-frontend.mjs

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SITE = join(__dirname, "..", "..", "site");

const html   = readFileSync(join(SITE, "dashboard.html"), "utf8");
const js     = readFileSync(join(SITE, "assets", "js", "dash-arch.js"), "utf8");
const css    = readFileSync(join(SITE, "assets", "css", "main.css"), "utf8");
const worker = readFileSync(join(__dirname, "..", "src", "index.js"), "utf8");
const recommendSrc = readFileSync(join(__dirname, "..", "src", "analyzers", "architecture", "recommend.js"), "utf8");
const graphSrc  = readFileSync(join(__dirname, "..", "src", "analyzers", "architecture", "graph.js"), "utf8");
const enrichSrc = readFileSync(join(__dirname, "..", "src", "analyzers", "architecture", "enrich.js"), "utf8");
const router      = readFileSync(join(SITE, "assets", "js", "dash-router.js"), "utf8");
const dashboardJs = readFileSync(join(SITE, "assets", "js", "dashboard.js"), "utf8");

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
  // Ids the module creates itself (the canvas wrapper) are exempt.
  const created = new Set(matchAll(js, /\bid:\s*"([a-z-]+)"/g));
  const wanted = uniq(matchAll(js, /getElementById\("([^"]+)"\)/g))
    .filter((id) => !created.has(id));
  const missing = wanted.filter((id) => !htmlIds.has(id));
  expect(missing.length === 0,
    `every id the JS queries exists in dashboard.html${
      missing.length ? " — missing: " + missing.join(", ") : ` (${wanted.length} checked)`}`);
}

// ===========================================================================
group("every endpoint the explorer calls is a route the Worker declares");
// ===========================================================================
{
  const declared = matchAll(worker, /router\.(?:get|post|put|patch|delete|all)\(\s*"([^"]+)"/g);
  const patterns = declared.map((p) => ({
    re: new RegExp("^" + p.replace(/:[A-Za-z0-9_]+/g, "[^/]+").replace(/\*/g, ".*") + "$"),
  }));
  const called = uniq(matchAll(js, /callApi\("([^"?]+?)[?"]/g))
    .map((p) => (p.endsWith("/") ? p + "x" : p));
  const unrouted = called.filter((path) => !patterns.some((p) => p.re.test(path)));
  expect(unrouted.length === 0,
    `every path dash-arch.js calls is routed${
      unrouted.length ? " — unrouted: " + unrouted.join(", ") : ` (${called.length} checked)`}`);
}

// ===========================================================================
group("every xray-* class the JS applies is styled, and none are dead");
// ===========================================================================
{
  const applied = uniq([
    ...matchAll(js, /class:\s*"([^"]+)"/g).flatMap((c) => c.split(/\s+/)),
    ...matchAll(js, /classList\.add\("([^"]+)"\)/g),
    ...matchAll(js, /setAttribute\("class",\s*"([^"]+)"\)/g),
    ...matchAll(js, /"\s(xray-[a-z-]+)"/g),
  ]).filter((c) => c.startsWith("xray-"));

  const styled = new Set(matchAll(css, /\.(xray-[a-zA-Z0-9-]+)/g));
  // Runtime-assembled: "xray-sev-" + severity. The prefix itself is never a
  // class; its variants never appear as literals.
  const dynamicPrefixes = uniq(matchAll(js, /"[^"]*?(xray-[a-z-]*-)"\s*\+/g));
  const isPrefix = (c) => dynamicPrefixes.includes(c);
  const fromPrefix = (c) => dynamicPrefixes.some((p) => c.startsWith(p) && c !== p);

  // Deliberately unstyled hooks: the namespace class, the .btn-styled fix
  // button, and the impact chip whose colours are data-driven inline.
  const bare = new Set(["xray-fix-btn", "xray-chip-impact"]);

  const unstyled = applied.filter((c) => !styled.has(c) && !isPrefix(c) && !bare.has(c));
  expect(unstyled.length === 0,
    `every xray-* class has a CSS rule${
      unstyled.length ? " — unstyled: " + unstyled.join(", ") : ` (${applied.length} checked)`}`);

  dynamicPrefixes.forEach((p) => {
    const variants = [...styled].filter((c) => c.startsWith(p) && c !== p);
    expect(variants.length > 0, `the runtime-built "${p}*" classes have rules`);
  });

  const orphans = [...styled].filter((c) => !js.includes(c) && !fromPrefix(c));
  expect(orphans.length === 0,
    `no xray-* rule is dead${orphans.length ? " — orphaned: " + orphans.join(", ") : ""}`);
}

// ===========================================================================
group("the design commitments hold in the source");
// ===========================================================================
{
  // 1. Severity never rides on colour alone: hatch patterns, glyph marks,
  //    the word in badges, the stripe — and a legend teaching all of them.
  expect(/SEV_HATCH = \{ critical: 6, high: 7, medium: 9 \}/.test(js),
    "hatch density: 6px critical, 7px high, 9px medium — density survives grayscale");
  expect(/SEV_MARK = \{ critical: "▲▲", high: "▲", medium: "●", low: "·" \}/.test(js),
    "glyph count: counting beats hue discrimination at chip size");
  expect(/legendRow/.test(js) && /xray-legend-swatch/.test(js),
    "the legend teaches swatch + glyph + word where they are used");
  expect(/width: 5, height: h/.test(js),
    "the 5px left stripe — severity by position, the fourth channel");

  // 2. Per-lens chips on every box, all three always visible.
  expect(/function lensChips/.test(js) &&
    /\["speed", "cost", "security"\]\.forEach/.test(js),
    "every box carries SPD/CST/SEC chips — the chips are how you pick a lens");
  expect(/ln === state\.lens \? C\.accent/.test(js),
    "…with the active lens ringed in teal");

  // 3. Lens buttons carry counts.
  expect(/function lensCounts/.test(js) && /xray-lens-count/.test(js),
    "lens buttons carry finding counts, so an empty lens is known before switching");

  // 4. Directed edges with trimmed arrowheads; hot path solid and coloured.
  expect(/marker-end.*arch-arrow/.test(js) && /function trimEdge/.test(js),
    "edges are directed, trimmed to box boundaries so arrowheads stay visible");
  expect(/SEV_RANK\[endSev\] \|\| 0\) >= 3/.test(js),
    "an edge goes hot when an endpoint carries high-or-worse under the lens");

  // 5. Keyboard model: arrows move, Enter activates, Esc goes up one level,
  //    aria-pressed reports the pin.
  expect(/ArrowRight|ArrowDown/.test(js) && /function moveFocus/.test(js),
    "arrow keys move focus between siblings — movement only, never activation");
  expect(/"aria-pressed": opts\.pressed/.test(js),
    "aria-pressed reports pin state, so the graph is legible without seeing it");
  expect(/state\.level === 2\) \{ state\.level = 1; state\.pinned = null/.test(js),
    "Esc goes up one level at a time, mirroring the breadcrumb");

  // 6. Diff mode: toggle only when a comparison happened; pulse exactly once;
  //    reduced motion disables it; resolved items stay visible with what
  //    they were.
  expect(/state\.newKeys !== null\) \{/.test(js),
    "the Since-last-run toggle only renders when a comparison actually happened");
  expect(/animation: xray-pulse 1100ms ease-out 1;/.test(css) &&
         /animation: xray-pulse-card 1400ms ease-out 1;/.test(css),
    "both pulses run exactly once (iteration-count 1)");
  expect(/prefers-reduced-motion: reduce\) \{\n  \.xray-new, \.xray-new-card \{ animation: none !important; \}/.test(css),
    "prefers-reduced-motion disables both — the badge and ring carry the diff");
  expect(/state\.pulsed\[/.test(js),
    "a finding pulses on first render only — re-renders never re-animate");
  expect(/resolvedItems/.test(js) && /xray-resolved-was/.test(js) &&
         /"was " \+ r\.severity/.test(js),
    "resolved findings stay visible, struck through, with what they were");

  // 7. Recommendations: effort × impact as two separate glyph chips, teal
  //    border only with the three-leg evidence box, scoped to the selection
  //    with an honest note when widened.
  expect(/EFFORT_MARK = \{ S: "○", M: "◐", L: "●" \}/.test(js),
    "effort has its own glyphs — never collapsed into one priority number");
  expect(/IMPACT_MARK = \{ high: "▲▲", medium: "▲", low: "·" \}/.test(js),
    "…and so does impact");
  expect(/xray-rec-legs/.test(js) && /hasLegs/.test(js),
    "the teal card border appears only when all three evidence legs are present");
  expect(/all three legs hold/.test(js),
    "the legs box names its own rule");
  expect(/r\.target === scope\.nodeId/.test(js) &&
         /none for this node — showing its cluster/.test(js),
    "recs scope to the pinned node and say so honestly when they widen");
  expect(/target: finding\.target/.test(recommendSrc) && /target: node\.id/.test(recommendSrc),
    "…and the analyzer supplies the target that scoping needs");

  // 8. The selection card explains what is selected before any list.
  expect(/function selectionCard/.test(js) && /function selectionScope/.test(js),
    "a selection card answers 'what am I looking at' above the findings");

  // 9. Full report link when the run is known; absent otherwise.
  expect(/if \(state\.runId\) \{/.test(js) && /#\/report\//.test(js),
    "Full report links to the stored run's report page, only when a run exists");

  // 10. Breadcrumb carries the L0/L1/L2 level tags.
  expect(/here\("L0"/.test(js) && /here\("L1"/.test(js) && /here\("L2"/.test(js),
    "the breadcrumb names its level, matching the design's zoom model");
}

// ===========================================================================
group("structural drift is rendered, and never invents a comparison");
// ===========================================================================
{
  expect(/\/api\/arch\/diff/.test(js),
    "the X-ray reads the diff endpoint Phase 1 shipped with nothing that drew it");
  expect(/\/api\/arch\/snapshots\?limit=1/.test(js),
    "…finding the latest snapshot rather than assuming an id");

  // The three outcomes must stay three. Collapsing "no history", "the
  // baseline aged out" and "nothing changed" into one empty state is the
  // exact failure the endpoint's own `note` was written to prevent: it would
  // report a brand-new repository and a lost baseline as a clean bill of
  // health.
  expect(/no_history/.test(js), "an org with no snapshots is its own state");
  expect(/incomparable/.test(js), "…distinct from a comparison that could not run");
  expect(/No structural change since the previous snapshot/.test(js),
    "…and both distinct from a diff that ran and found nothing");

  // The note is passed through, not re-derived. The endpoint distinguishes
  // "earliest snapshot" from "comparison point is gone"; re-deriving that in
  // the browser is how the two get conflated.
  expect(/d\.note \|\|/.test(js),
    "the endpoint's own wording is shown rather than a message guessed at in the client");

  expect(/reducedInputs/.test(js) && /no longer carries its/.test(js),
    "a reduced snapshot tells the reader its citations are gone");

  // Sign plus word, never colour alone — the rule the rest of the product
  // already follows.
  expect(/xray-drift-kind/.test(js) && /aria-hidden/.test(js),
    "the +/− sign is decorative and paired with a word that carries the state");
  expect(/\.xray-drift-kind/.test(css), "the drift panel is styled");

  // Everything above is satisfied by a panel that is written and never shown.
  // These two are the ones that bind it to the page: the loader has to run on
  // both paths that produce a result, and render() has to append what it
  // built. Verified by deleting each and watching this fail.
  expect((js.match(/loadDrift\(\)/g) || []).length >= 2,
    "the drift load runs on both result paths — a fresh analysis and a stored run");
  expect(/var drift = driftPanel\(\);[\s\S]{0,80}side\.appendChild\(drift\)/.test(js),
    "…and render() actually appends the panel it built");
}

// ===========================================================================
group("the map speaks the analyzer's vocabulary, not an invented one");
// ===========================================================================
{
  // The kind table is a mirror of buildGraph's output. A kind the analyzer
  // emits and the map does not know renders as "?" rather than borrowing
  // another kind's glyph, but the eleven it emits today must all be named:
  // an unrecognised kind on a real graph is a bug, not a degradation.
  const emitted = uniq(matchAll(graphSrc, /kind:\s*"([a-z_]+)"/g)).sort();
  const known = uniq(matchAll(js, /^\s{4}([a-z_]+):\s*\{ glyph:/gm)).sort();
  const unknown = emitted.filter((k) => !known.includes(k));
  expect(unknown.length === 0,
    `every kind buildGraph emits has a glyph and a description${
      unknown.length ? " — missing: " + unknown.join(", ") : ` (${emitted.length} kinds)`}`);
  expect(/KIND_UNKNOWN/.test(js) && /glyph: "\?"/.test(js),
    "…and a kind this build does not know still draws, marked as unrecognised");
  expect(/\.xray-sel-kinddesc/.test(css), "the kind description is styled");
}

// ===========================================================================
group("origin: whether a line was declared, observed, or both");
// ===========================================================================
{
  // enrich.js documents the three values and what each asserts. The map must
  // carry all three, because drawing a declaration and an observation the
  // same way is what let a static graph read as a live topology.
  ["static", "both", "runtime"].forEach((o) => {
    expect(new RegExp(`\\b${o}:\\s*\\{[^}]*label:`).test(js),
      `the map knows the "${o}" origin enrich.js emits`);
  });
  expect(/observed, never declared/.test(js) && /shadow/.test(js),
    "a runtime-only edge is named as a shadow dependency, in words");
  expect(/alarm: true/.test(js) && /xray-provenance-shadow/.test(css),
    "…and it is drawn to alarm rather than as one more line weight");

  // The prior question, stated permanently rather than on hover.
  expect(/A declaration graph, not a live one/.test(js),
    "the map states that it was read from files, not probed");
  expect(/provenanceNote\(result\.graph\)/.test(js),
    "…and render() actually appends that statement");

  // A cluster line stands in for several node lines. If a shadow hides in
  // that bundle, zooming out must not lose it.
  expect(/if \(o && o\.alarm\) seen\[key\]\.alarm = true/.test(js),
    "a shadow dependency survives the cluster-level edge collapse");
}

// ===========================================================================
group("confidence: cited by a file, or not");
// ===========================================================================
{
  // The predicate that decides this lives in the analyzer, and it must
  // understand the shape buildGraph actually emits. It did not: evidence is
  // a `path:line` STRING, hasEvidence only handled arrays and {file}
  // objects, and every node in every run came back unconfirmed while
  // carrying a real citation. Nothing caught it because no surface drew the
  // field. This pins the shape against the producer.
  expect(/const evidence = \(path, line\) =>/.test(graphSrc),
    "buildGraph cites as a `path:line` string");
  expect(/typeof x\.evidence === "string"/.test(enrichSrc),
    "…and hasEvidence recognises that form, so a cited fact reads as confirmed");

  expect(/isUnconfirmed/.test(js), "the map reads the confidence field");
  // Snapshots store the ENRICHED graph, so rows written before the fix above
  // carry "unconfirmed" forever. The UI must not print "no file cites this"
  // over a node whose citation is right there in the payload.
  expect(/hasCitation/.test(js) &&
         /x\.confidence === "unconfirmed" && !hasCitation\(x\)/.test(js),
    "a stored run with a stale verdict is not re-asserted against its own evidence");
  expect(/stroke-dasharray", "6 4"/.test(js) && /fill-opacity", "0\.45"/.test(js),
    "an unconfirmed node is dashed and washed, never drawn as an attested one");
  expect(/No file cites this/.test(js),
    "…and the detail card says why, in plain words");
  expect(/\.xray-sel-unconfirmed/.test(css), "the unconfirmed badge is styled");
}

// ===========================================================================
group("coverage is stated on every run, not only the bad ones");
// ===========================================================================
{
  // The analyzer already counts what it could not read. Reporting it only
  // when it is partial means a reader never learns the line exists, so they
  // have no reason to look for it on the run where it matters.
  expect(/COVERAGE · FULL/.test(js) && /COVERAGE · PARTIAL/.test(js),
    "coverage renders in both states");
  expect(/lower bound/.test(js),
    "a partial map says its counts are a lower bound");
  expect(/coverageStrip\(result\)/.test(js),
    "…and render() appends it");
  // Set in --fs-sm, the same size as the counts it qualifies. A lower-bound
  // warning in fine print is a way of having said it without it being read.
  expect(/\.xray-coverage-note \{[^}]*font-size: var\(--fs-sm\)/.test(css),
    "the lower-bound sentence is not set smaller than what it qualifies");
  // An old run stored before coverage was recorded is not a complete one.
  expect(/predates coverage recording/.test(js),
    "a run with no coverage recorded says so rather than reading as complete");
  expect(/filesAnalyzed/.test(js) && /truncatedSkippedList/.test(js),
    "the strip reads the fields the analyzer actually returns");
}

// ===========================================================================
group("one component of a run, addressable on its own");
// ===========================================================================
{
  // A 17-service graph plus "look at session-store" is not an answer. The
  // component has to be reachable directly — from a link, from the runs
  // feed, and by typing its name.
  expect(/componentIndex/.test(js) && /focusComponent/.test(js),
    "the explorer can resolve one component and focus it");
  expect(/#\/arch\/<runId>/.test(router) || /componentId/.test(router),
    "the router parses a component segment after the run id");
  expect(/openRun\(route\.runId, route\.componentId\)/.test(router),
    "…and passes it to the explorer");
  expect(/href:\s*"#\/arch\/" \+ encodeURIComponent\(it\.id\)/.test(dashboardJs),
    "View map in the runs feed routes through #/arch/<runId> so the explorer view is shown");
  expect(!/"data-run-action":\s*"viewmap"/.test(dashboardJs),
    "…and is not a button that loads into the hidden arch view");
  // dashboard.js builds the button through el(), so the action is an object
  // key rather than an HTML attribute — match what the file actually says.
  expect(/"data-run-action":\s*"archparts"/.test(dashboardJs),
    "the runs feed offers the components of an ARCH run");
  expect(/archparts/.test(js),
    "…and the explorer handles that action");
  expect(/xray-jump/.test(js) && /\.xray-jump-input/.test(css),
    "a component can also be reached by name from inside the map");
  expect(/list: listId/.test(js),
    "…via a native datalist, so typeahead needs no script of its own");

  // The two failure modes this must not have: a component that is not in
  // the run, and a run with no stored graph at all.
  expect(/missingComponent/.test(js) && /is not in this run/.test(js),
    "a stale component link keeps the map and names what it could not find");
  expect(/state\.missingComponent = null/.test(js),
    "…and the note is cleared on the next run, not inherited");
  expect(/no architecture map stored, so it has no components/.test(js),
    "a run with no stored graph says so rather than opening an empty picker");
}

// ===========================================================================
console.log("");
if (failures) {
  console.log(`\x1b[31m  ${failures} arch-frontend test(s) failed\x1b[0m`);
  process.exit(1);
}
console.log("\x1b[32m  all arch-frontend tests passed\x1b[0m");
