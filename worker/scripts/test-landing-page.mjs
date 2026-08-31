// The marketing landing page, and the code its claims and its wiring depend on.
//
// The page is a static Jekyll file, so nothing type-checks it. Two classes of
// breakage have to be caught here instead:
//
//   1. WIRING. pricing.js, checkout.js and auth-banner.js find their elements
//      by id, by attribute and by form action. Rename one in the markup and
//      the page still renders — the toggle simply stops working, silently, in
//      production. Every hook those three files read is pinned below.
//
//   2. CLAIMS. The page prints per-finding prices, a verdict vocabulary, a
//      rule id and an error code. Each is a fact about the Worker, and the
//      Worker is free to change under it. Where the page states a number, the
//      number is recomputed here from the same modules the product bills
//      from — so a price change that does not reach the page fails the build
//      rather than quietly overcharging or underquoting a visitor.
//
// Run with:  node scripts/test-landing-page.mjs

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { estimatePipelineCost } from "../src/ai/stages.js";
import { RULES } from "../src/analyzers/sast/registry.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SITE = join(__dirname, "..", "..", "site");

const index    = readFileSync(join(SITE, "index.html"), "utf8");
const nav      = readFileSync(join(SITE, "_includes", "nav.html"), "utf8");
const footer   = readFileSync(join(SITE, "_includes", "footer.html"), "utf8");
const css      = readFileSync(join(SITE, "assets", "css", "main.css"), "utf8");
const pricing  = readFileSync(join(SITE, "assets", "js", "pricing.js"), "utf8");
const checkout = readFileSync(join(SITE, "assets", "js", "checkout.js"), "utf8");
const validate = readFileSync(join(__dirname, "..", "src", "fix", "validate.js"), "utf8");
const stages   = readFileSync(join(__dirname, "..", "src", "ai", "stages.js"), "utf8");

let failures = 0;
const ok   = (msg) => console.log(`  \x1b[32m✓\x1b[0m ${msg}`);
const fail = (msg) => { console.log(`  \x1b[31m✗\x1b[0m ${msg}`); failures++; };
const expect = (cond, label) => (cond ? ok(label) : fail(label));
const group  = (name) => console.log(`\n\x1b[1m${name}\x1b[0m\n`);

// The stage/model selection the page prints. Kept next to the assertions that
// use it so the test states its premise instead of hiding it in a constant.
const SHOWN = {
  triage:   "@cf/openai/gpt-oss-20b",
  validate: "@cf/qwen/qwen3-30b-a3b-fp8",
  fix:      "@cf/moonshotai/kimi-k2.7-code",
  verify:   "@cf/qwen/qwen3-30b-a3b-fp8",
};
const usd = (n, dp) => "$" + n.toFixed(dp).replace(/0+$/, "").replace(/\.$/, "");

// ===========================================================================
group("the JavaScript that runs the page can still find everything it reads");
// ===========================================================================
{
  // pricing.js swaps prices on every element carrying both variants, scoped
  // to #pricing. Drop the id and the toggle silently does nothing.
  expect(/id="pricing"/.test(index) && /#pricing \[data-monthly\]\[data-annual\]/.test(pricing),
    "pricing.js scopes its price swap to a #pricing section that exists");
  expect(/name="billing"[\s\S]{0,80}value="monthly"/.test(index) &&
         /name="billing"[\s\S]{0,80}value="annual"/.test(index),
    "both billing radios are present with the values pricing.js compares against");
  expect((index.match(/data-monthly=/g) || []).length >= 8 &&
         (index.match(/data-annual=/g) || []).length >= 8,
    "every price and billing note carries both interval variants");

  // The seat stepper: pricing.js reads these two ids by name.
  expect(/id="practice-seats"/.test(index) && /id="practice-total"/.test(index) &&
         /getElementById\("practice-seats"\)/.test(pricing) &&
         /getElementById\("practice-total"\)/.test(pricing),
    "the seat stepper's input and total carry the ids pricing.js looks up");
  expect((index.match(/data-seat-step=/g) || []).length === 2,
    "both seat step buttons are present");

  // checkout.js: one form per sellable tier, plus the seat source.
  expect((index.match(/action="\/api\/checkout"/g) || []).length === 3 &&
         /form\[action="\/api\/checkout"\]/.test(checkout),
    "all three tiers post to the checkout endpoint checkout.js binds to");
  expect(/data-plan="solo"/.test(index) && /data-plan="practice"/.test(index) &&
         /data-plan="firm"/.test(index),
    "each checkout form names its plan");
  expect(/data-seats-from="practice-seats"/.test(index) &&
         /dataset\.seatsFrom/.test(checkout),
    "the Practice form points checkout.js at the seat input");

  // The free-tier signup, and the slot auth-banner.js renders into.
  expect(/id="signup-free-form"/.test(index) && /id="signup-email"/.test(index) &&
         /id="signup-message"/.test(index) &&
         /getElementById\("signup-free-form"\)/.test(checkout),
    "the free signup form keeps the three ids checkout.js drives");
  expect(/id="auth-banner-slot"/.test(index),
    "the auth banner still has its slot above the hero");
}

// ===========================================================================
group("no link on the site points at a section the page no longer has");
// ===========================================================================
{
  const anchors = new Set(
    [...index.matchAll(/<section[^>]*\sid="([a-z-]+)"/g)].map((m) => m[1]),
  );
  const linked = new Set(
    [...(nav + footer).matchAll(/href="\/#([a-z-]+)"/g)].map((m) => m[1]),
  );
  // #signup-free-form is an element, not a section — the nav's "Sign in".
  linked.delete("signup-free-form");
  const dead = [...linked].filter((a) => !anchors.has(a));
  expect(dead.length === 0, `nav and footer anchors all resolve${dead.length ? ` (dead: ${dead.join(", ")})` : ""}`);

  // /#features is linked from a published blog post, so it has to survive
  // any future renaming of that section.
  expect(anchors.has("features"),
    "the #features anchor a published post links to still exists");
}

// ===========================================================================
group("the per-finding prices are the ones the product actually bills");
// ===========================================================================
{
  // Recomputed, not transcribed: this is the same call the pipeline UI makes.
  const full = estimatePipelineCost(SHOWN);
  const routed = estimatePipelineCost(SHOWN, { routeToMcp: ["fix"] });

  expect(full.perFinding.algosizePrice !== null && !full.perFinding.partial,
    "the shipped stage selection is fully priced (no unpriced stage)");

  const headline = usd(full.perFinding.algosizePrice, 5);
  expect(index.includes(headline),
    `the headline per-finding price on the page is ${headline}, the funnel-blended figure`);
  const per100 = usd(full.perFinding.per100Findings, 2);
  expect(index.includes(per100),
    `the per-100-findings figure on the page is ${per100}`);

  const routedPrice = usd(routed.perFinding.algosizePrice, 5);
  expect(index.includes(routedPrice),
    `the bring-your-own-agent price on the page is ${routedPrice}`);

  // The blended total must be well under the sum of the per-run stage prices.
  // Charging every stage at full volume was a real bug once: it quoted ~9x.
  const sumPerRun = Object.values(full.perStage)
    .reduce((t, s) => t + (s.algosizePricePerRun || 0), 0);
  expect(full.perFinding.algosizePrice < sumPerRun / 2,
    "the page's total is funnel-blended, not the sum of the per-stage prices");

  // Each stage row prints the cost of one finding that reaches that stage.
  for (const [id, model] of Object.entries(SHOWN)) {
    const shown = usd(full.perStage[id].algosizePricePerRun, 6);
    expect(index.includes(shown),
      `the ${id} row prints ${shown}, its per-run price`);
    expect(index.includes(model.split("/").pop()),
      `the ${id} row names ${model.split("/").pop()}`);
  }
}

// ===========================================================================
group("the vocabulary the page quotes is the vocabulary the Worker emits");
// ===========================================================================
{
  expect(/passed_static/.test(index) && /"passed_static"/.test(validate),
    "the verdict badge prints a verdict validate.js can actually return");

  // The five checks named on the page are the five the validator runs — the
  // page used to claim three, which undersold it and would have gone stale
  // in the other direction just as easily.
  const emitted = new Set(
    [...validate.matchAll(/check: "([a-z_]+)"/g)].map((m) => m[1]),
  );
  expect(emitted.size === 5, `validate.js emits five checks (${[...emitted].join(", ")})`);
  expect(/Static validation · 5 of 5/.test(index),
    "the page's count matches the number of checks that run");

  expect(/must_differ/.test(index) && /code: "must_differ"/.test(stages),
    "the rejection the page names is the code validateStageConfig returns");
  expect(/422 must_differ/.test(index),
    "and it is paired with the status the API answers with");

  const ruleId = "sast.sql-injection.tainted-query";
  expect(RULES.some((r) => r.id === ruleId),
    `${ruleId} is a registered rule`);
  expect(index.includes(ruleId),
    "the fix card cites that rule id rather than an invented one");
}

// ===========================================================================
group("the advisory in the hero is a real one, scored from its own vector");
// ===========================================================================
{
  // A landing page for a scanner that prints a wrong advisory id is the same
  // failure the product exists to prevent, one layer up.
  expect(/GHSA-xvch-5gv4-984h/.test(index) && /minimist/.test(index) &&
         /1\.2\.5/.test(index) && /1\.2\.6/.test(index),
    "the hero names a real advisory with its affected and fixed versions");
  expect(/CVSS:3\.1\/AV:N\/AC:L\/PR:N\/UI:N\/S:U\/C:H\/I:H\/A:H/.test(index),
    "the vector is printed in full, so the 9.8 can be checked by hand");
  expect(/computed, not copied/.test(index),
    "and the card says the score is computed rather than relayed");
}

// ===========================================================================
group("the page holds up on a phone");
// ===========================================================================
{
  // Below 768px the inline nav links are hidden. Before the disclosure existed
  // that left a phone with no way to reach Pricing at all.
  expect(/<details class="nav-menu">/.test(nav),
    "the mobile menu is a <details> element, so it works with JavaScript off");
  expect(/\.nav-menu \{ display: block/.test(css) &&
         /@media \(min-width: 768px\) \{\n  \.nav-menu \{ display: none; \}/.test(css),
    "it is shown and hidden at the same breakpoint that swaps .nav-links");
  expect((nav.match(/href="\/#pricing"/g) || []).length >= 2,
    "both nav link sets reach pricing");

  // Wide content scrolls inside its own box; the page body never scrolls.
  expect(/\.fixcard-diff \{[\s\S]*?overflow-x: auto;/.test(css),
    "the diff scrolls inside the fix card rather than widening the page");

  // main.css is shared with the dashboard, and test-monitors-frontend.mjs
  // guards the .analyzer-* prefix as the monitor chips' own: any rule with
  // that prefix must be applied by the dashboard. The landing page's cards
  // are .instrument-*, so the two components cannot collide in one sheet.
  expect(!/class="[^"]*\banalyzer-/.test(index),
    "the landing page stays off the dashboard's .analyzer-* class prefix");

  // Every custom list zeroes the UA's padding — three new lists forgot it
  // once, and the indent it left read as a broken layout.
  for (const cls of ["checklist", "pipe-steps", "funnel"]) {
    const block = css.match(new RegExp(`\\.${cls} \\{[^}]*\\}`));
    expect(Boolean(block) && /padding: 0/.test(block[0]) && /list-style: none/.test(block[0]),
      `.${cls} resets the browser's default list indent`);
  }
}

// ---------- summary ----------
console.log("");
if (failures === 0) {
  console.log("\x1b[32m  all landing-page tests passed\x1b[0m\n");
  process.exit(0);
} else {
  console.log(`\x1b[31m  ${failures} landing-page test(s) failed\x1b[0m\n`);
  process.exit(1);
}
