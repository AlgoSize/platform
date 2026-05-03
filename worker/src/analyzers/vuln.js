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
// Secret patterns (shared by detectSecrets and the global redaction pass)
// ---------------------------------------------------------------------------

const SECRET_PATTERNS = [
  {
    type: "hardcoded_aws_access_key",
    severity: "critical",
    regex: /\bAKIA[0-9A-Z]{16}\b/g,
    recommendation: "Rotate this AWS access key immediately and store credentials in environment variables or AWS Secrets Manager.",
  },
  {
    type: "hardcoded_github_personal_token",
    severity: "critical",
    regex: /\bghp_[A-Za-z0-9]{36}\b/g,
    recommendation: "Revoke this GitHub PAT at github.com/settings/tokens and inject the token via an environment variable.",
  },
  {
    type: "hardcoded_github_fine_grained_token",
    severity: "critical",
    regex: /\bgithub_pat_[A-Za-z0-9_]{82,}\b/g,
    recommendation: "Revoke this GitHub fine-grained PAT and inject the token via an environment variable.",
  },
  {
    type: "hardcoded_stripe_live_key",
    severity: "critical",
    regex: /\bsk_live_[A-Za-z0-9]{20,}\b/g,
    recommendation: "Roll this Stripe live key in the Stripe dashboard immediately — anyone with this key can charge cards on your account.",
  },
  {
    type: "hardcoded_slack_token",
    severity: "high",
    regex: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
    recommendation: "Revoke this Slack token in the Slack admin console and inject it via an environment variable.",
  },
];

// Strings we consider "obviously a placeholder, not a real secret".
const PLACEHOLDER_RE = /(\$\{|process\.env|os\.getenv|getenv\s*\(|import\.meta\.env|YOUR_|xxxxx|placeholder|example|fake|<your|<insert|todo|fixme|change[_-]?me|replace[_-]?me)/i;

const GENERIC_SECRET_RE = /(?:api[_-]?key|apikey|access[_-]?token|secret[_-]?key|client[_-]?secret|auth[_-]?token)\s*[:=]\s*["']([^"']{8,})["']/i;

/**
 * One pass per file: collect every secret string by line, so the global
 * redaction pass can scrub them out of any finding's snippet — not just
 * findings emitted by detectSecrets. Without this, an http:// or eval()
 * finding on a line that also contains a leaked AWS key would echo the
 * key in plaintext.
 */
function collectSecretsByLine(file) {
  const map = new Map();  // lineNumber -> Set<matchedString>
  const lines = file.content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const text = lines[i];
    const set = new Set();
    for (const pat of SECRET_PATTERNS) {
      pat.regex.lastIndex = 0;
      let m;
      while ((m = pat.regex.exec(text)) !== null) set.add(m[0]);
    }
    const generic = GENERIC_SECRET_RE.exec(text);
    if (generic && !PLACEHOLDER_RE.test(generic[1]) && !PLACEHOLDER_RE.test(text)) {
      set.add(generic[1]);
    }
    if (set.size) map.set(i + 1, set);
  }
  return map;
}

function maskSecretsInSnippet(snippet, secrets) {
  if (!secrets || secrets.size === 0) return snippet;
  let out = snippet;
  // Sort longest-first so longer secrets that contain shorter ones (rare but
  // possible) get redacted before the shorter substring would partially eat
  // them.
  const sorted = Array.from(secrets).sort((a, b) => b.length - a.length);
  for (const s of sorted) out = out.split(s).join("***REDACTED***");
  return out;
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

    for (const pat of SECRET_PATTERNS) {
      pat.regex.lastIndex = 0;
      let m;
      while ((m = pat.regex.exec(text)) !== null) {
        findings.push({
          severity: pat.severity,
          type: pat.type,
          path: file.path,
          line: lineNumber,
          snippet: trimSnippet(text),
          recommendation: pat.recommendation,
        });
      }
    }

    const generic = GENERIC_SECRET_RE.exec(text);
    if (generic && !PLACEHOLDER_RE.test(generic[1]) && !PLACEHOLDER_RE.test(text)) {
      findings.push({
        severity: isCommentLine(text) ? "low" : "high",
        type: "hardcoded_generic_secret",
        path: file.path,
        line: lineNumber,
        snippet: trimSnippet(text),
        recommendation: "Move this credential to an environment variable or secret store; never commit raw secrets to source control.",
      });
    }
  }
  return findings;
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

    const evalMatch    = /\beval\s*\(/.exec(code);
    const newFuncMatch = /\bnew\s+Function\s*\(/.exec(code);
    const execMatch    = /\bexec\s*\(/.exec(code);

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
        severity: "high",
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

const SQL_KEYWORD = /(SELECT|INSERT|UPDATE|DELETE|FROM|WHERE|VALUES|JOIN|UNION)/i;

function detectSqlConcat(file) {
  const findings = [];
  const lines = file.content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const text = lines[i];
    if (isCommentLine(text)) continue;
    const ci = commentStartIndex(text);
    const code = ci >= 0 ? text.slice(0, ci) : text;

    const left  = /["'][^"']*\b(SELECT|INSERT|UPDATE|DELETE|FROM|WHERE|VALUES)\b[^"']*["']\s*\+\s*[A-Za-z_$][\w$.]*/i;
    const right = /[A-Za-z_$][\w$.]*\s*\+\s*["'][^"']*\b(SELECT|INSERT|UPDATE|DELETE|FROM|WHERE|VALUES)\b[^"']*["']/i;
    if (left.test(code) || right.test(code)) {
      findings.push({
        severity: "high",
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
    if (SQL_KEYWORD.test(body) && /\$\{[^}]+\}/.test(body)) {
      findings.push({
        severity: "high",
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
// Aggregator
// ---------------------------------------------------------------------------

const DETECTORS = [
  detectSecrets,
  detectDangerousEval,
  detectSqlConcat,
  detectSqlTemplateLiteral,
  detectInsecureHttp,
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

  for (const file of files) {
    const fileFindings = [];
    for (const d of DETECTORS) fileFindings.push(...d(file));

    const secretsByLine = collectSecretsByLine(file);
    if (secretsByLine.size > 0) {
      for (const f of fileFindings) {
        const secrets = secretsByLine.get(f.line);
        if (secrets) f.snippet = maskSecretsInSnippet(f.snippet, secrets);
      }
    }
    allFindings.push(...fileFindings);
  }

  allFindings.sort((a, b) =>
    (SEVERITY_RANK[b.severity] ?? 0) - (SEVERITY_RANK[a.severity] ?? 0) ||
    a.path.localeCompare(b.path) ||
    a.line - b.line ||
    a.type.localeCompare(b.type)
  );
  return { findings: allFindings };
}
