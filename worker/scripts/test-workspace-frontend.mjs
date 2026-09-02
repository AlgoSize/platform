// Wiring tests for the redesigned Workspace and Monitors & CI screens (D-8),
// and for the two-tab header they share.
//
// The collapse from five tabs to two moved three panels into new views, added
// a scorecard fed by a new endpoint, and made two settings that had never
// been consulted actually load-bearing. Every one of those is a seam where
// vanilla JS fails silently — getElementById returns null, a branch does
// nothing, and the page renders without the feature. These tests close them,
// and pin the honesty rules that are easy to lose precisely because losing
// them does not throw.
//
// Run with:  node scripts/test-workspace-frontend.mjs

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SITE   = join(__dirname, "..", "..", "site");
const WORKER = join(__dirname, "..", "src");

const html    = readFileSync(join(SITE, "dashboard.html"), "utf8");
const wsJs    = readFileSync(join(SITE, "assets", "js", "dash-workspace.js"), "utf8");
const archJs  = readFileSync(join(SITE, "assets", "js", "dash-arch.js"), "utf8");
const scanJs  = readFileSync(join(SITE, "assets", "js", "dash-scanner.js"), "utf8");
const optJs   = readFileSync(join(SITE, "assets", "js", "dash-optimizer.js"), "utf8");
const estJs   = readFileSync(join(SITE, "assets", "js", "dash-estimate.js"), "utf8");
const monJs   = readFileSync(join(SITE, "assets", "js", "dash-monitors.js"), "utf8");
const dashJs  = readFileSync(join(SITE, "assets", "js", "dashboard.js"), "utf8");
const router  = readFileSync(join(SITE, "assets", "js", "dash-router.js"), "utf8");
const css     = readFileSync(join(SITE, "assets", "css", "main.css"), "utf8");
const worker  = readFileSync(join(WORKER, "index.js"), "utf8");
const scorecard = readFileSync(join(WORKER, "handlers", "scorecard.js"), "utf8");
const runsJs    = readFileSync(join(WORKER, "handlers", "runs.js"), "utf8");
const routing   = readFileSync(join(WORKER, "monitors", "routing.js"), "utf8");
const meJs      = readFileSync(join(WORKER, "handlers", "me.js"), "utf8");
const inspect   = readFileSync(join(WORKER, "monitors", "inspect.js"), "utf8");
const scanJs2   = readFileSync(join(SITE, "assets", "js", "dash-scanner.js"), "utf8");
const costJs    = readFileSync(join(SITE, "assets", "js", "dash-cost.js"), "utf8");

let failures = 0;
const ok   = (msg) => console.log(`  \x1b[32m✓\x1b[0m ${msg}`);
const fail = (msg) => { console.log(`  \x1b[31m✗\x1b[0m ${msg}`); failures++; };
const expect = (cond, label) => (cond ? ok(label) : fail(label));
const group  = (name) => console.log(`\n\x1b[1m${name}\x1b[0m\n`);

const matchAll = (src, re) => [...src.matchAll(re)].map((m) => m[1]);
const uniq = (a) => [...new Set(a)];

// ===========================================================================
group("the header is two tabs and an account control");
// ===========================================================================
{
  const tabs = matchAll(html, /class="dash-tab"[^>]*data-view="([^"]+)"/g)
    .concat(matchAll(html, /data-view="([^"]+)"[^>]*class="dash-tab"/g));
  expect(uniq(tabs).length === 2 && tabs.includes("workspace") && tabs.includes("monitors"),
    `the nav strip holds exactly Workspace and Monitors & CI (found: ${uniq(tabs).join(", ") || "none"})`);
  expect(!/data-view="team"/.test(html),
    "Team no longer holds a tab — it lives inside Account");

  expect(/id="dash-avatar"/.test(html) && /id="account-link"/.test(html),
    "the Account control and its avatar slot exist");
  expect(/function hydrateAccountControl/.test(dashJs) &&
         /hydrateAccountControl\(me\)/.test(dashJs),
    "and /api/me hydrates it on every header refresh");
  // A URL that 404s must fall back to initials rather than leaving a broken
  // image — the person who set it would never see the failure otherwise.
  expect(/addEventListener\("error"/.test(dashJs) &&
         /me\.initials \|\| "··"/.test(dashJs),
    "a failed avatar image falls back to the initials, not a broken image");
  expect(/initials:\s+initialsFor\(/.test(meJs) &&
         /displayName:\s*\(stored && stored\.displayName\)/.test(meJs) &&
         /avatarUrl:\s+\(stored && stored\.avatarUrl\)/.test(meJs),
    "/api/me returns displayName, avatarUrl and server-computed initials");
}

// ===========================================================================
group("the tools that left the strip still have views and routes");
// ===========================================================================
{
  for (const v of ["scanner", "cost", "arch", "optimizer", "estimate"]) {
    expect(new RegExp(`id="view-${v}"`).test(html) &&
           new RegExp(`"#/${v}"`).test(router) &&
           new RegExp(`"${v}"`).test(router),
      `#/${v} has a view and a route`);
  }
  const workspace = html.split('id="view-workspace"')[1].split("/view-workspace")[0];
  for (const id of ["panel-vuln", "panel-cost", "panel-arch"]) {
    expect(!workspace.includes(`id="${id}"`),
      `${id} moved out of the workspace rather than being duplicated`);
  }
  expect(/id="panel-vuln"/.test(html) && /id="panel-cost"/.test(html) && /id="panel-arch"/.test(html),
    "…and all three still exist exactly once, so dashboard.js keeps driving them");
}

// ===========================================================================
group("selectors resolve — the silent-null failure");
// ===========================================================================
{
  const htmlIds = new Set(matchAll(html, /\sid="([^"]+)"/g));
  for (const [name, src] of [["dash-workspace.js", wsJs], ["dash-monitors.js", monJs]]) {
    const wanted = uniq(matchAll(src, /getElementById\("([^"]+)"\)/g));
    const missing = wanted.filter((id) => !htmlIds.has(id));
    expect(missing.length === 0,
      `every id ${name} queries exists${missing.length ? " — missing: " + missing.join(", ") : ` (${wanted.length} checked)`}`);
  }
}

// ===========================================================================
group("every endpoint the new screens call is a route the Worker declares");
// ===========================================================================
{
  const declared = matchAll(worker, /router\.(?:get|post|put|patch|delete|all)\(\s*"([^"]+)"/g);
  const patterns = declared.map((p) =>
    new RegExp("^" + p.replace(/:[A-Za-z0-9_]+/g, "[^/]+").replace(/\*/g, ".*") + "$"));
  const called = uniq([
    ...matchAll(wsJs,  /callApi\("([^"?+]+?)["?]/g),
    ...matchAll(monJs, /callApi\("([^"?+]+?)["?]/g),
  ]);
  const unrouted = called.filter((path) => !patterns.some((re) => re.test(path)));
  expect(unrouted.length === 0,
    `every called path is routed${unrouted.length ? " — unrouted: " + unrouted.join(", ") : ` (${called.length} checked)`}`);
  expect(called.includes("/api/scorecard"), "the scorecard reads /api/scorecard");
  expect(called.includes("/api/monitors/route"), "the routing card reads /api/monitors/route");
}

// ===========================================================================
group("the scorecard never turns 'not measured' into a pass");
// ===========================================================================
{
  // Four kinds, and the frontend has to render all four differently. If a
  // kind loses its branch the cell silently falls through to the last one.
  for (const kind of ["grade", "stale", "pending", "off"]) {
    expect(wsJs.includes(`"${kind}"`), `dash-workspace.js handles the "${kind}" cell`);
  }
  expect(/kind: "pending"/.test(scorecard) && /kind: "off"/.test(scorecard),
    "and the Worker distinguishes pending from off — different problems, different fixes");
  expect(/scorecard-cell-stale \.scorecard-value/.test(css),
    "a stale value is styled apart from a current one");

  // An accurate blank is only half a product: the reader still has to guess
  // whether the next move is theirs or ours. Every non-grade cell carries a
  // `fix`, and the renderer has to put it on the screen — a field the API
  // sends and the page drops is indistinguishable from one that was never
  // built, which is exactly how the cloud-spend column stayed invisible.
  expect(/fix: null/.test(scorecard) && /fixUnavailable/.test(scorecard),
    "the Worker attaches a fix to the cells that have one, and null to the cells that do not");
  expect(/cell\.fix/.test(wsJs) && /scorecard-fix/.test(wsJs),
    "dash-workspace.js renders it");
  expect(/\.scorecard-fix\b/.test(css), "…and it is styled");
  // It is the one line in the grid that must WRAP. Every other line truncates
  // because a clipped number is still a number; a clipped instruction is not
  // an instruction.
  expect(!/\.scorecard-fix\s*\{[^}]*white-space:\s*nowrap/.test(css),
    "…and is not clamped to one line the way the numbers are");

  // Five analyzers can be scheduled, so five columns are graded. The sort
  // controls and the header are built from the API's column list, not from a
  // literal, so this is the only place a missing column can hide.
  expect(/state\.scorecard && state\.scorecard\.columns/.test(wsJs),
    "the sort controls are built from the API's columns, so a new column needs no frontend edit");
  expect(/\(data\.columns \|\| \[\]\)\.forEach/.test(wsJs),
    "…and so is the table header");
  expect(/if \(av === null && bv === null\) return 0;/.test(wsJs) &&
         /if \(av === null\) return 1;/.test(wsJs),
    "unmeasured rows sort LAST, so a repo with no baseline is never top of the board");

  // The grade must come from the audit's own scoring function. Two copies of
  // the ceiling rules would eventually put a letter on the scorecard that the
  // report it links to does not show.
  expect(/scoreForCounts/.test(scorecard) && !/counts\.critical > 0\)\s+score = Math\.min/.test(scorecard),
    "security grades call the audit's scoreForCounts rather than re-implementing the ceilings");
}

// ===========================================================================
group("the header says what each column is measured in");
// ===========================================================================
{
  // The caption travels with the label from the Worker. A parallel list in
  // the frontend would be a second place to rename a column, and the two
  // would disagree the first time only one of them was edited.
  expect(/idiom: c\.idiom/.test(scorecard) && /glyph: c\.glyph/.test(scorecard),
    "the endpoint serves idiom and glyph alongside the label");
  expect(/c\.idiom/.test(wsJs) && /c\.glyph/.test(wsJs),
    "…and dash-workspace.js renders the API's values, not its own");
  expect(!/"Infra cost"|"Cloud spend"|"Dependencies"/.test(wsJs),
    "no column label is hardcoded in the frontend");
  // Every column needs one, or the ones without a caption read as the units
  // of the column beside them.
  const idioms = matchAll(scorecard, /idiom:\s*"([^"]+)"/g);
  const glyphs = matchAll(scorecard, /glyph:\s*"((?:[^"\\]|\\.)+)"/g);
  const cols   = matchAll(scorecard, /\{ id: "([a-z]+)",/g);
  expect(idioms.length === cols.length && glyphs.length === cols.length,
    `all ${cols.length} columns carry both (idioms: ${idioms.length}, glyphs: ${glyphs.length})`);
  // The head row is uppercase and tracked out; the caption must not be, or
  // the header reads as two labels stacked rather than a label and its unit.
  expect(/\.scorecard-th-idiom\s*\{[^}]*text-transform:\s*none/.test(css),
    "the caption is set apart from the label, not styled as a second one");
  expect(/aria-hidden": "true"[^}]*\}, c\.glyph/.test(wsJs) ||
         /class: "scorecard-th-glyph", "aria-hidden": "true" \}, c\.glyph/.test(wsJs),
    "the glyph is decoration — hidden from a screen reader, which gets the label");
}

// ===========================================================================
group("exactly one column carries a trend, because exactly one stores a delta");
// ===========================================================================
{
  // last_delta_json is written BY the sweep because it cannot be recomputed
  // on read — the previous advisory set is gone the moment the current one
  // overwrites it. The other five analyzers keep a current baseline and
  // nothing to compare it against, so a trend for them could only be made up.
  expect(/trends: \{ security: depsTrend\(m\) \}/.test(scorecard),
    "the row carries a trend for the dependency column and no other");
  expect(/function depsTrend/.test(scorecard) && /m\.lastDelta/.test(scorecard),
    "…and it comes from the stored delta rather than from a diff computed on read");
  expect(/if \(d\.baseline\) return null;/.test(scorecard),
    "a baseline sweep reports NO trend — its zero is a starting point, not a comparison");
  expect(/if \(!t\) return;/.test(wsJs),
    "a null or absent trend renders nothing, never a flat placeholder");
  // "=" beside a number nobody compared is the grid asserting stability it
  // never measured. There is no such glyph anywhere in the renderer.
  expect(!/"=" *\)/.test(wsJs) && !/scorecard-trend-same/.test(wsJs + css),
    "there is no 'unchanged' marker for the columns that were never compared");
  // Composed class names are the one thing the styled-class guard below
  // cannot see, so the two directions are pinned by name here.
  for (const dir of ["up", "flat"]) {
    expect(wsJs.includes(`scorecard-trend-${dir}`) &&
           new RegExp(`\\.scorecard-trend-${dir}\\b`).test(css),
      `the "${dir}" trend has a class in the renderer and a rule in the stylesheet`);
  }
  expect(/color: var\(--sev-critical\)/.test(
    css.slice(css.indexOf(".scorecard-trend-up"), css.indexOf(".scorecard-trend-flat"))),
    "…and 'up' is styled as bad news — this column counts new advisories, and there are no good ones");
  // The same zero on the Monitors screen. Two screens reading one column have
  // to agree about what it says, or the scorecard and the monitor row report
  // different things about the same sweep.
  expect(/d\.baseline/.test(monJs) && /"baseline"/.test(monJs),
    "the monitor row calls a baseline a baseline rather than 'no change'");
}

// ===========================================================================
group("a cell opens the tool behind it, for that repo");
// ===========================================================================
{
  // The grid says WHAT a repo scored; the tool page says why. A reader who
  // has to land on the bench and re-pick the repo from a list was handed the
  // navigation instead of the answer.
  expect(/analyzer: c\.analyzer/.test(scorecard),
    "the API sends each column's analyzer, so the link is built from server truth");
  expect(/#\/" \+ view \+ "\/watch\/"/.test(wsJs),
    "the cell href is #/<tool>/watch/<monitorId>");
  expect(/monitorId: m\.monitorId/.test(scorecard),
    "…and the row carries the monitor id that link needs");

  // The set of linkable analyzers is DERIVED from the Worker's own list, not
  // written out here. A literal would go stale in the unhelpful direction:
  // making an analyzer inspectable and forgetting to link it would still pass.
  const inspectable = (inspect.match(/INSPECTABLE = Object\.freeze\(\[([^\]]+)\]/) || [])[1] || "";
  const analyzers = inspectable.split(",").map((s2) => s2.trim().replace(/"/g, "")).filter(Boolean);
  const mapped = [...wsJs.matchAll(/(\w+): "(scanner|arch|optimizer|estimate|cost)",?/g)]
    .map((m) => m[1]);
  const viewKeys = wsJs.slice(wsJs.indexOf("var ANALYZER_VIEW"), wsJs.indexOf("var ANALYZER_VIEW") + 400);
  analyzers.forEach((a) => {
    expect(new RegExp("\\b" + a + ": \"").test(viewKeys),
      `${a} is inspectable on the Worker, so its column links to a tool page`);
  });
  expect(/\bcost: "cost"/.test(viewKeys),
    "cloud spend links too — it was the last column that could be graded and never opened, " +
    "and its cells were the only dead ends in the grid");
  expect(analyzers.length === 5,
    `all five analyzers are inspectable (${analyzers.join(", ")})`);
  expect(mapped.length >= 5, "the analyzer→view map covers every one of them");

  // The reason cloud spend took longer than the rest, and the rule that
  // survived giving it a page: it is the one analyzer with no baseline, on
  // purpose. A bill differs every day, so a diff would report Tuesday being
  // different from Monday as a finding.
  expect(/delta: null/.test(inspect) && /isBaseline: null/.test(inspect),
    "inspectCost returns a NULL delta, not an empty one — an empty delta would read as " +
    "'we compared and nothing changed' about a comparison nobody ran");
  expect(!/lastCost/.test(scorecard) || !/trends: \{ [^}]*spend/.test(scorecard),
    "…and cloud spend still carries no trend on the scorecard");

  // An <a> inside an <a> is invalid and the browser silently unnests it,
  // which is how the inner link stops working. The off cell already holds
  // one, so the cell around it must not be a second.
  expect(/cell\.kind === "off" \? null : cellHref\(r, col\)/.test(wsJs),
    "an off cell is not a link — its own move is to Monitors, and nesting anchors breaks both");

  // Four tool pages, one entry point each, one route shape for all of them.
  for (const [mod, src] of [["DashScanner", scanJs2], ["DashArch", archJs],
                            ["DashOptimizer", optJs], ["DashEstimate", estJs],
                            ["DashCost", costJs]]) {
    expect(/openMonitor: openMonitor/.test(src) && /function openMonitor\(monitorId\)/.test(src),
      `${mod} exposes openMonitor(monitorId)`);
    expect(/core\.clickMonitorRow\(/.test(src),
      `…and drives the row's own button rather than a second path to the same result`);
  }
  expect(/\(scanner\|arch\|optimizer\|estimate\|cost\)\\\/watch/.test(router),
    "the router parses one watch shape for all five, not a special case per tool");
  expect([scanJs2, archJs, optJs, estJs, costJs]
           .every((src) => /data-monitor": m\.monitorId/.test(src)),
    "every watch row tags its open button with the monitor it opens");
}

// ===========================================================================
group("a link that cannot be followed says which of three things went wrong");
// ===========================================================================
{
  // The scorecard grades from the last SWEEP; these pages re-read the repo
  // live. So a link can be valid and still land somewhere that cannot show
  // it, and "gone", "filtered" and "unopenable" have three different answers.
  for (const reason of ["gone", "filtered", "unopenable"]) {
    expect(dashJs.includes(`"${reason}"`), `DashCore names the "${reason}" case`);
  }
  expect(/function findDeepLink/.test(dashJs) && /function deepLinkNote/.test(dashJs),
    "one implementation of both, shared by the four pages");
  expect(/hit\.analyzers \|\| \[\]\)\.indexOf\(analyzer\) === -1/.test(dashJs),
    "a repo watched by a DIFFERENT analyzer reads as filtered, not as a missing monitor");
  // The note has to be re-emitted by render(), not inserted after it: a later
  // load resolves, re-renders, and takes any node render() did not put there.
  // That exact bug ate the X-ray's stale-component note.
  for (const [mod, src, field] of [["scanner", scanJs2, "state.deepLink"],
                                   ["X-ray", archJs, "watch.deepLink"],
                                   ["optimizer", optJs, "state.deepLink"],
                                   ["estimator", estJs, "watchDeepLink"],
                                   ["cost analyzer", costJs, "state.deepLink"]]) {
    expect(src.includes(field + " = ") && src.includes("if (" + field + ")"),
      `the ${mod} holds the note in state and re-emits it on render`);
  }
  expect(/clickMonitorRow[\s\S]{0,80}return false/.test(dashJs) ||
         /return false;\n  \}/.test(dashJs.slice(dashJs.indexOf("function clickMonitorRow"))),
    "a row with no open button returns false rather than a click that does nothing");
  expect(/\.deeplink-note\b/.test(css), "and the note is styled");
}

// ===========================================================================
group("the scorecard says what its non-numeric cells mean, and no more");
// ===========================================================================
{
  expect(/scorecard-key-item/.test(wsJs) && /\.scorecard-key-item\b/.test(css),
    "a key explains the three cells that carry no number");
  for (const term of ["first run pending", "not measured", "not watched"]) {
    expect(wsJs.includes(`"${term}"`), `…including "${term}"`);
  }
  // The mockup's fourth row — "↓ improved · ↑ worse · = unchanged, against
  // the previous nightly run" — is a key for something only ONE of the six
  // columns can say. Five of them store no previous value, so "= unchanged"
  // beside them would caption a comparison nothing performed.
  // Checked against the STRINGS the page can render, not the file: the
  // comment explaining why there is no trend key necessarily contains the
  // words it is ruling out, and a test that cannot tell those apart would
  // force the explanation to be deleted to stay green.
  const wsStrings = [...wsJs.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]).join(" | ");
  expect(!/unchanged/.test(wsStrings),
    "there is no trend key — five of the six columns have nothing to compare against");
  expect(!/improved|\bworse\b/.test(wsStrings),
    "…and no improved/worse legend for columns that store no prior value");

  // Six columns do not fit a laptop, so the grid scrolls sideways. A row of
  // numbers whose repo name has scrolled off the left is a row about nothing.
  expect(/\.scorecard-repo\s*\{[^}]*position:\s*sticky/.test(css),
    "the repository column stays put while the columns scroll");
  expect(/\.scorecard-repo\s*\{[^}]*background:/.test(css),
    "…and is opaque, or the cells scroll through it rather than under it");
}

// ===========================================================================
group("no shipped script is binary");
// ===========================================================================
{
  // A raw control byte makes a .js file `data` rather than text, and grep
  // and ripgrep then skip it as binary — a repo-wide search reports it as
  // having no matches at all. dash-arch.js carried one for months inside a
  // separator string that should have been written "\u0000".
  const { readdirSync } = await import("node:fs");
  const jsDir = join(SITE, "assets", "js");
  const offenders = readdirSync(jsDir)
    .filter((f) => f.endsWith(".js"))
    .filter((f) => {
      const buf = readFileSync(join(jsDir, f));
      for (const b of buf) if (b < 9 || (b > 13 && b < 32)) return true;
      return false;
    });
  expect(offenders.length === 0,
    `every dashboard script is greppable text${offenders.length ? " — binary: " + offenders.join(", ") : ""}`);
}

// ===========================================================================
group("monitor health is rendered as four distinct states");
// ===========================================================================
{
  expect(/function healthBadge/.test(monJs) &&
         /m\.lastStatus === "failed"/.test(monJs) &&
         /m\.lastStatus === "skipped"/.test(monJs),
    "failed and skipped render as their own states, not as 'baseline pending'");
  expect(/!m\.lastStatus && m\.lastRunAt === null/.test(monJs),
    "…and 'baseline pending' now requires a monitor that was genuinely never attempted");
  expect(/function healthReason/.test(monJs) && /m\.lastError/.test(monJs),
    "the stored error code is shown verbatim, so the screen and the logs say the same string");

  // Run-now on a paused monitor would advance the baseline the owner paused
  // to preserve. The API refuses it; the UI must not offer it either.
  expect(/if \(!m\.paused\) \{[\s\S]{0,400}?"Run now"/.test(monJs),
    "Run now is not rendered for a paused monitor");
  expect(/monitor_paused/.test(readFileSync(join(WORKER, "handlers", "monitors.js"), "utf8")),
    "and the endpoint refuses it server-side regardless of what the UI renders");
  expect(/Queued/.test(monJs),
    "the button reports 'queued', not 'done' — the endpoint answers 202, not a result");
}

// ===========================================================================
group("the watch list groups branches of one repository");
// ===========================================================================
{
  // Two branches of one service are two monitors — separate schedules,
  // separate baselines, separate emails — but ONE thing you are watching. A
  // flat list made them read as two unrelated services.
  expect(/function groupByRepo/.test(monJs) && /groupByRepo\(monitors\)\.forEach/.test(monJs),
    "the list is built from repository groups rather than a flat forEach");
  expect(/monitor-group-head/.test(monJs) && /\.monitor-group-head\b/.test(css),
    "each group carries a header naming the repository");
  // The grouping must not imply shared state, because there is none: each
  // branch keeps its own baseline and diffs independently.
  expect(/each keeps its own baseline/.test(monJs),
    "…and says the branches are watched separately, so nothing implies a shared baseline");
  expect(/g\.monitors\.length > 1/.test(monJs),
    "the branch note appears only when there is more than one branch to explain");
  // Every per-row control has to survive the refactor — the row moved into
  // its own function and a lost listener would be silent.
  expect(/function monitorItem\(m\)/.test(monJs), "one row builder, called per group member");
  for (const control of ["Run now", "Remove"]) {
    expect(monJs.includes(`"${control}"`), `…and the ${control} control still exists`);
  }
  expect(/m\.paused \? "Resume" : "Pause"/.test(monJs), "…and so does pause/resume");
}

// ===========================================================================
group("a grade timed on someone else's machine says so");
// ===========================================================================
{
  // The optimizer's CI gate grades a function by EXECUTING it, on the pull
  // request's own runner. ci.js has stored measuredBy: "ci_runner" since the
  // gate shipped, with a comment saying exactly why it matters — and nothing
  // read it back, so the feed rendered a runner-timed grade and a nightly one
  // as the same kind of fact.
  const ciJs = readFileSync(join(WORKER, "handlers", "ci.js"), "utf8");
  expect(/measuredBy: "ci_runner"/.test(ciJs), "the CI gate stores the provenance");
  expect(/json_extract\(result_json, '\$\.measuredBy'\)/.test(runsJs),
    "the runs list extracts that ONE scalar rather than selecting result_json");
  expect(!/SELECT[^`]*result_json,/.test(runsJs.slice(runsJs.indexOf("FROM runs") - 400)) ||
         !/result_json\s*\n\s*FROM runs/.test(runsJs),
    "…so the list still hauls no heavy fields");
  expect(/measuredBy: r\.measured_by \|\| null/.test(runsJs),
    "null when absent — every other analyzer is measured on our infrastructure, " +
    "which is an absence and not an unknown");
  expect(/it\.measuredBy === "ci_runner"/.test(dashJs) && /measured in your runner/.test(dashJs),
    "the feed renders it on the rows that carry it");
  expect(/\.run-item-measured\b/.test(css), "…and it is styled");
}

// ===========================================================================
group("the local schedule time is a conversion, not a setting");
// ===========================================================================
{
  // Only the UTC hour is stored (monitors.run_at_hour). The local half is
  // computed from the reader's own clock, so the same monitor reads
  // differently to two teammates — and without saying so it looks like a
  // preference the platform is honouring.
  expect(/converted in your browser/.test(monJs),
    "the row says the local time is converted in the browser");
  expect(/not saved|not a stored setting/.test(monJs),
    "…and that it is not stored");
  expect(/stored in UTC/.test(monJs),
    "…while naming what IS stored");
}

// ===========================================================================
group("the alert-routing card shows delivery, not configuration");
// ===========================================================================
{
  expect(/resolveMonitorRoute/.test(readFileSync(join(WORKER, "monitors", "run.js"), "utf8")),
    "the sweep resolves its recipients through monitors/routing.js");
  expect(/resolveMonitorRoute/.test(readFileSync(join(WORKER, "handlers", "monitors.js"), "utf8")),
    "and the card is served by that same resolver, so the two cannot drift");
  expect(!/getOrgBillingEmail/.test(readFileSync(join(WORKER, "monitors", "run.js"), "utf8")),
    "the hardcoded billing-email recipient is gone from the sweep");

  // The webhook is a bearer credential: anyone holding the URL can post into
  // the channel. It is reported as configured/not and never echoed back.
  expect(/url: slackEnabled \? webhook : null/.test(routing),
    "resolveMonitorRoute carries the webhook only when it will actually be used");
  expect(!/route\.slack\.url/.test(routing.split("export function describeRoute")[1] || ""),
    "describeRoute never puts the webhook URL in the browser payload");
  expect(!/slack\.url/.test(monJs),
    "…and the frontend never reads one");

  expect(/route-summary-bad/.test(monJs) && /route-summary-bad/.test(css),
    "a route that delivers nowhere is called out in words and in colour");
}

// ===========================================================================
group("the schedule hour is offered, sent, and read back");
// ===========================================================================
{
  expect(/id="monitor-hour"/.test(html), "the form has an hour control");
  expect(/runAtHour: formHour\(\)/.test(monJs), "…and the create POST sends it");
  expect(/invalid_hour/.test(monJs),
    "an out-of-range hour is surfaced on the field rather than swallowed");
  expect(/function hourLabel/.test(monJs) && /local/.test(monJs),
    "a stored hour renders in UTC with the viewer's local equivalent beside it");
  const store = readFileSync(join(WORKER, "monitors", "_store.js"), "utf8");
  expect(/hourNow !== wanted/.test(store) && /DEFAULT_SWEEP_HOUR/.test(store),
    "isDue() holds a monitor back until its hour, and defaults an unset one to 03:00");
  const wrangler = readFileSync(join(__dirname, "..", "wrangler.toml"), "utf8");
  expect(!/crons = \["0 3 \* \* \*"\]/.test(wrangler),
    "…and the trigger ticks often enough for that hour to ever arrive");
  // Changing WHEN a monitor runs must never clear a baseline — that would
  // turn a schedule edit into a silent "everything is new again" email.
  const setSched = store.split("export async function setMonitorSchedule")[1].split("export ")[0];
  expect(!/last_\w+ = NULL/.test(setSched),
    "setMonitorSchedule clears no baseline");
}

// ===========================================================================
group("the new classes are styled, and none are dead");
// ===========================================================================
{
  const PREFIX = /^(ws-pulse|ws-tool|scorecard-|route-|dash-avatar|dash-account|dash-tab-glyph|dash-head-split|dash-head-aside|dash-crumb|monitor-why|panel-empty-rich|ws-tools|deeplink-)/;
  const applied = uniq([
    ...matchAll(wsJs,  /class:\s*"([^"]+)"/g).flatMap((c) => c.split(/\s+/)),
    ...matchAll(monJs, /class:\s*"([^"]+)"/g).flatMap((c) => c.split(/\s+/)),
    ...matchAll(dashJs, /class:\s*"([^"]+)"/g).flatMap((c) => c.split(/\s+/)),
    ...matchAll(html,  /class="([^"]+)"/g).flatMap((c) => c.split(/\s+/)),
  ]).filter((c) => PREFIX.test(c));
  const styled = new Set(matchAll(css, /\.((?:ws-pulse|ws-tool|scorecard-|route-|dash-avatar|dash-account|dash-tab-glyph|dash-head-split|dash-head-aside|dash-crumb|monitor-why|panel-empty-rich|ws-tools|deeplink-)[a-zA-Z0-9-]*)/g));
  // Two families are composed at runtime — "scorecard-cell-" + cell.kind and
  // "route-row-" + (wired ? "on" : "off"). The extractor sees the stem, so
  // the stem is checked against the variants that actually exist rather than
  // being reported as an unstyled class that no rule could ever match.
  //
  // The cell-kind list is DERIVED from scorecard.js rather than written out
  // here. The literal that used to sit in this slot went stale the moment a
  // fifth kind was added, and it failed in the unhelpful direction: it named
  // the new rule as dead CSS instead of naming the kind nobody had styled.
  const CELL_KINDS = uniq(matchAll(scorecard, /kind:\s*"([a-z]+)"/g)
    .concat(matchAll(scorecard, /kind:\s*stale \? "([a-z]+)" : "([a-z]+)"/g)));
  const RUNTIME = {
    "scorecard-cell-": CELL_KINDS.concat(["grade", "stale"]).filter(
      (k, i, a) => a.indexOf(k) === i),
    "route-row-": ["on", "off"],
    "ws-pulse-": ["ok", "warn", "bad"],
  };
  const resolved = applied.flatMap((c) =>
    RUNTIME[c] ? RUNTIME[c].map((v) => c + v) : [c]);
  const unstyled = resolved.filter((c) => !styled.has(c));
  expect(unstyled.length === 0,
    `every new class has a CSS rule${unstyled.length ? " — unstyled: " + unstyled.join(", ") : ` (${applied.length} checked)`}`);
  const sources = wsJs + monJs + dashJs + html;
  // An orphan check has to know about the same composition, or every runtime
  // variant reads as a dead rule. Seeded from the RUNTIME map directly rather
  // than from `resolved`, because a class assembled as `"base-" + tone`
  // inside a longer expression never appears in the source as a bare stem.
  const composed = new Set(resolved);
  Object.keys(RUNTIME).forEach((stem) => {
    RUNTIME[stem].forEach((v) => composed.add(stem + v));
  });
  const orphans = [...styled].filter((c) => !sources.includes(c) && !composed.has(c));
  expect(orphans.length === 0,
    `no new rule is dead${orphans.length ? " — orphaned: " + orphans.join(", ") : ""}`);
}

// ===========================================================================
group("the header is one row, with the quota under the Account control");
// ===========================================================================
{
  expect(/class="dash-nav-left"/.test(html) && /class="dash-nav-right"/.test(html),
    "the bar is split into a left group and a right group");
  const left = html.split('class="dash-nav-left"')[1].split("</div>")[0] +
               html.split('class="dash-nav-left"')[1].slice(0, 2000);
  expect(/class="dash-tabs"/.test(left),
    "the tab strip is inside the left group, so it sits beside the brand");
  const right = html.split('class="dash-nav-right"')[1].split('<!-- ')[0] +
                html.split('class="dash-nav-right"')[1].slice(0, 3000);
  expect(/id="dash-quota"/.test(right) && /class="dash-nav-actions"/.test(right),
    "the quota and the actions row are both in the right group");
  expect(right.indexOf('class="dash-nav-actions"') < right.indexOf('id="dash-quota"'),
    "…and the quota comes after the actions, so it renders below them");
  expect(/\.dash-nav \.nav-inner \{[^}]*flex-wrap: nowrap/.test(css),
    "the bar never wraps to a second row");
  expect(!/id="dash-user-email"/.test(html) && !/dash-user-email/.test(dashJs),
    "the signed-in email is gone from the markup and the script");
}

// ===========================================================================
group("no class is applied without a rule, and no rule is applied to nothing");
// ===========================================================================
{
  // A class with no CSS renders as an unstyled inline span — which is how a
  // decorative glyph ended up on its own line above the scorecard title,
  // looking like a layout bug for as long as nobody looked closely.
  const applied = uniq(matchAll(html, /class="([^"]+)"/g)
    .flatMap((c) => c.split(/\s+/))
    .filter((c) => /^(panel|dash|ws|acct|scorecard|route|monitor|xr)-/.test(c)));
  const styled = new Set(matchAll(css, /\.([a-zA-Z][a-zA-Z0-9_-]*)/g));
  const unstyled = applied.filter((c) => !styled.has(c));
  expect(unstyled.length === 0,
    `every layout class in dashboard.html has a rule${unstyled.length ? " — unstyled: " + unstyled.join(", ") : ` (${applied.length} checked)`}`);
}

// ===========================================================================
group("no innerHTML anywhere in the new modules");
// ===========================================================================
{
  expect(!/innerHTML/.test(wsJs), "dash-workspace.js never touches innerHTML");
  expect(!/innerHTML/.test(monJs), "dash-monitors.js never touches innerHTML");
}

// ===========================================================================
group("every tool page has a monitored half, not just a manual bench");
// ===========================================================================
{
  // The gap this closes: an alert saying "3 new findings" used to lead to a
  // page whose only option was to re-upload your own codebase by hand.
  const PAGES = [
    ["Architecture X-ray",  "arch-watch-body", archJs, "arch"],
    ["Vulnerability scanner", "vuln-watch-body", scanJs, "vuln"],
    ["Algorithm optimizer", "opt-night-body",  optJs,  "algo"],
    ["Cost estimator",      "est-watch-body",  estJs,  "estimate"],
  ];
  for (const [label, containerId, src, analyzer] of PAGES) {
    expect(html.includes(`id="${containerId}"`),
      `${label} has a monitored section (#${containerId})`);
    expect(src.includes(`/result/${analyzer}`),
      `…and can open one through /api/monitors/:id/result/${analyzer}`);
  }

  // The whole point of routing through the same endpoint: a nightly result
  // and a hand-run result must be drawn by ONE renderer, or the two can
  // disagree about what a finding looks like.
  expect(/renderVuln:\s*function/.test(dashJs) && /renderAlgo:\s*function/.test(dashJs),
    "dashboard.js exposes its manual renderers so the monitored half reuses them");
  expect(/core\.renderVuln\(payload\.result\)/.test(scanJs),
    "the scanner's monitored result goes through the manual vuln renderer");
  expect(/render\(payload\.result\)/.test(estJs),
    "the estimator's monitored result goes through the manual estimate renderer");
  expect(/state\.result = payload\.result/.test(archJs),
    "the X-ray's monitored result drives the same explorer state the bench does");

  // Both new loaders have to be reachable from the router or the section
  // renders its loading placeholder forever.
  expect(/window\.DashArch\.load\(\)/.test(router),
    "entering #/arch loads its monitored section");
  // #/arch/<runId> opens ONE stored run — the route a CI architecture comment
  // links to. Asserted beside the bare route because they share a view name
  // and it would be easy to add the parameterised form while quietly breaking
  // the plain one, or the reverse.
  // The optional trailing argument is the component a link can name
  // (#/arch/<runId>/<componentId>); the run id stays first and required, so
  // this still fails if the parameterised route stops opening a run.
  expect(/route\.runId\)\s*window\.DashArch\.openRun\(route\.runId(?:,\s*route\.componentId)?\)/.test(router),
    "and #/arch/<runId> opens that run in the explorer");
  expect(/window\.DashScanner\)\s*\{?\s*(?:if \(route\.monitorId\)[\s\S]{0,90}?else\s+)?window\.DashScanner\.load\(\)/.test(router),
    "entering #/scanner loads its monitored section");
  expect(/dash-scanner\.js/.test(html), "dash-scanner.js is loaded by the page");
  expect(/window\.DashArch = \{ load/.test(archJs),
    "DashArch actually exports load() — it used to be an empty object");

  // An unreadable repo must not render as a clean one, on any page.
  for (const [label, , src] of PAGES) {
    expect(/payload\.status !== "ok"/.test(src),
      `${label} checks the payload status before rendering anything`);
  }

  // The X-ray's diff markers depend on translating the Worker's key rule into
  // this file's — they use different separators and fallbacks, so treating
  // one as the other would mark the wrong boxes as new.
  expect(/workerFindingKey/.test(archJs),
    "the X-ray translates the Worker's finding keys rather than assuming they match its own");
}

// ===========================================================================
group("a monitor row can show the baseline its deltas are measured from");
// ===========================================================================
{
  // Every "+2 new" badge on the Monitors page is a subtraction. The thing
  // being subtracted FROM is already stored and already served — this panel
  // is the first place the product renders it.
  expect(/function baselinePanel/.test(monJs),
    "dash-monitors renders a baseline panel");
  expect(/Baseline the sweep diffs against/.test(monJs),
    "…labelled as what the sweep diffs against, not as a result");
  expect(/var base = baselinePanel\(m\);/.test(monJs),
    "…and every monitor row gets one");

  // The panel must read the stored fields, not re-derive them. Each of these
  // is a column the sweep writes and GET /api/monitors already returns.
  for (const field of ["knownAdvisoryCount", "lastSource", "archFindingCount",
                       "lastEstimate", "lastAlgo", "lastCost"]) {
    expect(new RegExp(`m\\.${field}`).test(monJs),
      `the baseline panel reads the stored ${field}`);
  }

  // The rule this panel exists to keep. A baseline that was never recorded is
  // a sentence; rendering it as 0 would say the sweep looked and found
  // nothing, which is the opposite claim.
  expect(/not recorded yet/.test(monJs),
    "an unrecorded baseline says so rather than showing a zero");
  expect(/function noBaseline/.test(monJs),
    "…through an explicit helper, so the null path cannot be reached by accident");

  // Cloud spend is the one row that is recorded and compared against nothing.
  // monitors/run.js builds diffAdvisories, sourceDiff, archDiff, estDiff and
  // algoDiff — and no costDiff. If a costDiff ever lands, this assertion is
  // the reminder that the panel now owes the reader a different sentence.
  expect(!/costDiff/.test(readFileSync(join(WORKER, "monitors", "run.js"), "utf8")),
    "the sweep still computes no cost diff");
  expect(/diffed: false/.test(monJs),
    "…so the cloud-spend row is marked as recorded-but-not-compared");
  expect(/Recorded, not compared/.test(monJs),
    "…and says so in words, not only by omission");

  // Collapsed by default: six rows per monitor, open, on a page listing
  // twenty of them would bury the states that need daily attention.
  expect(/el\("details", \{ class: "monitor-baseline" \}\)/.test(monJs),
    "the panel is a <details>, so it starts collapsed");
  expect(/\.monitor-baseline-summary/.test(css),
    "the disclosure is styled rather than falling back to the UA marker");
  expect(/\.monitor-baseline-nodiff/.test(css),
    "the not-compared row is visually distinct from the five that are");
}

// ===========================================================================
group("the five CI gates read as five gates, not five wizards");
// ===========================================================================
{
  // Before: five always-expanded setup wizards, all of them, always — and
  // nothing on the page saying which gates were actually live.
  expect(html.includes('id="panel-ci-gates"'),
    "the Monitors page has a CI gates overview");
  expect((html.match(/details class="gate-setup"/g) || []).length === 5,
    "…and all five setup wizards are behind their own disclosure");
  expect(/One <code class="mono">ALGOSIZE_API_KEY<\/code> secret serves all five/.test(html),
    "…under the fact that makes five gates one setup: they share a secret");

  // The gate cards are read from stored runs. Whether the secret exists on
  // somebody's repository is their repository's business — the only evidence
  // we hold is a run that arrived.
  expect(/\/api\/runs\?source=ci/.test(monJs),
    "gate state is read from stored CI runs");
  expect(/function newestByAnalyzer/.test(monJs),
    "…the newest run per analyzer, from one request rather than five");

  // The honest half. handlers/ci.js persists exactly three analyzers with
  // source "ci"; the estimate and cost workflows post to the analyzer
  // endpoints with an API key, which stores a run with a NULL source.
  const ci = readFileSync(join(WORKER, "handlers", "ci.js"), "utf8");
  const ciAnalyzers = [...ci.matchAll(/analyzer: "(\w+)",\n\s*source: "ci"|source: "ci",\n\s*analyzer: "(\w+)"/g)];
  expect(/source: "ci"/.test(ci), "the CI ingest endpoint tags its runs as CI");
  expect((ci.match(/source: "ci"/g) || []).length === 3,
    "…for exactly three analyzers, which is why two gates cannot appear in the feed");
  expect(/not reported/.test(monJs),
    "a gate that files no CI-tagged run reads as not reported, never as not set up");
  expect(/can be\s*\n?\s*"?\s*wired up and passing and still show nothing here/.test(monJs) ||
         /wired up and passing and still show nothing here/.test(monJs),
    "…and the card says why, rather than implying the customer has not set it up");
}

// ===========================================================================
group("Recent CI runs is a feed of stored runs, with its provenance intact");
// ===========================================================================
{
  expect(html.includes('id="ci-runs-body"'),
    "the Monitors page has a recent-CI-runs feed");
  expect(/function renderCiRuns/.test(monJs), "…with a renderer behind it");
  // A read that FAILED and a feed that is genuinely empty are different
  // facts, and only one of them means "no CI yet". state.ciRuns is set to
  // null on the failure path and the renderer branches on it.
  expect(/state\.ciRuns = null/.test(monJs),
    "a failed CI read stores null rather than an empty list");
  expect(/items === null/.test(monJs),
    "…and the renderer shows an error for it, not the empty state");

  // The one number in this feed whose provenance changes what it is worth.
  // Stored by handlers/ci.js since the optimizer gate shipped.
  expect(/r\.measuredBy === "ci_runner"/.test(monJs),
    "optimizer rows say the grade was measured on the customer's runner");
  expect(/measured in your runner/.test(monJs),
    "…in those words, matching the runs feed on the Workspace");

  // A run's createdAt is milliseconds (handlers/runs.js stores Date.now()),
  // unlike a monitor's second-based timestamps. Multiplying it would date
  // every CI row somewhere in the year 57000.
  expect(!/createdAt \* 1000/.test(monJs),
    "run timestamps are not re-scaled — they are already milliseconds");
}

// ===========================================================================
group("the Big-O chart is drawn in the space the grade is fitted in");
// ===========================================================================
{
  // analyzers/bigo.js fits log(t) against log(n) and reads the slope. The
  // chart plotted log10(n) against a LINEAR millisecond axis, so the picture
  // could not be used to check the letter beside it — an O(n log n) and an
  // O(n²) curve are the same hockey stick on a linear axis.
  const bigo = readFileSync(join(WORKER, "analyzers", "bigo.js"), "utf8");
  expect(/export const NOISE_FLOOR_MS/.test(bigo),
    "the analyzer exports its noise floor rather than keeping it private");
  expect((bigo.match(/noiseFloorMs: NOISE_FLOOR_MS/g) || []).length === 5,
    "…and every inferBigO return carries it, so no result path leaves the chart guessing");

  expect(/renderBigOChart\(result\.bigO\.points, result\.bigO\.noiseFloorMs\)/.test(dashJs),
    "the chart is handed the floor the fit actually used");
  expect(!/renderBigOChart\(result\.bigO\.points\)\s*\)/.test(dashJs),
    "…and never falls back to a hardcoded copy of it");
  expect(/Timing curve · log\\u2013log/.test(dashJs),
    "the chart says both axes are logarithmic");
  expect(/Math\.log10\(Math\.max\(p\.ms, lift\)\)/.test(dashJs),
    "…because the y-axis genuinely is, not only in the title");

  // A probe under the floor was replaced by the floor BEFORE the slope was
  // taken. Drawing it where the clock landed would show the grade a
  // measurement it never used.
  expect(/noise floor/.test(dashJs),
    "the floor is drawn on the chart, not left as a footnote");
  expect(/clamped \?/.test(dashJs),
    "a clamped probe is marked as clamped rather than plotted as a reading");
}

console.log("");
if (failures) {
  console.log(`\x1b[31m  ${failures} workspace-frontend test(s) failed\x1b[0m`);
  process.exit(1);
}
console.log("\x1b[32m  all workspace-frontend tests passed\x1b[0m");
