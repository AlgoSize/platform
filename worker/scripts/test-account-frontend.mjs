// Wiring tests for the account-management frontend.
//
// site/assets/js/dash-account.js is vanilla JS with no build step and no
// framework, so its characteristic failure is silent: getElementById returns
// null, the branch quietly does nothing, and the section renders empty.
// Nothing throws and nothing logs. These tests close the seams where the
// module meets something else:
//
//   1. every element id the JS reaches for exists in dashboard.html
//   2. every /api/… path the JS calls is a route the Worker actually declares
//   3. every CSS class the JS applies has a rule in main.css
//   4. the router knows about the view, and the view exists
//   5. the honesty rules this screen is built on hold in the source
//
// Run with:  node scripts/test-account-frontend.mjs

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SITE = join(__dirname, "..", "..", "site");

const html   = readFileSync(join(SITE, "dashboard.html"), "utf8");
const js     = readFileSync(join(SITE, "assets", "js", "dash-account.js"), "utf8");
const router = readFileSync(join(SITE, "assets", "js", "dash-router.js"), "utf8");
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
group("selectors resolve — the silent-null failure");
// ===========================================================================
{
  const htmlIds = new Set(matchAll(html, /\sid="([^"]+)"/g));

  // Ids the module looks up but never creates itself. Anything it builds and
  // then re-reads (the preview wrapper, the confirm input) is created by the
  // same code that reads it, so it cannot be missing from the HTML.
  const created = new Set(matchAll(js, /el\("[a-z]+",\s*\{[^}]*\bid:\s*"([^"]+)"/g)
    .concat(matchAll(js, /\bid:\s*"(acct-[a-z-]+)"/g))
    .concat(matchAll(js, /\.id\s*=\s*"([^"]+)"/g))
    .concat(matchAll(js, /msgSlot\("([^"]+)"\)/g)));

  const wanted = uniq(matchAll(js, /getElementById\("([^"]+)"\)/g))
    .filter((id) => !created.has(id));

  const missing = wanted.filter((id) => !htmlIds.has(id));
  expect(missing.length === 0,
    `every id the JS queries exists in dashboard.html${
      missing.length ? " — missing: " + missing.join(", ") : ` (${wanted.length} checked)`}`);

  // The four structural hooks the whole screen hangs off. Named explicitly so
  // a rename in the HTML fails here rather than rendering a blank area.
  ["view-account", "acct-summary", "acct-nav", "acct-body",
   "acct-sec-title", "acct-sec-desc", "account-link"].forEach((id) => {
    expect(htmlIds.has(id), `dashboard.html declares #${id}`);
  });
}

// ===========================================================================
group("every endpoint the page calls is a route the Worker declares");
// ===========================================================================
{
  // Routes as declared, e.g. router.get("/api/account/sessions/:sessionId", …)
  const declared = matchAll(worker, /router\.(?:get|post|put|patch|delete|all)\(\s*"([^"]+)"/g);

  // A declared route with :params becomes a regex so a call with a real id
  // matches the pattern it was declared under.
  const patterns = declared.map((p) => ({
    raw: p,
    re: new RegExp("^" + p.replace(/:[A-Za-z0-9_]+/g, "[^/]+").replace(/\*/g, ".*") + "$"),
  }));

  const called = uniq([
    // callApi("/api/x", …) and callApi("/api/x/" + encodeURIComponent(id))
    ...matchAll(js, /callApi\("([^"]+?)"/g),
    ...matchAll(js, /core\.apiUrl\("([^"]+?)"\)/g),
  ]).map((p) => p.replace(/\/$/, ""));

  const unmatched = called.filter((path) => {
    // Strip a trailing concatenation point: "/api/keys/" + id → "/api/keys/x"
    const probe = path.endsWith("/") ? path + "x" : path;
    return !patterns.some((p) => p.re.test(probe));
  });

  expect(unmatched.length === 0,
    `every path dash-account.js calls is routed${
      unmatched.length ? " — unrouted: " + unmatched.join(", ") : ` (${called.length} checked)`}`);

  // The endpoints this screen cannot work without, asserted by name so that
  // deleting one from the router fails here instead of at runtime.
  ["/api/account", "/api/account/profile", "/api/account/email",
   "/api/account/sessions", "/api/account/logins", "/api/account/notifications",
   "/api/account/export", "/api/account/delete-preview", "/api/account/org",
   "/api/billing/summary", "/api/billing/invoices", "/api/billing/email",
   "/api/referrals", "/api/org/domain"].forEach((path) => {
    expect(declared.includes(path), `the Worker declares ${path}`);
  });
}

// ===========================================================================
group("the router reaches the view, and the view exists");
// ===========================================================================
{
  expect(/VIEWS = \[[^\]]*"account"/.test(router),
    "\"account\" is in the router's VIEWS list — without it the view is never unhidden");
  expect(/window\.DashAccount\)\s*window\.DashAccount\.open\(/.test(router),
    "the router calls DashAccount.open() for the account route");
  expect(/window\.DashAccount = \{/.test(js),
    "dash-account.js registers window.DashAccount");
  expect(/open:\s*open/.test(js), "…exposing open()");

  expect(/#\/account\//.test(router) || /indexOf\("#\/account\/"\)/.test(router),
    "sub-routes (#/account/<section>) are parsed, so each section is a real link");

  // The section ids the module declares must be the ones the router can route
  // to — a section that only exists in the nav is a dead link.
  const sectionIds = matchAll(js, /\{ id: "([a-z]+)", label:/g);
  expect(sectionIds.length === 10,
    `all ten sections are declared (found ${sectionIds.length}: ${sectionIds.join(", ")})`);
  ["profile", "security", "billing", "invoices", "branding",
   "referrals", "team", "keys", "notifications", "danger"].forEach((id) => {
    expect(sectionIds.includes(id), `section "${id}" is declared`);
  });

  // The script has to load after dashboard.js (which defines DashCore) and
  // before dash-router.js (which calls into it on the initial route).
  const iCore   = html.indexOf("assets/js/dashboard.js");
  const iAcct   = html.indexOf("assets/js/dash-account.js");
  const iRouter = html.indexOf("assets/js/dash-router.js");
  expect(iCore !== -1 && iAcct !== -1 && iRouter !== -1 && iCore < iAcct && iAcct < iRouter,
    "dash-account.js is loaded after dashboard.js and before dash-router.js");
}

// ===========================================================================
group("every class the JS applies is styled");
// ===========================================================================
{
  // Classes from el("tag", { class: "…" }) plus classList calls.
  const applied = uniq([
    ...matchAll(js, /class:\s*"([^"]+)"/g),
    ...matchAll(js, /classList\.(?:add|toggle)\("([^"]+)"/g),
    ...matchAll(js, /class:\s*"[^"]*"\s*\+\s*\([^)]*\?\s*" ([a-z-]+)"/g),
  ].join(" ").split(/\s+/).filter(Boolean))
    // Only our own namespace: .btn/.chip/.panel etc. are the shared system and
    // are covered by the styles that already ship them.
    .filter((c) => c.startsWith("acct-"));

  const styled = new Set(matchAll(css, /\.(acct-[a-zA-Z0-9-]+)/g));

  // Some class names are assembled at runtime — `"acct-domain-" + status`.
  // The prefix on its own is never a real class, and the variants it produces
  // never appear as literals in the source. Both halves of this check have to
  // know about that, or it reports the prefix as unstyled and every variant
  // as dead.
  // The prefix is the last token inside the string literal, which may itself
  // carry earlier static classes: `"acct-domain-state acct-domain-" + status`.
  const dynamicPrefixes = uniq(matchAll(js, /"[^"]*?(acct-[a-z0-9-]*-)"\s*\+/g));
  const isPrefix  = (c) => dynamicPrefixes.includes(c);
  const fromPrefix = (c) => dynamicPrefixes.some((p) => c.startsWith(p) && c !== p);

  const unstyled = applied.filter((c) => !styled.has(c) && !isPrefix(c));
  expect(unstyled.length === 0,
    `every acct-* class the JS applies has a CSS rule${
      unstyled.length ? " — unstyled: " + unstyled.join(", ") : ` (${applied.length} checked)`}`);

  // A runtime-assembled prefix has to resolve to something. A prefix with no
  // matching rules at all is the failure this would otherwise hide.
  dynamicPrefixes.forEach((p) => {
    const variants = [...styled].filter((c) => c.startsWith(p) && c !== p);
    expect(variants.length > 0,
      `the runtime-built "${p}*" classes have rules (${variants.join(", ") || "none"})`);
  });

  // And the reverse, which catches rules left behind by a rename.
  const orphans = [...styled]
    .filter((c) => !js.includes(c) && !html.includes(c) && !fromPrefix(c));
  expect(orphans.length === 0,
    `no acct-* rule is dead${orphans.length ? " — orphaned: " + orphans.join(", ") : ""}`);

  // .panel-input carries a 220px min-height for the analyzer textareas. A
  // single-line settings field that inherited it would render as a giant box,
  // which is exactly what happens if this override is dropped.
  expect(/\.acct-input\s*\{[^}]*min-height:\s*44px/.test(css),
    ".acct-input overrides .panel-input's textarea min-height");
}

// ===========================================================================
group("the honesty rules this screen is built on");
// ===========================================================================
{
  // Rule 1: nothing is built with innerHTML. Every node goes through el(),
  // which sets text via textContent — that is the entire XSS story on a page
  // rendering company names, member emails and DNS values.
  const innerHtmlUses = js.split("\n")
    .filter((line) => line.includes("innerHTML") && !line.trim().startsWith("//"));
  expect(innerHtmlUses.length === 0,
    `innerHTML is never used${innerHtmlUses.length ? " — found: " + innerHtmlUses.join(" / ") : ""}`);

  // Rule 2: a value we could not load is never drawn as a zero. The credit
  // balance is the case that matters — "$0.00" and "we could not read your
  // ledger" mean opposite things to the person reading them.
  expect(/credit\.known \? credit\.balance : "—"/.test(js),
    "an unreadable credit balance renders as an em dash, not as $0.00");
  expect(/could not be read/.test(js),
    "…and says so, rather than leaving the dash unexplained");

  // Rule 3: null invoices and empty invoices are different. Rendering the
  // first as the second tells a customer with six invoices they have none.
  expect(/inv\.invoices === null/.test(js),
    "a null invoice list is handled separately from an empty one");

  // Rule 4: the locked billing toggles refuse rather than pretending. The UI
  // must not paint an enabled switch the API would reject.
  expect(/chState\.locked/.test(js) && /b\.disabled = true/.test(js),
    "locked notification channels render as disabled switches, not live ones");

  // Rule 5: the credit qualifier is inline copy, not a tooltip. This is the
  // sentence someone forwards to their finance team.
  expect(/acct-credit-policy/.test(js) && /terms\.cashPolicy/.test(js),
    "the not-cash statement is rendered inline from the API's own wording");

  // Rule 6: destructive actions confirm, and the org deletion needs the name
  // typed back.
  expect(/confirmDisabled: true/.test(js) && /preview\.confirmPhrase/.test(js),
    "deleting an organisation starts with a disabled button and requires the typed name");
  expect(/input\.value\.trim\(\) === preview\.confirmPhrase/.test(js),
    "…matched exactly, case included");

  // Rule 7: an action the viewer cannot take is not rendered disabled — it is
  // not rendered, with a sentence where the reason is worth stating.
  expect(/Cannot revoke the session you are using/.test(js),
    "the current session explains why it has no revoke button rather than showing a dead one");

  // Rule 8: a partial save is reported as one. The org rename can be refused
  // while the personal fields succeed.
  expect(/res\.refused/.test(js),
    "a partially-refused profile save surfaces the refusal instead of reporting success");

  // Rule 9: verified DNS is not a served hostname, and the UI says which half
  // is done.
  expect(/servingReady/.test(js) && /servingNote/.test(js),
    "a verified domain still reports whether it is actually serving yet");
}

// ===========================================================================
group("accessibility hooks");
// ===========================================================================
{
  expect(/role: "switch"/.test(js), "notification toggles are switches");
  expect(/"aria-checked"/.test(js), "…with aria-checked reflecting state");
  expect(/role="radiogroup"|role: "radiogroup"/.test(js), "the accent picker is a radiogroup");
  expect(/role: "alertdialog"/.test(js), "destructive confirmations are alertdialogs");
  expect(/aria-label": "Account sections"|aria-label="Account sections"/.test(html + js),
    "the section sidebar is a labelled nav");
  expect(/setAttribute\("aria-current", "page"\)/.test(js) || /aria-current/.test(js),
    "the current section is marked aria-current");
  expect(/aria-current/.test(router),
    "…and the router marks the Account entry point itself");
  // Every avatar built from an image needs alt text; the initials version is
  // decorative and must be hidden instead.
  expect(/class: "acct-avatar", src: p\.avatarUrl, alt: ""/.test(js),
    "an avatar image carries alt (empty — the name is already beside it)");
  expect(/"aria-hidden": "true" \}, p\.initials/.test(js),
    "…and the initials fallback is aria-hidden rather than read out as a word");
}

// ===========================================================================
console.log("");
if (failures) {
  console.log(`\x1b[31m  ${failures} account-frontend test(s) failed\x1b[0m`);
  process.exit(1);
}
console.log("\x1b[32m  all account-frontend tests passed\x1b[0m");
