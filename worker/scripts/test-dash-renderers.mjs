// The monitored half of every tool page renders through DashCore's exported
// renderers. This executes them.
//
// Every other frontend test in this repo asserts on source TEXT, and that is
// usually the right trade for vanilla JS with no build step. It could not have
// caught this one. The bug was:
//
//   renderVuln: function (result) { showOutput("vuln", renderVuln(result)); }
//
// which reads perfectly — until you notice the internal renderVuln already
// ends in its own showOutput(...) and therefore returns undefined. So the
// wrapper cleared the output that had just been drawn and then called
// appendChild(undefined). Clicking "Show the advisories →" threw
// "Argument 1 ('node') to Node.appendChild must be an instance of Node" on
// ALL THREE tool pages, and nothing in the suite noticed, because the source
// text of a double-wrap looks exactly like the source text of a correct call.
//
// The shim below is deliberately STRICT about one thing: appendChild rejects a
// non-Node exactly as the browser does. A permissive stub would have accepted
// undefined and let this through a second time — the shim has to reproduce the
// failure or it is not testing anything.
//
// Run with:  node scripts/test-dash-renderers.mjs

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DASH_JS = join(__dirname, "..", "..", "site", "assets", "js", "dashboard.js");

let failures = 0;
const ok = (m) => console.log(`  \x1b[32m✓\x1b[0m ${m}`);
const fail = (m) => { console.log(`  \x1b[31m✗\x1b[0m ${m}`); failures++; };
const expect = (cond, label) => (cond ? ok(label) : fail(label));

// ---------------------------------------------------------------------------
// A DOM just complete enough to load dashboard.js, and strict where it counts.
// ---------------------------------------------------------------------------
function makeDom() {
  class Node {
    constructor(tag) {
      this.tagName = String(tag || "").toUpperCase();
      this.childNodes = [];
      this.attributes = {};
      this.dataset = {};
      this.style = {};
      this._text = "";
      this.className = "";
      this.disabled = false;
    }
    get firstChild() { return this.childNodes[0] || null; }
    // The assertion this whole file exists for.
    appendChild(node) {
      if (!(node instanceof Node)) {
        throw new TypeError(
          "Argument 1 ('node') to Node.appendChild must be an instance of Node");
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
      if (!(node instanceof Node)) {
        throw new TypeError(
          "Argument 1 ('node') to Node.insertBefore must be an instance of Node");
      }
      const i = ref ? this.childNodes.indexOf(ref) : this.childNodes.length;
      this.childNodes.splice(i < 0 ? this.childNodes.length : i, 0, node);
      node.parentNode = this;
      return node;
    }
    remove() { if (this.parentNode) this.parentNode.removeChild(this); }
    setAttribute(k, v) { this.attributes[k] = String(v); }
    getAttribute(k) { return this.attributes[k] ?? null; }
    removeAttribute(k) { delete this.attributes[k]; }
    hasAttribute(k) { return k in this.attributes; }
    addEventListener() {}
    removeEventListener() {}
    querySelector() { return null; }
    querySelectorAll() { return []; }
    scrollIntoView() {}
    closest() { return null; }
    set textContent(v) { this._text = String(v); this.childNodes = []; }
    get textContent() {
      return this._text || this.childNodes.map((c) => c.textContent).join("");
    }
    get classList() {
      return { add() {}, remove() {}, toggle() {}, contains() { return false; } };
    }
  }

  const registry = new Map();
  const document = {
    readyState: "complete",
    createElement: (tag) => new Node(tag),
    createTextNode: (t) => { const n = new Node("#text"); n.textContent = t; return n; },
    createDocumentFragment: () => new Node("#fragment"),
    // Any id resolves to a stable node, so the renderers find their mount
    // points without dashboard.html being parsed.
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
  return { document, registry };
}

function loadCore() {
  const { document, registry } = makeDom();
  const win = {
    location: { hash: "", href: "https://algosize.com/dashboard/", origin: "https://algosize.com" },
    addEventListener() {}, removeEventListener() {},
    setTimeout, clearTimeout, setInterval, clearInterval,
    fetch: () => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) }),
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    matchMedia: () => ({ matches: false, addEventListener() {}, addListener() {} }),
    alert() {}, confirm: () => true, prompt: () => null,
    requestAnimationFrame: (f) => setTimeout(f, 0),
    navigator: { clipboard: { writeText: () => Promise.resolve() }, userAgent: "node" },
    console,
  };
  win.window = win; win.self = win; win.globalThis = win; win.document = document;
  const ctx = vm.createContext(win);
  vm.runInContext(readFileSync(DASH_JS, "utf8"), ctx, { filename: "dashboard.js" });
  return { core: ctx.window.DashCore, document, registry };
}

// Shapes match what /api/monitors/:id/result/<analyzer> hands back — the
// payload the "Show the advisories →" button renders.
const FIXTURES = {
  vuln: {
    counts: { critical: 1, high: 2, medium: 0, low: 3 },
    scanned: { totalPackages: 42, manifests: [{ filename: "package-lock.json" }] },
    topAdvisories: [{
      id: "GHSA-test", package: "undici", ecosystem: "npm",
      installedVersion: "5.0.0", fixedIn: "6.0.0", severity: "high",
      advisoryUrl: "https://example.invalid/advisory", cvssScore: 7.5,
    }],
    fixCommand: "npm audit fix",
  },
  cost: { currentSpend: 1000, totalSavingsPct: 12, suggestions: [{ title: "Rightsize", savings: 100 }] },
  algo: { complexity: "O(n^2)", suggestions: [], wallTimeMs: 5 },
};

console.log("\n\x1b[1mthe monitored renderers draw without throwing\x1b[0m\n");

const { core, document } = loadCore();
expect(Boolean(core), "dashboard.js loads and exports window.DashCore");

if (core) {
  for (const [target, fixture] of Object.entries(FIXTURES)) {
    const name = "render" + target[0].toUpperCase() + target.slice(1);
    expect(typeof core[name] === "function", `DashCore.${name} is exported`);
    if (typeof core[name] !== "function") continue;

    const out = document.getElementById("output-" + target);
    out.childNodes = [];
    let threw = null;
    try { core[name](fixture); } catch (err) { threw = err; }

    expect(!threw,
      threw ? `DashCore.${name} draws without throwing — got "${threw.message}"`
            : `DashCore.${name} draws without throwing`);
    // Not throwing is only half of it: a renderer that silently mounts nothing
    // would pass the check above and still show the user an empty panel.
    expect(out.childNodes.length > 0,
      `…and actually mounts its result into #output-${target}`);
  }

  // A no-advisories result is a legitimate answer, not an error path, and it
  // must not be the case that only the populated shape happens to work.
  const out = document.getElementById("output-vuln");
  out.childNodes = [];
  let threw = null;
  try { core.renderVuln({ counts: {}, topAdvisories: [] }); } catch (err) { threw = err; }
  expect(!threw && out.childNodes.length > 0,
    "an empty advisory list renders too, rather than throwing or mounting nothing");
}

// ---------------------------------------------------------------------------
console.log("\nevery run type the CSV button is offered on can actually export\n");
// ---------------------------------------------------------------------------
//
// The Download CSV button is rendered for EVERY run, unconditionally, but
// csvForRun branched on cost, vuln and algo and then `return ""`. An arch run
// therefore downloaded a 0-byte file and said nothing — and an empty export is
// indistinguishable from "this run found nothing", which is the one thing it
// must never be mistaken for.
//
// Exercised through the real function rather than by reading the source,
// because "returns a non-empty string" is the property that matters and it is
// exactly what a text assertion cannot check.
if (core && typeof core.csvForRun === "function") {
  const RUNS = {
    arch: {
      analyzer: "arch",
      result: { findings: [{
        severity: "critical", lens: "security", rule: "datastore_publicly_published",
        target: "svc:db", evidence: "docker-compose.yml:10",
        why: "A database port is published to the host.", fix: "Remove the ports mapping.",
      }] },
    },
    estimate: {
      analyzer: "estimate",
      result: { providers: [{
        providerId: "aws", providerName: "AWS",
        estimatedTotalMicroUsd: 123_450_000, confidence: "medium",
      }] },
    },
    vuln: { analyzer: "vuln", result: { advisories: [{ severity: "high", package: "undici" }] } },
    cost: { analyzer: "cost", result: { suggestions: [{ impact: "high", title: "Rightsize" }] } },
    algo: { analyzer: "algo", result: { bigO: { label: "O(n)" }, wallTimeMs: 3 } },
  };

  for (const [name, run] of Object.entries(RUNS)) {
    const csv = core.csvForRun(run);
    expect(typeof csv === "string" && csv.trim().length > 0,
      `a ${name} run exports a non-empty CSV (got ${csv ? csv.length : 0} bytes)`);
    // A header alone is not an export — the row has to carry the finding.
    const lines = (csv || "").trim().split("\n");
    expect(lines.length >= 2, `…with a data row, not just a header (${name}: ${lines.length} line(s))`);
  }

  // The arch export must carry what an arch run is actually about.
  const archCsv = core.csvForRun(RUNS.arch);
  expect(/datastore_publicly_published/.test(archCsv) && /docker-compose\.yml:10/.test(archCsv),
    "and the arch export carries the rule and its file:line evidence");
} else {
  fail("DashCore.csvForRun is exported so the export can be tested at all");
}

// ---------------------------------------------------------------------------
console.log(failures === 0
  ? "\n\x1b[32mAll dashboard-renderer tests passed\x1b[0m\n"
  : `\n\x1b[31m${failures} dashboard-renderer test(s) failed\x1b[0m\n`);
process.exit(failures === 0 ? 0 : 1);
