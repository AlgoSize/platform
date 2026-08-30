// DashCore.callApi — the structured `errors` array must survive the wrapper.
//
// Bug: an endpoint that replies with { ok:false, errors:[{stage,code,message}] }
// (POST /api/ai/stage-config/validate, the Stage 5 != Stage 4 enforcement) had
// its per-item errors silently discarded by callApi — it only ever copied
// json.helpUrl and json.error (singular) onto the thrown Error, never
// json.errors (plural). dash-pipeline.js's catch handler reads err.errors to
// paint one inline message per stage row; with the field missing it always
// fell back to one generic message with no `stage`, so renderValidation's
// per-stage filter (`e.stage === s.id`) matched nothing — the server-side
// enforcement UI silently never rendered anything. Caught during the Fix
// Pipeline redesign, fixed additively in dashboard.js's callApi/callApiMultipart.
//
// Uses the same minimal VM+DOM harness as test-dash-renderers.mjs (a source-
// text assertion could not have caught this — the bug is in what the function
// actually attaches to a thrown Error at runtime).

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

/** Load the real dashboard.js into a VM with a mockable fetch. */
function loadCore(fetchImpl) {
  const registry = new Map();
  class Node {
    constructor(tag) { this.tagName = String(tag || "").toUpperCase(); this.childNodes = []; }
    appendChild(n) { this.childNodes.push(n); return n; }
    addEventListener() {}
  }
  const document = {
    readyState: "complete",
    createElement: (tag) => new Node(tag),
    getElementById: (id) => { if (!registry.has(id)) registry.set(id, new Node("div")); return registry.get(id); },
    querySelector: () => null, querySelectorAll: () => [],
    addEventListener() {}, body: new Node("body"), documentElement: new Node("html"),
  };
  const win = {
    location: { hash: "", href: "https://algosize.com/dashboard/", origin: "https://algosize.com" },
    addEventListener() {}, removeEventListener() {},
    setTimeout, clearTimeout, setInterval, clearInterval,
    fetch: fetchImpl,
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
  return ctx.window.DashCore;
}

const jsonRes = (status, body) => Promise.resolve({
  ok: status >= 200 && status < 300, status,
  json: () => Promise.resolve(body),
});

console.log("\n\x1b[1mcallApi carries a structured errors[] array through to the thrown Error\x1b[0m\n");

await (async () => {
  const core = loadCore(() => jsonRes(422, {
    schema: "algosize.stage-config-validation/1", ok: false,
    errors: [
      { stage: "verify", code: "must_differ", message: "verify must differ from fix" },
      { stage: "fix", code: "invalid_for_stage", message: "not a valid fix model" },
    ],
  }));
  let caught = null;
  try { await core.callApi("/api/ai/stage-config/validate", { config: {} }, "POST"); }
  catch (err) { caught = err; }
  expect(caught !== null, "a non-2xx response rejects the promise");
  expect(Array.isArray(caught && caught.errors) && caught.errors.length === 2,
    "…and the thrown Error carries the full errors[] array (this is the bug: it used to be undefined)");
  expect(caught.errors[0].stage === "verify" && caught.errors[0].message === "verify must differ from fix",
    "…with each item's stage + message intact, so a per-stage UI filter (e.stage === s.id) actually matches");
  expect(caught.status === 422, "…and the HTTP status is attached (err.status)");
})();

await (async () => {
  // A plain server_error (not 402) — sidesteps showQuotaBanner's modal-open
  // path, which this test's minimal DOM stub does not implement; the property
  // under test (the OLD singular error shape) is unrelated to that branch.
  const core = loadCore(() => jsonRes(500, { error: "server_error", message: "boom", helpUrl: "https://x" }));
  let caught = null;
  try { await core.callApi("/api/analyze/vuln", {}, "POST"); }
  catch (err) { caught = err; }
  expect(caught.code === "server_error" && caught.helpUrl === "https://x",
    "an endpoint with the OLD singular error shape still gets err.code/err.helpUrl (no regression)");
  expect(caught.errors === undefined,
    "…and err.errors is left undefined rather than fabricated when the body has no errors[]");
})();

await (async () => {
  const core = loadCore(() => jsonRes(200, { ok: true, value: 1 }));
  const result = await core.callApi("/api/whatever", {}, "GET");
  expect(result.ok === true && result.value === 1, "a 2xx response still resolves normally, unaffected");
})();

console.log("");
if (failures === 0) {
  console.log("\x1b[32m  all callApi-errors tests passed\x1b[0m\n");
  process.exit(0);
}
console.log(`\x1b[31m  ${failures} callApi-errors test(s) failed\x1b[0m\n`);
process.exit(1);
