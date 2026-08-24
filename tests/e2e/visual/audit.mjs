// Responsive audit — drives the real dashboard in a real browser at real
// phone widths and fails on the things a human notices immediately.
//
// Why a browser and not a CSS grep: horizontal overflow is emergent. It comes
// from a long unbreakable string inside a nowrap flex child inside a grid
// whose minmax is wider than the viewport — no single declaration is wrong,
// and no amount of reading the stylesheet finds it. Layout has to be computed
// to be checked.
//
// What it asserts, at each width, for every view:
//
//   1. THE PAGE DOES NOT SCROLL SIDEWAYS. The single most-reported mobile
//      bug, and the one users describe as "it's broken on my phone".
//   2. NO ELEMENT SPILLS PAST THE VIEWPORT. Catches the cause when (1) is
//      masked by an ancestor's overflow:hidden — the content is still
//      unreachable, it just no longer announces itself.
//   3. INTERACTIVE THINGS ARE BIG ENOUGH TO HIT. 40px is the floor; below
//      that a thumb hits the neighbour.
//   4. THE HEADER IS ONE ROW. Its whole design premise, and the thing that
//      silently regresses the moment someone adds a control.
//
// Deliberately NOT asserted: pixel positions, screenshots, font sizes. Those
// fail on every legitimate design change and teach people to ignore the
// suite.
//
// Run with:  node tests/responsive/audit.mjs

import { chromium } from "playwright";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SITE = join(__dirname, "..", "..", "..", "site");

// A synthetic origin. Nothing listens on it — every request is fulfilled
// from memory by the route handler — but the document having an origin at
// all is what lets relative /api/ paths resolve.
const ORIGIN = "http://algosize.test";

let failures = 0;
const ok   = (msg) => console.log(`  \x1b[32m✓\x1b[0m ${msg}`);
const fail = (msg) => { console.log(`  \x1b[31m✗\x1b[0m ${msg}`); failures++; };
const expect = (cond, label) => (cond ? ok(label) : fail(label));
const group  = (name) => console.log(`\n\x1b[1m${name}\x1b[0m\n`);

// Widths worth checking, and why each one is here.
// `touch` is not cosmetic: it decides whether `pointer: coarse` matches, and
// the touch-target floor in main.css is scoped to that rather than to a
// width — because the question is "is a finger doing the pointing", and a
// 1024px tablet answers yes while a 400px desktop window answers no. An
// audit that skipped it would test rules that never run on the devices they
// were written for.
const WIDTHS = [
  { w: 360,  h: 780,  touch: true,  name: "360px — a small Android in portrait" },
  { w: 390,  h: 844,  touch: true,  name: "390px — iPhone 14/15 portrait" },
  { w: 768,  h: 1024, touch: true,  name: "768px — tablet portrait, the awkward middle" },
  { w: 1280, h: 900,  touch: false, name: "1280px — laptop, mouse" },
];

// Every routed view. A view that is never opened is never checked, and the
// bug lives in the one nobody opened.
const VIEWS = [
  ["#/",          "Workspace"],
  ["#/monitors",  "Monitors & CI"],
  ["#/scanner",   "Vulnerability scanner"],
  ["#/cost",      "Cloud cost analyzer"],
  ["#/arch",      "Architecture X-ray"],
  ["#/optimizer", "Algorithm optimizer"],
  ["#/estimate",  "Cost estimator"],
  ["#/account",   "Account"],
];

/**
 * Turn the Jekyll template into a standalone page.
 *
 * Front matter and Liquid are stripped rather than rendered: the audit is
 * about layout, and no `{{ }}` in this template affects it beyond asset URLs,
 * which are rewritten to the real files on disk.
 */
function buildPage() {
  let html = readFileSync(join(SITE, "dashboard.html"), "utf8");
  html = html.replace(/^---[\s\S]*?\n---\n/, "");
  html = html.replace(/\{\{\s*'([^']+)'\s*\|\s*relative_url\s*\}\}/g, "$1");
  html = html.replace(/\{%[\s\S]*?%\}/g, "");
  html = html.replace(/\{\{[\s\S]*?\}\}/g, "");
  const css = readFileSync(join(SITE, "assets", "css", "main.css"), "utf8");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>${css}</style></head><body>${html}</body></html>`;
}

/**
 * Payloads, generated from the real handlers.
 *
 * Not hand-written, and that is the point. These fixtures were hand-written
 * once; five Account sections were quietly rendering "this section could not
 * be displayed" because a field had been named `profile` and the fixture said
 * `user`, and every spacing assertion passed against the error panels. The
 * generator (worker/scripts/gen-ui-fixtures.mjs) calls each handler through
 * its real entry point against the real migrations, so a renamed field either
 * breaks the generator or changes this file — and either way somebody sees it.
 *
 * Regenerate with:  node worker/scripts/gen-ui-fixtures.mjs
 */
const API = JSON.parse(
  readFileSync(join(__dirname, "..", "..", "fixtures", "ui-payloads.json"), "utf8"));

function matchApi(url) {
  const path = new URL(url, "http://localhost").pathname;
  if (API[path]) return API[path];
  for (const key of Object.keys(API)) {
    if (path.startsWith(key)) return API[key];
  }
  return {};
}

const run = async () => {
  // The container ships one Chromium build, which may not be the revision
  // this Playwright version would otherwise download. Point at the installed
  // binary rather than fetching a second copy — see the environment notes.
  const browser = await chromium.launch(
    process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});

  const html = buildPage();

  for (const { w, h, touch, name } of WIDTHS) {
    group(name);
    // A fresh context per width — hasTouch can only be set at context
    // creation, and it is what makes `pointer: coarse` match.
    const context = await browser.newContext({
      viewport: { width: w, height: h },
      hasTouch: touch,
      isMobile: touch,
    });
    await context.route("**/api/**", (route) =>
      route.fulfill({ status: 200, contentType: "application/json",
                      body: JSON.stringify(matchApi(route.request().url())) }));
    // Nothing should navigate away during an audit; a stray redirect would
    // end the run with a false pass on an empty page.
    // The page is served from a real origin so that relative /api/ URLs
    // parse. Anything else on the wire is stubbed empty — an audit must not
    // depend on the network.
    await context.route("**/*", (route) => {
      const u = route.request().url();
      if (u.includes("/api/")) return route.fallback();
      if (u.startsWith(ORIGIN + "/dashboard")) {
        return route.fulfill({ status: 200, contentType: "text/html", body: html });
      }
      if (u.startsWith("http")) return route.fulfill({ status: 200, body: "" });
      return route.fallback();
    });
    const page = await context.newPage();

    for (const [hash, label] of VIEWS) {
      await page.goto(ORIGIN + "/dashboard/", { waitUntil: "domcontentloaded" });
      await page.addScriptTag({ path: join(SITE, "assets", "js", "dashboard.js") });
      for (const f of ["dash-team", "dash-monitors", "dash-report", "dash-arch",
                       "dash-estimate", "dash-optimizer", "dash-workspace",
                       "dash-scanner", "dash-account", "dash-router"]) {
        await page.addScriptTag({ path: join(SITE, "assets", "js", f + ".js") }).catch(() => {});
      }
      await page.evaluate((hh) => { window.location.hash = hh; }, hash);
      await page.waitForTimeout(250);

      const report = await page.evaluate((vw) => {
        const out = { scrollWidth: document.documentElement.scrollWidth, spills: [], small: [],
                    errors: [...document.querySelectorAll(".panel-error, .acct-error")]
                      .filter((e) => getComputedStyle(e).display !== "none")
                      .map((e) => e.textContent.trim().slice(0, 90)) };
        const seen = new Set();
        document.querySelectorAll("body *").forEach((el) => {
          const cs = getComputedStyle(el);
          if (cs.display === "none" || cs.visibility === "hidden") return;
          const r = el.getBoundingClientRect();
          if (r.width === 0 && r.height === 0) return;

          // A spill is content past the right edge that no ancestor scrolls.
          if (r.right > vw + 1) {
            let scrollable = false;
            for (let p = el.parentElement; p; p = p.parentElement) {
              const pcs = getComputedStyle(p);
              if (/(auto|scroll)/.test(pcs.overflowX)) { scrollable = true; break; }
            }
            if (!scrollable) {
              const key = el.tagName + "." + (el.className || "").toString().slice(0, 40);
              if (!seen.has(key)) {
                seen.add(key);
                out.spills.push({ key, right: Math.round(r.right) });
              }
            }
          }

          // Tap targets.
          //
          // A link that FLOWS WITH TEXT is exempt: it is read in a sentence,
          // not aimed at, and giving it a 40px box would break the line
          // rhythm of the paragraph around it. The test for that is
          // structural rather than a list of container classes — the list
          // only ever grows, and it grows by someone hitting this failure and
          // adding whatever class they happened to use. A link with text
          // siblings is in a sentence; a link alone in its parent is a
          // control wearing a link's clothes.
          const tag = el.tagName.toLowerCase();
          const inSentence = tag === "a" && [...el.parentElement.childNodes].some(
            (n) => n.nodeType === 3 && n.textContent.trim().length > 0);
          const isControl = tag === "button" ||
            (tag === "a" && !inSentence) ||
            tag === "select" || (tag === "input" && el.type !== "hidden");
          if (isControl && r.height > 0 && r.height < 40) {
            const key = tag + "#" + (el.id || "") + "." + (el.className || "").toString().slice(0, 30);
            if (!seen.has("t" + key)) {
              seen.add("t" + key);
              out.small.push({ key, h: Math.round(r.height) });
            }
          }
        });
        return out;
      }, w);

      expect(report.errors.length === 0,
        `${label} — every panel rendered${report.errors.length ? ": " + report.errors.slice(0, 2).join(" | ") : ""}`);
      expect(report.scrollWidth <= w + 1,
        `${label} — no sideways scroll (scrollWidth ${report.scrollWidth} vs ${w})`);
      expect(report.spills.length === 0,
        `${label} — nothing spills past the right edge${report.spills.length ? ": " + report.spills.slice(0, 4).map((s) => `${s.key}@${s.right}px`).join(", ") : ""}`);
      if (touch) {
        expect(report.small.length === 0,
          `${label} — every control is at least 40px tall${report.small.length ? ": " + report.small.slice(0, 4).map((s) => `${s.key}=${s.h}px`).join(", ") : ""}`);
      }
    }

    // The header's design premise: one row, always.
    await page.goto(ORIGIN + "/dashboard/", { waitUntil: "domcontentloaded" });
    await page.addScriptTag({ path: join(SITE, "assets", "js", "dashboard.js") });
    await page.waitForTimeout(200);
    const header = await page.evaluate(() => {
      const left  = document.querySelector(".dash-nav-left");
      const right = document.querySelector(".dash-nav-right");
      const actions = document.querySelector(".dash-nav-actions");
      const quota = document.getElementById("dash-quota");
      if (!left || !right || !actions) return null;
      const L = left.getBoundingClientRect(), A = actions.getBoundingClientRect();
      const Q = quota && getComputedStyle(quota).display !== "none"
        ? quota.getBoundingClientRect() : null;
      return {
        sameRow: Math.abs(L.top - A.top) < L.height,
        leftIsLeft: L.left < A.left,
        quotaBelowActions: Q ? Q.top >= A.bottom - 2 : null,
        quotaRightAligned: Q ? Math.abs(Q.right - A.right) < 2 : null,
      };
    });
    expect(header && header.sameRow, "header — brand/tabs and the controls share one row");
    expect(header && header.leftIsLeft, "header — the tab strip is on the left");
    if (header && header.quotaBelowActions !== null) {
      expect(header.quotaBelowActions, "header — the quota sits below the controls");
      expect(header.quotaRightAligned, "header — …right-aligned under the Account button");
    }

    await context.close();
  }

  await browser.close();

  console.log("");
  if (failures) {
    console.log(`\x1b[31m  ${failures} responsive check(s) failed\x1b[0m`);
    process.exit(1);
  }
  console.log("\x1b[32m  all responsive checks passed\x1b[0m");
};

run().catch((err) => { console.error(err); process.exit(1); });
