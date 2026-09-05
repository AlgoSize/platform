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

import { readFileSync, readdirSync } from "node:fs";
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
const resolve  = readFileSync(join(__dirname, "..", "src", "compliance", "resolve.js"), "utf8");
const accept   = readFileSync(join(__dirname, "..", "src", "risk", "accept.js"), "utf8");
const workspce = readFileSync(join(SITE, "assets", "js", "dash-workspace.js"), "utf8");
const ssdf     = readFileSync(join(SITE, "compliance", "SSDF-mapping.md"), "utf8");
const cra      = readFileSync(join(SITE, "compliance", "CRA-mapping.md"), "utf8");
const packDir  = readdirSync(join(SITE, "compliance")).filter((f) => f.endsWith(".md"));

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
group("the compliance section counts what is actually in the mapping");
// ===========================================================================
{
  // The page prints 11 / 7 / 23 out of 41. Those are not decorative: they are
  // the SSDF mapping's own summary, and the mapping is edited by hand whenever
  // a control changes state. Recount the table body here rather than trusting
  // the summary row — a summary that has drifted from its own table would
  // otherwise agree with a page that has drifted with it.
  const practiceRows = ssdf.split("\n").filter((l) => /^\| \*\*[A-Z]{2}\.\d/.test(l));
  const countOf = (state) =>
    practiceRows.filter((l) => l.includes("| `" + state + "` |")).length;
  const counted = {
    automated: countOf("automated"),
    attested: countOf("attested"),
    "not covered": countOf("not covered"),
  };

  expect(practiceRows.length === 41,
    `the SSDF mapping still holds 41 practices (found ${practiceRows.length})`);
  expect(counted.automated + counted.attested + counted["not covered"] === practiceRows.length,
    "every practice carries exactly one of the three coverage states");

  // Each printed count is matched against its own card, not against the page
  // as a whole — "11" appearing somewhere is not the same as the automated
  // card saying 11.
  for (const [state, n] of Object.entries(counted)) {
    const cls = { automated: "cov-automated", attested: "cov-attested", "not covered": "cov-uncovered" }[state];
    const card = index.match(new RegExp(`<article class="cov-card ${cls}">[\\s\\S]*?</article>`));
    expect(Boolean(card) && new RegExp(`<strong>${n}</strong>\\s*${state}`).test(card[0]),
      `the ${state} card prints ${n}, the number in the mapping`);
  }

  const craRows = cra.split("\n").filter((l) => /^\| \*\*II\.\d/.test(l));
  expect(craRows.length === 8,
    `the CRA mapping still holds 8 Annex I Part II obligations (found ${craRows.length})`);
  expect(/EU CRA\s*\n?\s*Annex I Part II — 8 obligations/.test(index.replace(/\s+/g, " ").replace(/ /g, " ")) ||
         /Annex I Part II — 8 obligations/.test(index.replace(/\s+/g, " ")),
    "and the page says 8, not a number of its own");

  // The three practices in the two-axes table are quoted from the mapping. A
  // reworded practice must reword the page, or the page is quoting a document
  // that no longer says that.
  const AXES = [
    { id: "PW.4.1", state: "automated", cls: "ev-automated" },
    { id: "PS.1.1", state: "attested",  cls: "ev-attested" },
    { id: "PW.8.2", state: "not covered", cls: "ev-uncovered" },
  ];
  for (const a of AXES) {
    const row = ssdf.split("\n").find((l) => l.startsWith(`| **${a.id}**`));
    const title = row ? row.split("|")[2].trim() : null;
    expect(Boolean(title) && index.includes(title),
      `${a.id} is quoted word for word from the mapping`);
    expect(Boolean(row) && row.includes("| `" + a.state + "` |"),
      `${a.id} is ${a.state} in the mapping, which is what the page shows`);
    // The state and the verdict are two different cells. Pin the state to the
    // "How we know" column specifically: showing it in the Result column would
    // be the exact collapse the section's own note says never happens.
    const trBody = index.match(new RegExp(`<th scope="row" class="mono">${a.id.replace(/\./g, "\\.")}</th>[\\s\\S]*?</tr>`));
    expect(Boolean(trBody) && trBody[0].includes(`class="ev ${a.cls} mono"`),
      `${a.id}'s evidence state sits in the How-we-know column`);
  }

  // Two axes means the Result column has its own vocabulary, and the page may
  // only print words resolve.js can actually return.
  expect(/not_met/.test(resolve) && />✕<\/span> not met</.test(index.replace(/<span aria-hidden="true">/g, ">")),
    "\"not met\" is a result resolve.js can return");
  expect(/attestation_expired/.test(resolve) && /attestation expired/.test(index),
    "\"attestation expired\" is a result resolve.js can return");
  // PW.8.2 has no result at all. If it ever renders as one, the table has
  // collapsed the two axes into one badge.
  const uncoveredRow = index.match(/<th scope="row" class="mono">PW\.8\.2<\/th>[\s\S]*?<\/tr>/);
  expect(Boolean(uncoveredRow) && !/class="res /.test(uncoveredRow[0]) &&
         /no result/.test(uncoveredRow[0]),
    "a not-covered control renders no result, rather than a passing one");
}

// ===========================================================================
group("the accepted risk on the page is one the register would accept");
// ===========================================================================
{
  const card = index.match(/<article class="risk-card">[\s\S]*?<\/article>/);
  expect(Boolean(card), "the accepted-risk card is on the page");

  const ruleId = card ? (card[0].match(/([a-z]+\.[a-z0-9-]+\.[a-z0-9-]+) ·/) || [])[1] : null;
  const rule = RULES.find((r) => r.id === ruleId);
  expect(Boolean(rule), `${ruleId} is a registered rule, not an invented one`);

  // The design this section came from named `sast.xss.unescaped-template`,
  // which no analyzer emits. Printing a severity or a CWE the rule does not
  // carry is the same class of mistake one field further in.
  expect(Boolean(rule) && card[0].includes(`· ${rule.severity} ·`),
    "the severity beside the rule is the severity the registry gives it");
  expect(Boolean(rule) && rule.cwe.some((c) => card[0].includes(c)),
    "and the CWE is one the rule actually carries");

  // The whole point of NEVER_ACCEPTABLE is that some findings cannot be signed
  // away. An example drawn from one of those categories would advertise a
  // capability the code refuses.
  const banned = (accept.match(/NEVER_ACCEPTABLE = Object\.freeze\(\[([^\]]*)\]/) || [])[1] || "";
  const bannedList = banned.split(",").map((x) => x.trim().replace(/"/g, "")).filter(Boolean);
  expect(bannedList.length > 0 && Boolean(rule) && !bannedList.includes(rule.category),
    `the example's category (${rule && rule.category}) is one the register will accept`);
  // Sentence tests run against whitespace-collapsed HTML: the page wraps its
  // prose, and a line break inside a quoted sentence is not a change to it.
  const prose = index.replace(/\s+/g, " ");
  expect(bannedList.includes("secrets") && bannedList.includes("dependency") &&
         /Committed credentials and dependency advisories can never be accepted/.test(prose),
    "the page names the two categories the code refuses, and only those two");

  // Expiry is a read-side rule. The page says so because that is what makes a
  // revocation retroactive; if the code ever persisted the decision instead,
  // this sentence would become a promise nothing keeps.
  expect(/enforced on read/.test(prose) && /Nothing is stored against the scan/.test(prose),
    "the page states that expiry is evaluated on read, which is where accept.js evaluates it");
}

// ===========================================================================
group("the self-audit section counts real files");
// ===========================================================================
{
  const roadmapPages = packDir.filter((f) =>
    /^## Roadmap/m.test(readFileSync(join(SITE, "compliance", f), "utf8")));
  expect(/publish the result — 20 pages/.test(index.replace(/\s+/g, " ")) &&
         packDir.length === 20,
    `the pack really is ${packDir.length} pages, and the page says 20`);
  expect(roadmapPages.length === 17 &&
         /17 policy pages ends with a Roadmap section/.test(index.replace(/\s+/g, " ")),
    `${roadmapPages.length} pages end in a Roadmap section, and the page says 17`);
}

// ===========================================================================
group("the watch section describes automation that exists");
// ===========================================================================
{
  const workflow = readFileSync(join(__dirname, "..", "..", ".github", "workflows", "algosize-audit.yml"), "utf8");
  expect(/upload-sarif/.test(workflow) && /SARIF to the GitHub Security tab/.test(index.replace(/\s+/g, " ")),
    "the gate really does upload SARIF, which is what the page claims");
  expect(/One sticky comment per PR/.test(workflow) &&
         /in one\s+comment it keeps updating/.test(index),
    "and it really does keep one comment rather than appending");

  const migration = readFileSync(join(__dirname, "..", "migrations", "0017_monitor_health.sql"), "utf8");
  expect(/run_at_hour/.test(migration) &&
         /One sweep per repository, on your schedule/.test(index),
    "a per-repository hour is a stored column, not a plan");
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

  // Same rule, second prefix. test-tools-frontend.mjs owns watch-* for the
  // optimizer and estimator pages and fails any rule with that prefix the
  // dashboard does not apply — so a landing-page section about scheduled
  // sweeps has to be named something else, and was.
  expect(!/class="[^"]*\bwatch-/.test(index),
    "and off the tool pages' .watch-* prefix");

  // Every custom list zeroes the UA's padding — three new lists forgot it
  // once, and the indent it left read as a broken layout.
  for (const cls of ["checklist", "pipe-steps", "funnel", "risk-rules"]) {
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
