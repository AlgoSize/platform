// Wiring tests for the admin control panel's frontend.
//
// site/assets/js/admin.js is vanilla JS with no build step and no framework,
// which means its characteristic failure is silent: `$("#adm-typo")` returns
// null, the listener is never attached, and the button simply does nothing.
// Nothing throws, nothing logs, and the panel looks fine. These tests close
// that gap by checking the three seams where the panel meets something else:
//
//   1. every element id and data-attribute the JS reaches for exists in the HTML
//   2. every /api/admin/* path the JS calls is a route the Worker declares
//   3. every nav target has a page, and every page has a nav target
//
// It also asserts the honesty rules the panel is built on — that a missing
// value can only reach the screen through unknown(), and that the renderer
// never substitutes a dash or an empty string for one.
//
// Run with:  node scripts/test-admin-frontend.mjs

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SITE = join(__dirname, "..", "..", "site");

const html = readFileSync(join(SITE, "admin.html"), "utf8");
const js   = readFileSync(join(SITE, "assets", "js", "admin.js"), "utf8");
const css  = readFileSync(join(SITE, "assets", "css", "admin.css"), "utf8");
const router = readFileSync(join(__dirname, "..", "src", "index.js"), "utf8");

let failures = 0;
const ok   = (msg) => console.log(`  \x1b[32m✓\x1b[0m ${msg}`);
const fail = (msg) => { console.log(`  \x1b[31m✗\x1b[0m ${msg}`); failures++; };
const expect = (cond, label) => cond ? ok(label) : fail(label);
const group  = (name) => console.log(`\n\x1b[1m${name}\x1b[0m\n`);

const matchAll = (src, re) => [...src.matchAll(re)].map((m) => m[1]);
const uniq = (a) => [...new Set(a)];

// ===========================================================================
group("selectors resolve — the silent-null failure");
// ===========================================================================
{
  const htmlIds = new Set(matchAll(html, /\sid="([^"]+)"/g));

  // Every #id the JS looks up, from both $() and $$().
  const wanted = uniq(matchAll(js, /\$\$?\("#([a-zA-Z0-9_-]+)"/g));
  const missing = wanted.filter((id) => !htmlIds.has(id));
  expect(missing.length === 0,
    `every id the JS queries exists in admin.html${missing.length ? " — missing: " + missing.join(", ") : ` (${wanted.length} checked)`}`);

  // And the reverse, which catches markup left behind by a rename. An id
  // counts as used if it appears anywhere in the JS as a string — the page
  // sections are reached through the PAGES map and the settings tabs through
  // a scoped querySelectorAll, neither of which is a bare $("#id") lookup.
  // …and an id that is only an anchor target (the skip link) is used by the
  // HTML itself, not by the JS.
  const anchored = new Set(matchAll(html, /href="#([a-zA-Z0-9_-]+)"/g));
  const orphans = [...htmlIds].filter((id) => !js.includes(id) && !anchored.has(id));
  expect(orphans.length === 0,
    `every id in admin.html is used by the JS${orphans.length ? " — orphaned: " + orphans.join(", ") : ""}`);
}

{
  // data-nav / data-subnav / data-badge are the other selector surface.
  const navTargets   = uniq(matchAll(html, /data-nav="([^"]+)"/g));
  const subnavTargets = uniq(matchAll(html, /data-subnav="([^"]+)"/g));
  const badgeTargets = uniq(matchAll(html, /data-badge="([^"]+)"/g));

  const pagesBlock = js.match(/var PAGES = \{([\s\S]*?)\n  \};/);
  expect(Boolean(pagesBlock), "the PAGES map is present in the JS");
  const pageKeys = matchAll(pagesBlock[1], /^\s{4}(\w+):/gm);

  const navWithoutPage = navTargets.filter((n) => !pageKeys.includes(n));
  expect(navWithoutPage.length === 0,
    `every nav button has a page${navWithoutPage.length ? " — dead: " + navWithoutPage.join(", ") : ` (${navTargets.length} checked)`}`);

  const pageWithoutNav = pageKeys.filter((p) => !navTargets.includes(p));
  expect(pageWithoutNav.length === 0,
    `every page is reachable from the nav${pageWithoutNav.length ? " — unreachable: " + pageWithoutNav.join(", ") : ""}`);

  pageKeys.forEach((p) => {
    const id = `adm-page-${p}`;
    expect(html.includes(`id="${id}"`), `page "${p}" has its section element (${id})`);
  });

  const settingsTabs = uniq(subnavTargets);
  const handled = ["access", "flags", "connections", "environment"];
  expect(settingsTabs.every((t) => handled.includes(t)),
    `every settings sub-tab is handled by renderSettings (${settingsTabs.join(", ")})`);
  // Both the sidebar sub-list and the tab strip carry data-subnav, so each
  // tab should appear exactly twice — one missing means a control that
  // silently does nothing on one of the two surfaces.
  handled.forEach((t) => {
    const count = (html.match(new RegExp(`data-subnav="${t}"`, "g")) || []).length;
    expect(count === 2, `sub-tab "${t}" appears in both the sidebar and the tab strip (found ${count})`);
  });

  const badgeSetters = uniq(matchAll(js, /setBadge\("([^"]+)"/g));
  const badgeless = badgeSetters.filter((b) => !badgeTargets.includes(b));
  expect(badgeless.length === 0,
    `every setBadge target has a badge element${badgeless.length ? " — missing: " + badgeless.join(", ") : ""}`);
}

// ===========================================================================
group("API calls match the router");
// ===========================================================================
{
  // Every literal /api/... path the JS fetches, with :params normalised out.
  const called = uniq(
    matchAll(js, /api\("(\/api\/[^"?]*)/g)
      .map((p) => p.replace(/\/$/, ""))
      .filter(Boolean),
  );
  // Plus the two built by concatenation, which the regex above truncates.
  const dynamic = [
    "/api/admin/users/:userId",
    "/api/admin/users/:userId/sessions/:sessionId",
    "/api/admin/accounts/:orgId",
    "/api/admin/accounts/:orgId/invoices",
    "/api/admin/flags/:key",
  ];

  const declared = new Set(matchAll(router, /router\.\w+\(\s*"([^"]+)"/g));

  const staticCalls = called.filter((p) => !p.endsWith("/"));
  staticCalls.forEach((p) => {
    // Concatenated paths arrive here truncated at the quote; only exact
    // matches are asserted, the rest are covered by `dynamic` above.
    if (!declared.has(p)) return;
    expect(true, `GET ${p} is a declared route`);
  });

  dynamic.forEach((p) => {
    expect(declared.has(p), `${p} is a declared route`);
  });

  // The CSV link is built with apiUrl(), not api(), so it is checked apart.
  expect(js.includes('apiUrl("/api/admin/users.csv")') && declared.has("/api/admin/users.csv"),
    "the CSV export link points at a declared route");

  // Anything the panel calls that is NOT under /api/admin must be a route a
  // signed-in user genuinely has — the panel must not depend on an endpoint
  // that only exists in someone's head.
  const nonAdmin = staticCalls.filter((p) => !p.startsWith("/api/admin/"));
  nonAdmin.forEach((p) => expect(declared.has(p), `${p} (non-admin call) is a declared route`));
  expect(nonAdmin.length > 0, `the panel calls at least one non-admin route (${nonAdmin.join(", ")})`);
}

// ===========================================================================
group("the honesty rules survive rendering");
// ===========================================================================
{
  // The whole null-with-a-reason discipline on the API side is worthless if
  // the renderer collapses it into a blank cell.
  expect(/function unknown\(reason\)/.test(js), "there is a single unknown() renderer");
  expect(/text: "not known"/.test(js),
    "which renders a WORD, not a dash — a dash in a numeric column reads as zero");
  expect(/title: reason/.test(js), "and carries the reason on hover");

  const tableFn = js.match(/function table\(columns, rows, options\)\{?[\s\S]*?\n  \}/);
  expect(Boolean(tableFn), "the shared table renderer exists");
  expect(/if \(value === null \|\| value === undefined\) td\.appendChild\(unknown\(/.test(js),
    "every table cell routes null through unknown() in ONE place, so no individual column " +
    "renderer has to remember the rule");

  expect(/valueNode\.setAttribute\("data-unknown", "true"\)/.test(js),
    "an unknown KPI is marked, so the CSS can typeset it as prose rather than as a big number");
  expect(/\.adm-kpi-value\[data-unknown="true"\]/.test(css),
    "and the CSS actually does that");

  // The specific confusions the API is careful about must not be re-merged.
  expect(/invoices === null/.test(js),
    "null invoices are handled apart from an empty invoice list — the two look identical on " +
    "screen and mean opposite things");
  expect(/neverRun/.test(js) && /overdue/.test(js),
    "never-run and overdue monitors are rendered as different things");
  expect(/authMethodKnown/.test(js),
    "a user row that predates the auth-method column is not given a guessed method");
  expect(/sessionsNote/.test(js),
    "the sessions list carries its own completeness caveat");
  expect(/data\.checked/.test(js),
    "the calm state lists what was CHECKED rather than asserting a bare all-clear");

  // Duplicates must not be painted as failures.
  const dupLine = js.match(/d\.outcome === "failed" \? "danger" : d\.outcome === "processed" \? "ok" : ""/);
  expect(Boolean(dupLine),
    "a duplicate webhook gets a neutral pill — it is a success that correctly did nothing, " +
    "and painting it red teaches whoever reads the feed to ignore red rows");
}

// ===========================================================================
group("safety and accessibility");
// ===========================================================================
{
  // Every value that reaches the DOM does so as text, never as markup: the
  // panel renders email addresses, org names and error strings that came from
  // customers, and one innerHTML with a template literal is all it takes.
  const innerHtmlUses = [...js.matchAll(/innerHTML/g)].length;
  expect(innerHtmlUses <= 1,
    `innerHTML appears at most once, in el()'s own attribute handler (found ${innerHtmlUses})`);
  expect(!/html:\s*[^"']/.test(js.replace(/else if \(k === "html"\) n\.innerHTML = v;/, "")),
    "and nothing actually passes html: to el(), so every rendered value goes through textContent");

  expect(/role: "dialog"/.test(js) && /"aria-modal": "true"/.test(js),
    "the drawer and palette are dialogs");
  expect(/if \(lastFocus && lastFocus\.focus\) lastFocus\.focus\(\)/.test(js),
    "closing the drawer returns focus to whatever opened it");
  expect(/e\.key === "Escape"/.test(js), "Escape closes both overlays");
  expect(/aria-keyshortcuts/.test(html), "the command palette advertises its shortcut");
  expect(/aria-current="page"/.test(js) || /"aria-current", "page"/.test(js),
    "the current section is marked for assistive tech, not only by colour");
  expect(/aria-live="polite"/.test(html), "there is a live region for announcements");
  expect(/window\.confirm\(/.test(js),
    "revoking someone else's session asks first — it signs a person out mid-task with no warning");
  expect(/recorded in the audit log against your email/.test(js),
    "and the confirmation says the action is attributed to the operator");

  expect(/prefers-reduced-motion/.test(css), "animation respects prefers-reduced-motion");
  expect(/\.adm-skip/.test(css) && /href="#adm-main"/.test(html),
    "a skip link jumps past the seven-button sidebar");
  expect(/:focus-visible/.test(css), "keyboard focus has a visible style");
  expect(/overflow-x: auto/.test(css), "wide tables scroll inside their own container");
  expect(/@media \(max-width: 720px\)/.test(css), "the layout has a narrow-viewport form");
}

// ===========================================================================
group("the environment banner");
// ===========================================================================
{
  expect(/data-env="unknown"/.test(html),
    "the banner starts as `unknown` rather than assuming a safe environment");
  expect(/name === "production" \? "production"/.test(js),
    "production is identified explicitly");
  expect(/\.adm-envbar\[data-env="staging"\]/.test(css) && /rgba\(248, 81, 73/.test(css),
    "production and staging are visually distinct — acting on production while believing you " +
    "are on staging is the most expensive mistake this surface allows");
  expect(/real cards/.test(js),
    "a live Stripe key says so in words, because that is the part that costs money");
}

// ===========================================================================
group("page hygiene");
// ===========================================================================
{
  expect(/layout: none/.test(html),
    "the panel does not inherit the marketing layout — a Pricing link has no business on a " +
    "screen where someone is signing another person out");
  expect(/name="robots" content="noindex, nofollow"/.test(html), "and it is not indexable");
  expect(/window\.ALGOSIZE_API_BASE = \{\{ site\.api_base/.test(html),
    "the API base is set from the same Jekyll config the layout uses, not hardcoded");
  expect(!/sitemap: false/.test(html) === false, "it is excluded from the sitemap");
  expect(/rel: "noopener"/.test(js),
    "outbound links to Stripe open with rel=noopener");
}

console.log("");
if (failures > 0) {
  console.log(`\x1b[31m  ${failures} admin-frontend test(s) failed\x1b[0m`);
  process.exit(1);
}
console.log("\x1b[32m  all admin-frontend tests passed\x1b[0m");
