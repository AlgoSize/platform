// Normalized finding schema for the source-code scanner.
//
// The raw detectors (the pattern engine in analyzers/vuln.js, the AST engine
// in sast/ast.js) emit the minimal legacy shape this endpoint has always
// returned: { severity, type, path, line, snippet, recommendation }. This
// module is the one place that turns those into gradeable findings —
// registry metadata joined on, language detected, fingerprinted, deduped,
// sorted, numbered, summarized.
//
// Every legacy field is preserved untouched. scripts/test-vuln.mjs pins the
// old shape and every existing caller keeps working; the new fields are
// strictly additive. That is the contract: extending the schema must never be
// able to change what an old reader sees.

import { rulesForTypes, DEFAULT_RULE } from "./registry.js";

export const SEVERITIES  = Object.freeze(["critical", "high", "medium", "low", "info"]);
export const CONFIDENCES = Object.freeze(["high", "medium", "low"]);

export const SEVERITY_RANK   = Object.freeze({ critical: 5, high: 4, medium: 3, low: 2, info: 1 });
export const CONFIDENCE_RANK = Object.freeze({ high: 3, medium: 2, low: 1 });

// The coarse buckets the UI groups by. A rule declares exactly one, and the
// list is closed — a typo in a registry entry fails the test suite instead of
// silently creating a category of one that no filter will ever show.
export const CATEGORIES = Object.freeze([
  "injection",        // untrusted data becomes syntax: SQL, command, code, template, XXE
  "xss",
  "traversal",
  "secrets",          // credentials committed to source
  "auth",             // authentication weaknesses
  "access-control",   // authorization, ownership, tenant isolation
  "crypto",           // weak algorithms, bad randomness, TLS verification off
  "data-exposure",    // secrets or PII reaching logs / cleartext transport
  "deserialization",
  "ssrf",
  "redirect",
  "configuration",    // insecure defaults, debug surface, CORS, cookie flags
  "supply-chain",     // install-time and fetch-and-execute risk
  "dependency",       // known-vulnerable packages, mapped in from the audit
]);

// ---------------------------------------------------------------------------
// Language detection
// ---------------------------------------------------------------------------

const LANGUAGE_BY_EXT = {
  js: "javascript", mjs: "javascript", cjs: "javascript", jsx: "javascript",
  ts: "typescript", tsx: "typescript",
  py: "python", rb: "ruby", go: "go", php: "php", java: "java",
  sh: "shell", bash: "shell",
  yml: "yaml", yaml: "yaml", json: "json", toml: "toml",
  tf: "terraform", sql: "sql", html: "html",
};

export function languageForPath(path) {
  const base = String(path || "").split("/").pop().toLowerCase();
  if (base === "dockerfile" || base.startsWith("dockerfile.")) return "dockerfile";
  if (base.startsWith(".env")) return "env";
  const ext = base.includes(".") ? base.split(".").pop() : "";
  return LANGUAGE_BY_EXT[ext] || "text";
}

/**
 * True for files the AST engine can parse.
 *
 * Deliberately narrow: acorn parses JavaScript, and TypeScript's type
 * annotations are a syntax error to it. Handing it a .ts file would throw on
 * every one and the engine would report "unparseable" for a language the
 * product is mostly written in — a coverage number that reads as a bug. The
 * pattern engine covers TypeScript, and the roadmap in SECURITY-SCANNING.md
 * names the parser swap that would widen this.
 */
export function isAstParseable(path) {
  return /\.(?:js|mjs|cjs)$/i.test(String(path || ""));
}

// ---------------------------------------------------------------------------
// Fingerprints
// ---------------------------------------------------------------------------
//
// Four requirements, and the third is the one that shapes the design:
//
//   1. stable across scans — the same code yields the same fingerprint
//   2. distinct per defect
//   3. NOT keyed on the line number. Inserting a comment at the top of a file
//      must not re-identify every finding below it, or a "new findings" diff
//      reports the whole file as new after a whitespace commit.
//   4. computed from the MASKED snippet, never live credential material.
//
// Two identical findings in one file are separated by an occurrence counter,
// so the third copy of the same bad line still gets its own identity.

/** FNV-1a, run twice with different seeds and concatenated -> 16 hex chars. */
function fnv1a(str, seed) {
  let h = seed >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

export function fingerprintOf({ ruleId, path, snippet }, occurrence = 0) {
  const material = `${ruleId}|${path}|${String(snippet).replace(/\s+/g, " ").trim()}|${occurrence}`;
  const a = fnv1a(material, 0x811c9dc5).toString(16).padStart(8, "0");
  const b = fnv1a(material, 0x01000197).toString(16).padStart(8, "0");
  return a + b;
}

// ---------------------------------------------------------------------------
// Test code
// ---------------------------------------------------------------------------

// Whole path components and basename shapes that mean "this file is a test".
// Deliberately conservative: `test/` as a directory, `foo.test.js`,
// `test-foo.mjs`, `foo.spec.ts` — not any path merely containing the letters.
const TEST_DIR_RE = /(^|\/)(test|tests|__tests__|spec|specs|e2e)(\/)/i;
const TEST_BASENAME_RE = /(^|\/)(?:test[-_.][^/]*|[^/]*[-_.]test\.[^/.]+|[^/]*\.(?:test|spec)\.[^/.]+|spec[-_.][^/]*)$/i;

/** Is this path recognizably test code? */
export function isTestCodePath(path) {
  const p = String(path || "");
  return TEST_DIR_RE.test(p) || TEST_BASENAME_RE.test(p);
}

// The highest severity a non-secret finding in test code can carry.
//
// An injection pattern in a test file is almost always a planted vector or a
// mock — it is not reachable attack surface, and reporting it at high parity
// with the same pattern in a request handler buries the handler. This
// repository's own gate demonstrated the failure: the top of its report was
// its own scanner test suite. Capped rather than dropped — the finding is
// still true and still listed, labelled for what it is.
//
// SECRETS ARE NEVER CAPPED. A credential does not care which directory it
// leaks from; a real key pasted into a test is exactly as compromised as one
// in a handler, and test files are where real keys most often land.
const TEST_CODE_SEVERITY_CAP = "medium";

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

/**
 * Join registry metadata onto raw detector output.
 *
 * A raw finding whose `type` has no registry entry gets DEFAULT_RULE — an
 * explicit "unregistered" marker rather than a throw or a drop. Dropping it
 * would fail in the silent direction, which is the one failure mode this
 * codebase refuses everywhere. What actually keeps the registry complete is
 * the test that runs the engines over the fixture corpus and asserts the
 * marker never appears.
 */
export function normalizeFindings(rawFindings, { dedupe = true } = {}) {
  const byType = rulesForTypes();
  const occurrenceCount = new Map();

  let findings = rawFindings.map((raw) => {
    const rule = byType.get(raw.type) || DEFAULT_RULE;
    const base = {
      // Legacy shape, untouched.
      severity: raw.severity,
      type: raw.type,
      path: raw.path,
      line: raw.line,
      snippet: raw.snippet,
      recommendation: raw.recommendation,
      // Normalized additions.
      ruleId: rule.id,
      title: rule.title,
      category: rule.category,
      cwe: rule.cwe,
      owasp: rule.owasp,
      // A detector may override the registry baseline — a taint-confirmed
      // sink is a stronger claim than the same line matched by a regex — but
      // it never invents one, so an unset override keeps the rule's default.
      confidence: raw.confidence || rule.confidence,
      language: languageForPath(raw.path),
      module: raw.module || rule.module,
    };
    if (raw.column !== undefined) base.column = raw.column;
    if (raw.evidence !== undefined) base.evidence = raw.evidence;

    if (base.category !== "secrets" && isTestCodePath(base.path) &&
        (SEVERITY_RANK[base.severity] || 0) > SEVERITY_RANK[TEST_CODE_SEVERITY_CAP]) {
      base.severity = TEST_CODE_SEVERITY_CAP;
      base.evidence = { ...(base.evidence || {}), inTestCode: true, severityCapped: true };
    }

    const occKey = `${base.ruleId}|${base.path}|${String(base.snippet).replace(/\s+/g, " ").trim()}`;
    const occ = occurrenceCount.get(occKey) || 0;
    occurrenceCount.set(occKey, occ + 1);
    base.fingerprint = fingerprintOf(base, occ);
    return base;
  });

  if (dedupe) findings = dedupeFindings(findings, byType);
  sortFindings(findings);
  findings.forEach((f, i) => { f.id = "VS-" + String(i + 1).padStart(4, "0"); });
  return findings;
}

/**
 * Cross-analyzer dedupe.
 *
 * The two engines deliberately overlap: `exec("ls " + req.query.dir)` is
 * caught by the regex table on any file and by the taint tracker on
 * parseable JavaScript. Both firing is correct DETECTION and wrong
 * REPORTING — one defect must be one row, or the scanner's own thoroughness
 * inflates every count it produces.
 *
 * Rules describing the same defect share a registry `group`; within a group,
 * findings on the same path+line collapse to the strongest claim (severity,
 * then confidence, then the AST module, which carries a source/sink path the
 * pattern match cannot).
 *
 * Rules with no group never collapse across rules — only exact repeats of
 * the same rule at the same place do. Two DIFFERENT leaked credentials on one
 * line are two rotations, not one finding.
 */
export function dedupeFindings(findings, byType = rulesForTypes()) {
  const byKey = new Map();
  const keep = [];
  for (const f of findings) {
    const rule = byType.get(f.type) || DEFAULT_RULE;
    const groupKey = rule.group
      ? `g|${rule.group}|${f.path}|${f.line}`
      : `r|${f.ruleId}|${f.path}|${f.line}|${f.fingerprint}`;
    const existing = byKey.get(groupKey);
    if (!existing) { byKey.set(groupKey, f); keep.push(f); continue; }
    if (strongerOf(existing, f) === f) {
      keep[keep.indexOf(existing)] = f;
      byKey.set(groupKey, f);
    }
  }
  return keep;
}

function strongerOf(a, b) {
  const sev = (SEVERITY_RANK[b.severity] || 0) - (SEVERITY_RANK[a.severity] || 0);
  if (sev !== 0) return sev > 0 ? b : a;
  const conf = (CONFIDENCE_RANK[b.confidence] || 0) - (CONFIDENCE_RANK[a.confidence] || 0);
  if (conf !== 0) return conf > 0 ? b : a;
  if (a.module !== b.module) return b.module === "ast-analyzer" ? b : a;
  return a;
}

/** Severity desc, then path/line/type — the ordering the legacy tests pin. */
export function sortFindings(findings) {
  findings.sort((a, b) =>
    (SEVERITY_RANK[b.severity] ?? 0) - (SEVERITY_RANK[a.severity] ?? 0) ||
    a.path.localeCompare(b.path) ||
    a.line - b.line ||
    a.type.localeCompare(b.type));
  return findings;
}

/** The counts the UI's chips read. Every severity present even at zero. */
export function summarizeFindings(findings) {
  const bySeverity = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
  const byCategory = {};
  const byModule = {};
  for (const f of findings) {
    if (bySeverity[f.severity] !== undefined) bySeverity[f.severity]++;
    byCategory[f.category] = (byCategory[f.category] || 0) + 1;
    byModule[f.module] = (byModule[f.module] || 0) + 1;
  }
  return { total: findings.length, bySeverity, byCategory, byModule };
}

/**
 * A dependency advisory as a normalized finding.
 *
 * The advisory keeps its own richer shape in `advisories` — nothing is taken
 * away. This mapping exists so severity chips, category grouping and SARIF
 * can treat all three classes (source, secrets, dependency) through one
 * schema instead of three near-identical code paths that drift.
 *
 * `unknown` severity becomes `info` rather than being dropped or guessed
 * upward: OSV genuinely does publish advisories with no severity, and
 * inventing one would be the scanner overclaiming.
 */
export function advisoryToFinding(a) {
  return {
    severity: a.severity === "unknown" ? "info" : a.severity,
    type: "vulnerable_dependency",
    path: a.manifest || a.ecosystem || "dependencies",
    line: 0,
    snippet: `${a.package}@${a.installedVersion}${a.fixedIn ? ` (fixed in ${a.fixedIn})` : ""}`,
    recommendation: a.fixedIn
      ? `Upgrade ${a.package} to ${a.fixedIn} or later.`
      : `No fixed version is published yet — watch ${a.id} and consider a mitigation or a replacement package.`,
    ruleId: "deps.known-vulnerability",
    title: `Known vulnerability in ${a.package}`,
    category: "dependency",
    cwe: [],
    owasp: ["A06:2021-Vulnerable and Outdated Components"],
    confidence: "high",
    language: a.ecosystem || "unknown",
    module: "dependency-analyzer",
    evidence: { advisory: a.id, url: a.advisoryUrl || null },
    fingerprint: fingerprintOf({ ruleId: "deps.known-vulnerability", path: a.package, snippet: a.id }),
  };
}
