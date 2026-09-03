// Vulnerability scanner — pure rule engine.
//
// Same architectural shape as analyzers/cost.js: dependency-free, pure
// functions, no HTTP/KV/fetch — so the body of analyzeVuln can later be
// swapped for an LLM-backed implementation without changing the endpoint
// contract.
//
// Public surface:
//   validateVulnInput(payload) -> { ok: true, value } | { ok: false, error, message }
//   analyzeVuln(input)         -> { findings: [{...}] }
//
// Finding shape:
//   { severity: "critical"|"high"|"medium"|"low",
//     type: string,
//     path: string,
//     line: number,           // 1-indexed
//     snippet: string,        // matched line, trimmed; secrets masked
//     recommendation: string }


// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

const MAX_BYTES_PER_FILE = 200 * 1024;  // 200 KB per file (UTF-8)
const MAX_FILES = 50;
const MAX_INLINE_BYTES = MAX_BYTES_PER_FILE;
const SNIPPET_MAX = 160;

const TEXT_ENCODER = new TextEncoder();
const byteLength = (s) => TEXT_ENCODER.encode(s).length;


// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Accepts either:
 *   { code: "..." }                       — single inline blob
 *   { files: [{ path, content }, ...] }   — multi-file scan
 * Returns the canonical { files: [{ path, content }] } shape on success.
 */
export function validateVulnInput(payload) {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return { ok: false, error: "invalid_payload", message: "request body must be a JSON object" };
  }
  const hasCode  = typeof payload.code === "string";
  const hasFiles = Array.isArray(payload.files);

  if (!hasCode && !hasFiles) {
    return { ok: false, error: "invalid_payload", message: "must provide either `code` (string) or `files` (array)" };
  }
  if (hasCode && hasFiles) {
    return { ok: false, error: "invalid_payload", message: "provide either `code` or `files`, not both" };
  }

  if (hasCode) {
    if (byteLength(payload.code) > MAX_INLINE_BYTES) {
      return { ok: false, error: "code_too_large", message: `code must be at most ${MAX_INLINE_BYTES} bytes (UTF-8)` };
    }
    return { ok: true, value: { files: [{ path: "<inline>", content: payload.code }] } };
  }

  if (payload.files.length === 0) {
    return { ok: false, error: "invalid_payload", message: "`files` must be a non-empty array" };
  }
  if (payload.files.length > MAX_FILES) {
    return { ok: false, error: "too_many_files", message: `at most ${MAX_FILES} files per request` };
  }
  const files = [];
  for (let i = 0; i < payload.files.length; i++) {
    const f = payload.files[i];
    if (f === null || typeof f !== "object" || Array.isArray(f)) {
      return { ok: false, error: "invalid_file", message: `files[${i}] must be an object` };
    }
    if (typeof f.path !== "string" || f.path.trim() === "") {
      return { ok: false, error: "invalid_file", message: `files[${i}].path is required` };
    }
    if (typeof f.content !== "string") {
      return { ok: false, error: "invalid_file", message: `files[${i}].content must be a string` };
    }
    if (byteLength(f.content) > MAX_BYTES_PER_FILE) {
      return { ok: false, error: "file_too_large", message: `files[${i}] exceeds ${MAX_BYTES_PER_FILE} bytes (UTF-8)` };
    }
    files.push({ path: f.path.trim(), content: f.content });
  }
  return { ok: true, value: { files } };
}


// ---------------------------------------------------------------------------
// Helpers shared by detectors
// ---------------------------------------------------------------------------

function isCommentLine(text) {
  const t = text.trimStart();
  return t.startsWith("//") || t.startsWith("#") || t.startsWith("*") || t.startsWith("/*") || t.startsWith("<!--");
}

function trimSnippet(text) {
  const t = text.trim();
  return t.length > SNIPPET_MAX ? t.slice(0, SNIPPET_MAX - 1) + "…" : t;
}

/**
 * Find the column where an inline comment begins on a line, or -1.
 *
 * Heuristic, not a full lexer:
 *   - Tracks single, double, and backtick string contexts.
 *   - `//` only counts when not preceded by `:` (so `http://` isn't a comment).
 *   - `#`  only counts at start-of-line or after whitespace (so `array[0]#x`
 *     isn't a comment, but `code  # comment` is).
 *   - `\` skips the next character (basic escape handling).
 *
 * Good enough for an MVP scanner; trades exotic edge cases for simplicity.
 */
function commentStartIndex(text) {
  let inSingle = false, inDouble = false, inTick = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "\\") { i++; continue; }
    if (!inDouble && !inTick && c === "'")  { inSingle = !inSingle; continue; }
    if (!inSingle && !inTick && c === '"')  { inDouble = !inDouble; continue; }
    if (!inSingle && !inDouble && c === "`") { inTick = !inTick;   continue; }
    if (inSingle || inDouble || inTick) continue;

    if (c === "/" && text[i + 1] === "/" && text[i - 1] !== ":") return i;
    if (c === "#" && (i === 0 || /\s/.test(text[i - 1]))) return i;
  }
  return -1;
}


// ---------------------------------------------------------------------------
// Secret patterns
// ---------------------------------------------------------------------------
//
// The patterns, the placeholder list and the redaction primitives all live in
// analyzers/secrets.js — one definition, shared with the upload-triggered
// analyzers that must REFUSE credentials rather than report them. That module's
// header explains why architecture/graph.js keeps its own key-name heuristic
// instead of being folded in (the two disagree on comments, quoting and
// placeholder matching, and merging them would silently weaken this detector).
//
// The loop below still owns what is specific to THIS analyzer: emitting
// file-shaped findings with a path, a trimmed snippet, and a severity that
// depends on comment context.

import {
  collectSecretsByLine as collectSecretLinesIn,
  maskSecrets,
  scanLine,
} from "./secrets.js";
import { analyzeFileAst } from "./sast/ast.js";
import { isAstParseable, normalizeFindings, summarizeFindings } from "./sast/schema.js";

/**
 * One pass per file: collect every secret string by line, so the global
 * redaction pass can scrub them out of any finding's snippet — not just
 * findings emitted by detectSecrets. Without this, an http:// or eval()
 * finding on a line that also contains a leaked AWS key would echo the
 * key in plaintext.
 */
function collectSecretsByLine(file) {
  return collectSecretLinesIn(file.content);
}

function maskSecretsInSnippet(snippet, secrets) {
  return maskSecrets(snippet, secrets);
}


// ---------------------------------------------------------------------------
// Detector 1: hardcoded secrets
// ---------------------------------------------------------------------------
//
// We scan the full line (a leaked secret in a comment is still leaked).
// Snippet masking is handled by the global redaction pass below — this
// detector just emits raw snippets and trusts the post-pass.

function detectSecrets(file) {
  const findings = [];
  const lines = file.content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const text = lines[i];
    const lineNumber = i + 1;

    // scanLine returns the high-confidence patterns in declaration order, then
    // the generic heuristic — the same order this loop emitted them in before
    // the patterns moved to secrets.js. A `severity: null` hit is the generic
    // one, which is the only case whose severity depends on where it appeared:
    // a credential in a comment is still a leak, but a less urgent one.
    for (const hit of scanLine(text)) {
      // The generic name-equals-value heuristic is a CODE shape: `apiKey =
      // "…"` written inside an enclosing string (a test vector, a doc
      // example) is data. Match start inside a masked literal means exactly
      // that. Format rules are exempt — their matches (a PEM banner, an AWS
      // key) live inside quotes by definition and are leaks wherever they
      // appear.
      if (hit.severity === null && hit.index !== undefined) {
        const masked = maskLiterals(text);
        if (masked[hit.index] !== text[hit.index]) continue;
      }
      findings.push({
        severity: hit.severity === null ? (isCommentLine(text) ? "low" : "high") : hit.severity,
        type: hit.type,
        path: file.path,
        line: lineNumber,
        snippet: trimSnippet(text),
        recommendation: hit.recommendation,
      });
    }
  }
  return findings;
}


// ---------------------------------------------------------------------------
// String and regex literals are data, not code
// ---------------------------------------------------------------------------
//
// A code-shape detector that reads inside quotes reports every mention of the
// shape: a recommendation string saying "Avoid exec()", a rule regex spelling
// /dangerouslySetInnerHTML/, a test feeding 'db.query("SELECT …")' as data.
// This scanner's own source was the proof — five of its rule DEFINITIONS
// reported themselves as vulnerabilities.
//
// The discriminator is where a match STARTS. `createHash("md5")` starts at
// the function name, outside the string, and only extends into it — real
// code, keep. A recommendation string mentioning exec() or a rule regex
// spelling /dangerouslySetInnerHTML/ starts inside a literal — a mention,
// skip. `maskLiterals` blanks literal INTERIORS with spaces, preserving
// length, so `masked[i] !== line[i]` answers "is position i inside one".
//
// Two rules in the table are exempt via `scanLiterals: true`: a PEM banner
// and a credentialed connection string ARE string data — that is exactly how
// they leak — and their matches legitimately start inside quotes.
//
// The regex-literal heuristic: a `/` reads as regex, not division, when the
// previous non-space character opens an expression. That is exactly the
// context rule definitions appear in (`regex: /…/`), and a mis-read here
// only masks a division expression's right side — which no code-shape
// pattern needs to see.
const REGEX_LITERAL_PRECEDER = /[=:(,[!&|?;{]$|^$|\breturn$/;

/** Is the match at `index` inside a string/regex literal on this line? */
export function insideLiteral(line, masked, index) {
  return masked[index] !== line[index];
}

export function maskLiterals(line) {
  let out = "";
  let i = 0;
  const n = line.length;
  while (i < n) {
    const ch = line[i];
    if (ch === '"' || ch === "'" || ch === "`") {
      let j = i + 1;
      while (j < n && line[j] !== ch) j += line[j] === "\\" ? 2 : 1;
      const closed = j < n;
      out += ch + " ".repeat(Math.max(0, Math.min(j, n) - i - 1)) + (closed ? ch : "");
      i = closed ? j + 1 : n;
      continue;
    }
    if (ch === "/" && REGEX_LITERAL_PRECEDER.test(out.trimEnd().slice(-6).trim())) {
      let j = i + 1;
      let inClass = false;
      while (j < n) {
        if (line[j] === "\\") { j += 2; continue; }
        if (line[j] === "[") inClass = true;
        else if (line[j] === "]") inClass = false;
        else if (line[j] === "/" && !inClass) break;
        j++;
      }
      if (j < n) { // found a closing slash — treat as a regex literal
        out += "/" + " ".repeat(j - i - 1) + "/";
        i = j + 1;
        continue;
      }
    }
    out += ch;
    i++;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Detector 2: eval() / exec() / new Function()
// ---------------------------------------------------------------------------
//
// Code-only: skip lines that are entirely comments AND the trailing inline
// comment portion of mixed lines (so `const x=1; // eval(userInput)` doesn't
// false-fire).

function detectDangerousEval(file) {
  const findings = [];
  const lines = file.content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const text = lines[i];
    if (isCommentLine(text)) continue;

    const ci = commentStartIndex(text);
    const code = ci >= 0 ? text.slice(0, ci) : text;
    // An eval() mentioned inside a string or a rule regex is a mention, not
    // a call — matches that START inside a literal are dropped below.
    const maskedCode = maskLiterals(code);
    const outsideLiteral = (m) => m && !insideLiteral(code, maskedCode, m.index) ? m : null;

    const evalMatch    = outsideLiteral(/\beval\s*\(/.exec(code));
    const newFuncMatch = outsideLiteral(/\bnew\s+Function\s*\(/.exec(code));
    // `exec` needs a negative lookbehind for `.` — without it, every
    // `SOME_REGEX.exec(str)` in a JavaScript codebase was reported as a
    // high-severity command-execution finding. RegExp.prototype.exec is one
    // of the most common calls in JS, so the scanner drowned real findings
    // in noise on any real repo (this very file has three of them).
    //
    // The lookbehind alone was not enough. It excludes `db.exec(sql)` but not
    // `async exec(sql) {` — a method DEFINITION named `exec`, where the
    // preceding character is a space. Defining a method called `exec` spawns
    // nothing; it is a name. Three sites on this repository alone were
    // reported that way (a D1 stub, a SQLite adapter, a test double), none of
    // which can execute a process: no `child_process` import exists anywhere
    // in the scanned tree.
    //
    // So a definition keyword before the name disqualifies the match, as does
    // a `{`/`,` immediately after the closing paren, which is the shape of a
    // method body rather than a call.
    //
    // What stays flagged: a bare `exec(` — Python's built-in, or a
    // destructured `const { exec } = require("child_process")` — plus the
    // explicit child_process/os/subprocess spellings.
    const execMatch =
      outsideLiteral(/(?<!(?:function|async|get|set|def)\s+)(?<![.\w$])exec\s*\([^)]*\)(?!\s*[{,])/.exec(code)) ||
      outsideLiteral(/\b(?:child_process|cp)\.execS?y?n?c?\s*\(/.exec(code)) ||
      outsideLiteral(/\bexecSync\s*\(/.exec(code)) ||
      outsideLiteral(/\bos\.system\s*\(/.exec(code)) ||
      outsideLiteral(/\bsubprocess\.(?:run|call|check_output|check_call|Popen)\s*\([^)]*shell\s*=\s*True/.exec(code));

    if (evalMatch || newFuncMatch) {
      findings.push({
        severity: "high",
        type: "use_of_eval",
        path: file.path,
        line: i + 1,
        snippet: trimSnippet(text),
        recommendation: "Avoid eval / new Function on dynamic input — they enable arbitrary code execution. Prefer explicit dispatch tables, JSON.parse for data, or a sandboxed evaluator.",
      });
    }
    if (execMatch) {
      findings.push({
        // Medium, not high. This is a shape match with no flow evidence: the
        // analyzer sees a call named `exec` and cannot see whether its
        // argument is attacker-influenced. The registry grades its confidence
        // `low`, and this codebase already settled that a low-confidence shape
        // must not carry the same severity as a traced one — grading both the
        // same would mean confidence carries no information. The
        // concatenation-fed variant (`command_injection`) keeps its critical,
        // because a command assembled from a variable IS the evidence.
        severity: "medium",
        type: "use_of_exec",
        path: file.path,
        line: i + 1,
        snippet: trimSnippet(text),
        recommendation: "Avoid exec() on dynamic input — it enables arbitrary code execution. Use safer parsers or explicit dispatch.",
      });
    }
  }
  return findings;
}


// ---------------------------------------------------------------------------
// Detector 3: SQL string concatenation
// ---------------------------------------------------------------------------

// A lone SQL keyword is not a query.
//
// This used to be an unanchored, case-insensitive alternation, which meant
// `.join(", ")` matched JOIN and `Object.values()` matched VALUES — two of the
// most common expressions in JavaScript. On this repository alone that rule
// produced 188 findings across 78 files at HIGH severity, essentially all of
// them noise, and a gate that reports 371 highs is a gate nobody reads.
//
// So detection now requires the SHAPE of a statement: the keyword pairs that
// only ever co-occur in SQL. `SELECT` near a `FROM`, `INSERT INTO`, an
// `UPDATE` with its `SET`, a `WHERE` followed by an actual comparison. Prose
// containing the word "from" no longer qualifies, and neither does an array
// join.
//
// The bounded `{0,400}` gaps keep this linear — an unbounded `[\s\S]*?`
// between two alternated keywords is how a linter regex becomes a denial of
// service on a minified file.
const SQL_STATEMENT = new RegExp([
  "\\bSELECT\\b[\\s\\S]{0,400}?\\bFROM\\b",
  "\\bINSERT\\s+(?:OR\\s+\\w+\\s+)?INTO\\b",
  "\\bREPLACE\\s+INTO\\b",
  "\\bUPDATE\\b[\\s\\S]{0,200}?\\bSET\\b",
  "\\bDELETE\\s+FROM\\b",
  "\\bUNION\\s+(?:ALL\\s+)?SELECT\\b",
  // A fragment: FROM/JOIN naming a table, or a WHERE with a real comparison.
  "\\b(?:FROM|JOIN)\\s+[`\"'\\[]?\\w+[`\"'\\]]?\\s*(?:\\bWHERE\\b|\\bJOIN\\b|\\bON\\b|\\bORDER\\b|\\bGROUP\\b|\\bLIMIT\\b|\\bSET\\b)",
  "\\bWHERE\\b\\s+[\\w`\"'.\\[\\]]+\\s*(?:=|<|>|!=|<>|\\bLIKE\\b|\\bIN\\b|\\bIS\\b)",
].join("|"), "i");

// The concatenation case, where SQL is split across operands and no single
// literal holds a whole statement: `"WHERE " + clause`. Such a fragment counts
// only when the literal is NOTHING BUT a clause keyword — visibly a query
// being assembled, not a sentence that happens to contain the word.
//
// The keyword list here is deliberately shorter than the one above. DELETE,
// FROM, SET, JOIN, INTO and ON are all ordinary English, and every one of them
// produced a false positive on this repository's own UI copy: `"Delete " +
// phrase`, `"from " + price`, `"Remove " + label + " from the organisation?"`.
// Those verbs only earn a finding as part of a full statement shape, which
// SQL_STATEMENT already covers. What is left — WHERE, VALUES, ORDER BY and
// friends — has no plausible reading as prose glued to a variable.
const SQL_CLAUSE_ONLY = /^\s*(?:WHERE|VALUES|ORDER\s+BY|GROUP\s+BY|HAVING|LIMIT|OFFSET|UNION(?:\s+ALL)?)\s*\(?\s*$/i;

const looksLikeSqlLiteral = (text) => SQL_STATEMENT.test(text) || SQL_CLAUSE_ONLY.test(text);

function detectSqlConcat(file) {
  const findings = [];
  const lines = file.content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const text = lines[i];
    if (isCommentLine(text)) continue;
    const ci = commentStartIndex(text);
    const code = ci >= 0 ? text.slice(0, ci) : text;

    // Pull out the quoted operand next to a `+` and judge the LITERAL, rather
    // than asking whether a SQL word appears somewhere on the line. The old
    // form matched `"Scanned " + n + " packages from " + names` — an English
    // sentence — because "from" is in it.
    const left  = /(["'])((?:(?!\1)[^\\]|\\.)*)\1\s*\+\s*[A-Za-z_$][\w$.]*/;
    const right = /[A-Za-z_$][\w$.]*\s*\+\s*(["'])((?:(?!\1)[^\\]|\\.)*)\1/;
    const l = left.exec(code);
    const r = right.exec(code);
    if ((l && looksLikeSqlLiteral(l[2])) || (r && looksLikeSqlLiteral(r[2]))) {
      findings.push({
        severity: "medium", // shape without taint — see the registry note
        type: "sql_string_concatenation",
        path: file.path,
        line: i + 1,
        snippet: trimSnippet(text),
        recommendation: "Use parameterized queries (e.g. `?` placeholders or `$1` bind parameters). Concatenating user input into SQL is the canonical SQL-injection vector.",
      });
    }
  }
  return findings;
}


// ---------------------------------------------------------------------------
// Detector 4: unparameterized template strings used in queries
// ---------------------------------------------------------------------------
//
// Backtick template literal containing both a SQL keyword and a `${...}`
// interpolation. Line-by-line scan, so multi-line templates aren't caught;
// for an MVP the false-negative is preferable to the extra complexity.

function detectSqlTemplateLiteral(file) {
  const findings = [];
  const lines = file.content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const text = lines[i];
    if (isCommentLine(text)) continue;
    const ci = commentStartIndex(text);
    const code = ci >= 0 ? text.slice(0, ci) : text;

    const tmpl = /`([^`]*)`/.exec(code);
    if (!tmpl) continue;
    const body = tmpl[1];
    if (looksLikeSqlLiteral(body) && /\$\{[^}]+\}/.test(body)) {
      findings.push({
        severity: "medium", // shape without taint — see the registry note
        type: "sql_template_literal_injection",
        path: file.path,
        line: i + 1,
        snippet: trimSnippet(text),
        recommendation: "Don't interpolate variables into SQL template literals. Use the driver's prepared-statement / placeholder syntax (e.g. `?`, `$1`).",
      });
    }
  }
  return findings;
}


// ---------------------------------------------------------------------------
// Detector 5: insecure http:// URLs in production-looking config
// ---------------------------------------------------------------------------

const PRODUCTION_PATH_RE = /(?:^|[\\/])(prod|production|\.env(?:\.|$)|config|wrangler\.toml|settings\.py|application\.ya?ml|kubernetes|terraform|helm)/i;
const LOCAL_HOST_RE = /^http:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|\[::1\]|[a-z0-9-]+\.local)/i;
const HTTP_URL_RE = /\bhttp:\/\/[^\s"'`<>]+/g;

// URIs that are IDENTIFIERS, not endpoints.
//
// An XML namespace, an XML-parser feature switch and a JSON-Schema `$schema`
// are URI-shaped by specification and are never dereferenced — nothing is
// fetched, so no bytes travel in the clear and there is nothing for this rule
// to protect. Worse, they are FIXED strings: `http://www.w3.org/2000/svg` is
// the SVG namespace, and `https://www.w3.org/2000/svg` is a different
// namespace that no browser renders as SVG. So the remediation this rule
// recommends does not harden the code, it breaks it.
//
// Found by this scanner running on this repository's own pull request, where
// it flagged `document.createElementNS("http://www.w3.org/2000/svg", tag)` —
// a line that cannot be written any other way. That is the real cost of a
// false positive in a security rule: not the noise, but that a reader who
// dismisses it once learns to dismiss the next one, and the next one may be
// a genuine cleartext endpoint.
//
// Matched on the URI itself rather than on the syntax around it, because
// these are globally fixed identifiers: the SVG namespace is not an endpoint
// in a createElementNS call and an endpoint everywhere else.
const IDENTIFIER_URI_RE = new RegExp("^http://(?:" + [
  // XML namespaces and the XML infrastructure that names things with URIs.
  "(?:www\\.)?w3\\.org/",
  "xmlns\\.",
  "schemas\\.xmlsoap\\.org/",
  "schemas\\.microsoft\\.com/",
  "schemas\\.android\\.com/",
  "schemas\\.openxmlformats\\.org/",
  // Parser feature and property switches, e.g. the load-external-dtd feature
  // this file's own XXE rule matches on.
  "(?:xml\\.org/sax/|apache\\.org/xml/|javax\\.xml\\.)",
  // Schema and vocabulary identifiers.
  "json-schema\\.org/",
  "purl\\.org/",
  "maven\\.apache\\.org/POM/",
  "www\\.opengis\\.net/",
  "iptc\\.org/std/",
].join("|") + ")", "i");

function detectInsecureHttp(file) {
  const findings = [];
  const inProductionContext = PRODUCTION_PATH_RE.test(file.path);
  const lines = file.content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const text = lines[i];
    const ci = commentStartIndex(text);

    HTTP_URL_RE.lastIndex = 0;
    let m;
    while ((m = HTTP_URL_RE.exec(text)) !== null) {
      const url = m[0];
      if (LOCAL_HOST_RE.test(url)) continue;
      // Never fetched, and the https:// spelling is a different identifier.
      if (IDENTIFIER_URI_RE.test(url)) continue;
      // A URL is "in a comment" if the whole line is a comment OR if its
      // start position is past the inline comment marker.
      const inComment = isCommentLine(text) || (ci >= 0 && m.index >= ci);
      const baseSeverity = inProductionContext ? "medium" : "low";
      const severity = inComment ? "low" : baseSeverity;
      findings.push({
        severity,
        type: "insecure_http_url",
        path: file.path,
        line: i + 1,
        snippet: trimSnippet(text),
        recommendation: "Use https:// for non-local endpoints — http:// transmits cookies, tokens, and credentials in cleartext.",
      });
    }
  }
  return findings;
}


// ---------------------------------------------------------------------------
// Detector 6: table-driven code smells
// ---------------------------------------------------------------------------
//
// The five detectors above each needed their own control flow (comment
// handling, multiple regexes, context-sensitive severity). These don't —
// they're "does this line match a pattern that is essentially always a
// finding", so they live in a table instead of six near-identical functions.
//
// Rule for adding one: the pattern must be specific enough that a match is
// almost certainly the real thing. `\bexec\s*\(` was in the codebase and
// matched every `regex.exec(s)` call — a detector that cries wolf costs more
// trust than the finding it catches is worth. Where a pattern needs an
// escape hatch, `unless` suppresses the match.

const CODE_PATTERNS = [
  {
    type: "private_key_material",
    scanLiterals: true, // a PEM banner inside a string IS the leak
    severity: "critical",
    // The PEM banner itself — no ambiguity about what this is.
    regex: /-----BEGIN\s+(?:RSA|DSA|EC|OPENSSH|PGP|ENCRYPTED)?\s*PRIVATE KEY-----/,
    recommendation: "Remove this private key from source control, rotate it immediately, and load key material from a secret store at runtime. Assume the key is compromised — it is in your git history.",
  },
  {
    type: "disabled_tls_verification",
    severity: "high",
    regex: /rejectUnauthorized\s*:\s*false|NODE_TLS_REJECT_UNAUTHORIZED\s*[:=]\s*["']?0|InsecureSkipVerify\s*:\s*true|CURLOPT_SSL_VERIFYPEER\s*(?:,|=>)\s*(?:false|0)\b|\bverify\s*=\s*False\b/,
    recommendation: "Never disable certificate verification outside a throwaway local test — it turns TLS into plaintext against any network attacker. If a private CA is the problem, add that CA to the trust store instead.",
  },
  {
    type: "insecure_deserialization",
    severity: "high",
    // yaml.load is only unsafe without a safe loader, hence `unless`.
    regex: /\bpickle\.loads?\s*\(|\byaml\.load\s*\(|\bunserialize\s*\(|\bMarshal\.load\s*\(|readObject\s*\(\s*\)/,
    // js-yaml v4's `load` is the old `safeLoad`, and an explicit restricted
    // schema is safe in v3 too — both are correct code, and flagging them
    // would send someone to "fix" a line that is already right.
    unless: /SafeLoader|safe_load|Loader\s*=\s*yaml\.C?SafeLoader|CORE_SCHEMA|JSON_SCHEMA|FAILSAFE_SCHEMA|json\s*:\s*true/,
    recommendation: "Deserializing untrusted data executes attacker-chosen code. Use a data-only format (JSON), or the safe variant of the API — `yaml.safe_load`, and never `pickle` on anything that crossed a trust boundary.",
  },
  {
    type: "command_injection",
    severity: "critical",
    // A shell command built by interpolation or concatenation. Composed
    // from two halves so the "which call" and "which argument shape" parts
    // stay readable — and so the dotted spellings (`os.system`,
    // `child_process.exec`) are matched explicitly rather than being
    // excluded by the bare-call lookbehind.
    regex: new RegExp(
      // …the call
      "(?:(?:^|[^.\\w$])(?:exec|execSync|spawnSync?|popen|system)" +
      "|\\b(?:os\\.system|child_process\\.exec\\w*|subprocess\\.(?:run|call|Popen)))" +
      // …fed a template with ${}, a concatenated string, or a Python f-string
      "\\s*\\(\\s*(?:`[^`]*\\$\\{|[\"'][^\"']*[\"']\\s*\\+\\s*[A-Za-z_$]|f[\"'][^\"']*\\{)",
    ),
    recommendation: "Build the command as an argument array rather than a shell string (`execFile(cmd, [args])`, `subprocess.run([...], shell=False)`). Interpolating a variable into a shell string is remote code execution the moment that variable is attacker-influenced.",
  },
  {
    type: "weak_hash_algorithm",
    severity: "medium",
    regex: /createHash\s*\(\s*["'](?:md5|sha1)["']|\bhashlib\.(?:md5|sha1)\s*\(|MessageDigest\.getInstance\s*\(\s*["'](?:MD5|SHA-?1)["']/i,
    recommendation: "MD5 and SHA-1 are broken for anything security-relevant. Use SHA-256 or better for integrity, and a password hash (bcrypt/scrypt/Argon2) for credentials — never a raw digest.",
  },
  {
    type: "insecure_randomness",
    severity: "medium",
    // Only when the line is clearly about a secret value — Math.random()
    // for a UI jitter or a sample array is fine and must not be flagged.
    regex: /(?:Math\.random\s*\(\s*\)|\brandom\.(?:random|randint|choice)\s*\()/,
    requires: /token|secret|password|passwd|api[_-]?key|nonce|salt|otp|session|csrf|uuid|reset[_-]?code/i,
    recommendation: "Math.random() and Python's `random` are predictable and must not generate security tokens. Use `crypto.getRandomValues` / `crypto.randomUUID` in JS, or `secrets` in Python.",
  },
  {
    type: "weak_cipher_algorithm",
    severity: "high",
    // DES/RC4 by name, and any ECB-mode spelling. ECB is the one that looks
    // fine to a reader who has not seen the penguin: it encrypts identical
    // plaintext blocks to identical ciphertext blocks, so structure survives.
    regex: /createCipheriv?\s*\(\s*["'](?:des|des-ede3|rc4|[a-z0-9-]*-ecb)["']|Cipher\.getInstance\s*\(\s*["'][A-Z]+\/ECB|\bDES\.new\s*\(|\bARC4\.new\s*\(/i,
    recommendation: "Use an authenticated cipher — AES-256-GCM or ChaCha20-Poly1305 — with a unique nonce per message. DES and RC4 are broken, and ECB mode leaks the shape of the plaintext.",
  },
  {
    type: "weak_password_hash",
    severity: "high",
    // A general-purpose digest applied to something named like a password.
    // The `requires` gate is what keeps this off every legitimate checksum.
    regex: /createHash\s*\(\s*["'](?:md5|sha1|sha256|sha512)["']|\bhashlib\.(?:md5|sha1|sha256|sha512)\s*\(/i,
    requires: /password|passwd|pwd|passphrase/i,
    recommendation: "A fast digest is the wrong primitive for a password — speed is exactly what an offline cracker wants. Use bcrypt, scrypt or Argon2id through a maintained library, with a per-password salt.",
  },
  {
    type: "jwt_none_algorithm",
    severity: "critical",
    // Either half is fatal: decoding without verifying, or accepting "none".
    regex: /\bjwt\.decode\s*\(|algorithms?\s*:\s*\[[^\]]*["']none["']|\balgorithm\s*[:=]\s*["']none["']|verify_signature["']?\s*:\s*False|\boptions\s*=\s*\{\s*["']verify_signature["']\s*:\s*False/i,
    // `jwt.decode(token, { complete: true })` after a verify is a legitimate
    // read; a verify on the same line means the signature was checked.
    unless: /\bjwt\.verify\s*\(|verify_signature["']?\s*:\s*True/,
    recommendation: "Verify the signature with an explicit algorithm allowlist — `jwt.verify(token, key, { algorithms: [\"RS256\"] })`. An unverified decode returns attacker-authored claims.",
  },
  {
    type: "permissive_cors",
    severity: "high",
    // Wildcard origin AND credentials. Either alone can be legitimate; the
    // pair means any site can read authenticated responses.
    regex: /origin\s*:\s*["']\*["'][^}]*credentials\s*:\s*true|credentials\s*:\s*true[^}]*origin\s*:\s*["']\*["']|Access-Control-Allow-Origin["']\s*,\s*["']\*["'][\s\S]{0,120}Allow-Credentials["']\s*,\s*["']true|supports_credentials\s*=\s*True[^)]*origins\s*=\s*["']\*/i,
    recommendation: "Reflect only allowlisted origins when credentials are enabled. Browsers refuse `*` with credentials for this exact reason — code that routes around that refusal is disabling the protection on purpose.",
  },
  {
    type: "cors_reflects_origin",
    severity: "high",
    // Echoing the caller's own Origin header allowlists the whole internet.
    regex: /Access-Control-Allow-Origin["']\s*,\s*(?:req|request)\.(?:headers|get)[^)]*origin|setHeader\s*\(\s*["']Access-Control-Allow-Origin["']\s*,\s*origin\b/i,
    recommendation: "Compare the request's origin against an allowlist and echo it back only on a match. Reflecting it unconditionally is the same as `*`, but it also works with credentials.",
  },
  {
    type: "security_middleware_disabled",
    severity: "high",
    regex: /csrf\s*:\s*false|csrfProtection\s*:\s*false|\bWTF_CSRF_ENABLED\s*=\s*False|helmet\s*:\s*false|\.disable\s*\(\s*["']x-powered-by["']\s*\)\s*;?\s*\/\/\s*helmet|@csrf_exempt\b|csrf_exempt\s*=\s*True/i,
    recommendation: "Re-enable the middleware. If a single endpoint genuinely cannot use it — a webhook that verifies its own signature — exempt that one route rather than turning the protection off globally.",
  },
  {
    type: "debug_mode_enabled",
    severity: "medium",
    regex: /\bDEBUG\s*=\s*True\b|\bapp\.run\s*\([^)]*debug\s*=\s*True|\bFLASK_DEBUG\s*[:=]\s*["']?1\b|\bNODE_ENV\s*[:=]\s*["']development["'][^]*production/i,
    recommendation: "Drive the debug flag from the environment and default it off. Debug handlers print stack traces and environment variables, and some frameworks expose an interactive console on the error page.",
  },
  {
    type: "xxe_external_entities",
    severity: "high",
    regex: /noent\s*:\s*true|resolve_entities\s*=\s*True|\bXMLParser\s*\([^)]*resolve_entities\s*=\s*True|setFeature\s*\(\s*["']http:\/\/apache\.org\/xml\/features\/nonvalidating\/load-external-dtd["']\s*,\s*true|LIBXML_NOENT/i,
    recommendation: "Leave entity and DTD resolution off — the default in every modern parser. A document that resolves external entities can read local files and make requests from your server.",
  },
  {
    type: "template_injection",
    severity: "high",
    // A template COMPILED from an assembled string, rather than data passed
    // to a static template. `requires` keeps it to dynamic sources.
    regex: /(?:Handlebars|_|lodash|ejs|pug|jade|nunjucks)\.(?:compile|template|render(?:String)?)\s*\(|\brender_template_string\s*\(|\bTemplate\s*\(/,
    requires: /\+|\$\{|\bf["']|%s|\.format\s*\(|req\.|request\./,
    recommendation: "Compile templates from static files and pass user data as template VARIABLES. Building the template SOURCE from user input hands the attacker the template language, which in most engines reaches the host process.",
  },
  {
    type: "nosql_injection",
    severity: "high",
    // A request value used as (or spread into) a query document, so the
    // attacker controls operators, not just values.
    regex: /\.(?:find|findOne|findOneAndUpdate|updateOne|updateMany|deleteOne|deleteMany|count)\s*\(\s*(?:req|request)\.(?:body|query|params)\b|\.(?:find|findOne)\s*\(\s*\{[^}]*:\s*(?:req|request)\.(?:body|query|params)\.[A-Za-z_$][\w$]*\s*[},]/,
    recommendation: "Coerce request values to the primitive you expect — `String(req.body.user)` — or validate against a schema. Passing the raw value lets an attacker send `{\"$ne\": null}` and match every row.",
  },
  {
    type: "path_traversal",
    severity: "high",
    // A filesystem call whose path is joined/concatenated with request data.
    regex: /(?:readFile|readFileSync|writeFile|writeFileSync|createReadStream|createWriteStream|unlink|unlinkSync|sendFile|open)\s*\(\s*(?:[^)]*\b(?:path\.)?join\s*\([^)]*(?:req|request)\.(?:params|query|body)|[^),]*(?:req|request)\.(?:params|query|body)\.[A-Za-z_$][\w$]*)|\bopen\s*\(\s*(?:os\.path\.)?join\s*\([^)]*request\.(?:args|form|json)/,
    recommendation: "Resolve the path and confirm it is still inside the intended root: `const p = path.resolve(base, name); if (!p.startsWith(base + path.sep)) throw`. Better still, look the user's input up in an allowlist rather than treating it as a path.",
  },
  {
    type: "ssrf_user_url",
    severity: "high",
    regex: /\b(?:fetch|axios(?:\.(?:get|post|put|delete|request))?|got|superagent\.get|https?\.get|requests\.(?:get|post|put|delete))\s*\(\s*(?:req|request)\.(?:body|query|params)\.[A-Za-z_$][\w$]*|\b(?:fetch|axios|got)\s*\(\s*`[^`]*\$\{\s*(?:req|request)\.(?:body|query|params)\./,
    recommendation: "Allowlist the destination host before the call, and disable redirect following so an allowed host cannot bounce you onto an internal one. Blocklists lose to DNS rebinding and IPv6-mapped addresses.",
  },
  {
    type: "open_redirect",
    severity: "medium",
    regex: /\.redirect\s*\(\s*(?:req|request)\.(?:query|body|params)\.[A-Za-z_$][\w$]*|\.redirect\s*\(\s*`?\$?\{?\s*(?:req|request)\.(?:query|body|params)\.|\bwindow\.location(?:\.href)?\s*=\s*(?:new\s+URLSearchParams|[^;]*\.searchParams\.get)/,
    recommendation: "Accept a path, not a URL: reject anything containing a scheme or a leading `//`. Or map an opaque key to a destination held server-side, so the user never names the target at all.",
  },
  {
    type: "response_send_tainted_html",
    severity: "high",
    regex: /res\.(?:send|write|end)\s*\(\s*(?:`[^`]*<[a-z]+[^`]*\$\{\s*(?:req|request)\.|["'][^"']*<[a-z]+[^"']*["']\s*\+\s*(?:req|request)\.)/i,
    recommendation: "Render through a template engine with contextual auto-escaping, or HTML-encode the value at the point it enters the markup.",
  },
  {
    type: "sensitive_data_logging",
    severity: "medium",
    // A logging call whose argument names a credential. Deliberately requires
    // the credential-ish identifier to be the thing logged, not merely present
    // somewhere on the line.
    regex: /\b(?:console\.(?:log|info|warn|error|debug)|logger?\.(?:info|debug|warn|error|log)|print|println|puts|fmt\.Print\w*)\s*\([^)]*\b(?:password|passwd|secret|api[_-]?key|apikey|access[_-]?token|refresh[_-]?token|private[_-]?key|session[_-]?token|credit[_-]?card|ssn)\b/i,
    // A log that says a secret is MISSING or being redacted names the field
    // without printing it — the exact pattern this codebase uses itself.
    unless: /redact|\bmask|not set|missing|undefined|\bhas[A-Z]|\?\s*["']set["']|length|NOT CONFIGURED/i,
    recommendation: "Log an identifier instead of the value. Where the shape genuinely matters for debugging, log the length or a truncated hash — logs are retained longer and read by more people than the secret store.",
  },
  {
    type: "insecure_cookie_flags",
    severity: "medium",
    // `[^)]*` was wrong here: it cannot cross the closing paren of a nested
    // call, so the single most common spelling —
    // `res.cookie("sid", makeToken(), { httpOnly: false })` — never matched.
    // The rule looked present and tested and detected nothing.
    regex: /\bcookie\s*\([\s\S]{0,200}?(?:httpOnly|secure)\s*:\s*false|\bset_cookie\s*\([\s\S]{0,200}?(?:httponly|secure)\s*=\s*False/i,
    requires: /session|sid|auth|token|jwt|login|remember/i,
    recommendation: "Set `httpOnly: true`, `secure: true` and an explicit `sameSite` on every cookie that carries session state. httpOnly is what stops an XSS bug from becoming a session theft.",
  },
  {
    type: "unrestricted_file_upload",
    severity: "medium",
    // multer/formidable configured with neither a size cap nor a filter.
    regex: /\bmulter\s*\(\s*\{\s*(?:dest|storage)\s*:[^}]*\}\s*\)|\bmulter\s*\(\s*\)/,
    unless: /fileFilter|limits/,
    recommendation: "Set `limits.fileSize` and a `fileFilter` that allowlists content types. Store uploads outside the web root, and generate your own filename — the client-supplied one is attacker input.",
  },
  {
    type: "remote_code_execution_install",
    severity: "high",
    regex: /\b(?:curl|wget)\b[^|\n]*\|\s*(?:sudo\s+)?(?:ba|z|)sh\b/,
    recommendation: "Download to a file, verify a pinned checksum or signature, then run it. A pipe to a shell executes whatever that URL serves at that instant, with the build's privileges.",
  },
  {
    type: "hardcoded_db_connection_string",
    scanLiterals: true, // a credentialed URI inside a string IS the leak
    severity: "critical",
    // A driver URI carrying inline credentials. The `:pass@` shape is the
    // finding — a URI with no password in it is not one.
    regex: /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqp|mssql):\/\/[A-Za-z0-9._%-]+:[^@\s"'`$]{3,}@/,
    unless: /\$\{|process\.env|os\.getenv|<[a-z_]+>|:password@|:pass@|:changeme@|:secret@|localhost:.*:.*@$/i,
    recommendation: "Rotate the database password, then build the connection string from environment variables at runtime. A committed URI is a credential plus the address it opens.",
  },
  {
    type: "xss_sink",
    severity: "high",
    // innerHTML / document.write fed something that isn't a bare literal,
    // plus React's explicit escape hatch.
    regex: /\.innerHTML\s*=\s*(?:[^"'`\s][^;]*|`[^`]*\$\{)|\bdocument\.write\s*\(\s*[^"')]|dangerouslySetInnerHTML/,
    // Sanitizing at the sink is the documented fix. Continuing to flag the
    // fixed line would make the finding impossible to clear, which is how a
    // rule ends up globally suppressed along with its true positives.
    unless: /DOMPurify|\bsanitize|\bescapeHtml\b|\bxss\s*\(|createDOMPurify/i,
    recommendation: "Assigning untrusted data to innerHTML executes it. Use textContent for text, or sanitize with a vetted library (DOMPurify) when HTML is genuinely required.",
  },
];

function detectCodePatterns(file) {
  const findings = [];
  const lines = file.content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const text = lines[i];
    if (isCommentLine(text)) continue;
    const ci = commentStartIndex(text);
    const code = ci >= 0 ? text.slice(0, ci) : text;
    // See the maskLiterals block: a match STARTING inside a string or regex
    // literal is a mention of the shape, not the shape — this table is where
    // the scanner reported five of its own rule definitions as
    // vulnerabilities. Rules marked scanLiterals (PEM banners, connection
    // strings) are exempt: string data is exactly where those leak.
    const maskedCode = maskLiterals(code);

    for (const pat of CODE_PATTERNS) {
      const m = pat.regex.exec(code);
      if (!m) continue;
      if (!pat.scanLiterals && insideLiteral(code, maskedCode, m.index)) continue;
      if (pat.unless && pat.unless.test(code)) continue;
      if (pat.requires && !pat.requires.test(code)) continue;
      findings.push({
        severity: pat.severity,
        type: pat.type,
        path: file.path,
        line: i + 1,
        snippet: trimSnippet(text),
        recommendation: pat.recommendation,
      });
    }
  }
  return findings;
}

// ---------------------------------------------------------------------------
// Detector 7: Dockerfile ADD from a remote URL
// ---------------------------------------------------------------------------
//
// Its own detector rather than a table row because it is only a finding in a
// Dockerfile: `ADD https://...` in prose, a shell script, or a test fixture is
// not an instruction Docker will execute. The table has no access to the path.

const DOCKERFILE_RE = /(?:^|\/)Dockerfile(?:\.[\w.-]+)?$/i;

function detectDockerfileRisks(file) {
  if (!DOCKERFILE_RE.test(file.path)) return [];
  const findings = [];
  const lines = file.content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const text = lines[i];
    if (/^\s*#/.test(text)) continue;
    if (/^\s*ADD\s+(?:--\S+\s+)*https?:\/\//i.test(text)) {
      findings.push({
        severity: "medium",
        type: "dockerfile_remote_add",
        path: file.path,
        line: i + 1,
        snippet: trimSnippet(text),
        recommendation: "Replace with `RUN curl -fsSL <url> -o file && echo '<sha256>  file' | sha256sum -c -` so the build fails loudly when the remote payload changes. ADD also auto-extracts archives, which is a second surprise.",
      });
    }
  }
  return findings;
}

// ---------------------------------------------------------------------------
// Detector 8: multi-tenant queries missing their tenant filter
// ---------------------------------------------------------------------------
//
// This one needs the whole FILE, which is what makes it worth having and also
// what keeps it honest. A query with no tenant column in its WHERE clause is
// unremarkable on its own — most applications are not multi-tenant, and a
// scanner that flagged every un-scoped SELECT would be unusable.
//
// So the rule is comparative: it only fires in a file where OTHER queries
// against the same table DO filter by a tenant column. That is the file
// telling us its own convention, and the finding is the line that departs
// from it. Confidence stays `low` in the registry regardless — the analyzer
// cannot see whether scoping happens in a wrapper — but a low-confidence
// finding pointed at a real inconsistency is worth a human's thirty seconds,
// which a generic "this query has no WHERE clause" never is.

const TENANT_COL_RE = /\b(org_id|tenant_id|account_id|workspace_id|customer_id)\b/i;
const SQL_STATEMENT_RE = /\b(SELECT|UPDATE|DELETE)\b[\s\S]{0,400}?\bFROM\b\s+([A-Za-z_][\w.]*)|(?:\bUPDATE|\bDELETE\s+FROM)\s+([A-Za-z_][\w.]*)/i;

function detectMissingTenantScope(file) {
  if (!/\.(?:js|mjs|cjs|ts|tsx)$/i.test(file.path)) return [];
  const lines = file.content.split("\n");

  // Pass 1: which tables does this file ever scope by tenant?
  const scopedTables = new Set();
  const candidates = [];
  for (let i = 0; i < lines.length; i++) {
    const text = lines[i];
    if (isCommentLine(text)) continue;
    if (!/\b(SELECT|UPDATE|DELETE)\b/i.test(text)) continue;
    if (!/\b(FROM|UPDATE|INTO)\b/i.test(text)) continue;

    const m = SQL_STATEMENT_RE.exec(text);
    const table = m && (m[2] || m[3]);
    if (!table) continue;
    const key = table.toLowerCase();
    if (TENANT_COL_RE.test(text)) scopedTables.add(key);
    else if (/\bWHERE\b/i.test(text)) candidates.push({ line: i + 1, text, table: key });
  }

  // Pass 2: a candidate is a finding only when the file scopes that same
  // table elsewhere. No convention in the file, no claim from us.
  return candidates
    .filter((c) => scopedTables.has(c.table))
    .map((c) => ({
      // Medium, for the same reason as `use_of_exec` above, and the comment at
      // the head of this detector already concedes it: "the analyzer cannot
      // see whether scoping happens in a wrapper". It cannot, and on this
      // repository every one of the nine it raised was a query it had no way
      // to understand — an auth lookup that ESTABLISHES the tenant, updates
      // keyed on their own primary key, a retention sweep with only a time
      // predicate, and one deliberately cross-org admin route. All still worth
      // a human's thirty seconds. None worth a red build.
      severity: "medium",
      type: "missing_tenant_scope",
      path: file.path,
      line: c.line,
      snippet: trimSnippet(c.text),
      recommendation: `Other queries against \`${c.table}\` in this file filter by a tenant column and this one does not. Add the same filter, or move the scoping into a shared helper so it cannot be forgotten one statement at a time.`,
    }));
}

// ---------------------------------------------------------------------------
// Aggregator
// ---------------------------------------------------------------------------

const DETECTORS = [
  detectSecrets,
  detectDangerousEval,
  detectSqlConcat,
  detectSqlTemplateLiteral,
  detectInsecureHttp,
  detectCodePatterns,
  detectDockerfileRisks,
  detectMissingTenantScope,
];

const SEVERITY_RANK = { critical: 4, high: 3, medium: 2, low: 1 };

function normalizeFile(f) {
  return {
    path: typeof f?.path === "string" ? f.path.trim() : "<inline>",
    content: typeof f?.content === "string" ? f.content : "",
  };
}

/**
 * Run every detector on every file. After each file, run a global redaction
 * pass that masks any leaked secret strings out of every finding's snippet
 * (including findings from non-secret detectors that happened to land on a
 * line containing a secret). This is a hard safety property: the response
 * must never echo a secret back to the caller.
 *
 * Sort results by severity desc, then by path/line for stable ordering.
 * Idempotent against raw or pre-validated inputs.
 */
export function analyzeVuln(input) {
  const files = (input?.files ?? []).map(normalizeFile);
  const allFindings = [];
  const coverage = { filesScanned: 0, astParsed: 0, astUnparseable: [] };

  for (const file of files) {
    const fileFindings = [];
    for (const d of DETECTORS) fileFindings.push(...d(file));

    // The AST engine runs only where acorn can parse the file, and its
    // outcome is RECORDED either way. A file the parser could not read has
    // been scanned by the pattern engine alone, and reporting that as fully
    // covered would overstate exactly the checks the AST engine exists to
    // provide — so `astUnparseable` travels with the result and the UI says
    // "pattern only" rather than nothing.
    if (isAstParseable(file.path)) {
      const ast = analyzeFileAst(file);
      if (ast.parsed) coverage.astParsed++;
      else coverage.astUnparseable.push(file.path);
      fileFindings.push(...ast.findings);
    }
    coverage.filesScanned++;

    const secretsByLine = collectSecretsByLine(file);
    if (secretsByLine.size > 0) {
      for (const f of fileFindings) {
        const secrets = secretsByLine.get(f.line);
        if (secrets) f.snippet = maskSecretsInSnippet(f.snippet, secrets);
      }
    }
    allFindings.push(...fileFindings);
  }

  // Normalization joins registry metadata, fingerprints, dedupes the overlap
  // between the two engines, sorts and numbers. It runs AFTER the redaction
  // pass above so no fingerprint is ever derived from live secret material.
  const normalized = normalizeFindings(allFindings);
  const findings = normalized.findings;
  // What the test-code policy declined to show. Reported as a number rather
  // than dropped silently: a count that vanishes is how a scanner starts
  // lying about its coverage, and this one is the difference between "your
  // tests are clean" and "we stopped looking at your tests".
  coverage.suppressedInTests = normalized.suppressedInTests;

  // `findings` keeps every legacy field in the legacy order, so the existing
  // shape is unchanged for every existing reader; `summary` and `coverage`
  // are additive.
  return { findings, summary: summarizeFindings(findings), coverage };
}
