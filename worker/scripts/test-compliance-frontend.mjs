// The Compliance & Release Audit page, executed rather than read.
//
// The rules this page exists to enforce are RENDERING rules, and a source-text
// assertion cannot see any of them:
//
//   1. a not-covered control must show NO result badge — not a grey one, not an
//      empty one. A badge implies there is an answer;
//   2. it must never carry a failure colour, because "we hold no artifact" is a
//      fact about Algosize, not a finding about the customer;
//   3. the coverage tally must exclude not-covered controls from the RESULT
//      counts while still counting them in the evidence-state counts;
//   4. an expired attestation must render as expired, visibly, and raise the
//      banner — the quiet-lapse failure is the whole reason expiry is a state;
//   5. a downgrade qualifier must be shown as a chip, so the reason a row is
//      not green is on the screen rather than inferred.
//
// This loads the real site/assets/js/dash-compliance.js against a strict DOM
// shim — el() transcribed from dashboard.js, appendChild type-checked — and
// reads the resulting tree.
//
// Run with:  node scripts/test-compliance-frontend.mjs

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PAGE_JS = join(__dirname, "..", "..", "site", "assets", "js", "dash-compliance.js");
const ROUTER_JS = join(__dirname, "..", "..", "site", "assets", "js", "dash-router.js");
const WORKSPACE_JS = join(__dirname, "..", "..", "site", "assets", "js", "dash-workspace.js");
const DASHBOARD_HTML = join(__dirname, "..", "..", "site", "dashboard.html");

let failures = 0;
const ok = (m) => console.log(`  \x1b[32m✓\x1b[0m ${m}`);
const fail = (m) => { console.log(`  \x1b[31m✗\x1b[0m ${m}`); failures++; };
const expect = (cond, label) => (cond ? ok(label) : fail(label));
const group = (name) => console.log(`\n\x1b[1m${name}\x1b[0m\n`);

// ---------------------------------------------------------------------------
// DOM shim. Same transcription discipline as test-models-frontend.mjs: el() is
// copied from dashboard.js rather than written to match an assumption, and
// appendChild refuses anything that is not a Node, so a page that hands an
// array of children to the text argument fails here instead of rendering
// "[object HTMLSpanElement]" in production.
// ---------------------------------------------------------------------------

function makeDom() {
  const registry = new Map();
  class Node {
    constructor(tag) {
      this.tagName = String(tag || "").toUpperCase();
      this.childNodes = []; this.attributes = {}; this.style = {};
      this._text = ""; this.className = ""; this.hidden = false;
      this.value = ""; this.checked = false; this.disabled = false;
      this._listeners = {};
    }
    get firstChild() { return this.childNodes[0] || null; }
    appendChild(n) {
      if (!(n instanceof Node)) {
        throw new TypeError("appendChild expects a Node, got " + typeof n);
      }
      n.parentNode = this; this.childNodes.push(n); return n;
    }
    removeChild(n) { const i = this.childNodes.indexOf(n); if (i >= 0) this.childNodes.splice(i, 1); return n; }
    setAttribute(k, v) {
      this.attributes[k] = String(v);
      if (k === "id") { this.id = String(v); registry.set(String(v), this); }
    }
    getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attributes, k) ? this.attributes[k] : null; }
    removeAttribute(k) { delete this.attributes[k]; }
    addEventListener(t, fn) { (this._listeners[t] = this._listeners[t] || []).push(fn); }
    removeEventListener() {}
    focus() {}
    fire(t) { (this._listeners[t] || []).forEach((fn) => fn({ preventDefault() {}, target: this })); }
    set textContent(v) { this._text = String(v); this.childNodes = []; }
    get textContent() { return this._text || this.childNodes.map((c) => c.textContent).join(""); }
    get classList() {
      const self = this;
      return {
        add(c) { if (self.className.indexOf(c) < 0) self.className = (self.className + " " + c).trim(); },
        remove(c) { self.className = self.className.split(/\s+/).filter((x) => x && x !== c).join(" "); },
        contains(c) { return self.className.split(/\s+/).indexOf(c) >= 0; },
      };
    }
    walk(out = []) { out.push(this); this.childNodes.forEach((c) => c.walk(out)); return out; }
    find(p) { return this.walk().find(p) || null; }
    findAll(p) { return this.walk().filter(p); }
    querySelector() { return null; }
    querySelectorAll() { return []; }
  }

  const document = {
    createElement: (tag) => new Node(tag),
    createTextNode: (t) => { const n = new Node("#text"); n.textContent = t; return n; },
    getElementById: (id) => registry.get(id) || null,
    ensure: (id) => {
      if (!registry.has(id)) { const n = new Node("div"); n.id = id; registry.set(id, n); }
      return registry.get(id);
    },
    querySelector: () => null, querySelectorAll: () => [],
  };
  return { Node, document, registry };
}

/** DashCore.el EXACTLY as site/assets/js/dashboard.js defines it. */
function makeCore(document, routes, calls) {
  const el = (tag, attrs, text) => {
    const n = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach((k) => {
        const v = attrs[k];
        if (v === null || v === undefined || v === false) return;
        if (k === "class") n.className = v;
        else n.setAttribute(k, v === true ? "" : v);
      });
    }
    if (text !== null && text !== undefined) n.textContent = text;
    return n;
  };
  return {
    el, setBusy() {},
    apiUrl: (p) => "https://api.test" + p,
    errorState: (msg) => el("div", { class: "panel-error" }, msg),
    callApi(path) {
      calls.push(path);
      const key = Object.keys(routes).find((k) => path.indexOf(k) === 0);
      if (!key) return Promise.reject(new Error("not stubbed: " + path));
      const v = routes[key];
      return typeof v === "function" ? Promise.resolve(v(path)) : Promise.resolve(v);
    },
  };
}

function boot(routes) {
  const { document, registry } = makeDom();
  document.ensure("compliance-body");
  const calls = [];
  const win = { document, console, setTimeout, clearTimeout, Promise, alert() {}, DashCore: null };
  win.window = win; win.globalThis = win;
  win.DashCore = makeCore(document, routes, calls);
  const ctx = vm.createContext(win);
  vm.runInContext(readFileSync(PAGE_JS, "utf8"), ctx, { filename: "dash-compliance.js" });
  ctx.window.DashCompliance.load();
  return { registry, calls, ctx };
}

const flush = () => new Promise((r) => setTimeout(r, 10));

// ---------------------------------------------------------------------------
// Fixtures shaped exactly like GET /api/compliance/coverage answers.
// ---------------------------------------------------------------------------

const FRAMEWORKS = {
  frameworks: [
    { id: "ssdf-1.1", short: "SSDF", name: "NIST SSDF", version: "SP 800-218 v1.1",
      note: "n", totalControls: 42, coverage: { automated: 12, attested: 7, not_covered: 23 } },
    { id: "cra-annex1-ii", short: "CRA II", name: "EU CRA", version: "Annex I, II",
      note: "n", totalControls: 8, coverage: { automated: 3, attested: 1, not_covered: 4 } },
  ],
  catalogVersion: "2026-09-02.1",
  disclaimer: "This is evidence about a codebase, not a certification of conformity.",
};

function coverage(overrides = {}) {
  return {
    framework: {
      id: "ssdf-1.1", name: "NIST SSDF", version: "SP 800-218 v1.1", short: "SSDF",
      note: "Public, free to reference.",
      groups: [{ code: "PS", name: "Protect the Software" }, { code: "RV", name: "Respond to Vulnerabilities" }],
    },
    catalogVersion: "2026-09-02.1",
    period: { start: 1, end: 2, startOn: "2026-06-01", endOn: "2026-08-31" },
    monitor: { monitorId: "mon_1", repoUrl: "https://github.com/acme/api", branch: "main", paused: false },
    monitors: [{ monitorId: "mon_1", repoUrl: "https://github.com/acme/api", branch: "main" }],
    scans: { total: 12, vuln: 9, arch: 3 },
    summary: {
      total: 4,
      byState: { automated: 2, attested: 1, not_covered: 1 },
      byResult: { met: 1, not_met: 0, insufficient_evidence: 1, not_applicable: 0, attestation_expired: 1 },
    },
    controls: [
      { id: "PS.3.2", group: "PS", title: "Collect provenance data", coverage: "automated",
        evidenceState: "automated", result: "met", rationale: "A CycloneDX 1.5 bill of materials.",
        asserted: "412 components · 2 manifests", provenance: "nightly sweep run_1 · 2026-08-30",
        capturedAt: 1756512000, sourceRunId: "run_1", sourceAnalyzer: "vuln",
        qualifiers: [], attestation: null, why: null },
      { id: "PS.3.9", group: "PS", title: "Archive each release", coverage: "automated",
        evidenceState: "automated", result: "insufficient_evidence",
        rationale: "The scan found 900 packages but resolved 412.",
        asserted: "412 of 900", provenance: "CI run_2 · 2026-08-20",
        capturedAt: 1755648000, sourceRunId: "run_2", sourceAnalyzer: "vuln",
        qualifiers: ["sbom_incomplete"], attestation: null, why: null },
      { id: "RV.1.3", group: "RV", title: "Have a disclosure policy", coverage: "attested",
        evidenceState: "attested", result: "attestation_expired",
        rationale: "This attestation expired on 2026-07-01 and has not been renewed.",
        asserted: null, provenance: null, capturedAt: null,
        qualifiers: ["expired"],
        attestation: { id: "catt_1", kind: "attested", statement: "We publish a policy.",
                       ownerEmail: "sec@acme.io", documentUrl: "https://acme.io/policy",
                       expiresAt: 1751328000, expiresOn: "2026-07-01" },
        why: null },
      { id: "PW.8.2", group: "RV", title: "Perform executable code testing", coverage: "not_covered",
        evidenceState: "not_covered", result: "insufficient_evidence",
        rationale: "Dynamic testing is not something this platform does.",
        asserted: null, provenance: null, capturedAt: null,
        qualifiers: ["no_artifact_possible"], attestation: null,
        why: "Dynamic testing is not something this platform does. It reads code; it does not run it." },
    ],
    audits: [],
    disclaimer: "This page is evidence about a codebase, not a certification of conformity. " +
                "Algosize is neither an audit firm nor a notified body.",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
group("The two axes stay separate");
// ---------------------------------------------------------------------------

{
  const { registry } = boot({
    "/api/compliance/frameworks": FRAMEWORKS,
    "/api/compliance/coverage": coverage(),
  });
  await flush();
  const body = registry.get("compliance-body");
  const text = body.textContent;

  const notCoveredRow = body.find((n) => n.className === "cmp-row cmp-row-none");
  expect(!!notCoveredRow, "a not-covered control gets its own row treatment");

  // Rule 1: no result badge at all on a not-covered row.
  const badge = notCoveredRow && notCoveredRow.find((n) => (n.className || "").indexOf("cmp-res ") === 0);
  expect(!badge, "a not-covered control renders NO result badge — a badge would imply an answer");
  expect(!!notCoveredRow.find((n) => (n.className || "").split(" ").includes("cmp-noresult")),
    "it renders the explicit “no result” sentence instead");
  expect(notCoveredRow.textContent.includes("this tool has no artifact for this control"),
    "which names whose limitation it is");

  // Rule 2: never a failure colour.
  const failInk = notCoveredRow.findAll((n) => (n.className || "").includes("cmp-res-notmet"));
  expect(failInk.length === 0,
    "and never carries the not-met colour — that would be a finding about the customer");
  expect(notCoveredRow.textContent.includes("It reads code; it does not run it."),
    "the catalog's own sentence is quoted rather than paraphrased");

  // Rule 3: the tally splits correctly.
  expect(text.includes("Results exist only where evidence exists"),
    "the coverage panel says results exist only where evidence exists");
  expect(text.includes("1 not-covered controls have no result at all") ||
         text.includes("The 1 not-covered"),
    "and names how many controls have no result at all");

  const evChips = body.findAll((n) => (n.className || "").includes("cmp-count") &&
                                      (n.className || "").includes("cmp-ev-"));
  expect(evChips.length === 3, "three evidence-state counts are drawn");
  const resChips = body.findAll((n) => (n.className || "").includes("cmp-count-res"));
  expect(resChips.length >= 5, "and five result counts, separately");

  // Rule 4: an expired attestation is loud.
  expect(text.includes("attestation expired"), "an expired attestation renders as expired");
  const bannerNode = body.find((n) => (n.className || "").includes("cmp-banner"));
  expect(!!bannerNode && bannerNode.textContent.includes("RV.1.3"),
    "and raises a banner naming the control, so a lapse cannot pass quietly");
  expect(bannerNode.textContent.includes("carries no weight until it is renewed"),
    "the banner says what an expired claim is worth");

  // Rule 5: a downgrade shows its reason.
  const flags = body.findAll((n) => (n.className || "").split(" ").includes("cmp-flag"));
  expect(flags.some((f) => f.textContent === "sbom incomplete"),
    "a downgraded control shows the qualifier chip that downgraded it");

  expect(text.includes("neither an audit firm nor a notified body"),
    "the disclaimer is rendered from the server's own words");
}

// ---------------------------------------------------------------------------
group("States that must not read as clean");
// ---------------------------------------------------------------------------

{
  // No repository under watch.
  const { registry } = boot({
    "/api/compliance/frameworks": FRAMEWORKS,
    "/api/compliance/coverage": coverage({ monitor: null, monitors: [], controls: [], scans: { total: 0 } }),
  });
  await flush();
  const text = registry.get("compliance-body").textContent;
  expect(text.includes("No repository is under watch"),
    "with no subject the page says so rather than rendering an empty framework");
  expect(text.includes("Nothing below is blank because it passed") ||
         text.includes("nothing below is blank because it passed"),
    "and says why it is blank");
}

{
  // A paused watch.
  const cov = coverage();
  cov.monitor.paused = true;
  const { registry } = boot({
    "/api/compliance/frameworks": FRAMEWORKS,
    "/api/compliance/coverage": cov,
  });
  await flush();
  const text = registry.get("compliance-body").textContent;
  expect(text.includes("watch on this repository is paused"),
    "a paused watch is called out above the map");
  expect(text.includes("stopped being refreshed"),
    "and says what that means for everything below it");
}

{
  // No scan inside the period.
  const { registry } = boot({
    "/api/compliance/frameworks": FRAMEWORKS,
    "/api/compliance/coverage": coverage({ scans: { total: 0, vuln: 0, arch: 0 } }),
  });
  await flush();
  const text = registry.get("compliance-body").textContent;
  expect(text.includes("No scan landed inside this period"),
    "an empty period is announced");
  expect(text.includes("not because anything failed"),
    "and distinguished from a failure");
}

{
  // A published record.
  const { registry } = boot({
    "/api/compliance/frameworks": FRAMEWORKS,
    "/api/compliance/coverage": coverage({
      audits: [{ id: "caud_1", status: "published", publishedAt: 1788134400,
                 retainUntil: 1819670400, packSha256: "a".repeat(64), packBytes: 41000,
                 catalogVersion: "2026-09-02.1", summary: { total: 42 } }],
    }),
  });
  await flush();
  const body = registry.get("compliance-body");
  const text = body.textContent;
  expect(text.includes("a".repeat(64)), "the published record shows its SHA-256 for verification");
  expect(text.includes("kept until 2027-"), "and when it stops being kept");
  expect(text.includes("bulk bundle"),
    "the missing bulk bundle is stated in words rather than offered as a dead button");
  const dead = body.findAll((n) => n.tagName === "BUTTON" && /download/i.test(n.textContent));
  expect(dead.length === 0, "there is no download button that cannot download anything");
}

{
  // Server error.
  const { registry } = boot({ "/api/compliance/frameworks": FRAMEWORKS });
  await flush();
  const body = registry.get("compliance-body");
  expect(!!body.find((n) => n.className === "panel-error"),
    "a failed load renders the shared error panel, not a blank framework");
}

// ---------------------------------------------------------------------------
group("Wiring");
// ---------------------------------------------------------------------------

{
  const router = readFileSync(ROUTER_JS, "utf8");
  expect(/VIEWS\s*=\s*\[[^\]]*"compliance"/s.test(router), "the router knows the compliance view");
  expect(router.includes('if (h === "#/compliance")'), "and routes #/compliance to it");
  expect(/UNDER_WORKSPACE\s*=\s*\[[^\]]*"compliance"/s.test(router),
    "and files it under Workspace, so the Workspace tab stays current when it is open");
  expect(router.includes("window.DashCompliance.load()"), "and lazy-loads the page module");

  const html = readFileSync(DASHBOARD_HTML, "utf8");
  expect(html.includes('id="view-compliance"'), "dashboard.html has the view container");
  expect(html.includes('id="compliance-body"'), "and the body the page renders into");
  expect(html.includes("dash-compliance.js"), "and loads the module");
  // The header is two tabs. A third would break the e2e contract and, more to
  // the point, this is a tool — it belongs beside the scanner, not beside
  // Monitors.
  expect((html.match(/class="dash-tab"/g) || []).length === 2,
    "and no third top-level tab was added");
  expect(html.indexOf("dash-compliance.js") < html.indexOf("dash-router.js"),
    "the page module loads before the router that calls it");

  const ws = readFileSync(WORKSPACE_JS, "utf8");
  expect(ws.includes('id: "compliance"') && ws.includes('route: "#/compliance"'),
    "the Workspace grid carries a compliance tool card");
  expect(/id:\s*"compliance"[\s\S]{0,400}?analyzer:\s*null/.test(ws),
    "with no analyzer — there is no scorecard grade to invent for it");
  expect(ws.includes("t.emptyLine ||"),
    "and the card's empty line is per-tool, so it does not inherit a sentence that is untrue of it");

  // Every card with no analyzer must say what it IS. The shared default was
  // written about the CUR uploader and is false of a connection surface, a
  // config screen and a registry view; leaving any of them on it puts a
  // sentence on the screen that is not true of the thing beside it.
  const tools = ws.slice(ws.indexOf("var TOOLS = ["), ws.indexOf("];", ws.indexOf("var TOOLS = [")));
  const missing = tools.split(/\{\s*id:/).slice(1)
    .filter((chunk) => /analyzer:\s*null/.test(chunk) && !/emptyLine:/.test(chunk))
    .map((chunk) => (chunk.match(/^\s*"([\w-]+)"/) || [, "?"])[1]);
  expect(missing.length === 0,
    `every analyzer-less card carries its own empty line${missing.length ? " — missing: " + missing.join(", ") : ""}`);
}

// ---------------------------------------------------------------------------
console.log();
if (failures === 0) {
  console.log("\x1b[32m  all compliance frontend tests passed\x1b[0m\n");
  process.exit(0);
} else {
  console.log(`\x1b[31m  ${failures} compliance frontend test(s) failed\x1b[0m\n`);
  process.exit(1);
}
