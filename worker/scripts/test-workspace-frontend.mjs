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
const routing   = readFileSync(join(WORKER, "monitors", "routing.js"), "utf8");
const meJs      = readFileSync(join(WORKER, "handlers", "me.js"), "utf8");

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
  const PREFIX = /^(ws-pulse|ws-tool|scorecard-|route-|dash-avatar|dash-account|dash-tab-glyph|dash-head-split|dash-head-aside|dash-crumb|monitor-why|panel-empty-rich|ws-tools)/;
  const applied = uniq([
    ...matchAll(wsJs,  /class:\s*"([^"]+)"/g).flatMap((c) => c.split(/\s+/)),
    ...matchAll(monJs, /class:\s*"([^"]+)"/g).flatMap((c) => c.split(/\s+/)),
    ...matchAll(dashJs, /class:\s*"([^"]+)"/g).flatMap((c) => c.split(/\s+/)),
    ...matchAll(html,  /class="([^"]+)"/g).flatMap((c) => c.split(/\s+/)),
  ]).filter((c) => PREFIX.test(c));
  const styled = new Set(matchAll(css, /\.((?:ws-pulse|ws-tool|scorecard-|route-|dash-avatar|dash-account|dash-tab-glyph|dash-head-split|dash-head-aside|dash-crumb|monitor-why|panel-empty-rich|ws-tools)[a-zA-Z0-9-]*)/g));
  // Two families are composed at runtime — "scorecard-cell-" + cell.kind and
  // "route-row-" + (wired ? "on" : "off"). The extractor sees the stem, so
  // the stem is checked against the variants that actually exist rather than
  // being reported as an unstyled class that no rule could ever match.
  const RUNTIME = {
    "scorecard-cell-": ["grade", "stale", "pending", "off"],
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
    .filter((c) => /^(panel|dash|ws|acct|scorecard|route|monitor)-/.test(c)));
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
  expect(/window\.DashArch\)\s+window\.DashArch\.load\(\)/.test(router),
    "entering #/arch loads its monitored section");
  expect(/window\.DashScanner\)\s+window\.DashScanner\.load\(\)/.test(router),
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

console.log("");
if (failures) {
  console.log(`\x1b[31m  ${failures} workspace-frontend test(s) failed\x1b[0m`);
  process.exit(1);
}
console.log("\x1b[32m  all workspace-frontend tests passed\x1b[0m");
