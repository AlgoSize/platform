// The Model explorer page, executed rather than read.
//
// Four of this page's rules only exist at runtime:
//
//   1. dot collision relaxation — two models that score alike must both stay
//      visible, because one silently covering the other makes a scatter lie
//      about how many things are on it;
//   2. "avoid" and "unrated" must render as different marks, or the matrix
//      loses the fact that somebody looked at a pairing and said no;
//   3. an embedding model's output price must read "n/a — no output tokens",
//      never "$0", which would say free;
//   4. the caveat must be built from the server's provenance record, so it
//      cannot go stale when the prices are refreshed and the copy is not.
//
// A source-text assertion cannot see any of them. This loads the real
// site/assets/js/dash-models.js against a strict DOM shim and reads the tree.
//
// Run with:  node scripts/test-models-frontend.mjs

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MODELS_JS = join(__dirname, "..", "..", "site", "assets", "js", "dash-models.js");

let failures = 0;
const ok = (m) => console.log(`  \x1b[32m✓\x1b[0m ${m}`);
const fail = (m) => { console.log(`  \x1b[31m✗\x1b[0m ${m}`); failures++; };
const expect = (cond, label) => (cond ? ok(label) : fail(label));
const group = (name) => console.log(`\n\x1b[1m${name}\x1b[0m\n`);

// ---------------------------------------------------------------------------

function makeDom() {
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
        throw new TypeError("Argument 1 ('node') to Node.appendChild must be an instance of Node");
      }
      n.parentNode = this; this.childNodes.push(n); return n;
    }
    removeChild(n) { const i = this.childNodes.indexOf(n); if (i >= 0) this.childNodes.splice(i, 1); return n; }
    setAttribute(k, v) {
      this.attributes[k] = String(v);
      if (k === "id") { this.id = String(v); registry.set(String(v), this); }
      if (k === "checked") this.checked = true;
    }
    getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attributes, k) ? this.attributes[k] : null; }
    removeAttribute(k) { delete this.attributes[k]; }
    addEventListener(t, fn) { (this._listeners[t] = this._listeners[t] || []).push(fn); }
    removeEventListener() {}
    fire(t) { (this._listeners[t] || []).forEach((fn) => fn({ preventDefault() {}, target: this })); }
    set textContent(v) { this._text = String(v); this.childNodes = []; }
    get textContent() { return this._text || this.childNodes.map((c) => c.textContent).join(""); }
    get classList() {
      const self = this;
      return {
        add(c) { if (self.className.indexOf(c) < 0) self.className = (self.className + " " + c).trim(); },
        remove(c) { self.className = self.className.split(/\s+/).filter((x) => x && x !== c).join(" "); },
        toggle(c, on) { on ? this.add(c) : this.remove(c); },
        contains(c) { return self.className.split(/\s+/).indexOf(c) >= 0; },
      };
    }
    walk(out = []) { out.push(this); this.childNodes.forEach((c) => c.walk(out)); return out; }
    find(p) { return this.walk().find(p) || null; }
    findAll(p) { return this.walk().filter(p); }
    querySelector() { return null; }
    querySelectorAll() { return []; }
  }

  const registry = new Map();
  const document = {
    createElement: (tag) => new Node(tag),
    createTextNode: (t) => { const n = new Node("#text"); n.textContent = t; return n; },
    getElementById: (id) => registry.get(id) || null,
    ensure: (id) => { if (!registry.has(id)) { const n = new Node("div"); n.id = id; registry.set(id, n); } return registry.get(id); },
    querySelector: () => null, querySelectorAll: () => [],
  };
  return { Node, document, registry };
}

function makeCore(document, routes, calls) {
  // DashCore.el EXACTLY as site/assets/js/dashboard.js defines it.
  //
  // THIS IS THE POINT OF THE FILE. The first version of this stub accepted an
  // array of child nodes, because that is what I assumed el() did. The real
  // one does `n.textContent = text` and nothing else, so every composite node
  // on the page rendered "[object HTMLSpanElement],[object HTMLSpanElement]"
  // in production while this test passed. A stub written to match an
  // assumption tests the assumption, not the code — so this one is a
  // transcription of the real function, and the page is responsible for
  // building its own trees.
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
    errorState: (msg) => el("div", { class: "panel-empty" }, msg),
    callApi(path, body, method) {
      calls.push(path);
      const handler = Object.keys(routes).find((k) => path.indexOf(k) === 0);
      if (!handler) return Promise.reject(new Error("not stubbed: " + path));
      return Promise.resolve(routes[handler](path));
    },
  };
}

function boot(routes) {
  const { document, registry } = makeDom();
  document.ensure("models-body");
  const calls = [];
  const win = { document, console, setTimeout, clearTimeout, DashCore: null };
  win.window = win; win.globalThis = win;
  win.DashCore = makeCore(document, routes, calls);
  const ctx = vm.createContext(win);
  vm.runInContext(readFileSync(MODELS_JS, "utf8"), ctx, { filename: "dash-models.js" });
  ctx.window.DashModels.load();
  return { registry, calls };
}

const flush = () => new Promise((r) => setTimeout(r, 5));
const textOf = (n) => n.textContent;

// ---------------------------------------------------------------------------
// Fixtures shaped exactly like GET /api/ai/models now answers.
// ---------------------------------------------------------------------------

const PROVENANCE = {
  relayedOn: "2026-08",
  sourceUrl: "https://developers.cloudflare.com/workers-ai/models/",
  sourceName: "Cloudflare Workers AI models page",
  confirmedAgainstBill: false,
  caveat: "Relayed from Cloudflare's published rates, not re-confirmed against a bill.",
};

const FAMILIES = [
  { id: "embeddings", description: "Turning code into vectors." },
  { id: "fix_suggestion", description: "Writing a single-file patch." },
  { id: "visual_reasoning", description: "Reading a screenshot as evidence." },
];

// Two models with IDENTICAL scores — the collision case.
function point(model, over) {
  return Object.assign({
    model, label: model, provider: "workers-ai", x: 80, y: 70,
    deprecated: false, scored: false, p50Ms: 900, contextWindow: 128000,
    bestTier: "primary", notes: "A note about " + model,
    priceHint: { inputPer1M: 0.2, outputPer1M: 0.3, verified: true },
  }, over || {});
}

const SCATTER = {
  kind: "cost_vs_capability",
  x: { key: "costScore", label: "Cost efficiency", low: "expensive", high: "cheap" },
  y: { key: "capability", label: "Capability", low: "weaker", high: "stronger" },
  note: "The general-purpose view: what you get per dollar.",
  provenance: PROVENANCE,
  points: [
    point("@cf/twin/one"),
    point("@cf/twin/two"),                       // identical position
    point("@cf/baai/bge-m3", { x: 99, y: 62, priceHint: { inputPer1M: 0.012, outputPer1M: null, verified: true } }),
    // Shaped the way models.js priceHint() really returns a superseded model:
    // both prices null, with the REASON attached. pricing.js lists this class
    // of model at a real price and pickPrice declines it for a new call, which
    // is not the same fact as "emits no output tokens".
    point("@cf/old/model", { x: 40, y: 30, deprecated: true, bestTier: null,
      priceHint: { inputPer1M: null, outputPer1M: null, reason: "model_deprecated", verified: false } }),
  ],
};

const MATRIX = {
  kind: "model_fit_by_task",
  families: FAMILIES,
  provenance: PROVENANCE,
  rows: [
    { model: "@cf/good/one", label: "Good One", deprecated: false, scored: false,
      contextWindow: 128000, priceHint: { inputPer1M: 0.2, outputPer1M: 0.3, verified: true },
      fit: { embeddings: "unrated", fix_suggestion: "primary", visual_reasoning: "unrated" } },
    { model: "@cf/old/model", label: "Old", deprecated: true, scored: false,
      contextWindow: 8192, priceHint: { inputPer1M: 0.06, outputPer1M: 0.18, verified: true },
      fit: { embeddings: "unrated", fix_suggestion: "avoid", visual_reasoning: "unrated" } },
  ],
};

function routesFor(over) {
  return Object.assign({
    "/api/ai/models": (path) => {
      const body = { schema: "algosize.stage-models/2", taskFamilies: FAMILIES };
      if (path.indexOf("model_fit_by_task") >= 0) body.graph = MATRIX;
      else body.graph = SCATTER;
      if (path.indexOf("task=") >= 0) {
        const task = /task=([a-z_]+)/.exec(path)[1];
        body.recommendation = task === "visual_reasoning"
          ? { task, description: "Reading a screenshot as evidence.", budget: false, models: [], empty: true }
          : { task, description: "Writing a single-file patch.", budget: false, empty: false,
              models: [
                { model: "@cf/good/one", tier: "primary", contextWindow: 128000, notes: "Best patch writer.",
                  priceHint: { inputPer1M: 0.95, outputPer1M: 4, verified: true } },
                { model: "@cf/baai/bge-m3", tier: "budget", contextWindow: 8192, notes: "Embeddings only.",
                  priceHint: { inputPer1M: 0.012, outputPer1M: null, verified: true } },
              ] };
      }
      return body;
    },
  }, over || {});
}

// ---------------------------------------------------------------------------

group("nothing on the page renders as a stringified DOM node");

{
  // The regression that shipped: passing an array of nodes to DashCore.el put
  // "[object HTMLSpanElement]" on screen wherever a composite node was built.
  // One assertion over the whole tree catches every site at once, including
  // ones added later.
  for (const view of ["scatter", "matrix", "recommend"]) {
    const { registry } = boot(routesFor());
    await flush();
    const body = registry.get("models-body");
    if (view !== "scatter") {
      const label = view === "matrix" ? "Fit matrix" : "Recommend";
      body.findAll((n) => /mdl-seg/.test(n.className)).find((b) => textOf(b) === label).fire("click");
      await flush();
    }
    const text = textOf(registry.get("models-body"));
    expect(!/\[object /.test(text),
      `${view}: no node is stringified into the page — every composite is built with appendChild`);
  }
}

group("two models that score alike both stay visible");

{
  const { registry } = boot(routesFor());
  await flush();
  const body = registry.get("models-body");
  const dots = body.findAll((n) => /mdl-dot/.test(n.className));
  expect(dots.length === 4, "every point in the dataset gets a dot — none is dropped");

  const pos = dots.map((d) => d.getAttribute("style"));
  expect(new Set(pos).size === 4,
    "…and no two dots share a position: identical scores are nudged apart rather than " +
    "stacked, so the scatter never claims fewer models than it was given");

  const keyRows = body.findAll((n) => /mdl-key-row/.test(n.className));
  expect(keyRows.length === 4, "the key lists every model beside the plot");
  expect(/1/.test(textOf(keyRows[0])) && /4/.test(textOf(keyRows[3])),
    "…numbered against the same order as the dots, so a dot can be looked up");
}

group("a null price is not a free one");

{
  const { registry } = boot(routesFor());
  await flush();
  const body = registry.get("models-body");
  // Hover the embedding model to open its tooltip.
  const dot = body.find((n) => n.getAttribute("data-model") === "@cf/baai/bge-m3");
  dot.fire("mouseenter");
  await flush();

  const tip = registry.get("models-body").find((n) => /mdl-tip/.test(n.className) && n.getAttribute("role") === "tooltip");
  expect(tip !== null, "hovering a dot opens its tooltip");
  const t = textOf(tip);
  expect(/n\/a — no output tokens/.test(t),
    "an embedding model's output price reads 'n/a', never $0 — it emits no output tokens, " +
    "and a zero would say free");
  expect(/\$0\.012/.test(t), "…while its real input price is shown");
  expect(/engineering estimates/.test(t),
    "…and the tooltip says the scores are estimates rather than benchmark results");
}

{
  // The other null, and the one that was being described wrongly. A superseded
  // model has a PUBLISHED output price that pickPrice refuses for a new call —
  // @cf/moonshotai/kimi-k2.5 is listed at $0.180 / 1M out — and the tooltip
  // said "n/a — no output tokens" about it. Same shape as the embedding case,
  // opposite fact.
  const { registry } = boot(routesFor());
  await flush();
  const body = registry.get("models-body");
  const dot = body.find((n) => n.getAttribute("data-model") === "@cf/old/model");
  expect(dot !== null, "a superseded model is on the plot when they are shown");
  dot.fire("mouseenter");
  await flush();

  const tip = registry.get("models-body").find((n) => /mdl-tip/.test(n.className) && n.getAttribute("role") === "tooltip");
  const t = textOf(tip);
  expect(!/no output tokens/.test(t),
    "a superseded model is never described as emitting no output tokens");
  expect(/not quoted — superseded/.test(t),
    "…it says the price is not quoted because the model is superseded");
  // Both legs, not just the one that was reported: the input price is refused
  // for the same reason and must say the same thing.
  expect((t.match(/not quoted — superseded/g) || []).length === 2,
    "…on both the input and the output row, since both are refused for that reason");
}

group("avoid and unrated are different marks");

{
  const { registry } = boot(routesFor());
  await flush();
  registry.get("models-body")
    .findAll((n) => /mdl-seg/.test(n.className))
    .find((b) => textOf(b) === "Fit matrix")
    .fire("click");
  await flush();

  const body = registry.get("models-body");
  const cells = body.findAll((n) => /mdl-cell/.test(n.className));
  const avoid = cells.filter((c) => c.getAttribute("data-tier") === "avoid");
  const unrated = cells.filter((c) => c.getAttribute("data-tier") === "unrated");
  expect(avoid.length === 1 && unrated.length === 4, "both states render");
  expect(textOf(avoid[0]) !== textOf(unrated[0]),
    "…with DIFFERENT marks: a pairing somebody rejected must not look like one nobody rated");
  expect(textOf(avoid[0]) === "✗" && textOf(unrated[0]) === "·",
    "…a cross for a refusal, a dot for an absence");

  expect(cells.every((c) => textOf(c).length > 0),
    "every cell carries a letter or glyph as well as a colour, so the matrix survives greyscale");
  expect(/superseded/.test(textOf(body)),
    "a superseded model is labelled rather than quietly mixed in");
}

group("an empty recommendation is a deliberate blank");

{
  const { registry } = boot(routesFor());
  await flush();
  registry.get("models-body")
    .findAll((n) => /mdl-seg/.test(n.className))
    .find((b) => textOf(b) === "Recommend")
    .fire("click");
  await flush();

  let body = registry.get("models-body");
  expect(/Best patch writer/.test(textOf(body)), "a rated task lists its models with the reason each is there");
  expect(/\$0\.012 \/ 1M/.test(textOf(body)),
    "a model with no output price shows a single per-1M figure rather than an invented output rate");

  body.findAll((n) => /mdl-chip/.test(n.className))
    .find((c) => textOf(c) === "visual_reasoning")
    .fire("click");
  await flush();

  body = registry.get("models-body");
  expect(/No model on the shortlist is rated for this job/.test(textOf(body)) &&
         /deliberate blank, not a gap in the data/.test(textOf(body)),
    "an unrated task says nothing scored well enough — not that the data is missing");
}

group("the caveat is built from the server's provenance, not typed here");

{
  const { registry } = boot(routesFor());
  await flush();
  const t = textOf(registry.get("models-body"));
  expect(/Prices are relayed, not confirmed/.test(t), "the caveat is rendered");
  expect(/2026-08/.test(t) && /Cloudflare Workers AI models page/.test(t),
    "…carrying the date and source the SERVER reported, so refreshing the prices refreshes the caveat");
  expect(/seeded engineering estimates/.test(t),
    "…and states that the quality scores are estimates, which the design alone did not say");
}

{
  // A registry that reports no provenance must not silently look confirmed.
  const noProv = {
    "/api/ai/models": () => ({
      taskFamilies: FAMILIES,
      graph: Object.assign({}, SCATTER, { provenance: undefined }),
    }),
  };
  const { registry } = boot(noProv);
  await flush();
  expect(/treat every figure here as unsourced/.test(textOf(registry.get("models-body"))),
    "with no provenance at all the page says the prices are UNSOURCED rather than dropping the caveat");
}

group("the deprecated toggle asks the server, it does not filter locally");

{
  const { registry, calls } = boot(routesFor());
  await flush();
  const before = calls.length;
  const toggle = registry.get("models-body").find((n) => n.tagName === "INPUT" && n.getAttribute("type") === "checkbox");
  toggle.checked = true;
  toggle.fire("change");
  await flush();
  expect(calls.length === before + 1 && /includeDeprecated=1/.test(calls[calls.length - 1]),
    "showing superseded models re-fetches with the flag — the client never holds models it was not sent");
}

console.log("");
if (failures) {
  console.log(`\x1b[31m  ${failures} models-frontend test(s) failed\x1b[0m\n`);
  process.exit(1);
}
console.log("\x1b[32m  all models-frontend tests passed\x1b[0m\n");
