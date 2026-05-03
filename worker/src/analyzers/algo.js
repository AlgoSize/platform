// Algorithm optimizer — pure rule engine.
//
// Same architectural shape as analyzers/cost.js and analyzers/vuln.js:
// dependency-free, pure functions, no HTTP/KV/fetch — so the body of
// analyzeAlgo can later be swapped for an LLM-backed implementation
// without changing the endpoint contract.
//
// Public surface:
//   validateAlgoInput(payload) -> { ok: true, value } | { ok: false, error, message }
//   analyzeAlgo(input)         -> success | unknown
//
// Success shape:
//   { currentComplexity: string,
//     suggestions: [{ type, line, description, recommendation }],
//     optimizedExample: string }
//
// Unknown shape (no detector fired — task spec calls this "honest fallback"):
//   { currentComplexity: "unknown", reason: string }
//
// MVP scope: JavaScript / TypeScript only. We make a token attempt at TS
// (same lexical shape as JS) and explicitly bail on other languages with
// an "unknown" response rather than fabricating advice.


// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

const MAX_BYTES = 100 * 1024;      // 100 KB UTF-8 — algorithms are usually small
const MAX_LOOPS = 200;             // ceiling on tracked loop anchors
const MAX_FUNCTIONS = 200;         // ceiling on tracked function declarations

const TEXT_ENCODER = new TextEncoder();
const byteLength = (s) => TEXT_ENCODER.encode(s).length;


// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const SUPPORTED_LANGS = new Set(["javascript", "js", "typescript", "ts"]);

/**
 * Accepts: { source: string, language?: string }
 * Returns canonical { source, language } on success. Language is normalized
 * to lower-case; unsupported languages are accepted at the validation layer
 * and surfaced as an "unknown" complexity by the analyzer (so the caller
 * still gets a 200 with a clear reason instead of a 400).
 */
export function validateAlgoInput(payload) {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return { ok: false, error: "invalid_payload", message: "request body must be a JSON object" };
  }
  if (typeof payload.source !== "string") {
    return { ok: false, error: "invalid_payload", message: "`source` (string) is required" };
  }
  if (payload.source.trim() === "") {
    return { ok: false, error: "invalid_payload", message: "`source` must not be empty" };
  }
  if (byteLength(payload.source) > MAX_BYTES) {
    return { ok: false, error: "source_too_large", message: `source must be at most ${MAX_BYTES} bytes (UTF-8)` };
  }
  let language = "javascript";
  if (payload.language !== undefined) {
    if (typeof payload.language !== "string") {
      return { ok: false, error: "invalid_payload", message: "`language` must be a string when provided" };
    }
    language = payload.language.trim().toLowerCase();
    if (language === "") language = "javascript";
  }
  return { ok: true, value: { source: payload.source, language } };
}


// ---------------------------------------------------------------------------
// Lexical pre-pass — strip strings and comments to spaces
// ---------------------------------------------------------------------------
//
// Every detector below runs over the stripped output, NOT the raw source.
// This avoids two whole classes of false positives:
//   - "for (let i..." mentioned inside a string or comment treated as a loop
//   - method names mentioned in docs ("call .includes(x)") treated as calls
//
// Newlines are preserved character-by-character so line numbers stay aligned
// with the original source. Other characters inside strings/comments are
// replaced with a single space so column offsets also stay aligned (matters
// for the brace-matching helpers).

function stripStringsAndComments(source) {
  let out = "";
  let i = 0;
  const n = source.length;

  while (i < n) {
    const c = source[i];
    const next = source[i + 1];

    // Block comment: /* ... */
    if (c === "/" && next === "*") {
      out += "  ";
      i += 2;
      while (i < n && !(source[i] === "*" && source[i + 1] === "/")) {
        out += source[i] === "\n" ? "\n" : " ";
        i++;
      }
      if (i < n - 1) { out += "  "; i += 2; }
      continue;
    }

    // Line comment: // ...
    if (c === "/" && next === "/") {
      while (i < n && source[i] !== "\n") { out += " "; i++; }
      continue;
    }

    // String literals and template literals — blank everything inside.
    // Template ${expr} content is also blanked (rare to nest a loop or
    // recursive call inside an interpolation — accepted false-negative).
    if (c === '"' || c === "'" || c === "`") {
      const quote = c;
      out += " ";
      i++;
      while (i < n && source[i] !== quote) {
        if (source[i] === "\\" && i + 1 < n) {
          // Skip escape pair, preserving newline if any.
          out += source[i + 1] === "\n" ? " \n" : "  ";
          i += 2;
          continue;
        }
        out += source[i] === "\n" ? "\n" : " ";
        i++;
      }
      if (i < n) { out += " "; i++; }
      continue;
    }

    out += c;
    i++;
  }
  return out;
}


// ---------------------------------------------------------------------------
// Brace / paren / line helpers
// ---------------------------------------------------------------------------

function findMatching(src, startIdx, open, close) {
  let depth = 0;
  for (let i = startIdx; i < src.length; i++) {
    if (src[i] === open) depth++;
    else if (src[i] === close) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function nextNonWs(src, i) {
  while (i < src.length && /\s/.test(src[i])) i++;
  return i;
}

function lineOf(src, idx) {
  // 1-indexed line number for character position `idx`.
  let line = 1;
  const limit = Math.min(idx, src.length);
  for (let i = 0; i < limit; i++) if (src[i] === "\n") line++;
  return line;
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}


// ---------------------------------------------------------------------------
// Loop discovery
// ---------------------------------------------------------------------------
//
// We collect every loop "anchor" with:
//   - line       : 1-indexed source line of the loop keyword
//   - bodyStart  : char offset of the first char inside the body
//   - bodyEnd    : char offset of the closing delimiter (exclusive)
//   - array      : iterated array name if knowable (string), else null
//   - kind       : "for-index" | "for-of" | "for-in" | "for-other" |
//                  "while" | "do-while" | "method"
//
// For brace-bodied loops (for/while/do-while), the body is { ... }.
// For method-form loops (arr.forEach(cb)), the body is the callback's
// argument list — i.e. the span between the opening `(` and matching `)`.
// That's a coarse approximation, but it's good enough to detect "another
// loop or .includes() call appears anywhere inside this callback".

// Init expression is any non-`;` text — the inner loop in
// `for (let j = i+1; j < arr.length; j++)` should match just as readily as
// the outer `for (let i = 0; ...)`. The discriminator is the `< ARR.length`
// bound, not the init.
const FOR_INDEX_RE = /\bfor\s*\(\s*(?:let|var|const)?\s*[\w$]+\s*=\s*[^;]+?;\s*[\w$]+\s*<\s*([\w$.]+)\.length\s*;/g;
const FOR_OF_RE    = /\bfor\s*\(\s*(?:let|var|const)\s+[\w$]+\s+of\s+([\w$.]+)\s*\)/g;
const FOR_IN_RE    = /\bfor\s*\(\s*(?:let|var|const)\s+[\w$]+\s+in\s+([\w$.]+)\s*\)/g;
const FOR_OTHER_RE = /\bfor\s*\(/g;
const WHILE_RE     = /\bwhile\s*\(/g;
const DO_RE        = /\bdo\s*\{/g;
const METHOD_RE    = /\b([\w$][\w$.]*)\.(forEach|map|filter|reduce|some|every|find|findIndex|flatMap)\s*\(/g;

function findLoops(code) {
  const loops = [];
  const pushBraceBodied = (kind, headerStart, array) => {
    // do-while: header is `do { ... } while (...)` — body brace is right after `do`.
    if (kind === "do-while") {
      const braceIdx = code.indexOf("{", headerStart);
      if (braceIdx < 0) return;
      const bodyEnd = findMatching(code, braceIdx, "{", "}");
      if (bodyEnd < 0) return;
      loops.push({ kind, array, line: lineOf(code, headerStart), bodyStart: braceIdx + 1, bodyEnd });
      return;
    }

    const parenStart = code.indexOf("(", headerStart);
    if (parenStart < 0) return;
    const parenEnd = findMatching(code, parenStart, "(", ")");
    if (parenEnd < 0) return;
    const afterParen = nextNonWs(code, parenEnd + 1);

    if (code[afterParen] === "{") {
      const bodyEnd = findMatching(code, afterParen, "{", "}");
      if (bodyEnd < 0) return;
      loops.push({ kind, array, line: lineOf(code, headerStart), bodyStart: afterParen + 1, bodyEnd });
      return;
    }

    // Single-statement body (no braces). Body span runs from after the
    // header's `)` up to the matching statement terminator at the same
    // brace/paren depth — usually the next `;`, but we also stop on a
    // closing brace that would mean we've left the surrounding block.
    // This catches the common `for (...) for (...) work();` and
    // `for (const x of arr) if (other.includes(x)) hits++;` patterns.
    let depth = 0, parenDepth = 0;
    let i = afterParen;
    for (; i < code.length; i++) {
      const c = code[i];
      if (c === "{") depth++;
      else if (c === "}") { if (depth === 0) break; depth--; }
      else if (c === "(") parenDepth++;
      else if (c === ")") { if (parenDepth === 0) break; parenDepth--; }
      else if (c === ";" && depth === 0 && parenDepth === 0) { break; }
    }
    if (i <= afterParen) return;
    loops.push({ kind, array, line: lineOf(code, headerStart), bodyStart: afterParen, bodyEnd: i });
  };

  const matchers = [
    { re: FOR_INDEX_RE, kind: "for-index", capture: 1 },
    { re: FOR_OF_RE,    kind: "for-of",    capture: 1 },
    { re: FOR_IN_RE,    kind: "for-in",    capture: 1 },
    { re: WHILE_RE,     kind: "while",     capture: null },
    { re: DO_RE,        kind: "do-while",  capture: null },
  ];
  for (const { re, kind, capture } of matchers) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(code)) !== null) {
      pushBraceBodied(kind, m.index, capture ? m[capture] : null);
      if (loops.length >= MAX_LOOPS) break;
    }
  }

  // FOR_OTHER catches `for (let i = 0; i < n; i++)` where the bound is not
  // `arr.length`. We only push it if it's not already covered by FOR_INDEX
  // (same start position) — checked via `array === null && for-other` kind.
  FOR_OTHER_RE.lastIndex = 0;
  let m;
  while ((m = FOR_OTHER_RE.exec(code)) !== null) {
    const already = loops.some(l => l.line === lineOf(code, m.index) &&
                                    (l.kind === "for-index" || l.kind === "for-of" || l.kind === "for-in"));
    if (already) continue;
    pushBraceBodied("for-other", m.index, null);
    if (loops.length >= MAX_LOOPS) break;
  }

  // Method-form loops: arr.forEach(cb), arr.map(cb), etc.
  METHOD_RE.lastIndex = 0;
  while ((m = METHOD_RE.exec(code)) !== null) {
    const recv = m[1];
    const parenStart = m.index + m[0].length - 1;  // position of `(`
    const parenEnd = findMatching(code, parenStart, "(", ")");
    if (parenEnd < 0) continue;
    loops.push({
      kind: "method",
      array: recv,
      line: lineOf(code, m.index),
      bodyStart: parenStart + 1,
      bodyEnd: parenEnd,
    });
    if (loops.length >= MAX_LOOPS) break;
  }

  // Sort by bodyStart so nested-pair scanning is deterministic and short-
  // circuits cleanly when an inner loop's start is past the outer's end.
  loops.sort((a, b) => a.bodyStart - b.bodyStart);
  return loops;
}


// ---------------------------------------------------------------------------
// Function discovery (for recursion detection)
// ---------------------------------------------------------------------------
//
// We collect:
//   - function NAME(...) { ... }
//   - const/let/var NAME = (...) => { ... }
//   - const/let/var NAME = function (...) { ... }
//
// Arrow functions with an expression body (no braces, e.g. `x => x*2`) are
// rare for recursion patterns and skipped — accepted false-negative.

const FUNC_DECL_RE   = /\bfunction\s+([A-Za-z_$][\w$]*)\s*\(/g;
const CONST_FUNC_RE  = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?function\b[^(]*\(/g;
const ARROW_FUNC_RE  = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(?[^)=]*\)?\s*=>\s*\{/g;

function findFunctions(code) {
  const funcs = [];

  const pushFromOpenParen = (name, headerStart) => {
    const parenStart = code.indexOf("(", headerStart);
    if (parenStart < 0) return;
    const parenEnd = findMatching(code, parenStart, "(", ")");
    if (parenEnd < 0) return;
    const braceIdx = nextNonWs(code, parenEnd + 1);
    if (code[braceIdx] !== "{") return;
    const bodyEnd = findMatching(code, braceIdx, "{", "}");
    if (bodyEnd < 0) return;
    funcs.push({
      name,
      line: lineOf(code, headerStart),
      bodyStart: braceIdx + 1,
      bodyEnd,
    });
  };

  for (const re of [FUNC_DECL_RE, CONST_FUNC_RE]) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(code)) !== null) {
      pushFromOpenParen(m[1], m.index);
      if (funcs.length >= MAX_FUNCTIONS) break;
    }
  }

  ARROW_FUNC_RE.lastIndex = 0;
  let m;
  while ((m = ARROW_FUNC_RE.exec(code)) !== null) {
    const braceIdx = code.indexOf("{", m.index);
    if (braceIdx < 0) continue;
    const bodyEnd = findMatching(code, braceIdx, "{", "}");
    if (bodyEnd < 0) continue;
    funcs.push({
      name: m[1],
      line: lineOf(code, m.index),
      bodyStart: braceIdx + 1,
      bodyEnd,
    });
    if (funcs.length >= MAX_FUNCTIONS) break;
  }

  return funcs;
}


// ---------------------------------------------------------------------------
// Detector 1: nested loops over the same array
// ---------------------------------------------------------------------------

function detectNestedSameArray(loops) {
  const out = [];
  for (let i = 0; i < loops.length; i++) {
    const outer = loops[i];
    if (!outer.array) continue;
    for (let j = i + 1; j < loops.length; j++) {
      const inner = loops[j];
      if (inner.bodyStart >= outer.bodyEnd) break;  // sorted — no more nesteds
      if (!inner.array) continue;
      if (inner.array !== outer.array) continue;
      if (inner.bodyStart < outer.bodyStart) continue;
      out.push({
        type: "nested_loops_same_array",
        line: inner.line,
        description: `Inner loop iterates "${inner.array}" again inside an outer loop over the same array — that's O(n²) work for what is usually a contains-style check.`,
        recommendation: `Build a Set or Map from "${inner.array}" once before the outer loop, then look up in O(1) inside the loop instead of scanning the array again.`,
      });
    }
  }
  return out;
}


// ---------------------------------------------------------------------------
// Detector 2: repeated array operations inside loops
// ---------------------------------------------------------------------------
//
// `.includes()`, `.indexOf()`, `.find()`, etc. on a *variable* receiver,
// invoked from inside any loop body. Static built-ins (Math, console, JSON,
// Object) are skipped to avoid noise on `Math.max(...)` style calls.

const SCAN_RE = /([\w$][\w$.]*)\.(includes|indexOf|lastIndexOf|find|findIndex|some|every)\s*\(/g;
const SCAN_RECV_BLOCKLIST = /^(Math|console|Object|Array|JSON|String|Number|Date|Promise|window|document)$/;

function detectArrayScanInLoop(loops, code) {
  const out = [];
  const seenLoops = new Set();
  for (const loop of loops) {
    if (seenLoops.has(loop.bodyStart)) continue;  // dedupe overlapping loop matches
    SCAN_RE.lastIndex = loop.bodyStart;
    let m;
    while ((m = SCAN_RE.exec(code)) !== null) {
      if (m.index >= loop.bodyEnd) break;
      const recv = m[1].split(".")[0];
      if (SCAN_RECV_BLOCKLIST.test(recv)) continue;
      out.push({
        type: "array_scan_in_loop",
        line: lineOf(code, m.index),
        description: `"${m[1]}.${m[2]}(...)" runs inside a loop. Each call is O(n), so the loop is O(n²) overall.`,
        recommendation: `Build a Set from "${m[1]}" once before the loop and use \`set.has(x)\` for O(1) membership checks.`,
      });
      seenLoops.add(loop.bodyStart);
      break;  // one suggestion per loop is enough
    }
  }
  return out;
}


// ---------------------------------------------------------------------------
// Detector 3: recursive calls without memoization (or iteration)
// ---------------------------------------------------------------------------
//
// We split recursion into two distinct findings because their complexity
// and the right fix are different:
//
//   - linear_recursion       (1 self-call site)  → suggest iteration
//                            Complexity is usually O(n); the real risk is
//                            stack growth on deep inputs (factorial, sum-list).
//
//   - exponential_recursion  (≥2 self-call sites) → suggest memoization
//                            If subproblems overlap (Fibonacci-style), the
//                            cost is O(2^n). When they don't overlap (binary
//                            tree walk), it's still O(n) — so we phrase the
//                            recommendation conditionally rather than asserting
//                            exponential outright.
//
// Memoization detection uses pattern-evidence (cache.has/get/set, cache[k],
// new Map/Set) rather than bare word-matching, so an unrelated `seen` or
// `store` variable elsewhere in the function doesn't suppress a real finding.

const MEMO_USE_RE  = /\b(memo|cache|dp|memoize|cached|lookup|table)\s*\.\s*(has|get|set)\s*\(/i;
const MEMO_IDX_RE  = /\b(memo|cache|dp|memoize|cached|lookup|table|seen|visited)\s*\[/i;
const MEMO_NEW_RE  = /\bnew\s+(Map|Set|WeakMap|WeakSet)\b/i;

function hasMemoCache(body) {
  return MEMO_USE_RE.test(body) || MEMO_IDX_RE.test(body) || MEMO_NEW_RE.test(body);
}

function detectUnmemoizedRecursion(funcs, code) {
  const out = [];
  for (const fn of funcs) {
    const body = code.slice(fn.bodyStart, fn.bodyEnd);
    const callRe = new RegExp(`\\b${escapeRegex(fn.name)}\\s*\\(`, "g");
    const calls = body.match(callRe);
    if (!calls || calls.length < 1) continue;
    if (hasMemoCache(body)) continue;

    if (calls.length === 1) {
      out.push({
        type: "linear_recursion",
        line: fn.line,
        description: `Function "${fn.name}" calls itself once per invocation. Runtime is O(n), but each call grows the JS call stack — deep inputs will hit the engine's stack limit.`,
        recommendation: `Convert to an iterative loop (with an accumulator, or a manual stack/array if you need depth-first ordering).`,
      });
    } else {
      out.push({
        type: "exponential_recursion",
        line: fn.line,
        description: `Function "${fn.name}" makes ${calls.length} recursive calls per invocation with no cache in scope. If subproblems overlap (Fibonacci-style), runtime is exponential O(2^n); even when they don't, repeated work is common.`,
        recommendation: `Add a memoization cache (e.g. \`const memo = new Map()\`) keyed by the function's arguments and return the cached value when present.`,
      });
    }
  }
  return out;
}


// ---------------------------------------------------------------------------
// Optimized-example builder
// ---------------------------------------------------------------------------

function buildOptimizedExample(suggestions) {
  // Pick the worst-impact suggestion's type to drive the example. Ranking:
  // exponential recursion > nested-same-array / array-scan-in-loop > linear recursion.
  const types = new Set(suggestions.map(s => s.type));
  if (types.has("exponential_recursion")) {
    return [
      "// Memoize so each subproblem is computed once.",
      "const memo = new Map();",
      "function fn(n) {",
      "  if (memo.has(n)) return memo.get(n);",
      "  if (n < 2) return n;",
      "  const result = fn(n - 1) + fn(n - 2);",
      "  memo.set(n, result);",
      "  return result;",
      "}",
    ].join("\n");
  }
  if (types.has("nested_loops_same_array") || types.has("array_scan_in_loop")) {
    return [
      "// Build the lookup once outside the loop — O(n) one-time cost.",
      "const lookup = new Set(arr);",
      "for (const x of items) {",
      "  if (lookup.has(x)) {",
      "    // O(1) membership check instead of an O(n) scan",
      "  }",
      "}",
    ].join("\n");
  }
  if (types.has("linear_recursion")) {
    return [
      "// Iterative version — same O(n) runtime, no stack growth.",
      "function fn(n) {",
      "  let acc = 1;",
      "  for (let i = 2; i <= n; i++) acc *= i;",
      "  return acc;",
      "}",
    ].join("\n");
  }
  return "";
}


// ---------------------------------------------------------------------------
// Aggregator
// ---------------------------------------------------------------------------

function dominantComplexity(suggestions) {
  // Worst-first: exponential beats quadratic beats linear. Linear recursion
  // is a real concern (stack growth) but is asymptotically the cheapest of
  // the three, so it only "wins" when nothing worse fired.
  if (suggestions.some(s => s.type === "exponential_recursion")) {
    return "O(2^n) — potentially exponential (multi-branch recursion without memoization)";
  }
  if (suggestions.some(
    s => s.type === "nested_loops_same_array" || s.type === "array_scan_in_loop",
  )) {
    return "O(n²) — quadratic";
  }
  if (suggestions.some(s => s.type === "linear_recursion")) {
    return "O(n) — linear recursion (stack-growth concern)";
  }
  return "unknown";
}

/**
 * Returns either a populated success shape with at least one suggestion,
 * or an "unknown" honest fallback. NEVER fabricates suggestions: if no
 * detector fires, the response says so plainly.
 */
export function analyzeAlgo(input) {
  const source = typeof input?.source === "string" ? input.source : "";
  const language = typeof input?.language === "string" ? input.language.toLowerCase() : "javascript";

  if (!SUPPORTED_LANGS.has(language)) {
    return {
      currentComplexity: "unknown",
      reason: `language "${language}" is not supported in this MVP — submit JavaScript or TypeScript source.`,
    };
  }
  if (source.trim() === "") {
    return {
      currentComplexity: "unknown",
      reason: "source is empty.",
    };
  }

  const code = stripStringsAndComments(source);
  const loops = findLoops(code);
  const funcs = findFunctions(code);

  const suggestions = [
    ...detectNestedSameArray(loops),
    ...detectArrayScanInLoop(loops, code),
    ...detectUnmemoizedRecursion(funcs, code),
  ];

  // De-dupe (type, line) pairs — a nested-same-array inner loop that ALSO
  // does an .includes on the same array would otherwise be reported twice
  // for the same position by different detectors.
  const seen = new Set();
  const unique = [];
  for (const s of suggestions) {
    const k = `${s.type}@${s.line}`;
    if (seen.has(k)) continue;
    seen.add(k);
    unique.push(s);
  }
  unique.sort((a, b) => a.line - b.line || a.type.localeCompare(b.type));

  if (unique.length === 0) {
    return {
      currentComplexity: "unknown",
      reason: "Couldn't detect any of the patterns this MVP looks for: nested loops over the same array, repeated array scans (.includes / .indexOf / .find) inside a loop, or unmemoized recursion. The code may already be efficient, or the bottleneck may be a pattern this analyzer doesn't recognize yet.",
    };
  }

  return {
    currentComplexity: dominantComplexity(unique),
    suggestions: unique,
    optimizedExample: buildOptimizedExample(unique),
  };
}
