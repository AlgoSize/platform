// The admin AI spend page, executed rather than read.
//
// Every honesty rule this panel is built on lives in a renderer, not in the
// API: the endpoint returns null-with-a-reason and a tri-state coverage flag,
// and all of that is worth nothing if the table paints a null as $0.00 or the
// coverage banner quietly rounds "nothing could be priced" up to "measured".
// A source-text assertion cannot tell the difference — `fmtUsd(g.totalCostUsd)`
// reads identically whether the value arrives as null or as 0.
//
// So this boots the real site/assets/js/admin.js against a strict DOM shim and
// a scripted fetch, drives the AI spend page, and reads what actually landed
// in the tree. Like test-dash-renderers.mjs, appendChild rejects a non-Node
// exactly as a browser does — a permissive stub tests nothing.
//
// Run with:  node scripts/test-admin-aiusage-frontend.mjs

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ADMIN_JS = join(__dirname, "..", "..", "site", "assets", "js", "admin.js");

let failures = 0;
const ok = (m) => console.log(`  \x1b[32m✓\x1b[0m ${m}`);
const fail = (m) => { console.log(`  \x1b[31m✗\x1b[0m ${m}`); failures++; };
const expect = (cond, label) => (cond ? ok(label) : fail(label));
const group = (name) => console.log(`\n\x1b[1m${name}\x1b[0m\n`);

// ---------------------------------------------------------------------------
// DOM shim
// ---------------------------------------------------------------------------

function makeDom() {
  class Node {
    constructor(tag) {
      this.tagName = String(tag || "").toUpperCase();
      this.childNodes = [];
      this.attributes = {};
      this.style = {};
      this.dataset = {};
      this._text = "";
      this.className = "";
      this.hidden = false;
      this.value = "";
      this._listeners = {};
    }
    get firstChild() { return this.childNodes[0] || null; }
    appendChild(node) {
      if (!(node instanceof Node)) {
        throw new TypeError("Argument 1 ('node') to Node.appendChild must be an instance of Node");
      }
      node.parentNode = this;
      this.childNodes.push(node);
      return node;
    }
    removeChild(node) {
      const i = this.childNodes.indexOf(node);
      if (i >= 0) this.childNodes.splice(i, 1);
      return node;
    }
    insertBefore(node, ref) {
      const i = ref ? this.childNodes.indexOf(ref) : this.childNodes.length;
      this.childNodes.splice(i < 0 ? this.childNodes.length : i, 0, node);
      node.parentNode = this;
      return node;
    }
    remove() { if (this.parentNode) this.parentNode.removeChild(this); }
    setAttribute(k, v) { this.attributes[k] = String(v); }
    getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attributes, k) ? this.attributes[k] : null; }
    removeAttribute(k) { delete this.attributes[k]; }
    hasAttribute(k) { return k in this.attributes; }
    addEventListener(type, fn) { (this._listeners[type] = this._listeners[type] || []).push(fn); }
    removeEventListener() {}
    click() { (this._listeners.click || []).forEach((fn) => fn({ preventDefault() {} })); }
    querySelector() { return null; }
    querySelectorAll() { return []; }
    closest() { return null; }
    scrollIntoView() {}
    focus() {}
    set textContent(v) { this._text = String(v); this.childNodes = []; }
    get textContent() {
      return this._text || this.childNodes.map((c) => c.textContent).join("");
    }
    set innerHTML(v) { this._text = String(v); this.childNodes = []; }
    get classList() { return { add() {}, remove() {}, toggle() {}, contains() { return false; } }; }
    /** Every node in this subtree, for assertions. */
    walk(out = []) {
      out.push(this);
      this.childNodes.forEach((c) => c.walk(out));
      return out;
    }
    find(pred) { return this.walk().find(pred) || null; }
    findAll(pred) { return this.walk().filter(pred); }
  }

  const registry = new Map();
  const document = {
    readyState: "complete",
    createElement: (tag) => new Node(tag),
    createTextNode: (t) => { const n = new Node("#text"); n.textContent = t; return n; },
    getElementById: (id) => {
      if (!registry.has(id)) { const n = new Node("div"); n.id = id; registry.set(id, n); }
      return registry.get(id);
    },
    querySelector: (sel) => {
      const m = /^#([A-Za-z0-9_-]+)$/.exec(sel);
      return m ? document.getElementById(m[1]) : null;
    },
    querySelectorAll: () => [],
    addEventListener() {},
    body: new Node("body"),
    documentElement: new Node("html"),
  };
  return { Node, document, registry };
}

/**
 * Boot admin.js with a scripted fetch and drive it to the AI spend page.
 * Returns the id registry plus the list of URLs the panel actually requested.
 */
function bootPanel(routes) {
  const { document, registry } = makeDom();
  const requests = [];
  const fetchImpl = (url, options) => {
    const path = String(url);
    requests.push(path);
    const key = Object.keys(routes).find((k) => path.indexOf(k) === 0);
    const body = key ? routes[key](path, options) : { error: "not_stubbed" };
    return Promise.resolve({
      ok: true, status: 200,
      text: () => Promise.resolve(JSON.stringify(body)),
      json: () => Promise.resolve(body),
    });
  };
  const win = {
    location: { hash: "#aiusage", href: "https://algosize.com/admin/", origin: "https://algosize.com" },
    history: { replaceState() {} },
    addEventListener() {}, removeEventListener() {},
    setTimeout, clearTimeout, setInterval, clearInterval,
    fetch: fetchImpl,
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    matchMedia: () => ({ matches: false, addEventListener() {}, addListener() {} }),
    navigator: { clipboard: { writeText: () => Promise.resolve() }, userAgent: "node" },
    // No Chart.js — the canvas branch is expected to no-op, not throw.
    console,
  };
  win.window = win; win.self = win; win.globalThis = win; win.document = document;
  const ctx = vm.createContext(win);
  vm.runInContext(readFileSync(ADMIN_JS, "utf8"), ctx, { filename: "admin.js" });
  return { registry, requests, document };
}

const flush = () => new Promise((r) => setTimeout(r, 5));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ME = { email: "ops@algosize.com" };
const SETTINGS = { environment: { name: "production", stripeMode: "test" } };

function usageBody(overrides) {
  return Object.assign({
    generatedAt: Math.floor(Date.now() / 1000),
    window: "30d", groupBy: "model", sort: "cost", dir: "desc",
    range: { startAt: 0, endAt: 1 },
    summary: {
      requests: 40, measuredRequests: 31, neurons: 1200000,
      totalCostUsd: 13.2, platformMarginUsd: 3.3, algosizePriceUsd: 16.5,
      marginPct: 20, partial: true,
    },
    coverage: {
      requests: 40, measuredRequests: 31, unmeasuredRequests: 9,
      measuredPct: 77.5, state: "partial",
    },
    emptyState: null,
    lastRowAt: Date.now(),
    groups: [
      {
        key: "kimi-k2.7-code", label: "kimi-k2.7-code", requests: 31, measuredRequests: 31,
        measured: "full", neurons: 1200000, totalCostUsd: 13.2, platformMarginUsd: 3.3,
        algosizePriceUsd: 16.5, marginPct: 20, partial: false, errors: 0,
        budget: { state: "ok", spendUsd: 16.5, limitUsd: null, pct: null },
      },
      {
        key: "unverified-model", label: "unverified-model", requests: 9, measuredRequests: 0,
        measured: "none", neurons: null, totalCostUsd: null, platformMarginUsd: null,
        algosizePriceUsd: null, marginPct: null, partial: true, errors: 0,
        budget: { state: "unmeasured", spendUsd: null, limitUsd: null, pct: null },
      },
    ],
    trend: [
      { date: "2026-08-28", neurons: 700000, totalCostUsd: 7.7, platformMarginUsd: 1.9,
        algosizePriceUsd: 9.6, requests: 22, measuredRequests: 22, partial: false },
      { date: "2026-08-29", neurons: 500000, totalCostUsd: 5.5, platformMarginUsd: 1.4,
        algosizePriceUsd: 6.9, requests: 18, measuredRequests: 9, partial: true },
    ],
    topExpensive: [
      {
        id: 1, orgId: "org_9b44", orgName: "Beacon", feature: "verify", model: "gpt-oss-20b",
        provider: "workers-ai", totalCostUsd: 0.33, platformMarginUsd: 0.082,
        algosizePriceUsd: 0.412, neurons: 30000, inputTokens: 177000, outputTokens: 21000,
        totalTokens: 198000, scanId: null, fixTaskId: null, status: "ok", createdAt: Date.now(),
      },
      {
        id: 2, orgId: "org_8f21", orgName: "Aster", feature: "fix", model: "kimi-k2.7-code",
        provider: "workers-ai", totalCostUsd: 0.229, platformMarginUsd: 0.057,
        algosizePriceUsd: 0.286, neurons: 20000, inputTokens: null, outputTokens: null,
        totalTokens: null, scanId: null, fixTaskId: null, status: "ok", createdAt: Date.now(),
      },
    ],
    budget: { limitUsd: null, note: "No AI_BUDGET_USD limit is configured; spend is tracked but not capped." },
  }, overrides || {});
}

const routesFor = (body) => ({
  "/api/me": () => ME,
  "/api/admin/settings": () => SETTINGS,
  "/api/admin/ai-usage": () => body,
});

const textOf = (node) => node.textContent;

// ---------------------------------------------------------------------------

group("the AI spend page asks the server to sort, and shows which column won");

{
  const { registry, requests } = bootPanel(routesFor(usageBody()));
  await flush();
  const usageCalls = requests.filter((r) => r.indexOf("/api/admin/ai-usage") === 0);
  expect(usageCalls.length === 1 && /sort=cost/.test(usageCalls[0]) && /dir=desc/.test(usageCalls[0]),
    "the first load asks for the default sort explicitly, so the client and server agree on it");

  const table = registry.get("adm-aiusage-table");
  const headers = table.findAll((n) => n.className === "adm-sort");
  expect(headers.length === 6,
    "every rankable column is a sort control (name, requests, neurons, cost, margin, revenue)");
  const costHeader = headers.find((h) => textOf(h).indexOf("Raw cost") === 0);
  expect(costHeader && costHeader.getAttribute("data-active") === "true",
    "the active column is marked, rather than leaving the reader to guess what the order means");

  // Re-clicking the active descending column must flip it, not re-request desc.
  costHeader.click();
  await flush();
  const after = requests.filter((r) => r.indexOf("/api/admin/ai-usage") === 0);
  expect(after.length === 2 && /sort=cost/.test(after[1]) && /dir=asc/.test(after[1]),
    "clicking the active column flips direction and re-fetches — sorting is a server round-trip, " +
    "because only the server still holds the nulls that decide which rows have no rank");
}

group("a null is never painted as a number");

{
  const { registry } = bootPanel(routesFor(usageBody()));
  await flush();
  const table = registry.get("adm-aiusage-table");
  const rows = table.findAll((n) => n.tagName === "TR").slice(1);
  expect(rows.length === 2, "both groups render");

  const unmeasured = rows[1];
  const cells = unmeasured.childNodes.map(textOf);
  expect(cells.indexOf("$0.00") === -1 && cells.indexOf("0") === -1,
    "the group where nothing could be priced shows no $0.00 and no bare 0");
  expect(unmeasured.findAll((n) => n.className === "adm-unknown").length === 4,
    "…its neurons, cost, margin and revenue each read 'not known' with a reason on hover");
  expect(unmeasured.find((n) => textOf(n) === "not measured") !== null,
    "…and its coverage cell says not measured, which is a different fact from partial");

  const measured = rows[0];
  expect(measured.find((n) => textOf(n) === "measured") !== null,
    "a fully measured group says so plainly");
}

group("coverage is stated, not implied");

{
  const { registry } = bootPanel(routesFor(usageBody()));
  await flush();
  const banner = registry.get("adm-aiusage-coverage");
  const text = textOf(banner);
  expect(/9 of 40 calls/.test(text),
    "the banner names how many calls could not be priced, against the total");
  expect(/lower bound/.test(text),
    "…and says every total on the page is therefore a lower bound");
  expect(/77\.5% measured/.test(text),
    "…with the measured share spelled out as a percentage");

  const summary = registry.get("adm-aiusage-summary");
  expect(/20\.0%/.test(textOf(summary)),
    "margin is shown as a share of revenue (a 25% markup is 20% of revenue)");
  expect(/31 of 40 priced/.test(textOf(summary)),
    "the requests tile carries the measured count rather than a bare total");
}

{
  const clean = usageBody({
    summary: { requests: 31, measuredRequests: 31, neurons: 1200000, totalCostUsd: 13.2,
               platformMarginUsd: 3.3, algosizePriceUsd: 16.5, marginPct: 20, partial: false },
    coverage: { requests: 31, measuredRequests: 31, unmeasuredRequests: 0, measuredPct: 100, state: "full" },
  });
  const { registry } = bootPanel(routesFor(clean));
  await flush();
  expect(textOf(registry.get("adm-aiusage-coverage")) === "",
    "with full coverage the banner is absent — a warning that shows in every state stops being read");
}

{
  const { registry } = bootPanel(routesFor(usageBody()));
  await flush();
  const note = textOf(registry.get("adm-aiusage-chart-note"));
  expect(/1 of 2 days include calls with no measured cost/.test(note) && /lower bounds/.test(note),
    "a day built from measured calls only is counted in words — a bar cannot say " +
    "'lower bound' by height, and a shorter one reads as a cheaper day");
}

group("an empty page says WHY it is empty");

{
  const never = usageBody({
    summary: { requests: 0, measuredRequests: 0, neurons: null, totalCostUsd: null,
               platformMarginUsd: null, algosizePriceUsd: null, marginPct: null, partial: false },
    coverage: { requests: 0, measuredRequests: 0, unmeasuredRequests: 0, measuredPct: null, state: "empty" },
    groups: [], topExpensive: [], trend: [],
    emptyState: { reason: "no_rows_ever", lastRowAt: null }, lastRowAt: null,
  });
  const { registry } = bootPanel(routesFor(never));
  await flush();
  const text = textOf(registry.get("adm-aiusage-table"));
  expect(/Nothing has ever been recorded/.test(text) && /Not \$0 of spend/.test(text),
    "an empty ai_usage table reads as a plumbing failure, not as a month with no spend");
}

{
  const quiet = usageBody({
    summary: { requests: 0, measuredRequests: 0, neurons: null, totalCostUsd: null,
               platformMarginUsd: null, algosizePriceUsd: null, marginPct: null, partial: false },
    coverage: { requests: 0, measuredRequests: 0, unmeasuredRequests: 0, measuredPct: null, state: "empty" },
    groups: [], topExpensive: [], trend: [],
    emptyState: { reason: "no_rows_in_window", lastRowAt: Date.now() - 86400000 * 30 },
    lastRowAt: Date.now() - 86400000 * 30,
  });
  const { registry } = bootPanel(routesFor(quiet));
  await flush();
  const text = textOf(registry.get("adm-aiusage-table"));
  expect(/Rows exist, but none in this period/.test(text) && /last recorded call/.test(text),
    "a quiet window says rows exist elsewhere and names when the last call landed");
}

group("an expensive request is explainable");

{
  const { registry } = bootPanel(routesFor(usageBody()));
  await flush();
  const top = registry.get("adm-aiusage-top");
  const rows = top.findAll((n) => n.className === "adm-aiusage-top-row");
  expect(rows.length === 2, "both rows render");
  expect(/198k tok/.test(textOf(rows[0])),
    "the token count that explains the cost is on the row, not just the dollar figure");
  expect(!/tok/.test(textOf(rows[1])),
    "…and a request whose provider returned no usage block shows no token count at all, " +
    "rather than 0 tok");
  expect(/cost \$0\.33/.test(textOf(rows[0])) && /margin \$0\.08/.test(textOf(rows[0])),
    "cost of goods and margin are shown apart from the customer price");
}

console.log("");
if (failures) {
  console.log(`\x1b[31m  ${failures} admin AI spend frontend test(s) failed\x1b[0m\n`);
  process.exit(1);
}
console.log("\x1b[32m  all admin AI spend frontend tests passed\x1b[0m\n");
