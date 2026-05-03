// Tests for the algorithm optimizer: validation, legacy detectors,
// HTTP/auth layer, and (Task #16) the sandbox runner, Big-O inference,
// LLM client + stub fallback, and the {code, sampleInput} payload path.

import { validateAlgoInput, analyzeAlgo } from "../src/analyzers/algo.js";
import { analyzeAlgoHandler } from "../src/handlers/analyze.js";
import worker from "../src/index.js";
import { issueJWT } from "../src/auth.js";
import { runUserCode } from "../src/analyzers/sandbox_runner.js";
import { inferBigO } from "../src/analyzers/bigo.js";
import { getRefactorSuggestion, parseLlmReply } from "../src/analyzers/llm.js";

import { makeD1 } from "./_d1-stub.mjs";

let failures = 0;
const ok   = (msg) => console.log(`  \x1b[32m✓\x1b[0m ${msg}`);
const fail = (msg) => { console.log(`  \x1b[31m✗\x1b[0m ${msg}`); failures++; };
const expect = (cond, label) => cond ? ok(label) : fail(label);

function makeKV() {
  const store = new Map();
  return {
    async get(key)            { return store.has(key) ? store.get(key) : null; },
    async put(key, val)       { store.set(key, val); },
    async delete(key)         { store.delete(key); },
    _store: store,
  };
}
function makeEnv(overrides = {}) {
  return {
    JWT_SECRET: "jwt-test-secret-32-or-more-chars-please-okay",
    SITE_ORIGIN: "http://localhost:5000",
    COOKIE_NAME: "algosize_session",
    SESSIONS: makeKV(),
    USERS: makeKV(),
    DB: makeD1(),
    ...overrides,
  };
}

console.log("\nvalidateAlgoInput\n");

expect(validateAlgoInput(null).ok === false, "null payload rejected");
expect(validateAlgoInput([]).ok === false, "array payload rejected");
expect(validateAlgoInput("hi").ok === false, "string payload rejected");
expect(validateAlgoInput({}).ok === false, "missing source rejected");
expect(validateAlgoInput({ source: "" }).ok === false, "empty source rejected");
expect(validateAlgoInput({ source: "   " }).ok === false, "whitespace-only source rejected");
{
  const r = validateAlgoInput({ source: "x = 1", language: 42 });
  expect(!r.ok && r.error === "invalid_payload", "non-string language rejected");
}
{
  const big = "x".repeat(100 * 1024 + 1);
  const r = validateAlgoInput({ source: big });
  expect(!r.ok && r.error === "source_too_large", "oversized source rejected (>100KB)");
}
{
  const r = validateAlgoInput({ source: "function f(){}" });
  expect(r.ok && r.value.language === "javascript", "default language is javascript");
}
{
  const r = validateAlgoInput({ source: "const x=1", language: "  TypeScript  " });
  expect(r.ok && r.value.language === "typescript", "language normalized to lowercase + trimmed");
}

console.log("\nDetector: nested loops over the same array\n");

// Canonical O(n²): find duplicates by checking arr against arr
{
  const out = analyzeAlgo({
    source: `
function hasDuplicates(arr) {
  for (let i = 0; i < arr.length; i++) {
    for (let j = i + 1; j < arr.length; j++) {
      if (arr[i] === arr[j]) return true;
    }
  }
  return false;
}
`.trim(),
  });
  expect(out.currentComplexity && out.currentComplexity.includes("O(n²)"),
         "nested for-index loops over arr.length → O(n²)");
  expect(out.suggestions.some(s => s.type === "nested_loops_same_array"),
         "emits nested_loops_same_array suggestion");
  expect(typeof out.optimizedExample === "string" && out.optimizedExample.includes("Set"),
         "optimizedExample shows the Set conversion");
}

// for-of nested over same array
{
  const out = analyzeAlgo({
    source: `
for (const a of items) {
  for (const b of items) {
    pairs.push([a, b]);
  }
}
`.trim(),
  });
  expect(out.suggestions && out.suggestions.some(s => s.type === "nested_loops_same_array"),
         "for-of nested over same array flagged");
}

// Different arrays → NOT flagged as nested-same-array
{
  const out = analyzeAlgo({
    source: `
for (const a of as) {
  for (const b of bs) {
    pairs.push([a, b]);
  }
}
`.trim(),
  });
  const nested = (out.suggestions || []).some(s => s.type === "nested_loops_same_array");
  expect(!nested, "nested loops over DIFFERENT arrays NOT flagged as same-array");
}

console.log("\nDetector: array scan inside loops\n");

// .includes inside a for loop → array_scan_in_loop
{
  const out = analyzeAlgo({
    source: `
function intersect(a, b) {
  const out = [];
  for (const x of a) {
    if (b.includes(x)) out.push(x);
  }
  return out;
}
`.trim(),
  });
  expect(out.currentComplexity && out.currentComplexity.includes("O(n²)"),
         ".includes() inside for-of loop → O(n²)");
  expect(out.suggestions.some(s => s.type === "array_scan_in_loop"),
         "emits array_scan_in_loop suggestion");
}

// .indexOf inside while loop → flagged
{
  const out = analyzeAlgo({
    source: `
let i = 0;
while (i < items.length) {
  if (haystack.indexOf(items[i]) >= 0) found++;
  i++;
}
`.trim(),
  });
  expect(out.suggestions && out.suggestions.some(s => s.type === "array_scan_in_loop"),
         ".indexOf() inside while loop flagged");
}

// .find inside .forEach (method-form loop) → flagged
{
  const out = analyzeAlgo({
    source: `
items.forEach(item => {
  const match = catalogue.find(c => c.id === item.id);
  if (match) results.push(match);
});
`.trim(),
  });
  expect(out.suggestions && out.suggestions.some(s => s.type === "array_scan_in_loop"),
         ".find() inside .forEach() flagged");
}

// Math.max(...) inside a loop is NOT flagged (built-in receiver blocklist)
{
  const out = analyzeAlgo({
    source: `
for (const x of arr) {
  result = Math.max(result, x);
  console.log(JSON.stringify(x));
}
`.trim(),
  });
  const scan = (out.suggestions || []).some(s => s.type === "array_scan_in_loop");
  expect(!scan, "Math/console/JSON inside loop NOT flagged as array scan");
}

console.log("\nDetector: unmemoized recursion\n");

// Multi-branch recursion (fib) → exponential_recursion + O(2^n)
{
  const out = analyzeAlgo({
    source: `
function fib(n) {
  if (n < 2) return n;
  return fib(n - 1) + fib(n - 2);
}
`.trim(),
  });
  expect(out.currentComplexity && out.currentComplexity.includes("O(2^n)"),
         "unmemoized fib (2 call sites) → O(2^n)");
  expect(out.suggestions.some(s => s.type === "exponential_recursion"),
         "emits exponential_recursion suggestion (not generic recursion)");
  expect(out.suggestions.every(s => s.type !== "linear_recursion"),
         "fib does NOT also emit a spurious linear_recursion finding");
  expect(typeof out.optimizedExample === "string" && out.optimizedExample.includes("memo"),
         "optimizedExample shows memoization pattern");
}

// Single-branch recursion (factorial) → linear_recursion + O(n), NOT exponential
{
  const out = analyzeAlgo({
    source: `
function factorial(n) {
  if (n <= 1) return 1;
  return n * factorial(n - 1);
}
`.trim(),
  });
  expect(out.suggestions && out.suggestions.some(s => s.type === "linear_recursion"),
         "factorial (1 call site) → linear_recursion (correctness fix from code review)");
  expect(out.suggestions.every(s => s.type !== "exponential_recursion"),
         "factorial NOT misclassified as exponential_recursion");
  expect(out.currentComplexity.includes("O(n)") && !out.currentComplexity.includes("O(2^n)"),
         "factorial complexity reported as O(n), not O(2^n)");
  expect(typeof out.optimizedExample === "string" && out.optimizedExample.includes("Iterative"),
         "optimizedExample suggests iteration for linear recursion");
}

// fib WITH `memo.has/get/set` Map → NOT flagged
{
  const out = analyzeAlgo({
    source: `
const memo = new Map();
function fib(n) {
  if (memo.has(n)) return memo.get(n);
  if (n < 2) return n;
  const r = fib(n - 1) + fib(n - 2);
  memo.set(n, r);
  return r;
}
`.trim(),
  });
  const rec = (out.suggestions || []).some(
    s => s.type === "exponential_recursion" || s.type === "linear_recursion",
  );
  expect(!rec, "fib WITH memo.has/get/set NOT flagged");
}

// Recursion with object-as-cache (cache[k]) → NOT flagged
{
  const out = analyzeAlgo({
    source: `
const cache = {};
function fib(n) {
  if (cache[n] !== undefined) return cache[n];
  if (n < 2) return n;
  cache[n] = fib(n - 1) + fib(n - 2);
  return cache[n];
}
`.trim(),
  });
  const rec = (out.suggestions || []).some(
    s => s.type === "exponential_recursion" || s.type === "linear_recursion",
  );
  expect(!rec, "fib with object-as-cache (cache[n]) NOT flagged (memo heuristic tightened)");
}

// Recursion via const arrow function (1 call site) → linear_recursion
{
  const out = analyzeAlgo({
    source: `
const fact = (n) => {
  if (n <= 1) return 1;
  return n * fact(n - 1);
};
`.trim(),
  });
  expect(out.suggestions && out.suggestions.some(s => s.type === "linear_recursion"),
         "arrow-function single-call recursion flagged as linear_recursion");
}

// Non-recursive function → NOT flagged
{
  const out = analyzeAlgo({
    source: `
function add(a, b) { return a + b; }
function sumArr(arr) {
  let s = 0;
  for (const x of arr) s += x;
  return s;
}
`.trim(),
  });
  const rec = (out.suggestions || []).some(
    s => s.type === "exponential_recursion" || s.type === "linear_recursion",
  );
  expect(!rec, "non-recursive helpers NOT flagged");
}

console.log("\nHonest fallback (CRITICAL: never fabricate advice)\n");

// Trivial straight-line function → unknown
{
  const out = analyzeAlgo({
    source: `
function area(r) {
  const PI = 3.14159;
  return PI * r * r;
}
`.trim(),
  });
  expect(out.currentComplexity === "unknown" && typeof out.reason === "string" && out.reason.length > 0,
         "trivial straight-line function → {currentComplexity:'unknown', reason}");
  expect(!("suggestions" in out), "unknown response has NO suggestions key (no fabrication)");
  expect(!("optimizedExample" in out), "unknown response has NO optimizedExample key");
}

// Empty / whitespace source → unknown (analyzer side)
{
  const out = analyzeAlgo({ source: "   \n  " });
  expect(out.currentComplexity === "unknown", "whitespace source → unknown at analyzer level");
}

// Unsupported language → unknown with explicit reason
{
  const out = analyzeAlgo({ source: "def f(n): return n", language: "python" });
  expect(out.currentComplexity === "unknown" && /python/i.test(out.reason),
         "unsupported language → unknown with reason naming the language");
}

// Comment containing "for (let i=0; i<arr.length...)" should NOT trigger
{
  const out = analyzeAlgo({
    source: `
// This used to be:
//   for (let i = 0; i < arr.length; i++)
//     for (let j = 0; j < arr.length; j++)
//        ... O(n²) madness ...
function avg(arr) {
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}
`.trim(),
  });
  expect(out.currentComplexity === "unknown",
         "loop pattern in a comment is stripped → no false positive");
}

// String literal containing loop syntax should NOT trigger
{
  const out = analyzeAlgo({
    source: `
const help = "for (let i = 0; i < arr.length; i++) for (let j = 0; j < arr.length; j++) {}";
function f() { return help.length; }
`.trim(),
  });
  expect(out.currentComplexity === "unknown",
         "loop pattern in a string literal is stripped → no false positive");
}

console.log("\nSingle-statement loops (no braces)\n");

// Single-statement for-of with .includes → flagged
{
  const out = analyzeAlgo({
    source: `function f(items, other) { for (const x of items) if (other.includes(x)) hits++; }`,
  });
  expect(out.suggestions && out.suggestions.some(s => s.type === "array_scan_in_loop"),
         "single-statement for-of with .includes() flagged (no-braces case)");
}

// Single-statement nested for over same array → flagged
{
  const out = analyzeAlgo({
    source: `for (let i = 0; i < arr.length; i++) for (let j = 0; j < arr.length; j++) work(arr[i], arr[j]);`,
  });
  expect(out.suggestions && out.suggestions.some(s => s.type === "nested_loops_same_array"),
         "single-statement nested for-loops over same array flagged");
}

console.log("\nAggregation\n");

// Multiple detectors fire; pick worst complexity (recursion > nested)
{
  const out = analyzeAlgo({
    source: `
function fib(n) {
  if (n < 2) return n;
  return fib(n - 1) + fib(n - 2);
}
function dupes(arr) {
  for (const a of arr) {
    for (const b of arr) {
      if (a === b) seen++;
    }
  }
}
`.trim(),
  });
  expect(out.currentComplexity.includes("O(2^n)"),
         "exponential complexity dominates quadratic when both fire");
  expect(out.suggestions.length >= 2,
         "both suggestions present");
}

// Suggestions sorted by line number
{
  const out = analyzeAlgo({
    source: `
function dupes(arr) {                      // line 1
  for (const a of arr) {                   // line 2
    for (const b of arr) {}                // line 3
  }
}
function fib(n) {                          // line 6
  if (n < 2) return n;
  return fib(n - 1) + fib(n - 2);
}
`.trim(),
  });
  const lines = out.suggestions.map(s => s.line);
  const sorted = lines.every((v, i, a) => i === 0 || a[i - 1] <= v);
  expect(sorted, "suggestions sorted by line number ascending");
}

console.log("\nHTTP layer (legacy heuristic path — `{source}` body)\n");

// Invalid JSON → 400
{
  const req = new Request("http://x/api/analyze/algo", { method: "POST", body: "not-json" });
  const res = await analyzeAlgoHandler(req, makeEnv());
  const body = await res.json();
  expect(res.status === 400 && body.error === "invalid_json", "invalid JSON → 400 invalid_json");
}

// Validation failure → 400
{
  const req = new Request("http://x/api/analyze/algo", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  });
  const res = await analyzeAlgoHandler(req, makeEnv());
  const body = await res.json();
  expect(res.status === 400 && body.error === "invalid_payload",
         "missing source → 400 invalid_payload");
}

// Good payload (legacy `source`) → 200 with full success shape
{
  const req = new Request("http://x/api/analyze/algo", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      source: "function fib(n){ if (n<2) return n; return fib(n-1)+fib(n-2); }",
    }),
  });
  const res = await analyzeAlgoHandler(req, makeEnv());
  const body = await res.json();
  expect(
    res.status === 200 &&
      typeof body.currentComplexity === "string" &&
      Array.isArray(body.suggestions) &&
      body.suggestions.length >= 1 &&
      typeof body.optimizedExample === "string",
    "fib payload → 200 with full {currentComplexity, suggestions[], optimizedExample} shape",
  );
}

// Honest fallback over HTTP
{
  const req = new Request("http://x/api/analyze/algo", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ source: "function add(a,b){ return a+b }" }),
  });
  const res = await analyzeAlgoHandler(req, makeEnv());
  const body = await res.json();
  expect(
    res.status === 200 &&
      body.currentComplexity === "unknown" &&
      typeof body.reason === "string",
    "trivial code → 200 with {currentComplexity:'unknown', reason}",
  );
}

console.log("\nRouter — auth gate on /api/analyze/algo\n");

// No token → 401
{
  const env = makeEnv();
  const req = new Request("http://x/api/analyze/algo", {
    method: "POST",
    headers: { "content-type": "application/json", "Origin": "http://localhost:5000" },
    body: JSON.stringify({ source: "x" }),
  });
  const res = await worker.fetch(req, env, {});
  const body = await res.json();
  expect(res.status === 401 && body.error === "unauthorized" && body.reason === "missing_token",
         "no token → 401 unauthorized (route is gated)");
}

// Valid token → 200 (full pipeline through router)
{
  const env = makeEnv();
  const token = await issueJWT(env, "user_1", "alice@example.com", "active");
  const req = new Request("http://x/api/analyze/algo", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "Origin": "http://localhost:5000",
      "Authorization": `Bearer ${token}`,
    },
    body: JSON.stringify({ source: "function fib(n){ return fib(n-1)+fib(n-2); }" }),
  });
  const res = await worker.fetch(req, env, {});
  const body = await res.json();
  expect(res.status === 200 && body.suggestions && body.suggestions.length >= 1,
         "valid token + recursive payload → 200 with suggestions");
}

// Tampered token → 401
{
  const env = makeEnv();
  const token = await issueJWT(env, "user_1", "alice@example.com", "active");
  const tampered = token.slice(0, -2) + (token.slice(-2) === "AA" ? "BB" : "AA");
  const req = new Request("http://x/api/analyze/algo", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "Origin": "http://localhost:5000",
      "Authorization": `Bearer ${tampered}`,
    },
    body: JSON.stringify({ source: "function f(){}" }),
  });
  const res = await worker.fetch(req, env, {});
  expect(res.status === 401, "tampered token → 401");
}

// Stub route is GONE — used to be 501 not_implemented
{
  const env = makeEnv();
  const token = await issueJWT(env, "user_1", "alice@example.com", "active");
  const req = new Request("http://x/api/analyze/algo", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "Origin": "http://localhost:5000",
      "Authorization": `Bearer ${token}`,
    },
    body: JSON.stringify({ source: "function f(){}" }),
  });
  const res = await worker.fetch(req, env, {});
  const body = await res.json();
  expect(res.status !== 501 && body.error !== "not_implemented",
         "stub replaced — endpoint no longer returns 501");
}

// ===========================================================================
// NEW (Task #16) — sandbox runner, Big-O, LLM, end-to-end {code, sampleInput}
// ===========================================================================

console.log("\nSandbox runner — happy path\n");

{
  const r = await runUserCode("function f(arr){ return arr.length; }", [1, 2, 3]);
  expect(r.ok && r.result === 3 && typeof r.ms === "number",
         "function returning a number runs and reports ms");
}
{
  const r = await runUserCode(
    "function pick(arr){ return arr.filter(x => x > 2); }",
    [1, 2, 3, 4],
  );
  expect(r.ok && Array.isArray(r.result) && r.result.length === 2,
         "function returning an array round-trips through JSON serialization");
}
{
  const r = await runUserCode("function noop(){ return null; }", null);
  expect(r.ok && r.result === null, "function returning null is valid");
}
{
  const r = await runUserCode("function sumN(n){ let s=0; for(let i=0;i<n;i++) s+=i; return s; }", 1000);
  expect(r.ok && r.result === 499500, "numeric input + numeric output works");
}

console.log("\nSandbox runner — input validation\n");

{
  const r = await runUserCode(null, []);
  expect(!r.ok && r.error === "invalid_code", "non-string code rejected");
}
{
  const r = await runUserCode("", []);
  expect(!r.ok && r.error === "invalid_code", "empty code rejected");
}
{
  const big = "function f(){ return 1; } /* " + "x".repeat(50 * 1024) + " */";
  const r = await runUserCode(big, []);
  expect(!r.ok && r.error === "code_too_large", "code over 50KB rejected");
}
{
  const r = await runUserCode("const x = 1;", []);
  expect(!r.ok && r.error === "no_function_declaration",
         "code without a function declaration rejected");
}
{
  // Used to return `async_not_supported`; now caught one layer earlier
  // by the `\basync\b` block-list pattern (see Task #16 third hardening).
  const r = await runUserCode("async function f(arr){ return arr.length; }", [1]);
  expect(!r.ok && r.error === "forbidden_import",
         "async function rejected at parse time (block-list catches `async` keyword)");
}
{
  const r = await runUserCode("function f(){ ", []);
  expect(!r.ok && r.error === "compile_error", "syntactically broken code → compile_error");
}

console.log("\nSandbox runner — forbidden API block-list\n");

const forbiddenSamples = [
  ["require('fs')",                 "function f(){ const fs = require('fs'); return 0; }"],
  ["dynamic import",                "function f(){ return import('foo'); }"],
  ["fetch()",                       "function f(){ return fetch('http://x'); }"],
  ["XMLHttpRequest",                "function f(){ const x = new XMLHttpRequest(); return 0; }"],
  ["WebSocket",                     "function f(){ const w = new WebSocket('ws://x'); return 0; }"],
  ["process",                       "function f(){ return process.env; }"],
  ["globalThis",                    "function f(){ return globalThis.x; }"],
  ["eval()",                        "function f(){ return eval('1+1'); }"],
  ["Function constructor",          "function f(){ return Function('return 1')(); }"],
  ["fs.readFile",                   "function f(){ return fs.readFile('x'); }"],
  ["net.createServer",              "function f(){ return net.createServer(); }"],
  ["child_process.exec",            "function f(){ return child_process.exec('ls'); }"],
];
for (const [label, code] of forbiddenSamples) {
  const r = await runUserCode(code, []);
  expect(!r.ok && r.error === "forbidden_import",
         `block-list rejects ${label}`);
}
{
  // import statement at top of file
  const r = await runUserCode("import fs from 'fs';\nfunction f(){ return 0; }", []);
  expect(!r.ok && r.error === "forbidden_import",
         "block-list rejects top-level import statement");
}
{
  // String literals that mention forbidden words but don't actually call them
  // are allowed — the regex requires the call/access syntax (e.g. `fetch(`,
  // `fs.`). This keeps benign code that happens to use those words in
  // strings or comments from being false-positived.
  const r = await runUserCode("function f(){ return 'fetch is fun'; }", []);
  expect(r.ok && r.result === "fetch is fun",
         "block-list allows benign string mentions of forbidden words (no call syntax)");
}
{
  // Comment containing forbidden token but no actual usage → allowed.
  const r = await runUserCode("function f(){ /* never call fs */ return 1; }", []);
  expect(r.ok && r.result === 1,
         "block-list allows forbidden words in comments when not followed by call/access syntax");
}

console.log("\nSandbox runner — sandbox-escape bypass attempts (post-review hardening)\n");

// Each entry is a known escape vector the architect's review surfaced.
// All of them MUST be rejected at parse time by the regex pre-check
// (defense layer 1). Defense layer 2 (lexical shadowing) is verified
// indirectly — if the regex ever regresses, the shadowed `undefined`
// binding causes runtime_error rather than letting the escape succeed.
const bypassAttempts = [
  ["self['fetch']('http://x')",         "function f(){ return self['fetch']('http://x'); }"],
  ["window.fetch",                      "function f(){ return window.fetch('http://x'); }"],
  ["globalThis.fetch via bracket",      "function f(){ return globalThis['fetch']('x'); }"],

  // Prototype-chain Function-constructor escape — every form must be blocked
  // because this is the ONLY path that bypasses lexical shadowing (Function
  // constructor creates code that runs in global scope, sees real fetch).
  ["({}).constructor.constructor",      "function f(){ return ({}).constructor.constructor('return 1')(); }"],
  ["({})['constructor']['constructor']", "function f(){ return ({})['constructor']['constructor']('return fetch')(); }"],
  ["[].constructor.constructor",        "function f(){ return [].constructor.constructor('return fetch')(); }"],
  ["String.prototype.constructor chain","function f(){ return ('').constructor.constructor('return 1')(); }"],
  ["Object['constructor'](...)",        "function f(){ return Object['constructor']('return 1')(); }"],
  ["Reflect.get(O, 'constructor')",     "function f(){ return Reflect.get(Object, 'constructor'); }"],
  ["[].__proto__.constructor",          "function f(){ return [].__proto__.constructor; }"],
  ["[].__proto__['constructor']",       "function f(){ return [].__proto__['constructor']; }"],
  ["new Proxy escape",                  "function f(){ return new Proxy({}, {}); }"],

  // Unicode-escape identifier bypass — would spell `constructor` past the
  // word-boundary regex without the \\uXXXX escape filter.
  ["\\u0063onstructor escape",          "function f(){ return ({})['\\u0063onstructor']; }"],
  ["\\xXX hex escape",                  "function f(){ return '\\x66'; }"],

  // Async-scheduling escapes (could run network code AFTER timing returns).
  ["setTimeout escape",                 "function f(){ return setTimeout(() => 1, 0); }"],
  ["setInterval escape",                "function f(){ return setInterval(() => 1, 0); }"],
  ["queueMicrotask escape",             "function f(){ return queueMicrotask(() => 1); }"],
  ["Promise.resolve().then escape",     "function f(){ Promise.resolve().then(() => 1); return 1; }"],

  // Other host-object reaches.
  ["caches.default",                    "function f(){ return caches.default; }"],
  ["crypto.subtle",                     "function f(){ return crypto.subtle; }"],
  ["addEventListener",                  "function f(){ addEventListener('fetch', () => 1); return 1; }"],
  ["navigator.userAgent",               "function f(){ return navigator.userAgent; }"],
];
for (const [label, code] of bypassAttempts) {
  const r = await runUserCode(code, []);
  expect(!r.ok && r.error === "forbidden_import",
         `bypass blocked by regex: ${label}`);
}

// Lexical-shadowing layer (defense 2) — verified directly by importing the
// SHADOWED_GLOBALS list and confirming the runner doesn't crash even when
// the regex layer is bypassed. We do that by hand-constructing the shadow
// prologue + a benign reference and checking the user's `fetch` resolves
// to undefined inside the function.
{
  // We can't easily disable the regex layer from here; instead we inspect
  // _internal to verify the shadow list covers every regex-blocked global.
  const { _internal } = await import("../src/analyzers/sandbox_runner.js");
  const mustShadow = ["fetch", "self", "window", "globalThis", "Function",
                      "setTimeout", "setInterval", "queueMicrotask", "Promise",
                      "caches", "crypto", "XMLHttpRequest", "WebSocket"];
  const missing = mustShadow.filter((n) => !_internal.SHADOWED_GLOBALS.includes(n));
  expect(missing.length === 0,
         `defense layer 2: SHADOWED_GLOBALS covers all critical globals (missing: ${missing.join(", ") || "none"})`);
}

// Strings that reference a forbidden NAME but not its call/access syntax
// should still be allowed (we don't want pathological false positives).
// Note: the new patterns are word-boundary based, so e.g. "selfish" is fine
// but "self" alone is not — strings like "running self test" would be
// rejected (acceptable trade-off).
{
  const r = await runUserCode("function f(){ return 'fetching is allowed'; }", []);
  expect(r.ok && r.result === "fetching is allowed",
         "block-list allows benign substrings (e.g. 'fetching') — word-boundary regex");
}

console.log("\nSandbox runner — defense layer 3 (runtime prototype-chain barrier)\n");

// These attacks build the property name "constructor" at RUNTIME via string
// concatenation or array-join, so the source regex CANNOT see them. They
// must be blocked by the runtime barrier (Function.prototype.constructor
// patched to throw during user-code execution).
//
// The trick: each attack assembles "constructor" without ever spelling it
// in source, then uses bracket access to reach the Function constructor
// via the prototype chain. With layer 3 active, the lookup hits our
// throwing thunk and the user call fails with `runtime_error`.
const dynamicAssemblyAttacks = [
  ["string concat",        "function f(){ const c='con'+'structor'; return ({}[c][c])('return 1')(); }"],
  ["array join",           "function f(){ const c=['con','structor'].join(''); return ({}[c][c])('return fetch')(); }"],
  ["String.fromCharCode",  "function f(){ const c=String.fromCharCode(99,111,110,115,116,114,117,99,116,111,114); return ({}[c][c])('return 1')(); }"],
  ["template literal",     "function f(){ const a='con',b='structor'; const c=`${a}${b}`; return ({}[c][c])('return 1')(); }"],
  ["base64-style",         "function f(){ const c='cONstrUCtor'.toLowerCase(); return ({}[c][c])('return 1')(); }"],
];
for (const [label, code] of dynamicAssemblyAttacks) {
  const r = await runUserCode(code, []);
  expect(!r.ok && r.error === "runtime_error" && /Function constructor access blocked/.test(r.message),
         `runtime barrier blocks dynamic-assembly attack: ${label} (got ${r.error}: ${r.message})`);
}

// toJSON / getter escape — the architect's fifth-round attack. JSON.stringify
// invokes user-supplied `toJSON` methods AND walks property getters, so any
// of those callbacks runs synchronously DURING serialization. If we
// uninstall the barrier before serialize, the toJSON/getter callback can
// mount a dynamic-assembly attack with no async or constructor token in
// the source. Fix: keep barrier installed across compile→thenCheck→stringify.
// What we test for: the attack throws (security guarantee held), AND the
// thrown error came from OUR barrier (not some unrelated bug). The error
// code may be `runtime_error` (when the throw happens during compiled()
// or .then access) or `result_not_serializable` (when JSON.stringify
// catches the toJSON/getter throw and propagates it). Either is fine —
// both mean the escape failed.
const escapeBlocked = (r) =>
  !r.ok &&
  (r.error === "runtime_error" || r.error === "result_not_serializable") &&
  /Function constructor access blocked/.test(r.message);

{
  // toJSON escape — note `constructor` and `Function` are obtained without
  // either word ever appearing in source.
  const code = `function f(){
    return { toJSON(){ const c='con'+'structor'; return ({}[c][c])('return 1')(); } };
  }`;
  const r = await runUserCode(code, []);
  expect(escapeBlocked(r),
         `toJSON escape blocked — barrier stays installed across JSON.stringify (got ${r.error}: ${r.message})`);
}
{
  // Getter on `.then` escape — fires during the thenable check. Same
  // attack mounted from a property getter rather than toJSON.
  const code = `function f(){
    return Object.defineProperty({}, 'then', {
      get(){ const c='con'+'structor'; return ({}[c][c])('return 1')(); }
    });
  }`;
  const r = await runUserCode(code, []);
  expect(escapeBlocked(r),
         `getter-on-then escape blocked — barrier stays installed across .then check (got ${r.error}: ${r.message})`);
}
{
  // Plain getter on a regular property fires during JSON.stringify's
  // [[Get]] walk. Last fallback path.
  const code = `function f(){
    return Object.defineProperty({}, 'x', {
      enumerable: true,
      get(){ const c='con'+'structor'; return ({}[c][c])('return 1')(); }
    });
  }`;
  const r = await runUserCode(code, []);
  expect(escapeBlocked(r),
         `property-getter escape during JSON.stringify blocked (got ${r.error}: ${r.message})`);
}

// Verify the barrier is RESTORED after user code runs — no leakage of the
// patched state into the host runtime. This is the safety guarantee that
// makes the patch acceptable in a shared-isolate environment.
{
  const before = Function.prototype.constructor;
  await runUserCode("function f(){ return 1; }", []);
  expect(Function.prototype.constructor === before,
         "runtime barrier restores Function.prototype.constructor after run (success path)");
}
{
  const before = Function.prototype.constructor;
  await runUserCode("function f(){ throw new Error('boom'); }", []);
  expect(Function.prototype.constructor === before,
         "runtime barrier restores Function.prototype.constructor after run (throw path)");
}
{
  const { _internal } = await import("../src/analyzers/sandbox_runner.js");
  const before = Function.prototype.constructor;
  const barrier = _internal.installPrototypeBarrier();
  expect(Function.prototype.constructor !== before,
         "installPrototypeBarrier replaces Function.prototype.constructor");
  let threw = false;
  try { Function.prototype.constructor("return 1")(); } catch { threw = true; }
  expect(threw, "patched Function.prototype.constructor throws when called");
  barrier.uninstall();
  expect(Function.prototype.constructor === before,
         "barrier.uninstall() restores the original");
  // Idempotent
  barrier.uninstall();
  expect(Function.prototype.constructor === before,
         "barrier.uninstall() is idempotent (no double-restore corruption)");
}

console.log("\nSandbox runner — runtime errors and timeout\n");

{
  const r = await runUserCode("function f(){ throw new Error('boom'); }", []);
  expect(!r.ok && r.error === "runtime_error" && /boom/.test(r.message),
         "thrown user error → runtime_error with message");
}
{
  // Promise is now in the block-list (it enables async-scheduling escapes
  // like Promise.resolve().then(() => fetch(...)) that would run after our
  // timing measurement returned). So `Promise.resolve(...)` is rejected at
  // the regex layer with `forbidden_import`, not at the result-shape check.
  const r = await runUserCode("function f(){ return Promise.resolve(1); }", []);
  expect(!r.ok && r.error === "forbidden_import",
         "Promise reference rejected by block-list (async-scheduling escape)");
}
{
  // `async function f(){}` is now caught by the `\basync\b` block-list
  // pattern (used to be a special case returning async_not_supported).
  const r = await runUserCode("async function f(){ return 1; }", []);
  expect(!r.ok && r.error === "forbidden_import",
         "top-level async function rejected by block-list");
}
{
  // Async function EXPRESSION inside the user's outer sync function — this
  // was the architect's fourth-round attack. Without the `\basync\b` regex
  // it would slip past the top-level `async function` check, and when
  // called would return a Promise whose microtask continuation runs
  // AFTER the runtime prototype barrier is uninstalled.
  const code = "function f(){ return (async () => { return 1; })(); }";
  const r = await runUserCode(code, []);
  expect(!r.ok && r.error === "forbidden_import",
         "async arrow IIFE rejected by block-list (microtask-escape attack)");
}
{
  const code = "function f(){ const g = async function(){ return 1; }; return g(); }";
  const r = await runUserCode(code, []);
  expect(!r.ok && r.error === "forbidden_import",
         "async function expression rejected by block-list");
}
{
  const code = "function f(){ return (async () => { await 0; const c='con'+'structor'; return ({}[c][c])('return 1')(); })(); }";
  const r = await runUserCode(code, []);
  expect(!r.ok && r.error === "forbidden_import",
         "FULL microtask-escape chain (async + await + dynamic-assembly + Function ctor) rejected at parse time");
}
// Real CPU cap — AST instrumentation interrupts synchronous infinite
// loops by throwing from an injected check. These actually busy-loop;
// each must terminate well under a 3 s wall-clock budget.
{
  const t0 = Date.now();
  const r = await runUserCode("function f(){ while(true){} }", null, { timeoutMs: 100 });
  const wall = Date.now() - t0;
  expect(!r.ok && r.error === "timeout", `infinite while(true) preempted (got ${r.error})`);
  expect(wall < 3000, `infinite while(true) killed within 3s (took ${wall}ms)`);
}
{
  const t0 = Date.now();
  const r = await runUserCode("function f(){ for(;;){} }", null, { timeoutMs: 100 });
  const wall = Date.now() - t0;
  expect(!r.ok && r.error === "timeout", `infinite for(;;) preempted (got ${r.error})`);
  expect(wall < 3000, `infinite for(;;) killed within 3s (took ${wall}ms)`);
}
{
  // Single-statement (braceless) loop body must still get the check.
  const t0 = Date.now();
  const r = await runUserCode("function f(){ let i=0; while(true) i++; return i; }", null, { timeoutMs: 100 });
  const wall = Date.now() - t0;
  expect(!r.ok && r.error === "timeout", `braceless while body preempted (got ${r.error})`);
  expect(wall < 3000, `braceless while body killed within 3s (took ${wall}ms)`);
}
{
  // Infinite recursion: function-entry check fires before each call.
  const t0 = Date.now();
  const r = await runUserCode("function g(x){ return g(x); } function f(){ return g(0); }", null, { timeoutMs: 100 });
  const wall = Date.now() - t0;
  expect(!r.ok && (r.error === "timeout" || r.error === "runtime_error"),
         `infinite recursion terminated (got ${r.error})`);
  expect(wall < 3000, `infinite recursion killed within 3s (took ${wall}ms)`);
}
{
  // No false positive: a fast function is NOT misreported as timeout.
  const r = await runUserCode("function f(arr){ return arr.length; }", [1, 2, 3]);
  expect(r.ok && r.result === 3, "fast function not falsely timed out");
}
{
  // Custom timeoutMs is honoured by the AST check.
  const t0 = Date.now();
  const r = await runUserCode("function f(){ while(true){} }", null, { timeoutMs: 10 });
  const wall = Date.now() - t0;
  expect(!r.ok && r.error === "timeout", `custom 10ms cap fires (got ${r.error})`);
  expect(wall < 1000, `10ms cap kills within 1s (took ${wall}ms)`);
}

// E2E through the sandbox HTTP boundary — proves the cap holds across
// the same boundary production uses, not only the in-process path.
{
  const sandboxModule = await import("../../worker-sandbox/src/index.js");
  const env = makeEnv({
    SANDBOX: { fetch: (url, init) => sandboxModule.default.fetch(new Request(url, init)) },
  });
  const t0 = Date.now();
  const req = new Request("http://x/api/analyze/algo", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code: "function loop(){ while(true){} }", sampleInput: [1, 2, 3] }),
  });
  const res = await analyzeAlgoHandler(req, env);
  const wall = Date.now() - t0;
  const body = await res.json();
  expect(res.status === 400 && body.error === "timeout",
         `infinite loop killed via sandbox service binding (status=${res.status} error=${body.error})`);
  expect(wall < 5000, `sandbox-boundary kill within 5s (took ${wall}ms)`);
}

// Caller-supplied timeoutMs MUST NOT bypass the sandbox's hardcoded 1s policy.
{
  const sandboxModule = await import("../../worker-sandbox/src/index.js");
  const t0 = Date.now();
  const res = await sandboxModule.default.fetch(new Request("http://sandbox/run", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code: "function loop(){ while(true){} }", input: null, timeoutMs: 60000 }),
  }));
  const wall = Date.now() - t0;
  const body = await res.json();
  expect(!body.ok && body.error === "timeout",
         `sandbox ignores caller-supplied timeoutMs override (got ${body.error})`);
  expect(wall < 3000, `sandbox enforces own 1s cap regardless of body.timeoutMs (took ${wall}ms)`);
}
{
  // Result that can't be JSON-serialised (BigInt) → result_not_serializable
  const r = await runUserCode("function f(){ return 1n; }", []);
  expect(!r.ok && r.error === "result_not_serializable",
         "BigInt result → result_not_serializable");
}

console.log("\nBig-O inference\n");

{
  const r = inferBigO([{ n: 100, ms: 1 }, { n: 1000, ms: 10 }, { n: 10000, ms: 100 }]);
  expect(r.label === "O(n)" && r.exponent !== null,
         "perfect linear scaling → O(n)");
}
{
  const r = inferBigO([{ n: 100, ms: 1 }, { n: 1000, ms: 100 }, { n: 10000, ms: 10000 }]);
  expect(r.label === "O(n²)", "quadratic scaling (1, 100, 10000) → O(n²)");
}
{
  const r = inferBigO([{ n: 100, ms: 5 }, { n: 1000, ms: 5 }, { n: 10000, ms: 5 }]);
  expect(r.label === "O(1)", "constant timing → O(1)");
}
{
  const r = inferBigO([{ n: 100, ms: 1 }, { n: 1000, ms: 1000 }, { n: 10000, ms: 1000000 }]);
  expect(r.label === "O(n³)", "cubic scaling → O(n³)");
}
{
  const r = inferBigO([{ n: 100, ms: 0 }, { n: 1000, ms: 0 }, { n: 10000, ms: 0 }]);
  expect(r.label === "O(1)" && /noise/i.test(r.reason || ""),
         "all-zero times at large n → O(1) with noise reason");
}
{
  const r = inferBigO([{ n: 100, ms: 1 }]);
  expect(r.label === "unknown", "single point → unknown");
}
{
  const r = inferBigO([]);
  expect(r.label === "unknown", "empty input → unknown");
}

console.log("\nLLM client — stub fallback + reply parsing\n");

{
  // No OPENAI_API_KEY → stub
  const s = await getRefactorSuggestion({ code: "function f(){}", bigO: "O(n²)", ms: 5 }, {});
  expect(s.provider === "stub" && /OPENAI_API_KEY/.test(s.text),
         "no API key → stub suggestion mentions OPENAI_API_KEY");
  expect(s.code === null, "stub suggestion has no code block");
}
{
  // bigO=unknown → stub talks about unmeasurable complexity
  const s = await getRefactorSuggestion({ code: "function f(){}", bigO: "unknown", ms: 5 }, {});
  expect(s.provider === "stub" && /could not measure/i.test(s.text),
         "bigO=unknown → stub explains complexity unmeasurable");
}
{
  // Mocked OpenAI fetch → success
  const mockFetch = async (url, init) => {
    return new Response(JSON.stringify({
      choices: [{ message: {
        content: "Use a Set to deduplicate in O(n).\n\n```js\nfunction findDuplicates(items){\n  const seen = new Set();\n  return items.filter(x => seen.has(x) ? true : (seen.add(x), false));\n}\n```\n",
      }}],
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const env = { OPENAI_API_KEY: "sk-test-mock", OPENAI_FETCH: mockFetch };
  const s = await getRefactorSuggestion({ code: "function f(){}", bigO: "O(n²)", ms: 5 }, env);
  expect(s.provider === "openai", "successful OpenAI call → provider:openai");
  expect(s.code && /seen\.has/.test(s.code), "code block extracted from fenced reply");
  expect(s.text && /Set to deduplicate/.test(s.text), "prose preserved (fences stripped)");
  expect(!/```/.test(s.text), "fenced blocks stripped from prose section");
}
{
  // OpenAI returns 500 → falls back to stub with HTTP-status hint
  const mockFetch = async () => new Response("oops", { status: 500 });
  const env = { OPENAI_API_KEY: "sk-test-mock", OPENAI_FETCH: mockFetch };
  const s = await getRefactorSuggestion({ code: "function f(){}", bigO: "O(n)", ms: 5 }, env);
  expect(s.provider === "stub" && /500/.test(s.text),
         "OpenAI HTTP 500 → stub fallback with status hint");
}
{
  // Pure parser test
  const r = parseLlmReply("Use a hash map.\n```js\nfunction g(){return 1;}\n```");
  expect(r.code === "function g(){return 1;}" && /hash map/.test(r.text),
         "parseLlmReply extracts code block + prose");
}
{
  const r = parseLlmReply("No code here, just thoughts.");
  expect(r.code === null, "parseLlmReply returns code:null when no fenced block");
}

console.log("\nHTTP layer — new {code, sampleInput} sandbox path\n");

// Happy-path end-to-end through the handler.
{
  const env = makeEnv();
  const req = new Request("http://x/api/analyze/algo", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      code: "function pickBig(arr){ return arr.filter(x => x > 50); }",
      sampleInput: [10, 20, 60, 70, 80],
    }),
  });
  const res = await analyzeAlgoHandler(req, env);
  const body = await res.json();
  expect(res.status === 200, "{code, sampleInput} → 200");
  expect(typeof body.wallTimeMs === "number" && body.wallTimeMs >= 0,
         "response includes wallTimeMs");
  expect(body.bigO && typeof body.bigO.label === "string",
         "response includes bigO.label");
  expect(Array.isArray(body.bigO.points) && body.bigO.points.length === 3,
         "Big-O probe ran at all 3 sizes (100/1000/10000)");
  expect(body.suggestion && body.suggestion.provider === "stub",
         "no API key → suggestion provider is 'stub'");
  expect(body.sandbox === "in_process",
         "without SANDBOX binding handler reports in_process execution");
  expect(Array.isArray(body.sampleResult) && body.sampleResult.length === 3,
         "sampleResult is the array returned by pickBig");
}

// Validation: missing code
{
  const req = new Request("http://x/api/analyze/algo", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sampleInput: [1, 2] }),
  });
  const res = await analyzeAlgoHandler(req, makeEnv());
  const body = await res.json();
  // Without `code` we fall through to the legacy validator → invalid_payload
  expect(res.status === 400 && body.error === "invalid_payload",
         "{sampleInput} with no code → 400 invalid_payload (falls to legacy path)");
}

// Forbidden import surfaces as a 400 with the sandbox error
{
  const req = new Request("http://x/api/analyze/algo", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      code: "function f(){ return require('fs'); }",
      sampleInput: [1, 2, 3],
    }),
  });
  const res = await analyzeAlgoHandler(req, makeEnv());
  const body = await res.json();
  expect(res.status === 400 && body.error === "forbidden_import",
         "user code using require() → 400 forbidden_import surfaced from sandbox");
}

// Compile error in user code → 400 compile_error
{
  const req = new Request("http://x/api/analyze/algo", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      code: "function f({ ",
      sampleInput: null,
    }),
  });
  const res = await analyzeAlgoHandler(req, makeEnv());
  const body = await res.json();
  expect(res.status === 400 && body.error === "compile_error",
         "broken syntax in user code → 400 compile_error");
}

// Sample input that the function can't handle at scale → Big-O probe degrades
// to "unknown" with a note, but the sample run still succeeds (the function
// works fine on the user's small input).
{
  const env = makeEnv();
  const req = new Request("http://x/api/analyze/algo", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      code: "function f(obj){ return obj.x + obj.y; }",
      sampleInput: { x: 1, y: 2 },
    }),
  });
  const res = await analyzeAlgoHandler(req, env);
  const body = await res.json();
  expect(res.status === 200 && body.sampleResult === 3,
         "object input — sample run succeeds with the user's actual input");
  expect(body.bigO.label === "unknown" && /not an array or number/.test(body.bigO.reason || ""),
         "object input → Big-O probe skipped with explanatory reason");
}

// SANDBOX service binding is preferred when present.
{
  let captured = null;
  const env = makeEnv({
    SANDBOX: {
      async fetch(_url, init) {
        captured = JSON.parse(init.body);
        return new Response(JSON.stringify({
          ok: true, ms: 7, heapBytes: 12, result: ["mocked"],
        }), { status: 200, headers: { "content-type": "application/json" } });
      },
    },
  });
  const req = new Request("http://x/api/analyze/algo", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      code: "function f(arr){ return arr.length; }",
      sampleInput: [1, 2, 3],
    }),
  });
  const res = await analyzeAlgoHandler(req, env);
  const body = await res.json();
  expect(body.sandbox === "service_binding",
         "SANDBOX present → handler routes through the service binding");
  expect(body.wallTimeMs === 7 && body.heapBytes === 12,
         "service-binding response values flow through to the handler");
  expect(captured && captured.code && captured.input,
         "service-binding receives the {code, input} body");
}

// LLM mocked end-to-end through the handler — verifies we plumb
// env.OPENAI_FETCH through to the suggestion call.
{
  const mockFetch = async () => new Response(JSON.stringify({
    choices: [{ message: {
      content: "Use a hash set.\n```js\nfunction findDuplicates(items){return [...new Set(items)];}\n```",
    }}],
  }), { status: 200, headers: { "content-type": "application/json" } });
  const env = makeEnv({ OPENAI_API_KEY: "sk-test", OPENAI_FETCH: mockFetch });
  const req = new Request("http://x/api/analyze/algo", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      code: "function findDuplicates(items){ const o=[]; for(const a of items) for(const b of items) if(a===b) o.push(a); return o; }",
      sampleInput: [1, 2, 3, 1],
    }),
  });
  const res = await analyzeAlgoHandler(req, env);
  const body = await res.json();
  expect(body.suggestion.provider === "openai",
         "with OPENAI_API_KEY + mocked fetch → suggestion.provider === 'openai'");
  expect(body.suggestion.code && /new Set/.test(body.suggestion.code),
         "rewritten function extracted from mocked LLM reply");
}

// End-to-end through the router with auth.
{
  const env = makeEnv();
  const token = await issueJWT(env, "user_1", "alice@example.com", "active");
  const req = new Request("http://x/api/analyze/algo", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "Origin": "http://localhost:5000",
      "Authorization": `Bearer ${token}`,
    },
    body: JSON.stringify({
      code: "function sum(arr){ let s=0; for(const x of arr) s+=x; return s; }",
      sampleInput: [1, 2, 3, 4, 5],
    }),
  });
  const res = await worker.fetch(req, env, {});
  const body = await res.json();
  expect(res.status === 200 && body.sampleResult === 15,
         "router → sandbox path: signed-in user gets sampleResult");
  expect(body.bigO && body.bigO.points && body.bigO.points.length >= 2,
         "router → sandbox path: Big-O probe ran");
}

console.log();
if (failures === 0) console.log("All algo-analyzer tests passed.");
else { console.log(`${failures} test(s) failed.`); process.exit(1); }
