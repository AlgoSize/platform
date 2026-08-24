// Account spacing audit — measures the rendered Account area and reports
// where the rhythm breaks.
//
// "Spacing looks off" is a real complaint that no unit test catches, because
// every individual rule is defensible; what goes wrong is the RELATIONSHIP
// between them. A section whose blocks sit 16px apart next to one whose
// blocks sit 24px apart reads as sloppy even when neither number is wrong.
// So this checks agreement, not absolute values:
//
//   1. ONE LEFT EDGE per section. Every direct child of the content pane
//      starts at the same x. An element indented by an inherited padding or
//      a stray margin is the single most visible spacing defect.
//   2. NO COLLISIONS AND NO TOUCHING. Stacked siblings keep at least 8px of
//      air; anything less reads as a rendering bug.
//   3. CONSISTENT VERTICAL RHYTHM. The gaps between a section's blocks come
//      from a small set, not from six different accidental values.
//   4. SYMMETRIC HORIZONTAL PADDING. A card padded 16px left and 12px right
//      is off-centre by an amount the eye catches before the mind does.
//   5. NOTHING OVERFLOWS ITS SECTION.
//
// Run with:  node tests/responsive/account-spacing.mjs

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
const ok   = (m) => console.log(`  \x1b[32m✓\x1b[0m ${m}`);
const fail = (m) => { console.log(`  \x1b[31m✗\x1b[0m ${m}`); failures++; };
const expect = (c, l) => (c ? ok(l) : fail(l));
const group  = (n) => console.log(`\n\x1b[1m${n}\x1b[0m\n`);

const SECTIONS = ["profile", "security", "billing", "invoices", "branding",
                  "referrals", "team", "keys", "notifications", "danger"];

const WIDTHS = [
  { w: 390,  h: 900,  touch: true,  name: "390px — phone" },
  { w: 1280, h: 1000, touch: false, name: "1280px — laptop" },
];

function buildPage() {
  let html = readFileSync(join(SITE, "dashboard.html"), "utf8")
    .replace(/^---[\s\S]*?\n---\n/, "")
    .replace(/\{\{\s*'([^']+)'\s*\|\s*relative_url\s*\}\}/g, "$1")
    .replace(/\{%[\s\S]*?%\}/g, "")
    .replace(/\{\{[\s\S]*?\}\}/g, "");
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
  const p = new URL(url, "http://localhost").pathname;
  if (API[p]) return API[p];
  for (const k of Object.keys(API)) if (p.startsWith(k)) return API[k];
  return {};
}

const run = async () => {
  const browser = await chromium.launch(
    process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
  const html = buildPage();

  for (const { w, h, touch, name } of WIDTHS) {
    group(name);
    const context = await browser.newContext({
      viewport: { width: w, height: h }, hasTouch: touch, isMobile: touch });
    await context.route("**/api/**", (r) =>
      r.fulfill({ status: 200, contentType: "application/json",
                  body: JSON.stringify(matchApi(r.request().url())) }));
    await context.route("**/*", (r) => {
      const u = r.request().url();
      if (u.includes("/api/")) return r.fallback();
      if (u.startsWith(ORIGIN + "/dashboard")) {
        return r.fulfill({ status: 200, contentType: "text/html", body: html });
      }
      if (u.startsWith("http")) return r.fulfill({ status: 200, body: "" });
      return r.fallback();
    });
    const page = await context.newPage();

    for (const section of SECTIONS) {
      await page.goto(ORIGIN + "/dashboard/", { waitUntil: "domcontentloaded" });
      await page.addScriptTag({ path: join(SITE, "assets", "js", "dashboard.js") });
      for (const f of ["dash-team", "dash-monitors", "dash-report", "dash-arch",
                       "dash-estimate", "dash-optimizer", "dash-workspace",
                       "dash-scanner", "dash-account", "dash-router"]) {
        await page.addScriptTag({ path: join(SITE, "assets", "js", f + ".js") }).catch(() => {});
      }
      await page.evaluate((sec) => { window.location.hash = "#/account/" + sec; }, section);
      await page.waitForTimeout(320);

      const r = await page.evaluate(() => {
        const pane = document.querySelector(".acct-main") ||
                     document.querySelector("#view-account .panel");
        if (!pane) return { missing: true };

        const kids = [...pane.children].filter((el) => {
          const cs = getComputedStyle(el);
          if (cs.display === "none" || el.hasAttribute("hidden")) return false;
          const b = el.getBoundingClientRect();
          return b.width > 0 && b.height > 0;
        });

        const boxes = kids.map((el) => {
          const b = el.getBoundingClientRect();
          return { tag: el.tagName.toLowerCase(),
                   cls: (el.className || "").toString().split(/\s+/)[0] || "",
                   left: Math.round(b.left), right: Math.round(b.right),
                   top: Math.round(b.top), bottom: Math.round(b.bottom) };
        });

        const gaps = [];
        for (let i = 1; i < boxes.length; i++) gaps.push(boxes[i].top - boxes[i - 1].bottom);

        // Asymmetric horizontal padding on anything that looks like a card.
        const asym = [];
        pane.querySelectorAll("*").forEach((el) => {
          const cs = getComputedStyle(el);
          if (cs.display === "none") return;
          const l = parseFloat(cs.paddingLeft), rr = parseFloat(cs.paddingRight);
          if (l > 0 && rr > 0 && Math.abs(l - rr) > 1) {
            const b = el.getBoundingClientRect();
            if (b.height > 24 && b.width > 80) {
              asym.push({ cls: (el.className || "").toString().split(/\s+/)[0] || el.tagName,
                          l, r: rr });
            }
          }
        });

        const paneBox = pane.getBoundingClientRect();
        const overflow = [];
        pane.querySelectorAll("*").forEach((el) => {
          const cs = getComputedStyle(el);
          if (cs.display === "none") return;
          let scrollable = false;
          for (let p = el.parentElement; p && p !== pane.parentElement; p = p.parentElement) {
            if (/(auto|scroll)/.test(getComputedStyle(p).overflowX)) { scrollable = true; break; }
          }
          if (scrollable) return;
          const b = el.getBoundingClientRect();
          if (b.width > 0 && b.right > paneBox.right + 1) {
            overflow.push({ cls: (el.className || "").toString().split(/\s+/)[0] || el.tagName,
                            over: Math.round(b.right - paneBox.right) });
          }
        });

        // A section that failed to render is a section whose spacing was
        // never measured. Without this the suite happily "passes" on a
        // stack of error panels, which is exactly what it did before.
        const errors = [...document.querySelectorAll(".panel-error, .acct-error")]
          .filter((e) => getComputedStyle(e).display !== "none")
          .map((e) => e.textContent.trim().slice(0, 90));

        return { boxes, gaps, asym: asym.slice(0, 6), overflow: overflow.slice(0, 6),
                 count: kids.length, errors };
      });

      if (r.missing) { fail(`${section} — the content pane did not render`); continue; }
      expect(r.errors.length === 0,
        `${section} — rendered without an error panel${r.errors.length ? ": " + r.errors[0] : ""}`);
      if (r.count < 2) { ok(`${section} — single block, nothing to compare`); continue; }

      const lefts = [...new Set(r.boxes.map((b) => b.left))];
      expect(lefts.length === 1,
        `${section} — every block shares one left edge${lefts.length > 1 ? " (found " + lefts.join(", ") + "px)" : ""}`);

      const tight = r.gaps.filter((g) => g < 8);
      expect(tight.length === 0,
        `${section} — no two blocks are closer than 8px${tight.length ? " (found " + tight.join(", ") + "px)" : ""}`);

      const distinct = [...new Set(r.gaps.map((g) => Math.round(g)))];
      expect(distinct.length <= 2,
        `${section} — vertical rhythm comes from at most 2 gap values${distinct.length > 2 ? " (found " + distinct.join(", ") + "px)" : ""}`);

      expect(r.asym.length === 0,
        `${section} — horizontal padding is symmetric${r.asym.length ? ": " + r.asym.map((a) => `${a.cls} ${a.l}/${a.r}`).join(", ") : ""}`);

      expect(r.overflow.length === 0,
        `${section} — nothing overflows the pane${r.overflow.length ? ": " + r.overflow.map((o) => `${o.cls} +${o.over}px`).join(", ") : ""}`);
    }

    await context.close();
  }

  await browser.close();
  console.log("");
  if (failures) {
    console.log(`\x1b[31m  ${failures} account-spacing check(s) failed\x1b[0m`);
    process.exit(1);
  }
  console.log("\x1b[32m  all account-spacing checks passed\x1b[0m");
};

run().catch((e) => { console.error(e); process.exit(1); });
