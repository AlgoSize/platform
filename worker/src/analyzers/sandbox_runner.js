// Sandbox runner — shared by the main Worker and the sibling
// `algosize-sandbox` Worker (`worker-sandbox/src/index.js`).
//
// Threat model: user code is HOSTILE. It tries to (a) reach the network,
// (b) burn CPU forever, or (c) escape into the host runtime via the
// prototype chain. Defense in depth, in order of execution:
//
//   1. Source regex block-list — rejects mention of forbidden identifiers
//      and \uXXXX/\xXX source escapes that would smuggle them past the
//      word-boundary checks.
//   2. Lexical shadowing — `const fetch = undefined; …` prepended to the
//      compiled body so any reference resolves to undefined even if a
//      future regex update misses something.
//   3. AST timeout instrumentation — acorn parses the source and we
//      inject a deadline check at every loop body and function entry.
//      The check throws synchronously; V8 unwinds the stack. This is
//      the actual hard CPU cap. (Without this an infinite `while(true)`
//      runs until Cloudflare's per-request budget kills the Worker.)
//   4. Runtime prototype-chain barrier — Function.prototype.constructor
//      (and async/generator variants) are replaced with a throwing thunk
//      across the whole user-code window (call + thenable check + JSON
//      stringify), then restored in finally. Defeats every dynamic
//      `({}).constructor.constructor("…")()` escape, including those
//      assembled from runtime strings the regex layer cannot detect.
//   5. Sibling-Worker isolation — when SANDBOX is bound, all of the
//      above runs inside `algosize-sandbox`, a separate Worker with
//      ZERO privileged bindings (no KV, no D1, no secrets). Any escape
//      that reaches fetch sees no user data or signing keys.
//
// The keyword block-list (async/await/Promise/constructor/Function/eval/
// Reflect/Proxy/__proto__/setTimeout/queueMicrotask/…) is INTENTIONAL
// product policy: each entry corresponds to a real escape vector found
// during review (async = microtask continuation runs after barrier
// uninstall; constructor = prototype-chain Function escape; Promise =
// same). Removing any one of them re-opens that vector. Algorithms
// targeted by this product (sort/search/math) do not need them.

import * as acorn from "acorn";

const FORBIDDEN_PATTERNS = [
  { re: /\brequire\s*\(/,                                       label: "require()" },
  { re: /\bimport\s*\(/,                                        label: "import()" },
  { re: /^\s*import\s+(?:[\w*{}\s,]+\s+from\s+)?['"][^'"]+['"]/m, label: "import" },
  { re: /\bfetch\s*\(/,                                         label: "fetch" },
  { re: /\bXMLHttpRequest\b/,                                   label: "XMLHttpRequest" },
  { re: /\bWebSocket\b/,                                        label: "WebSocket" },
  { re: /\bnavigator\b/,                                        label: "navigator" },
  { re: /\bself\b/,                                             label: "self" },
  { re: /\bwindow\b/,                                           label: "window" },
  { re: /\bglobalThis\b/,                                       label: "globalThis" },
  { re: /\bprocess\b/,                                          label: "process" },
  { re: /\bcaches\b/,                                           label: "caches" },
  { re: /\bcrypto\b/,                                           label: "crypto" },
  { re: /\bconstructor\b/,                                      label: "constructor" },
  { re: /\b__proto__\b/,                                        label: "__proto__" },
  { re: /\bReflect\b/,                                          label: "Reflect" },
  { re: /\bProxy\b/,                                            label: "Proxy" },
  { re: /\beval\s*\(/,                                          label: "eval" },
  { re: /\bFunction\s*\(/,                                      label: "Function ctor" },
  { re: /\bsetTimeout\b/,                                       label: "setTimeout" },
  { re: /\bsetInterval\b/,                                      label: "setInterval" },
  { re: /\bqueueMicrotask\b/,                                   label: "queueMicrotask" },
  { re: /\bPromise\b/,                                          label: "Promise" },
  { re: /\baddEventListener\b/,                                 label: "addEventListener" },
  { re: /\basync\b/,                                            label: "async" },
  { re: /\bawait\b/,                                            label: "await" },
  { re: /\\u[0-9a-fA-F]{4}/,                                    label: "\\uXXXX escape" },
  { re: /\\u\{[0-9a-fA-F]+\}/,                                  label: "\\u{...} escape" },
  { re: /\\x[0-9a-fA-F]{2}/,                                    label: "\\xXX escape" },
  { re: /\b(?:fs|net|child_process|http|https|os)\s*\./,        label: "node stdlib" },
];

const SHADOWED_GLOBALS = [
  "fetch", "XMLHttpRequest", "WebSocket", "navigator",
  "self", "window", "globalThis", "process", "caches", "crypto",
  "Function", "setTimeout", "setInterval", "queueMicrotask",
  "Promise", "addEventListener", "MessageChannel", "BroadcastChannel",
];

const MAX_CODE_BYTES = 50 * 1024;
const MAX_RESULT_BYTES = 100 * 1024;
const DEFAULT_TIMEOUT_MS = 1000;

// Names injected as outer-Function args. Random suffix so user code is
// extremely unlikely to declare a colliding identifier; even if it
// tried, the inner IIFE wrapper means user `let`/`const` cannot shadow
// the outer-arg names anyway.
const DEADLINE_NAME = "__algosize_deadline_5b3a2c__";
const CHECK_NAME    = "__algosize_check_5b3a2c__";

/**
 * Run user-supplied JS function source against `input`.
 *
 * @param {string} code      Top-level function declaration.
 * @param {*}      input     JSON-serialisable arg.
 * @param {{now?:()=>number, timeoutMs?:number}} [opts]
 * @returns {Promise<object>} `{ok:true, ms, heapBytes, result}` or `{ok:false, error, message?, ms?}`
 */
export async function runUserCode(code, input, opts = {}) {
  if (typeof code !== "string")  return { ok: false, error: "invalid_code", message: "code must be a string" };
  if (!code.trim())              return { ok: false, error: "invalid_code", message: "code must not be empty" };
  if (code.length > MAX_CODE_BYTES)
    return { ok: false, error: "code_too_large", message: `code must be ≤ ${MAX_CODE_BYTES} bytes` };

  for (const { re, label } of FORBIDDEN_PATTERNS) {
    if (re.test(code)) return { ok: false, error: "forbidden_import", message: `forbidden API: ${label}` };
  }

  const fnNameMatch = /^\s*function\s+([A-Za-z_$][\w$]*)\s*\(/m.exec(code);
  if (!fnNameMatch) {
    return {
      ok: false, error: "no_function_declaration",
      message: "code must declare a top-level function: `function name(input) { ... }`",
    };
  }
  const fnName = fnNameMatch[1];

  // AST timeout instrumentation (defense layer 3).
  let instrumented;
  try {
    instrumented = instrumentForTimeout(code);
  } catch (err) {
    return { ok: false, error: "compile_error", message: String(err && err.message || err) };
  }

  // Compile with acceptor params for deadline + check fn. User code lives
  // inside an IIFE so its top-level `let`/`const` cannot collide with the
  // outer arg names (each call gets a fresh inner scope).
  const shadowPrologue = SHADOWED_GLOBALS.map((n) => `const ${n} = undefined;`).join("\n");
  let compiled;
  try {
    compiled = new Function(
      "input", DEADLINE_NAME, CHECK_NAME,
      `"use strict";\n${shadowPrologue}\nreturn (function(){\n${instrumented}\nreturn ${fnName}(input);\n})();`,
    );
  } catch (err) {
    return { ok: false, error: "compile_error", message: String(err && err.message || err) };
  }

  const now = opts.now || (typeof performance !== "undefined" ? () => performance.now() : () => Date.now());
  const timeoutMs = typeof opts.timeoutMs === "number" ? opts.timeoutMs : DEFAULT_TIMEOUT_MS;
  const start = now();
  const deadline = start + timeoutMs;
  const check = () => { if (now() >= deadline) throw new Error(`__algosize_timeout__:execution exceeded ${timeoutMs} ms`); };

  // Defense layer 4 — prototype-chain barrier kept installed across
  // call + thenable probe + JSON.stringify (each can run user code via
  // getters or toJSON), restored in finally.
  const protoBarrier = installPrototypeBarrier();
  let result, runtimeErr = null, isThenable = false, resultJson, serializeErr = null;
  try {
    try {
      result = compiled(input, deadline, check);
    } catch (err) { runtimeErr = err; }

    if (!runtimeErr) {
      try { isThenable = !!(result && typeof result.then === "function"); }
      catch (err) { runtimeErr = err; }
    }
    if (!runtimeErr && !isThenable) {
      try { resultJson = JSON.stringify(result === undefined ? null : result); }
      catch (err) { serializeErr = err; }
    }
  } finally {
    protoBarrier.uninstall();
  }

  const ms = now() - start;

  if (runtimeErr) {
    const msg = String(runtimeErr && runtimeErr.message || runtimeErr);
    if (msg.startsWith("__algosize_timeout__:")) {
      return { ok: false, error: "timeout", message: msg.slice("__algosize_timeout__:".length), ms };
    }
    return { ok: false, error: "runtime_error", message: msg, ms };
  }
  if (isThenable) {
    return { ok: false, error: "async_not_supported", message: "function returned a Promise; async not supported" };
  }
  if (ms > timeoutMs) {
    return { ok: false, error: "timeout", message: `execution exceeded ${timeoutMs} ms`, ms };
  }
  if (serializeErr) {
    return { ok: false, error: "result_not_serializable", message: String(serializeErr && serializeErr.message || serializeErr), ms };
  }

  let truncated = false;
  if (resultJson && resultJson.length > MAX_RESULT_BYTES) {
    resultJson = resultJson.slice(0, MAX_RESULT_BYTES);
    truncated = true;
  }
  const heapBytes = resultJson ? resultJson.length : 0;
  return { ok: true, ms, heapBytes, result: truncated ? null : safeParse(resultJson), truncated };
}

function safeParse(s) { try { return JSON.parse(s); } catch { return null; } }

// AST instrumentation: parse the user source and inject a deadline-check
// call at the entry of every function and every loop body. Three edit kinds:
//   - `insert`    — for an existing BlockStatement body of a function/loop:
//                   zero-width insert of `check();` after the `{`.
//   - `wrap-stmt` — for a braceless single-statement loop body
//                   (`while (x) f()`): wrap as `{ check; f() }`.
//   - `wrap-expr` — for an arrow function with an expression body
//                   (`x => x+1`):    wrap as `{ check; return (x+1); }`.
//
// Edits can NEST (e.g. a braceless `for` whose body is another braceless
// `for`). To handle nesting correctly we build an edit tree (parent =
// smallest enclosing edit) and render recursively: each edit's inner
// text is built from the already-transformed text of its children.
// String-splicing in reverse order does NOT work for overlapping edits
// because the outer edit's pre-computed `replacement` would still
// contain the original (un-instrumented) inner source.
export function instrumentForTimeout(source) {
  const ast = acorn.parse(source, { ecmaVersion: 2022, sourceType: "script", allowReturnOutsideFunction: false });
  const checkCall = `${CHECK_NAME}();`;
  const edits = [];

  walk(ast, (node) => {
    if (node.type === "FunctionDeclaration" || node.type === "FunctionExpression") {
      if (node.body && node.body.type === "BlockStatement") {
        edits.push({ start: node.body.start + 1, end: node.body.start + 1, kind: "insert" });
      }
    } else if (node.type === "ArrowFunctionExpression") {
      if (node.body.type === "BlockStatement") {
        edits.push({ start: node.body.start + 1, end: node.body.start + 1, kind: "insert" });
      } else {
        edits.push({ start: node.body.start, end: node.body.end, kind: "wrap-expr" });
      }
    } else if (node.type === "WhileStatement" || node.type === "DoWhileStatement"
            || node.type === "ForStatement"   || node.type === "ForInStatement" || node.type === "ForOfStatement") {
      if (node.body.type === "BlockStatement") {
        edits.push({ start: node.body.start + 1, end: node.body.start + 1, kind: "insert" });
      } else {
        edits.push({ start: node.body.start, end: node.body.end, kind: "wrap-stmt" });
      }
    }
  });

  // Build edit tree: each edit's parent is the smallest enclosing edit.
  // Insert edits are zero-width, so they're never parents and never enclosed
  // in the strict-containment sense; treat them as point children.
  for (const e of edits) e.children = [];
  for (const e of edits) {
    let parent = null, parentSize = Infinity;
    for (const p of edits) {
      if (p === e) continue;
      // p contains e iff p.start <= e.start AND p.end >= e.end AND at least one
      // strict inequality (so a zero-width insert at the same point doesn't
      // "contain" itself or another zero-width edit).
      if (p.start <= e.start && p.end >= e.end && (p.start < e.start || p.end > e.end)) {
        const size = p.end - p.start;
        if (size < parentSize) { parent = p; parentSize = size; }
      }
    }
    if (parent) parent.children.push(e);
  }
  const roots = edits.filter((e) => !edits.some((p) =>
    p !== e && p.start <= e.start && p.end >= e.end && (p.start < e.start || p.end > e.end),
  ));

  return renderRange(0, source.length, roots);

  function renderRange(rangeStart, rangeEnd, list) {
    const sorted = list.slice().sort((a, b) => a.start - b.start);
    let out = "";
    let p = rangeStart;
    for (const e of sorted) {
      out += source.slice(p, e.start);
      out += renderEdit(e);
      p = e.end;
    }
    out += source.slice(p, rangeEnd);
    return out;
  }

  function renderEdit(e) {
    if (e.kind === "insert") return checkCall; // zero-width, no children
    const inner = renderRange(e.start, e.end, e.children);
    if (e.kind === "wrap-stmt") return `{ ${checkCall} ${inner} }`;
    if (e.kind === "wrap-expr") return `{ ${checkCall} return (${inner}); }`;
    return inner;
  }
}

function walk(node, visit, parent = null) {
  if (!node || typeof node.type !== "string") return;
  visit(node, parent);
  for (const key of Object.keys(node)) {
    if (key === "loc" || key === "range" || key === "start" || key === "end" || key === "type") continue;
    const child = node[key];
    if (Array.isArray(child)) {
      for (const c of child) if (c && typeof c.type === "string") walk(c, visit, node);
    } else if (child && typeof child.type === "string") {
      walk(child, visit, node);
    }
  }
}

function installPrototypeBarrier() {
  const targets = [];
  function patch(proto) {
    if (!proto || (typeof proto !== "object" && typeof proto !== "function")) return;
    const desc = Object.getOwnPropertyDescriptor(proto, "constructor");
    if (!desc || !("value" in desc)) return;
    Object.defineProperty(proto, "constructor", {
      value: function blockedConstructor() { throw new Error("Function constructor access blocked by sandbox"); },
      writable: desc.writable, configurable: true, enumerable: desc.enumerable,
    });
    targets.push({ proto, desc });
  }
  patch(Function.prototype);
  try { patch(Object.getPrototypeOf(function*(){})); } catch {}
  try { patch(Object.getPrototypeOf(async function(){})); } catch {}
  try { patch(Object.getPrototypeOf(async function*(){})); } catch {}

  let installed = true;
  return {
    uninstall() {
      if (!installed) return;
      installed = false;
      for (const t of targets) Object.defineProperty(t.proto, "constructor", t.desc);
    },
  };
}

export const _internal = {
  FORBIDDEN_PATTERNS, SHADOWED_GLOBALS, MAX_CODE_BYTES, MAX_RESULT_BYTES,
  DEFAULT_TIMEOUT_MS, installPrototypeBarrier, instrumentForTimeout,
};
