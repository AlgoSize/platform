// The Fix Pipeline page, executed rather than read.
//
// Three of this page's rules only exist at runtime, where a source-text
// assertion cannot see them:
//
//   1. routing the fix stage must also park verification — one checkbox
//      changes another row, and a checkbox that stays unchecked while its
//      stage is routed is a lie about what will be billed;
//   2. a partial estimate must render the WORD "partial", never the sum of the
//      priced stages, which would be a price we cannot stand behind;
//   3. Stage 1 is an anchor with no model control at all, and rendering it
//      through the normal row path would put an empty dropdown on it.
//
// So this loads the real site/assets/js/dash-pipeline.js against a strict DOM
// shim and a scripted DashCore, drives it, and reads the tree.
//
// Run with:  node scripts/test-pipeline-frontend.mjs

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PIPE_JS = join(__dirname, "..", "..", "site", "assets", "js", "dash-pipeline.js");

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
      if (k === "id") this.id = String(v);
      if (k === "checked") this.checked = true;
      if (k === "hidden") this.hidden = true;
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
    querySelector(sel) {
      const m = /^\[data-funnel-model='([^']+)'\]$/.exec(sel);
      if (m) return this.find((n) => n.getAttribute("data-funnel-model") === m[1]);
      if (sel === "select") return this.find((n) => n.tagName === "SELECT");
      if (sel === "input[type='checkbox']") {
        return this.find((n) => n.tagName === "INPUT" && n.getAttribute("type") === "checkbox");
      }
      if (sel === ".pipe-agent.active") return this.find((n) => /pipe-agent/.test(n.className) && /active/.test(n.className));
      return null;
    }
    querySelectorAll(sel) {
      if (sel === ".pipe-agent") return this.findAll((n) => /pipe-agent/.test(n.className));
      if (sel === "select, input") return this.findAll((n) => n.tagName === "SELECT" || n.tagName === "INPUT");
      return [];
    }
  }

  const registry = new Map();
  const document = {
    createElement: (tag) => new Node(tag),
    createTextNode: (t) => { const n = new Node("#text"); n.textContent = t; return n; },
    getElementById: (id) => registry.get(id) || null,
    ensure: (id) => { if (!registry.has(id)) { const n = new Node("div"); n.id = id; registry.set(id, n); } return registry.get(id); },
    querySelector: () => null, querySelectorAll: () => [],
  };
  // Elements the module creates get registered as it sets their id, so
  // getElementById finds them the way a browser would.
  const origCreate = document.createElement;
  document.createElement = (tag) => {
    const n = origCreate(tag);
    const set = n.setAttribute.bind(n);
    n.setAttribute = (k, v) => { set(k, v); if (k === "id") registry.set(String(v), n); };
    return n;
  };
  return { Node, document, registry };
}

/** DashCore, scripted: `el` builds nodes, `callApi` answers from `routes`. */
function makeCore(document, routes, calls) {
  const el = (tag, attrs, children) => {
    const n = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach((k) => {
        const v = attrs[k];
        if (v === null || v === undefined || v === false) return;
        if (k === "class") n.className = v;
        else n.setAttribute(k, v === true ? "" : v);
      });
    }
    const kids = Array.isArray(children) ? children : (children === undefined ? [] : [children]);
    kids.forEach((c) => {
      if (c === null || c === undefined) return;
      n.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
    });
    return n;
  };
  return {
    el,
    setBusy() {},
    errorState: (msg) => el("div", { class: "panel-empty" }, msg),
    callApi(path, body, method) {
      calls.push({ path, body, method });
      const key = Object.keys(routes).find((k) => path.indexOf(k) === 0);
      if (!key) return Promise.reject(new Error("not stubbed: " + path));
      const r = routes[key](body);
      return r && r.__reject ? Promise.reject(r.err) : Promise.resolve(r);
    },
  };
}

function boot(routes) {
  const { document, registry } = makeDom();
  document.ensure("pipeline-body");
  const calls = [];
  const win = {
    document, console,
    setTimeout, clearTimeout,
    navigator: { clipboard: { writeText: () => Promise.resolve() } },
    DashCore: null,
  };
  win.window = win; win.globalThis = win;
  win.DashCore = makeCore(document, routes, calls);
  const ctx = vm.createContext(win);
  vm.runInContext(readFileSync(PIPE_JS, "utf8"), ctx, { filename: "dash-pipeline.js" });
  ctx.window.DashPipeline.load();
  return { registry, calls, document };
}

const flush = () => new Promise((r) => setTimeout(r, 5));

// ---------------------------------------------------------------------------
// Fixtures — shaped exactly like GET /api/ai/models now answers.
// ---------------------------------------------------------------------------

const MODELS = {
  schema: "algosize.stage-models/1",
  funnel: { detect: 1, triage: 1, validate: 0.15, fix: 0.1, verify: 0.1 },
  stages: [
    { id: "detect", label: "Detection", stage: 1, selectable: false, share: 1,
      description: "Deterministic SAST rules, secret patterns and dependency manifests.",
      note: "Exhaustive and free — there is no model to choose.", options: [], default: null },
    { id: "triage", label: "Triage (FP filter)", stage: 2, selectable: true, share: 1,
      description: "A cheap model reads each finding.", note: "Suppresses raw SAST noise.",
      distinctFrom: null,
      options: [{ model: "m/cheap", label: "cheap", priceHint: { outputPer1M: 0.2 } }], default: "m/cheap" },
    { id: "validate", label: "Deep validation", stage: 3, selectable: true, share: 0.15,
      description: "A reasoning model judges exploitability.", note: "Critical findings run as an ensemble.",
      distinctFrom: null,
      options: [{ model: "m/reason", label: "reason", priceHint: { outputPer1M: 1.1 } }], default: "m/reason" },
    { id: "fix", label: "Fix generation", stage: 4, selectable: true, share: 0.1,
      description: "A code specialist writes the patch.", note: "", distinctFrom: null,
      options: [{ model: "m/coder", label: "coder", priceHint: { outputPer1M: 4 } }], default: "m/coder" },
    { id: "verify", label: "Cross-model verification", stage: 5, selectable: true, share: 0.1,
      description: "A different model checks the patch.", note: "", distinctFrom: "fix",
      options: [{ model: "m/reason2", label: "reason2", priceHint: { outputPer1M: 1.2 } }], default: "m/reason2" },
  ],
};

const PRICED = {
  perStage: {
    detect: { share: 1, algosizePrice: 0, algosizePricePerRun: 0, selectable: false },
    triage: { share: 1, model: "m/cheap", algosizePrice: 0.00022, algosizePricePerRun: 0.00022 },
    validate: { share: 0.15, model: "m/reason", algosizePrice: 0.0000427, algosizePricePerRun: 0.000285 },
    fix: { share: 0.1, model: "m/coder", algosizePrice: 0.001225, algosizePricePerRun: 0.01225 },
    verify: { share: 0.1, model: "m/reason2", algosizePrice: 0.0000454, algosizePricePerRun: 0.000454 },
  },
  routeToMcp: [],
  perFinding: { algosizePrice: 0.0015331, per100Findings: 0.15331, partial: false, unpricedStages: [] },
};

const PARTIAL = Object.assign({}, PRICED, {
  perFinding: { algosizePrice: null, per100Findings: null, partial: true, unpricedStages: ["validate"] },
});

const baseRoutes = (estimate = PRICED) => ({
  "/api/ai/models": () => MODELS,
  "/api/ai/estimate": () => estimate,
  "/api/ai/stage-config/validate": () => ({ ok: true, errors: [] }),
});

const textOf = (n) => n.textContent;

// ---------------------------------------------------------------------------

group("Stage 1 is an anchor, not a dropdown with nothing in it");

{
  const { registry } = boot(baseRoutes());
  await flush();
  const row = registry.get("pipe-row-detect");
  expect(row !== null && /pipe-row-anchor/.test(row.className),
    "Stage 1 renders through the anchor path");
  expect(row.querySelector("select") === null && row.querySelector("input[type='checkbox']") === null,
    "…with no model dropdown and no route toggle — there is nothing to choose");
  expect(/Deterministic SAST rules/.test(textOf(row)) && /no model to choose/.test(textOf(row)),
    "…and says in words why it has no control");
  expect(registry.get("pipe-row-triage").querySelector("select") !== null,
    "a selectable stage still gets its dropdown");
}

group("every stage carries the server's copy and its funnel share");

{
  const { registry } = boot(baseRoutes());
  await flush();
  const row = registry.get("pipe-row-validate");
  expect(/A reasoning model judges exploitability/.test(textOf(row)),
    "the stage description comes from the server, not from the frontend");
  expect(/15% of findings/.test(textOf(row)),
    "…and the share that makes its cost contribution small is stated on the row");
  expect(/100% of findings/.test(textOf(registry.get("pipe-row-triage"))),
    "…with triage at full volume, because it sees everything");
}

group("routing the fix stage parks verification with it");

{
  const { registry, calls } = boot(baseRoutes());
  await flush();
  const fixRow = registry.get("pipe-row-fix");
  const verifyRow = registry.get("pipe-row-verify");

  const verifyBox = verifyRow.querySelector("input[type='checkbox']");
  expect(verifyBox.disabled === true,
    "verification has no toggle of its own — it follows the fix stage");

  const fixBox = fixRow.querySelector("input[type='checkbox']");
  fixBox.checked = true;
  fixBox.fire("change");
  await flush();

  expect(verifyBox.checked === true,
    "turning on the fix toggle checks verification too, so the UI cannot show a state the server will not run");
  expect(fixRow.querySelector("select").disabled === true && verifyRow.querySelector("select").disabled === true,
    "…and both model dropdowns go inert, because neither model will be called");

  const validate = calls.filter((c) => c.path.indexOf("/api/ai/stage-config/validate") === 0).pop();
  expect(Array.isArray(validate.body.routeToMcp) && validate.body.routeToMcp.indexOf("fix") >= 0,
    "the routing is sent with the config, so the server does not grade a stage it will not run");

  fixBox.checked = false;
  fixBox.fire("change");
  await flush();
  expect(verifyBox.checked === false && verifyRow.querySelector("select").disabled === false,
    "…and turning it back off releases verification with it");
}

group("a partial estimate is not a smaller number");

{
  const { registry } = boot(baseRoutes(PARTIAL));
  await flush();
  const panel = registry.get("pipe-cost-body");
  const body = textOf(panel);
  const headline = panel.find((n) => /pipe-total-num/.test(n.className));
  expect(textOf(headline) === "partial",
    "the headline reads 'partial' when a stage has no published rate");
  expect(!/\$/.test(textOf(headline)),
    "…and carries no dollar figure at all — the sum of the priced stages is an " +
    "incomplete pipeline, not a cheaper one, and quoting it would be a price we cannot stand behind");
  expect(/Deep validation has no published rate/.test(body),
    "…and names the stage responsible, so the gap is actionable");
  expect(/\$/.test(body),
    "…while the stages that ARE priced still show their contribution below it");
}

{
  const { registry } = boot(baseRoutes());
  await flush();
  const body = textOf(registry.get("pipe-cost-body"));
  expect(/per 100 findings/.test(body),
    "a fully priced pipeline is also quoted per 100 findings");
  expect(/Blended across the funnel/.test(body),
    "…and says the total is blended, not the sum of every stage at full volume");
  expect(/10%/.test(body) && /15%/.test(body),
    "…with each stage's share beside its contribution");
}

group("running the pipeline reports what it parked — and what it skipped");

{
  const routes = Object.assign(baseRoutes(), {
    "/api/pipeline/run": () => ({
      runId: "run_1", parked: 3, ms: 4200, attached: true,
      summary: { total: 12, budgetState: "ok",
        funnel: { waiting_for_agent: 3, suppressed_fp: 7, needs_human: 2 } },
      coverage: { findingsConsidered: 12, capped: true },
    }),
  });
  const { registry } = boot(routes);
  await flush();
  registry.get("pipe-run").value = "run_1";
  registry.get("pipe-run-go").fire("click");
  await flush();

  const out = textOf(registry.get("pipe-run-out"));
  expect(/3 findings waiting for an agent/.test(out),
    "the outcome leads with the number the next action on this page depends on");
  expect(/false positive/.test(out) && /needs a person/.test(out),
    "…and names every other outcome in words rather than leaving raw enum values on screen");
  expect(/Only the first 12 findings were run/.test(out),
    "a capped run says so — otherwise it reads as a clean sweep of the whole scan");
}

{
  const routes = Object.assign(baseRoutes(), {
    "/api/pipeline/run": () => ({
      runId: "run_1", parked: 0, ms: 900, attached: true,
      summary: { total: 4, budgetState: "unmeasured", funnel: { suppressed_fp: 4 } },
      coverage: { findingsConsidered: 4, capped: false },
    }),
  });
  const { registry } = boot(routes);
  await flush();
  registry.get("pipe-run").value = "run_1";
  registry.get("pipe-run-go").fire("click");
  await flush();
  expect(/not the same as being under budget/.test(textOf(registry.get("pipe-run-out"))),
    "an unmeasured budget state says it did not gate the run, rather than passing as 'under budget'");
}

group("the handoff says whether these findings survived the funnel");

{
  const routes = Object.assign(baseRoutes(), {
    "/api/fix/handoff": () => ({ selection: "all_findings", parked: null, agent: "mcp",
      findings: [{ fingerprint: "a" }, { fingerprint: "b" }], prompt: "# do the thing" }),
  });
  const { registry } = boot(routes);
  await flush();
  registry.get("pipe-run").value = "run_1";
  registry.get("pipe-handoff-go").fire("click");
  await flush();
  expect(/from the raw scan \(pipeline not run\)/.test(textOf(registry.get("pipe-handoff-out"))),
    "an untriaged scan is labelled as one — an agent must not be told noise survived a funnel it never entered");
}

{
  const routes = Object.assign(baseRoutes(), {
    "/api/fix/handoff": () => ({ selection: "parked", parked: 2, agent: "claude_code",
      findings: [{ fingerprint: "a" }, { fingerprint: "b" }], prompt: "# do the thing" }),
  });
  const { registry } = boot(routes);
  await flush();
  registry.get("pipe-run").value = "run_1";
  registry.get("pipe-handoff-go").fire("click");
  await flush();
  expect(/parked by the pipeline/.test(textOf(registry.get("pipe-handoff-out"))),
    "…and a parked set is labelled as having passed triage and validation");
}

console.log("");
if (failures) {
  console.log(`\x1b[31m  ${failures} pipeline-frontend test(s) failed\x1b[0m\n`);
  process.exit(1);
}
console.log("\x1b[32m  all pipeline-frontend tests passed\x1b[0m\n");
