// Tests for the cyber-security auditor: CVSS scoring, OSV advisory
// extraction, lockfile name normalization, the new source detectors, and the
// audit verdict.
//
// Every block here corresponds to a bug that was live in the scanner:
//   1. CVSS vectors never produced a severity (the parser looked for a bare
//      number inside a vector that contains none), so most PyPI/Go/distro
//      advisories came back "unknown".
//   2. `fixedIn` took the last `fixed` event across all ranges, including
//      GIT ranges — so remediation advice was sometimes a commit SHA.
//   3. PyPI names weren't PEP 503-normalized, so `Flask_Cors==3.0.0` matched
//      nothing in OSV: a silent false negative.
//   4. `/\bexec\s*\(/` flagged every `regex.exec(str)` call as command
//      execution.
//   5. Package/vuln caps truncated the audit silently.
//   6. The vuln summary line dropped `unknown` from its total.
//
// Run with:  node scripts/test-security-audit.mjs

import { scoreCvssVector, severityForScore } from "../src/analyzers/cvss.js";
import { osvHydrateVulns, osvBatchQuery, compareVersions, MAX_VULNS_TO_HYDRATE } from "../src/analyzers/osv.js";
import { parseLockfile, normalizePypiName } from "../src/analyzers/lockfile.js";
import { analyzeVuln } from "../src/analyzers/vuln.js";
import { buildAuditSummary, countBySeverity, gradeForScore, worstSeverity } from "../src/analyzers/audit.js";
import { analyzeVulnHandler } from "../src/handlers/analyze.js";
import { summarize } from "../src/handlers/runs.js";

let failures = 0;
const ok   = (msg) => console.log(`  \x1b[32m✓\x1b[0m ${msg}`);
const fail = (msg) => { console.log(`  \x1b[31m✗\x1b[0m ${msg}`); failures++; };
const expect = (cond, label) => cond ? ok(label) : fail(label);

const scan = (content, path = "app.js") => analyzeVuln({ files: [{ path, content }] }).findings;
const typesIn = (content, path) => scan(content, path).map((f) => f.type);
const has = (content, type, path) => typesIn(content, path).includes(type);

// ---------------------------------------------------------------------------
console.log("\ncvss.js — base score from a vector\n");
// ---------------------------------------------------------------------------

// Reference vectors with published base scores (FIRST calculator).
const V3_CASES = [
  ["CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H", 9.8, "critical"],
  ["CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:H", 7.5, "high"],
  ["CVSS:3.1/AV:N/AC:L/PR:N/UI:R/S:C/C:L/I:L/A:N", 6.1, "medium"],
  ["CVSS:3.1/AV:L/AC:L/PR:L/UI:N/S:U/C:H/I:N/A:N", 5.5, "medium"],
  ["CVSS:3.1/AV:N/AC:H/PR:N/UI:N/S:U/C:N/I:N/A:L", 3.7, "low"],
  ["CVSS:3.0/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H", 9.8, "critical"],
  ["CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:N", 0.0, "none"],
];
for (const [vector, score, severity] of V3_CASES) {
  const r = scoreCvssVector(vector);
  expect(r && r.score === score && r.severity === severity,
         `${vector.slice(0, 34)}… → ${score} (${severity})${r ? ` [got ${r.score} ${r.severity}]` : " [got null]"}`);
}
expect(scoreCvssVector(V3_CASES[0][0]).approximate === false, "an exact v3 vector is not flagged approximate");

// CVSS v2 has its own formula and no version prefix.
expect(scoreCvssVector("AV:N/AC:L/Au:N/C:C/I:C/A:C").score === 10, "v2 AV:N/AC:L/Au:N/C:C/I:C/A:C → 10.0");
expect(scoreCvssVector("AV:N/AC:M/Au:N/C:P/I:N/A:N").score === 4.3, "v2 AV:N/AC:M/Au:N/C:P/I:N/A:N → 4.3");
expect(scoreCvssVector("AV:N/AC:M/Au:N/C:P/I:N/A:N").version === "2.0", "v2 vectors are identified as 2.0");

// v4 is approximated, and must say so.
{
  const r = scoreCvssVector("CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:H/VA:H/SC:N/SI:N/SA:N");
  expect(r && r.approximate === true, "a v4 vector is scored but flagged approximate");
  expect(r && r.severity === "critical", `v4 all-high maps to critical (got ${r && r.severity})`);
}

// Tolerated real-world shapes.
expect(scoreCvssVector("CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H 9.8").score === 9.8,
       "a vector with its score appended still parses");
expect(scoreCvssVector("9.1").score === 9.1, "a plain numeric score is accepted");
expect(scoreCvssVector("7").severity === "high", "an integer score is accepted");

// Rejections.
for (const bad of [null, undefined, "", "   ", "not-a-vector", "CVSS:3.1/AV:X/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H", "11.5", 42]) {
  expect(scoreCvssVector(bad) === null, `rejects ${JSON.stringify(bad)}`);
}
expect(scoreCvssVector("CVSS:3.1/AV:N/AC:L") === null, "rejects a vector missing mandatory metrics");

expect(severityForScore(9.0) === "critical" && severityForScore(8.9) === "high", "critical/high boundary is 9.0");
expect(severityForScore(7.0) === "high" && severityForScore(6.9) === "medium", "high/medium boundary is 7.0");
expect(severityForScore(4.0) === "medium" && severityForScore(3.9) === "low", "medium/low boundary is 4.0");
expect(severityForScore(0) === "none" && severityForScore("x") === "unknown", "0.0 is none; garbage is unknown");

// ---------------------------------------------------------------------------
console.log("\nosv.js — severity + fix extraction\n");
// ---------------------------------------------------------------------------

/** Stub OSV: /v1/vulns/<id> returns the detail we hand it. */
function osvStub(detailsById, { onVulnFetch } = {}) {
  return async (url) => {
    const m = /\/v1\/vulns\/(.+)$/.exec(String(url));
    if (m) {
      if (onVulnFetch) onVulnFetch(decodeURIComponent(m[1]));
      const d = detailsById[decodeURIComponent(m[1])];
      return d ? { ok: true, json: async () => d } : { ok: false, status: 404 };
    }
    return { ok: false, status: 404 };
  };
}

const pkg = (name = "vulnpkg", version = "1.0.0") => ({ name, version, ecosystem: "npm" });

{
  // The headline bug: a CVSS vector with no text rating must still triage.
  const detail = {
    id: "PYSEC-1", summary: "RCE",
    severity: [{ type: "CVSS_V3", score: "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H" }],
    affected: [{ package: { name: "vulnpkg", ecosystem: "npm" }, ranges: [{ type: "SEMVER", events: [{ introduced: "0" }, { fixed: "2.0.0" }] }] }],
  };
  const [a] = await osvHydrateVulns([{ id: "PYSEC-1", package: pkg() }], osvStub({ "PYSEC-1": detail }));
  expect(a.severity === "critical", `CVSS-only advisory scores critical (got ${a.severity})`);
  expect(a.cvssScore === 9.8, "the numeric score travels with the advisory");
  expect(a.cvssVersion === "3.1" && typeof a.cvssVector === "string", "the vector and version are reported");
  expect(a.severityApproximate === false, "an exact score is not flagged approximate");
}

{
  // A vector must beat the text rating: the vector is the checkable source.
  const detail = {
    id: "G-1", summary: "x",
    database_specific: { severity: "LOW" },
    severity: [{ type: "CVSS_V3", score: "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H" }],
    affected: [],
  };
  const [a] = await osvHydrateVulns([{ id: "G-1", package: pkg() }], osvStub({ "G-1": detail }));
  expect(a.severity === "critical", "a CVSS vector outranks a text rating");
}

{
  // Text rating is still the fallback when there's no usable vector.
  const detail = { id: "G-2", summary: "x", database_specific: { severity: "MODERATE" }, severity: [], affected: [] };
  const [a] = await osvHydrateVulns([{ id: "G-2", package: pkg() }], osvStub({ "G-2": detail }));
  expect(a.severity === "medium", "GHSA MODERATE maps to medium");
  expect(a.cvssScore === null, "no vector means no numeric score is invented");
}

{
  const detail = { id: "G-3", summary: "x", severity: [{ score: "nonsense" }], affected: [] };
  const [a] = await osvHydrateVulns([{ id: "G-3", package: pkg() }], osvStub({ "G-3": detail }));
  expect(a.severity === "unknown", "an unscoreable advisory stays honestly unknown");
}

{
  // GIT ranges hold commit hashes, not versions.
  const detail = {
    id: "F-1", summary: "x", database_specific: { severity: "HIGH" },
    affected: [{
      package: { name: "vulnpkg", ecosystem: "npm" },
      ranges: [
        { type: "SEMVER", events: [{ introduced: "0" }, { fixed: "1.2.9" }] },
        { type: "GIT", repo: "https://github.com/x/y", events: [{ introduced: "0" }, { fixed: "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678" }] },
      ],
    }],
  };
  const [a] = await osvHydrateVulns([{ id: "F-1", package: pkg("vulnpkg", "1.2.0") }], osvStub({ "F-1": detail }));
  expect(a.fixedIn === "1.2.9", `GIT ranges are ignored for fixedIn (got ${a.fixedIn})`);
}

{
  // Multi-branch advisory: recommend the smallest upgrade that clears it.
  const detail = {
    id: "F-2", summary: "x", database_specific: { severity: "HIGH" },
    affected: [{
      package: { name: "vulnpkg", ecosystem: "npm" },
      ranges: [
        { type: "SEMVER", events: [{ introduced: "1.0.0" }, { fixed: "1.2.9" }] },
        { type: "SEMVER", events: [{ introduced: "2.0.0" }, { fixed: "2.0.4" }] },
        { type: "SEMVER", events: [{ introduced: "3.0.0" }, { fixed: "3.1.1" }] },
      ],
    }],
  };
  const [onOne] = await osvHydrateVulns([{ id: "F-2", package: pkg("vulnpkg", "1.2.0") }], osvStub({ "F-2": detail }));
  expect(onOne.fixedIn === "1.2.9", `a 1.2.x install is told to go to 1.2.9 (got ${onOne.fixedIn})`);
  const [onTwo] = await osvHydrateVulns([{ id: "F-2", package: pkg("vulnpkg", "2.0.1") }], osvStub({ "F-2": detail }));
  expect(onTwo.fixedIn === "2.0.4", `a 2.0.x install is told to go to 2.0.4 (got ${onTwo.fixedIn})`);
}

expect(compareVersions("1.9.0", "1.10.0") < 0, "compareVersions orders 1.9.0 before 1.10.0");
expect(compareVersions("4.17.21", "4.17.20") > 0, "compareVersions orders 4.17.21 after 4.17.20");
expect(compareVersions("1.2", "1.2.1") < 0, "a shorter version sorts before its own patch release");
expect(compareVersions("2.0.0", "2.0.0") === 0, "equal versions compare equal");

{
  // Truncation must be reported, not silent.
  const details = {};
  const matches = [];
  for (let i = 0; i < MAX_VULNS_TO_HYDRATE + 25; i++) {
    const id = `V-${i}`;
    details[id] = { id, summary: "x", database_specific: { severity: "HIGH" }, affected: [] };
    matches.push({ id, package: pkg(`p${i}`) });
  }
  const stats = {};
  const out = await osvHydrateVulns(matches, osvStub(details), stats);
  expect(out.length === MAX_VULNS_TO_HYDRATE, `hydration is capped at ${MAX_VULNS_TO_HYDRATE}`);
  expect(stats.vulnsMatched === MAX_VULNS_TO_HYDRATE + 25, "the stats report how many were matched");
  expect(stats.vulnsHydrated === MAX_VULNS_TO_HYDRATE, "the stats report how many were hydrated");
  expect(stats.vulnsTruncated === true, "truncation is flagged");
}

{
  // Duplicate ids across packages must not eat hydration budget.
  const details = { "DUP": { id: "DUP", summary: "x", database_specific: { severity: "LOW" }, affected: [] } };
  const fetched = [];
  const matches = Array.from({ length: 5 }, (_, i) => ({ id: "DUP", package: pkg(`p${i}`) }));
  const stats = {};
  const out = await osvHydrateVulns(matches, osvStub(details, { onVulnFetch: (id) => fetched.push(id) }), stats);
  expect(fetched.length === 1, "a repeated advisory id is fetched once");
  expect(out.length === 5, "but is reported once per affected install");
  expect(stats.vulnsTruncated === false, "five copies of one advisory is not truncation");
}

{
  // Batch-query truncation.
  const packages = Array.from({ length: 1200 }, (_, i) => ({ name: `p${i}`, version: "1.0.0", ecosystem: "npm" }));
  const stats = {};
  const fetchImpl = async () => ({ ok: true, json: async () => ({ results: [] }) });
  await osvBatchQuery(packages, fetchImpl, stats);
  expect(stats.packagesQueried === 1000, "the batch query is capped at 1000 packages");
  expect(stats.packagesTruncated === true, "batch truncation is flagged");
}

// ---------------------------------------------------------------------------
console.log("\nlockfile.js — PEP 503 names\n");
// ---------------------------------------------------------------------------

expect(normalizePypiName("Flask_Cors") === "flask-cors", "underscores normalize to hyphens");
expect(normalizePypiName("zope.interface") === "zope-interface", "dots normalize to hyphens");
expect(normalizePypiName("Django") === "django", "names lowercase");
expect(normalizePypiName("ruamel--yaml__x") === "ruamel-yaml-x", "runs of separators collapse");

{
  const { packages } = parseLockfile("requirements.txt",
    "Flask_Cors==3.0.0\nzope.interface==5.0\nDjango==4.0\nrequests[security]==2.25.1\n");
  const names = packages.map((p) => p.name);
  expect(names.includes("flask-cors"), `Flask_Cors → flask-cors (got ${names.join(", ")})`);
  expect(names.includes("zope-interface"), "zope.interface → zope-interface");
  expect(names.includes("requests"), "a package with extras still parses");
  expect(packages.find((p) => p.name === "requests").version === "2.25.1", "the extras form keeps its version");
}

// ---------------------------------------------------------------------------
console.log("\nvuln.js — exec false positive\n");
// ---------------------------------------------------------------------------

expect(!has("const m = SECRET_RE.exec(line);", "use_of_exec"),
       "RegExp.prototype.exec is NOT reported as command execution");
expect(!has("while ((m = re.exec(text)) !== null) { count++; }", "use_of_exec"),
       "an exec() loop is not reported");
expect(!has("const parts = pattern.exec(input) || [];", "use_of_exec"),
       "a guarded exec() call is not reported");
expect(has("exec(open(path).read())", "use_of_exec", "run.py"),
       "a bare exec() (Python) is still reported");
expect(has("const { exec } = require('child_process');\nexec(cmd);", "use_of_exec"),
       "a destructured child_process exec is still reported");
expect(has("child_process.execSync(cmd)", "use_of_exec"),
       "child_process.execSync is reported");
expect(has("os.system(cmd)", "use_of_exec", "run.py"), "os.system is reported");
expect(has("subprocess.run(cmd, shell=True)", "use_of_exec", "run.py"),
       "subprocess with shell=True is reported");
expect(has("eval(userInput)", "use_of_eval"), "eval is still reported");

// ---------------------------------------------------------------------------
console.log("\nvuln.js — new detectors\n");
// ---------------------------------------------------------------------------

const DETECTOR_CASES = [
  ["private_key_material", "-----BEGIN RSA PRIVATE KEY-----", "key.pem", "critical"],
  ["private_key_material", "-----BEGIN OPENSSH PRIVATE KEY-----", "id_ed25519", "critical"],
  ["disabled_tls_verification", "const agent = new https.Agent({ rejectUnauthorized: false });", "app.js", "high"],
  ["disabled_tls_verification", "r = requests.get(url, verify=False)", "fetch.py", "high"],
  ["disabled_tls_verification", "tr := &http.Transport{TLSClientConfig: &tls.Config{InsecureSkipVerify: true}}", "main.go", "high"],
  ["insecure_deserialization", "data = pickle.loads(payload)", "load.py", "high"],
  ["insecure_deserialization", "cfg = yaml.load(raw)", "load.py", "high"],
  ["command_injection", "exec(`convert ${userFile} out.png`)", "img.js", "critical"],
  ["command_injection", 'os.system("rm -rf " + target)', "clean.py", "critical"],
  ["weak_hash_algorithm", "const h = crypto.createHash('md5').update(pw).digest('hex');", "auth.js", "medium"],
  ["weak_hash_algorithm", "digest = hashlib.sha1(data).hexdigest()", "hash.py", "medium"],
  ["insecure_randomness", "const token = Math.random().toString(36);", "auth.js", "medium"],
  ["xss_sink", "el.innerHTML = userComment;", "ui.js", "high"],
  ["xss_sink", "<div dangerouslySetInnerHTML={{ __html: body }} />", "Post.jsx", "high"],
];
for (const [type, content, path, severity] of DETECTOR_CASES) {
  const f = scan(content, path).find((x) => x.type === type);
  expect(f && f.severity === severity,
         `${type}: ${content.slice(0, 46)}${content.length > 46 ? "…" : ""}`);
}

// False positives the new detectors must NOT produce.
const BENIGN = [
  ["yaml.load(raw, Loader=yaml.SafeLoader)", "load.py", "insecure_deserialization"],
  ["yaml.safe_load(raw)", "load.py", "insecure_deserialization"],
  ["const jitter = Math.random() * 100;", "anim.js", "insecure_randomness"],
  ["const idx = Math.floor(Math.random() * items.length);", "pick.js", "insecure_randomness"],
  ["el.innerHTML = '';", "ui.js", "xss_sink"],
  ['el.innerHTML = "<hr>";', "ui.js", "xss_sink"],
  ["const h = crypto.createHash('sha256').update(x).digest();", "hash.js", "weak_hash_algorithm"],
  ["// rejectUnauthorized: false was removed here", "app.js", "disabled_tls_verification"],
];
for (const [content, path, type] of BENIGN) {
  expect(!has(content, type, path), `no ${type} for: ${content.slice(0, 48)}`);
}

{
  // The scanner must still redact secrets from snippets of new findings.
  const out = scan("const h = crypto.createHash('md5').update('AKIAIOSFODNN7EXAMPLE').digest();");
  expect(out.every((f) => !f.snippet.includes("AKIAIOSFODNN7EXAMPLE")),
         "secrets stay redacted in the new detectors' snippets");
  expect(out.some((f) => f.snippet.includes("***REDACTED***")), "the redaction marker is present");
}

// ---------------------------------------------------------------------------
console.log("\naudit.js — the verdict\n");
// ---------------------------------------------------------------------------

expect(gradeForScore(100) === "A" && gradeForScore(90) === "A" && gradeForScore(89) === "B", "A/B boundary is 90");
expect(gradeForScore(60) === "C" && gradeForScore(59) === "D", "C/D boundary is 60");
expect(worstSeverity({ critical: 0, high: 0, medium: 2, low: 1, unknown: 0 }) === "medium", "worstSeverity picks the top band present");
expect(worstSeverity({ critical: 0, high: 0, medium: 0, low: 0, unknown: 0 }) === null, "worstSeverity is null on a clean audit");
expect(countBySeverity([{ severity: "critical" }, { severity: "nonsense" }, {}]).unknown === 2,
       "unrecognized and missing severities count as unknown");

{
  const clean = buildAuditSummary({ findings: [], advisories: [] });
  expect(clean.securityScore === 100 && clean.grade === "A", "a clean audit scores 100/A");
  expect(clean.totalIssues === 0 && clean.worstSeverity === null, "a clean audit reports nothing outstanding");
  expect(clean.remediation.length === 0, "a clean audit has no remediation steps");
  expect(clean.complete === true, "a clean audit is complete");
}

{
  const s = buildAuditSummary({
    findings: [
      { severity: "critical", type: "hardcoded_aws_access_key", path: "a.js", line: 3 },
      { severity: "high",     type: "sql_string_concatenation", path: "b.js", line: 9 },
      { severity: "medium",   type: "weak_hash_algorithm",      path: "c.js", line: 1 },
    ],
    advisories: [
      { severity: "critical", package: "lodash", installedVersion: "4.17.20", fixedIn: "4.17.21" },
      { severity: "high",     package: "minimist", installedVersion: "1.2.0", fixedIn: null },
    ],
    fixCommand: "npm audit fix",
  });
  expect(s.totalIssues === 5, "issues from both sources are counted");
  expect(s.counts.critical === 2 && s.counts.high === 2 && s.counts.medium === 1, "counts split by severity");
  expect(s.securityScore === 100 - (25 * 2 + 12 * 2 + 4), `score deducts per severity (got ${s.securityScore})`);
  expect(s.securityScore <= 39, "a critical finding caps the score in the F band");
  expect(s.grade === "F" && s.worstSeverity === "critical", "two criticals grade F");
  expect(s.sourceFindings === 3 && s.dependencyAdvisories === 2, "the two sources are reported separately");

  expect(/Rotate 1 exposed credential/.test(s.remediation[0].action), "credential rotation is the first step");
  expect(s.remediation[0].priority === "now", "rotation is priority `now`");
  expect(/a\.js:3/.test(s.remediation[0].action), "the step names where the secret is");
  const upgrade = s.remediation.find((r) => /Upgrade 1 vulnerable/.test(r.action));
  expect(!!upgrade, "fixable dependencies get an upgrade step");
  expect(upgrade.command === "npm audit fix", "the upgrade step carries the ecosystem command");
  expect(/lodash 4\.17\.20 → 4\.17\.21/.test(upgrade.action), "the upgrade step names the version jump");
  const noFix = s.remediation.find((r) => /no fixed version/.test(r.action));
  expect(!!noFix && /minimist/.test(noFix.action), "advisories with no fix get their own step");
  expect(s.remediation.some((r) => /injection-prone/.test(r.action)), "injection sinks get a step");
  expect(s.remediation.some((r) => /hygiene/.test(r.action)), "hygiene issues get a step");
}

{
  const partial = buildAuditSummary({
    advisories: [{ severity: "low", package: "x", installedVersion: "1", fixedIn: "2" }],
    partial: { packagesTruncated: true, vulnsTruncated: false },
  });
  expect(partial.complete === false, "a truncated audit is not complete");
  expect(/lower bound/.test(partial.partialReason), "the response says the counts are a floor");
  expect(partial.partial.packagesTruncated === true, "the truncation detail is carried through");
}

// ---------------------------------------------------------------------------
console.log("\nhandler + run history\n");
// ---------------------------------------------------------------------------

const req = (body) => new Request("https://algosize.com/api/analyze/vuln", {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
});

{
  const res = await analyzeVulnHandler(req({ code: "const k = 'AKIAIOSFODNN7EXAMPLE';" }), {}, null);
  const out = await res.json();
  expect(res.status === 200, "source scan returns 200");
  expect(out.summary && out.summary.grade === "F", "source scan carries an audit summary");
  expect(out.summary.sourceFindings > 0 && out.summary.dependencyAdvisories === 0,
         "the summary attributes findings to the source scan");
  expect(Array.isArray(out.findings), "the raw findings list is still returned (back-compat)");
}

{
  // GitHub throttling must not masquerade as "this repo has no lockfiles".
  const env = { FETCH: async () => ({ status: 429, ok: false, text: async () => "rate limited" }) };
  const res = await analyzeVulnHandler(req({ repoUrl: "https://github.com/o/r" }), env, null);
  const out = await res.json();
  expect(res.status === 503, `GitHub 429 → 503 (got ${res.status})`);
  expect(out.error === "github_rate_limited", `error code names the cause (got ${out.error})`);
  expect(/rate-limit/i.test(out.message), "the message explains what happened");
}

{
  const env = { FETCH: async () => ({ status: 403, ok: false, text: async () => "forbidden" }) };
  const res = await analyzeVulnHandler(req({ repoUrl: "https://github.com/o/r" }), env, null);
  expect(res.status === 503, "GitHub 403 is treated the same as 429");
}

{
  // A repo with a clean lockfile still gets a verdict.
  const lock = JSON.stringify({ name: "x", lockfileVersion: 3, packages: { "": {}, "node_modules/left-pad": { version: "1.3.0" } } });
  const env = {
    FETCH: async (url) => String(url).endsWith("package-lock.json")
      ? { ok: true, status: 200, text: async () => lock }
      : (String(url).includes("api.osv.dev")
          ? { ok: true, status: 200, json: async () => ({ results: [{}] }) }
          : { ok: false, status: 404, text: async () => "" }),
  };
  const res = await analyzeVulnHandler(req({ repoUrl: "https://github.com/o/r" }), env, null);
  const out = await res.json();
  expect(res.status === 200, "a clean repo audit returns 200");
  expect(out.summary.securityScore === 100 && out.summary.grade === "A", "a clean repo scores 100/A");
  expect(out.summary.complete === true, "a small audit is complete");
  expect(out.scanned.packagesFound === 1, "the response reports how many packages were found");
}

expect(summarize("vuln", { counts: { critical: 0, high: 0, medium: 0, low: 0, unknown: 7 } }) === "7 advisories · 0 crit, 0 high",
       "unknown-severity advisories are counted in the run-history headline");
expect(summarize("vuln", { summary: { totalIssues: 3, grade: "D", counts: { critical: 1, high: 2 } } }) ===
       "3 issues · grade D · 1 crit, 2 high",
       "the headline prefers the audit summary when present");
expect(summarize("vuln", { counts: { critical: 0, high: 0, medium: 0, low: 1, unknown: 0 } }).startsWith("1 advisory"),
       "one advisory is singularized");

// ---------------------------------------------------------------------------
console.log(failures === 0
  ? "\n\x1b[32mAll security-audit tests passed\x1b[0m\n"
  : `\n\x1b[31m${failures} security-audit test(s) failed\x1b[0m\n`);
process.exit(failures === 0 ? 0 : 1);
