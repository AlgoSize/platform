// AST analyzer with lightweight taint tracking.
//
// The pattern engine in analyzers/vuln.js asks "does this LINE look
// dangerous". That question has a ceiling: it cannot tell
//
//     db.query("SELECT * FROM t WHERE id = " + id)          // id is a constant
//
// from the same line where `id` came from `req.params.id`. One is fine and one
// is a critical vulnerability, and they are spelled identically. Line matching
// must therefore either flag both (noise) or neither (a miss).
//
// This module answers the question the pattern engine cannot: did this value
// come from the request? It parses the file with acorn — already a dependency,
// used by the optimizer and the sandbox runner — walks it, and tracks which
// local names hold request-derived data.
//
// ---------------------------------------------------------------------------
// WHAT THIS IS NOT
// ---------------------------------------------------------------------------
//
// It is not a full taint engine. Deliberately, and the boundary is worth
// stating plainly because "we have taint analysis" is easy to over-read:
//
//   - Tracking is per function scope. A tainted value passed into another
//     function is not followed across that boundary.
//   - No alias analysis. `const o = {v: req.query.x}; sink(o.v)` is missed.
//   - No sanitizer modelling beyond an explicit recognised list, so a custom
//     validator does not clear taint and can produce a false positive.
//   - Loops and branches are walked once, not to a fixed point.
//
// Every one of those is a FALSE NEGATIVE except the sanitizer gap, which is
// the one direction a security tool can afford to be wrong in. The pattern
// engine still covers these files, so a miss here degrades to the old
// behaviour rather than to silence. SECURITY-SCANNING.md carries the same
// list under "Limitations", because a user who believes this is complete
// interprets a clean result far more strongly than it deserves.

import * as acorn from "acorn";

const SNIPPET_MAX = 160;

/** Request-derived roots. `req.body`, `request.query`, `process.argv`, … */
const TAINT_ROOTS = new Set(["req", "request", "ctx", "context"]);
const TAINT_PROPS = new Set(["body", "query", "params", "headers", "cookies", "url", "originalUrl"]);

/**
 * Calls that neutralize taint for our purposes.
 *
 * Short and explicit. A longer list guessed at would clear taint that is
 * still live, which turns a missed finding into a confidently clean one —
 * the failure this codebase refuses. Anything not on this list keeps its
 * taint, so the cost of the list being short is a false positive, never a
 * false clean.
 */
const SANITIZERS = new Set([
  "escape", "escapeHtml", "sanitize", "sanitizeHtml", "encodeURIComponent",
  "parseInt", "parseFloat", "Number", "Boolean",
]);

/** name -> [rule type, severity] for direct sink calls. */
const SINKS = [
  { match: (c) => isMember(c, null, ["query", "execute", "raw", "prepare"]),
    type: "sql_injection_tainted", severity: "critical",
    recommendation: "Pass the value as a bind parameter — `db.query('… WHERE id = ?', [id])` — instead of building the statement text with it." },
  { match: (c) => isCallee(c, ["exec", "execSync", "spawn", "spawnSync", "execFile"]) ||
                  isMember(c, ["child_process", "cp"], ["exec", "execSync", "spawn", "spawnSync"]),
    type: "command_injection_tainted", severity: "critical",
    recommendation: "Use the argument-array form (`execFile(cmd, [arg])`) so no shell parses the value, and validate it against an allowlist first." },
  { match: (c) => isCallee(c, ["eval"]) || isNewFunction(c),
    type: "code_injection_tainted", severity: "critical",
    recommendation: "Remove the dynamic evaluation. No amount of input validation makes eval on request data safe." },
  { match: (c) => isMember(c, ["fs", "fsp", "fsPromises"],
                    ["readFile", "readFileSync", "writeFile", "writeFileSync", "createReadStream",
                     "createWriteStream", "unlink", "unlinkSync", "appendFile", "open"]) ||
                  isMember(c, ["res", "response"], ["sendFile", "download"]),
    type: "path_traversal_tainted", severity: "high",
    // A containment check on the same variable is the documented fix for this
    // exact finding, so a scanner that keeps firing after it makes the fix
    // un-clearable — and an un-clearable finding gets suppressed wholesale,
    // taking the real ones with it. `guard` names the check that answers it.
    guard: "containment",
    recommendation: "Resolve the path and confirm it is still inside the intended root before opening it." },
  { match: (c) => isCallee(c, ["fetch"]) ||
                  isMember(c, ["axios", "got", "https", "http", "superagent"], ["get", "post", "put", "delete", "request"]),
    type: "ssrf_tainted_fetch", severity: "high",
    recommendation: "Allowlist the destination host before the call and disable redirect following." },
];

const trimSnippet = (t) => {
  const s = String(t).trim();
  return s.length > SNIPPET_MAX ? s.slice(0, SNIPPET_MAX - 1) + "…" : s;
};

// ---------------------------------------------------------------------------
// Small AST predicates
// ---------------------------------------------------------------------------

function isCallee(call, names) {
  return call.callee && call.callee.type === "Identifier" && names.includes(call.callee.name);
}

/** `objects === null` matches any receiver — `anything.query(...)`. */
function isMember(call, objects, props) {
  const c = call.callee;
  if (!c || c.type !== "MemberExpression" || c.computed) return false;
  if (c.property.type !== "Identifier" || !props.includes(c.property.name)) return false;
  if (objects === null) return true;
  return c.object.type === "Identifier" && objects.includes(c.object.name);
}

function isNewFunction(node) {
  return node.type === "NewExpression" && node.callee.type === "Identifier" && node.callee.name === "Function";
}

/** `req.query.id` / `req.body` — a request-derived member chain. */
function isTaintRoot(node) {
  let n = node;
  while (n && n.type === "MemberExpression") {
    if (n.object.type === "Identifier" && TAINT_ROOTS.has(n.object.name) &&
        !n.computed && n.property.type === "Identifier" && TAINT_PROPS.has(n.property.name)) {
      return true;
    }
    n = n.object;
  }
  if (node.type === "MemberExpression" &&
      node.object.type === "MemberExpression" &&
      node.object.object.type === "Identifier" && node.object.object.name === "process" &&
      node.object.property.name === "argv") return true;
  return false;
}

/** A readable description of where a tainted value came from. */
function describeExpr(node, src) {
  if (!node) return "unknown";
  const text = src.slice(node.start, node.end);
  return text.length > 60 ? text.slice(0, 59) + "…" : text;
}

// ---------------------------------------------------------------------------
// Walker
// ---------------------------------------------------------------------------

function walk(node, visit, parent = null) {
  if (!node || typeof node.type !== "string") return;
  visit(node, parent);
  for (const key of Object.keys(node)) {
    if (key === "start" || key === "end" || key === "loc" || key === "type") continue;
    const child = node[key];
    if (Array.isArray(child)) {
      for (const c of child) if (c && typeof c.type === "string") walk(c, visit, node);
    } else if (child && typeof child.type === "string") {
      walk(child, visit, node);
    }
  }
}

// ---------------------------------------------------------------------------
// Analysis
// ---------------------------------------------------------------------------

/**
 * Parse one file and return raw findings in the legacy detector shape.
 *
 * Never throws. A file that will not parse — TypeScript, JSX, a syntax error,
 * a future proposal acorn does not know — returns `{ findings: [], parsed:
 * false }` and the caller reports it as uncovered rather than clean. That
 * distinction is the whole reason `parsed` is in the return value: a scanner
 * that reports a file it could not read as having no findings is lying in the
 * most reassuring possible direction.
 */
export function analyzeFileAst(file) {
  let ast;
  try {
    ast = acorn.parse(file.content, {
      ecmaVersion: "latest",
      sourceType: "module",
      allowReturnOutsideFunction: true,
      allowAwaitOutsideFunction: true,
      allowHashBang: true,
      locations: true,
    });
  } catch {
    try {
      ast = acorn.parse(file.content, {
        ecmaVersion: "latest", sourceType: "script",
        allowReturnOutsideFunction: true, allowHashBang: true, locations: true,
      });
    } catch {
      return { findings: [], parsed: false };
    }
  }

  const src = file.content;
  const findings = [];
  const tainted = new Map();   // local name -> description of its origin

  // ---- pass 1: propagate taint through simple assignments -----------------
  //
  // Two shapes cover the overwhelming majority of real handler code:
  // `const id = req.params.id` and `const { id } = req.query`. Anything more
  // elaborate is a documented miss rather than a guess.
  walk(ast, (node) => {
    if (node.type === "VariableDeclarator" && node.init) {
      if (node.id.type === "Identifier" && exprIsTainted(node.init, tainted)) {
        tainted.set(node.id.name, describeExpr(node.init, src));
      } else if (node.id.type === "ObjectPattern" && isTaintRoot(node.init)) {
        for (const prop of node.id.properties) {
          if (prop.type === "Property" && prop.value.type === "Identifier") {
            tainted.set(prop.value.name, describeExpr(node.init, src) + "." + (prop.key.name || "?"));
          }
        }
      }
    }
    if (node.type === "AssignmentExpression" && node.left.type === "Identifier" &&
        exprIsTainted(node.right, tainted)) {
      tainted.set(node.left.name, describeExpr(node.right, src));
    }
  });

  // ---- pass 1b: variables that carry a containment check ------------------
  //
  // `if (!p.startsWith(root)) throw` is THE remedy for path traversal, and
  // recognising it is what makes the path-traversal finding actionable: it
  // appears, you add the check, it goes away. Scoped to path sinks via the
  // sink's `guard` field rather than clearing taint globally, because a
  // startsWith check says nothing about whether the same value is safe to
  // put in a SQL statement.
  const containmentChecked = new Set();
  walk(ast, (node) => {
    if (node.type !== "CallExpression") return;
    const c = node.callee;
    if (!c || c.type !== "MemberExpression" || c.computed) return;
    if (c.property.type !== "Identifier") return;
    if (!["startsWith", "includes", "match", "test"].includes(c.property.name)) return;
    if (c.object.type === "Identifier") containmentChecked.add(c.object.name);
    // `PATTERN.test(p)` names the value as the ARGUMENT, not the receiver.
    if (c.property.name === "test") {
      for (const a of node.arguments || []) {
        if (a.type === "Identifier") containmentChecked.add(a.name);
      }
    }
  });

  // ---- pass 2: sinks, credentials, DOM writes -----------------------------
  walk(ast, (node) => {
    if (node.type === "CallExpression" || node.type === "NewExpression") {
      const taintedArg = (node.arguments || []).find((a) => exprIsTainted(a, tainted));
      if (taintedArg) {
        for (const sink of SINKS) {
          if (!sink.match(node)) continue;
          if (sink.guard === "containment" &&
              taintedArg.type === "Identifier" && containmentChecked.has(taintedArg.name)) {
            break;
          }
          findings.push({
            severity: sink.severity,
            type: sink.type,
            path: file.path,
            line: node.loc.start.line,
            column: node.loc.start.column + 1,
            snippet: trimSnippet(lineAt(src, node.loc.start.line)),
            recommendation: sink.recommendation,
            confidence: "high",
            module: "ast-analyzer",
            evidence: {
              source: originOf(taintedArg, tainted, src) || describeExpr(taintedArg, src),
              sink: describeExpr(node.callee || node, src),
              pattern: "taint-flow",
            },
          });
          break;
        }
      }
    }

    // innerHTML / outerHTML written a tainted value.
    if (node.type === "AssignmentExpression" &&
        node.left.type === "MemberExpression" && !node.left.computed &&
        node.left.property.type === "Identifier" &&
        (node.left.property.name === "innerHTML" || node.left.property.name === "outerHTML") &&
        exprIsTainted(node.right, tainted)) {
      findings.push({
        severity: "high",
        type: "xss_tainted_sink",
        path: file.path,
        line: node.loc.start.line,
        column: node.loc.start.column + 1,
        snippet: trimSnippet(lineAt(src, node.loc.start.line)),
        recommendation: "Assign to textContent, or sanitize with DOMPurify immediately before insertion.",
        confidence: "high",
        module: "ast-analyzer",
        evidence: {
          source: originOf(node.right, tainted, src) || describeExpr(node.right, src),
          sink: describeExpr(node.left, src),
          pattern: "taint-flow",
        },
      });
    }

    // Credential-shaped name assigned a string literal. Structural, so a
    // reformatted or multi-line assignment is caught where the line-based
    // pattern would miss it.
    if (node.type === "VariableDeclarator" && node.id.type === "Identifier" &&
        node.init && node.init.type === "Literal" && typeof node.init.value === "string") {
      maybeCredential(node.id.name, node.init, node, file, src, findings);
    }
    if (node.type === "Property" && !node.computed &&
        node.key && (node.key.type === "Identifier" || node.key.type === "Literal") &&
        node.value && node.value.type === "Literal" && typeof node.value.value === "string") {
      maybeCredential(node.key.name || node.key.value, node.value, node, file, src, findings);
    }
  });

  findings.push(...detectUnguardedRoutes(ast, file, src));
  return { findings, parsed: true };
}

const CREDENTIAL_NAME_RE = /^(?:.*_)?(?:password|passwd|secret|api[_-]?key|apikey|access[_-]?token|auth[_-]?token|client[_-]?secret|private[_-]?key|encryption[_-]?key|signing[_-]?key)$/i;
// Values that are obviously not live credentials. Kept in step with the
// placeholder list in analyzers/secrets.js in spirit, not by import: that
// module's list is tuned for line scanning and this one sees the bare value.
// Two shapes of "obviously fake": the whole value IS a placeholder word, or
// the value carries a delimited test/dummy/sample token — `sk-ant-test`,
// `dummy-token-123`. Delimited, not substring: "latest" and "attestation"
// contain the letters and are not admissions of fakeness.
//
// The token list is the ONLY list extended when a self-describing fake value
// slips through. The anchored whole-value list above, and graph.js's, stay
// where they are: analyzers/secrets.js:9-35 names the concrete regression that
// merging them causes — `const apiKey = "test1234"` would stop being flagged,
// because `test` is in graph's anchored list. A critical detector getting
// quietly weaker is the failure this codebase refuses.
//
// So every entry here has to be a phrase nobody puts in a LIVE credential.
// `do-not-use`, `not-for-prod`, `fixture`, `redacted`, `local-dev`, `dev-only`,
// `stub` and `mock` qualify — each is the author saying, in the value itself,
// that it is not real. Deliberately absent: `wrong`, `invalid`, `not-a`. A real
// secret can contain those; they describe a shape, not a fakeness, and a
// fixture that relies on one should be renamed instead.
//
// One practical note for whoever renames a fixture to satisfy this list: the
// CI gate posts file contents to the DEPLOYED Worker, so it judges the branch
// with the previously deployed analyzer. A value marked with a word only the
// new list knows stays red until deploy. Reach for a long-standing marker —
// `test`, `example`, `sample` — and the fix works before and after.
const PLACEHOLDER_VALUE_RE = /^(?:|x{3,}|\*+|changeme|change[_-]?me|placeholder|example|test|todo|fixme|your[_-].*|<.*>|\$\{.*\}|process\.env\..*)$/i;
const PLACEHOLDER_TOKEN_RE =
  /(?:^|[-_.:/])(?:test|testing|dummy|sample|example|demo|fake|placeholder|changeme|xxx+|fixture|stub|mock|redacted|do[-_.]?not[-_.]?use|not[-_.]?for[-_.]?prod|local[-_.]?dev|dev[-_.]?only)(?:[-_.:/]|$)/i;

function maybeCredential(name, literal, node, file, src, findings) {
  if (!name || !CREDENTIAL_NAME_RE.test(String(name))) return;
  const value = literal.value;
  if (value.length < 8) return;
  if (PLACEHOLDER_VALUE_RE.test(value) || PLACEHOLDER_TOKEN_RE.test(value)) return;
  findings.push({
    severity: "high",
    type: "hardcoded_credential_assignment",
    path: file.path,
    line: node.loc.start.line,
    column: node.loc.start.column + 1,
    // The raw line is NOT used here. It contains the credential, and though
    // analyzeVuln's redaction pass would mask it, relying on a later pass to
    // undo an avoidable disclosure is the wrong default in a module whose
    // output is stored and emailed.
    snippet: `${name} = "***REDACTED***"`,
    recommendation: "Read this value from configuration at runtime, and rotate the committed one — it is in the git history regardless of what the file says now.",
    confidence: "medium",
    module: "ast-analyzer",
    evidence: { pattern: "literal-assignment", identifier: String(name) },
  });
}

/**
 * State-changing Express routes with no visible guard.
 *
 * The heuristic, stated so its limits are legible: a route is flagged only
 * when it is a mutating verb, declares exactly one handler argument (so no
 * middleware sits in front of it), and its body mentions nothing that looks
 * like an auth check. Registered `low` confidence in the registry because the
 * guard can legitimately live in `router.use()` above, or in a wrapper this
 * analyzer never sees.
 *
 * It earns its place anyway: "which mutating endpoints have no visible
 * authentication" is a question worth a human answering once per codebase,
 * and nothing else in the product asks it.
 */
const MUTATING_VERBS = ["post", "put", "patch", "delete"];
const AUTH_HINT_RE = /auth|session|login|user|permission|role|token|verify|guard|requir|current|principal|jwt|passport|isAdmin|owner|acl|can[A-Z]/i;

function detectUnguardedRoutes(ast, file, src) {
  const findings = [];
  walk(ast, (node) => {
    if (node.type !== "CallExpression") return;
    const c = node.callee;
    if (!c || c.type !== "MemberExpression" || c.computed) return;
    if (c.property.type !== "Identifier" || !MUTATING_VERBS.includes(c.property.name)) return;
    if (!c.object || c.object.type !== "Identifier" || !/^(?:app|router|api|server)$/i.test(c.object.name)) return;

    const args = node.arguments || [];
    if (args.length !== 2) return;                       // middleware present
    if (args[0].type !== "Literal" || typeof args[0].value !== "string") return;
    const handler = args[1];
    if (handler.type !== "FunctionExpression" && handler.type !== "ArrowFunctionExpression") return;

    const body = src.slice(handler.start, handler.end);
    if (AUTH_HINT_RE.test(body)) return;

    findings.push({
      severity: "medium",
      type: "missing_auth_guard",
      path: file.path,
      line: node.loc.start.line,
      column: node.loc.start.column + 1,
      snippet: trimSnippet(lineAt(src, node.loc.start.line)),
      recommendation: `\`${c.property.name.toUpperCase()} ${args[0].value}\` changes state and has no middleware and no visible authentication check in its handler. Attach the router's auth middleware, or check the session inside the handler. If it is deliberately public, say so in a comment — that also silences this finding.`,
      confidence: "low",
      module: "ast-analyzer",
      evidence: { route: `${c.property.name.toUpperCase()} ${args[0].value}`, pattern: "no-guard-visible" },
    });
  });
  return findings;
}

// ---------------------------------------------------------------------------
// Taint predicates
// ---------------------------------------------------------------------------

function exprIsTainted(node, tainted) {
  if (!node) return false;
  switch (node.type) {
    case "Identifier":
      return tainted.has(node.name);
    case "MemberExpression":
      return isTaintRoot(node) || exprIsTainted(node.object, tainted);
    case "BinaryExpression":
      return node.operator === "+" &&
        (exprIsTainted(node.left, tainted) || exprIsTainted(node.right, tainted));
    case "TemplateLiteral":
      return node.expressions.some((e) => exprIsTainted(e, tainted));
    case "CallExpression": {
      // A recognised sanitizer clears taint; anything else passes it through,
      // so an unknown helper stays suspicious rather than silently clean.
      const name = node.callee.type === "Identifier" ? node.callee.name
        : (node.callee.type === "MemberExpression" && node.callee.property.type === "Identifier"
            ? node.callee.property.name : null);
      if (name && SANITIZERS.has(name)) return false;
      return (node.arguments || []).some((a) => exprIsTainted(a, tainted));
    }
    case "AwaitExpression":
      return exprIsTainted(node.argument, tainted);
    case "ConditionalExpression":
      return exprIsTainted(node.consequent, tainted) || exprIsTainted(node.alternate, tainted);
    case "LogicalExpression":
      return exprIsTainted(node.left, tainted) || exprIsTainted(node.right, tainted);
    default:
      return false;
  }
}

/**
 * The request expression a tainted value actually came from, or null.
 *
 * Returns null rather than a best guess when no operand is tainted, because
 * the caller renders this as `evidence.source` — the field a reader uses to
 * decide whether a finding is real. An early version walked to the FIRST
 * operand and described it, which on `db.query("SELECT … " + id)` reported
 * the source as the SQL literal: confidently wrong, and wrong in the way that
 * makes a reader distrust every other finding on the page. Naming the tainted
 * operand or nothing at all is the only honest pair of options.
 */
function originOf(node, tainted, src) {
  if (!node) return null;
  switch (node.type) {
    case "Identifier":
      return tainted.has(node.name) ? tainted.get(node.name) : null;
    case "MemberExpression":
      if (isTaintRoot(node)) return describeExpr(node, src);
      return originOf(node.object, tainted, src);
    case "BinaryExpression":
      return originOf(node.left, tainted, src) || originOf(node.right, tainted, src);
    case "TemplateLiteral":
      for (const e of node.expressions) {
        const o = originOf(e, tainted, src);
        if (o) return o;
      }
      return null;
    case "CallExpression":
      for (const a of node.arguments || []) {
        const o = originOf(a, tainted, src);
        if (o) return o;
      }
      return null;
    case "AwaitExpression":
      return originOf(node.argument, tainted, src);
    case "ConditionalExpression":
      return originOf(node.consequent, tainted, src) || originOf(node.alternate, tainted, src);
    case "LogicalExpression":
      return originOf(node.left, tainted, src) || originOf(node.right, tainted, src);
    default:
      return null;
  }
}

function lineAt(src, lineNumber) {
  return src.split("\n")[lineNumber - 1] || "";
}
