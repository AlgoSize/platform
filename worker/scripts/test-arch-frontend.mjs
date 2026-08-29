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
console.log("");
if (failures) {
  console.log(`\x1b[31m  ${failures} arch-frontend test(s) failed\x1b[0m`);
  process.exit(1);
}
console.log("\x1b[32m  all arch-frontend tests passed\x1b[0m");
