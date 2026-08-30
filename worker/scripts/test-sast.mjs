// Source-code scanner (SAST) tests.
//
// Five things are checked here, and the order matters — each one is a
// different way this scanner could be broken while looking fine:
//
//   1. REGISTRY COVERAGE. Derived from what the engines actually emit over the
//      fixture corpus, never from a hand-written list. A hand-written list
//      goes stale in the unhelpful direction: it keeps passing after someone
//      adds a detector with no CWE mapping.
//   2. TRUE POSITIVES. Every rule family finds its defect in the vulnerable
//      fixture.
//   3. FALSE POSITIVES. The safe fixture — the correctly-written version of
//      every vulnerable handler — must produce ZERO findings. This is the
//      test that keeps the tool usable: a finding that survives its own
//      documented fix gets the whole rule suppressed, real positives included.
//   4. NO SECRET ECHO. The response must never contain credential material.
//   5. END TO END. Through the real handler, with a stubbed GitHub.
//
// Run with:  node scripts/test-sast.mjs

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { analyzeVuln } from "../src/analyzers/vuln.js";
import { analyzeFileAst } from "../src/analyzers/sast/ast.js";
import {
  RULES, rulesForTypes, DEFAULT_RULE, coveredCwes, coveredOwasp,
} from "../src/analyzers/sast/registry.js";
import {
  CATEGORIES, SEVERITIES, CONFIDENCES, fingerprintOf, normalizeFindings,
  advisoryToFinding, languageForPath, isAstParseable,
} from "../src/analyzers/sast/schema.js";
import { analyzeVulnHandler } from "../src/handlers/analyze.js";
import { toSarif } from "../src/analyzers/sarif.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(__dirname, "fixtures", "sast");

let failures = 0;
const ok   = (m) => console.log(`  \x1b[32m✓\x1b[0m ${m}`);
const fail = (m) => { console.log(`  \x1b[31m✗\x1b[0m ${m}`); failures++; };
const expect = (c, m) => (c ? ok(m) : fail(m));
const group  = (n) => console.log(`\n\x1b[1m${n}\x1b[0m\n`);

const read = (p) => readFileSync(join(FIXTURES, p), "utf8");
const scan = (path, content) => analyzeVuln({ files: [{ path, content }] });

// Credential formats, assembled at runtime. A full-format literal in a
// committed file is blocked by GitHub's push protection — correctly — so the
// only place these can exist is in memory.
const FAKE_AWS    = "AKIA" + "IOSFODNN7" + "EXAMPLE";
const FAKE_PAT    = "ghp_" + "abcdefghijklmnopqrstuvwxyz" + "0123456789";
const FAKE_STRIPE = "sk_" + "live_" + "abcdef0123456789ABCDEFGH";
const FAKE_SLACK  = "xo" + "xb-" + "1234567890-1234567890-" + "abcdef1234567890ABCDEFGH";

const VULN = read("vulnerable/app.js");
const SAFE = read("safe/app.js");

const vulnResult = scan("app.js", VULN);
const safeResult = scan("app.js", SAFE);

// ===========================================================================
group("every rule is fully specified");
// ===========================================================================
{
  const ids = new Set(), types = new Set();
  let malformed = [];
  for (const r of RULES) {
    if (ids.has(r.id)) malformed.push(`duplicate id ${r.id}`);
    if (types.has(r.type)) malformed.push(`duplicate type ${r.type}`);
    ids.add(r.id); types.add(r.type);
    for (const field of ["id", "type", "title", "description", "category",
                         "severity", "confidence", "module", "remediation"]) {
      if (!r[field]) malformed.push(`${r.id}: missing ${field}`);
    }
    if (!Array.isArray(r.cwe))  malformed.push(`${r.id}: cwe must be an array`);
    if (!Array.isArray(r.owasp)) malformed.push(`${r.id}: owasp must be an array`);
    if (!Array.isArray(r.languages) || !r.languages.length) {
      malformed.push(`${r.id}: languages must be a non-empty array`);
    }
    if (!CATEGORIES.includes(r.category)) malformed.push(`${r.id}: unknown category ${r.category}`);
    if (!SEVERITIES.includes(r.severity)) malformed.push(`${r.id}: bad severity ${r.severity}`);
    if (!CONFIDENCES.includes(r.confidence)) malformed.push(`${r.id}: bad confidence ${r.confidence}`);
    for (const c of r.cwe) {
      if (!/^CWE-\d+$/.test(c)) malformed.push(`${r.id}: malformed CWE "${c}"`);
    }
    for (const o of r.owasp) {
      if (!/^A\d{2}:\d{4}-/.test(o)) malformed.push(`${r.id}: malformed OWASP tag "${o}"`);
    }
    // The remediation is what a reader acts on. "Do not do this" is not a
    // remediation, so it has to be long enough to name an alternative.
    if (r.remediation && r.remediation.length < 40) {
      malformed.push(`${r.id}: remediation too short to be actionable`);
    }
  }
  expect(malformed.length === 0,
    `all ${RULES.length} rules carry id/title/description/severity/confidence/CWE/OWASP/languages/remediation` +
    (malformed.length ? " — " + malformed.slice(0, 5).join("; ") : ""));

  expect(coveredCwes().length >= 25,
    `the ruleset spans the CWE Top 25 breadth (${coveredCwes().length} distinct CWEs)`);
  expect(coveredOwasp().length >= 8,
    `…across ${coveredOwasp().length} OWASP Top 10 categories`);

  // Every rule that a `group` collapses must agree on the defect it names, or
  // dedupe silently drops a finding that was about something else.
  const byGroup = {};
  RULES.filter((r) => r.group).forEach((r) => {
    (byGroup[r.group] = byGroup[r.group] || []).push(r);
  });
  const badGroups = Object.entries(byGroup)
    .filter(([, rs]) => new Set(rs.map((r) => r.category)).size !== 1)
    .map(([g]) => g);
  expect(badGroups.length === 0,
    `every dedupe group stays inside one category${badGroups.length ? " — " + badGroups.join(", ") : ` (${Object.keys(byGroup).length} groups)`}`);
}

// ===========================================================================
group("no detector emits a type the registry does not know");
// ===========================================================================
//
// THE test that keeps the registry honest. Derived from the engines' real
// output over the corpus, so adding a detector without a registry entry fails
// here rather than shipping a finding with no CWE and no remediation.
{
  const secretish = [
    `const k = "${FAKE_AWS}";`,
    `const t = "${FAKE_PAT}";`,
    `const s = "${FAKE_STRIPE}";`,
    `const sl = "${FAKE_SLACK}";`,
    `const apiKey = "abc12345xyzqwerty";`,
    `-----BEGIN RSA PRIVATE KEY-----`,
    `const DSN = "postgres://user:hunter2hunter2@db.example.com:5432/app";`,
  ].join("\n");
  const misc = [
    `import { get } from "http";`,
    `const u = "http://api.example.com/v1";`,
    `db.query("SELECT * FROM t WHERE a = " + b);`,
    `curl https://example.com/i.sh | sh`,
    `jwt.decode(token);`,
    `yaml.load(input);`,
    `pickle.loads(blob);`,
    `const h = crypto.createHash("md5").update(x).digest("hex");`,
    `const nonce = Math.random();`,
    `agent = new https.Agent({ rejectUnauthorized: false });`,
    `parser = new XMLParser({ noent: true });`,
    `Handlebars.compile("<b>" + req.query.t + "</b>");`,
    `app.use(cors({ origin: "*", credentials: true }));`,
    `res.setHeader("Access-Control-Allow-Origin", req.headers.origin);`,
    `const opts = { csrf: false };`,
    `DEBUG = True`,
    `el.innerHTML = userInput;`,
  ].join("\n");

  const emitted = new Set();
  for (const [p, c] of [
    ["app.js", VULN], ["safe.js", SAFE],
    ["config.js", secretish], ["misc.js", misc],
    ["Dockerfile", "FROM node:22\nADD https://example.com/x.tar.gz /opt/\n"],
    ["deploy.sh", "curl -fsSL https://get.example.com | sudo bash\n"],
    ["multi.js", "db.query('SELECT * FROM t WHERE org_id = ? AND id = ?', [o, i]);\ndb.query('SELECT * FROM t WHERE id = ?', [i]);\n"],
  ]) {
    for (const f of scan(p, c).findings) emitted.add(f.type);
  }

  const known = rulesForTypes();
  const unknown = [...emitted].filter((t) => !known.has(t));
  expect(unknown.length === 0,
    `every emitted type has a registry entry (${emitted.size} types exercised)` +
    (unknown.length ? " — unregistered: " + unknown.join(", ") : ""));

  const unregistered = [...emitted].filter((t) => (known.get(t) || DEFAULT_RULE).id === DEFAULT_RULE.id);
  expect(unregistered.length === 0,
    "…and none fell through to the unregistered placeholder");

  // The corpus has to actually exercise the ruleset, or the check above is
  // vacuously true — the classic way a coverage test passes while covering
  // nothing.
  expect(emitted.size >= 25,
    `the corpus exercises a meaningful share of the ruleset (${emitted.size} of ${RULES.length})`);
}

// ===========================================================================
group("the vulnerable fixture is found, family by family");
// ===========================================================================
{
  const byRule = new Set(vulnResult.findings.map((f) => f.ruleId));
  const byCat  = new Set(vulnResult.findings.map((f) => f.category));

  const REQUIRED = [
    ["sast.sql-injection.tainted-query",       "SQL injection"],
    ["sast.command-injection.tainted-exec",    "command injection"],
    ["sast.code-injection.tainted-eval",       "code injection"],
    ["sast.nosql-injection.operator-injection","NoSQL operator injection"],
    ["sast.path-traversal.tainted-fs-call",    "path traversal"],
    ["sast.ssrf.tainted-url",                  "SSRF"],
    ["sast.open-redirect.unvalidated-target",  "open redirect"],
    ["sast.xss.reflected-response",            "reflected XSS"],
    ["sast.crypto.password-fast-hash",         "password hashed with a fast digest"],
    ["sast.crypto.weak-cipher",                "broken cipher"],
    ["sast.auth.jwt-verification-bypass",      "JWT verification bypass"],
    ["sast.auth.cookie-missing-flags",         "insecure cookie flags"],
    ["sast.auth.route-without-guard",          "unguarded state-changing route"],
    ["sast.deserialization.unsafe-loader",     "unsafe deserialization"],
    ["sast.logging.sensitive-value",           "credential written to a log"],
    ["sast.cors.wildcard-with-credentials",    "wildcard CORS with credentials"],
    ["sast.upload.no-type-or-size-limit",      "unrestricted upload"],
  ];
  for (const [ruleId, label] of REQUIRED) {
    expect(byRule.has(ruleId), `finds ${label} (${ruleId})`);
  }
  expect(byCat.size >= 10,
    `spanning ${byCat.size} categories: ${[...byCat].sort().join(", ")}`);

  // A taint-confirmed finding must carry the flow, or the reader cannot check
  // it without re-reading the whole handler.
  const tainted = vulnResult.findings.find((f) => f.ruleId === "sast.sql-injection.tainted-query");
  expect(tainted && tainted.evidence && /req\.params\.id/.test(tainted.evidence.source),
    `…and names the request property the value came from (got "${tainted && tainted.evidence && tainted.evidence.source}")`);
  expect(tainted && tainted.confidence === "high",
    "a proven flow is high confidence, unlike the same line matched by a regex");
  expect(tainted && tainted.cwe.includes("CWE-89") &&
         tainted.owasp.some((o) => /A03/.test(o)),
    "…carrying its CWE and OWASP mapping");
}

// ===========================================================================
group("the safe fixture produces nothing at all");
// ===========================================================================
//
// The single most important assertion in this file. Every handler in the safe
// fixture is the documented fix for a handler in the vulnerable one — so a
// finding here is a finding that CANNOT BE CLEARED by doing the right thing,
// and an un-clearable rule gets suppressed wholesale, taking its true
// positives with it.
{
  expect(safeResult.findings.length === 0,
    `the correctly-written app scans clean (got ${safeResult.findings.length}` +
    (safeResult.findings.length
      ? ": " + safeResult.findings.map((f) => `${f.ruleId}@${f.line}`).join(", ")
      : "") + ")");

  // Named individually so a regression says WHICH fix stopped working.
  const SUPPRESSIONS = [
    ["parameterized query",        "db.query('SELECT * FROM t WHERE id = ?', [id]);"],
    ["argument-array exec",        "execFile('tail', ['-n', String(n), file]);"],
    ["contained path",             "const p = path.resolve(ROOT, name);\nif (!p.startsWith(ROOT + path.sep)) throw new Error('bad');\nfs.readFile(p, cb);"],
    ["sanitized innerHTML",        "el.innerHTML = DOMPurify.sanitize(html);"],
    ["yaml safe schema",           "yaml.load(text, { schema: yaml.CORE_SCHEMA });"],
    ["verified JWT",               "jwt.verify(token, key, { algorithms: ['RS256'] });"],
    ["bcrypt password",            "const h = await bcrypt.hash(password, 12);"],
    ["crypto randomness",          "const token = crypto.randomBytes(32).toString('hex');"],
    ["env-sourced credential",     "const apiKey = process.env.API_KEY;"],
    ["placeholder credential",     "const apiKey = 'YOUR_API_KEY_HERE';"],
    ["allowlisted CORS",           "app.use(cors({ origin: ALLOWED, credentials: true }));"],
    ["bounded upload",             "multer({ dest: '/tmp', limits: { fileSize: 1024 }, fileFilter: f });"],
    ["secure cookie",              "res.cookie('session_id', t, { httpOnly: true, secure: true });"],
    ["redacted log",               "console.log('token', '***redacted***');"],
    ["local http url",             "const dev = 'http://localhost:8787/api';"],
    ["regex exec, not shell",      "const m = SOME_RE.exec(line);"],
    ["Math.random for jitter",     "const jitter = Math.random() * 100;"],
  ];
  for (const [label, code] of SUPPRESSIONS) {
    const out = scan("s.js", code);
    expect(out.findings.length === 0,
      `no finding on ${label}` +
      (out.findings.length ? ` — got ${out.findings.map((f) => f.ruleId).join(", ")}` : ""));
  }
}

// ===========================================================================
group("secrets are detected and never echoed back");
// ===========================================================================
{
  const cases = [
    ["AWS access key",   FAKE_AWS,    "secrets.aws.access-key-id",           "critical"],
    ["GitHub PAT",       FAKE_PAT,    "secrets.github.pat",                  "critical"],
    ["Stripe live key",  FAKE_STRIPE, "secrets.stripe.live-key",             "critical"],
    ["Slack token",      FAKE_SLACK,  "secrets.slack.token",                 "high"],
  ];
  for (const [label, value, ruleId, severity] of cases) {
    const out = scan("config.js", `const credential = "${value}";`);
    const f = out.findings.find((x) => x.ruleId === ruleId);
    expect(f && f.severity === severity, `${label} → ${ruleId} (${severity})`);
    const serialized = JSON.stringify(out);
    expect(!serialized.includes(value),
      `…and the value appears nowhere in the response — not in the snippet, not in the fingerprint`);
  }

  const pem = scan("k.pem", "-----BEGIN RSA PRIVATE KEY-----\nMIIEow==\n-----END RSA PRIVATE KEY-----");
  expect(pem.findings.some((f) => f.ruleId === "secrets.private-key.pem" && f.severity === "critical"),
    "PEM private key → critical");

  const dsn = scan("db.js", 'const DSN = "postgres://appuser:hunter2hunter2@db.example.com:5432/app";');
  expect(dsn.findings.some((f) => f.ruleId === "secrets.database.connection-string"),
    "database URI with inline credentials is detected");

  // A structural credential the line-based pattern would miss.
  const ast = analyzeFileAst({
    path: "c.js",
    content: 'const config = {\n  clientSecret:\n    "9f8e7d6c5b4a3f2e1d0c",\n};\n',
  });
  expect(ast.parsed && ast.findings.some((f) => f.type === "hardcoded_credential_assignment"),
    "the AST engine catches a credential split across lines");
  expect(!JSON.stringify(ast.findings).includes("9f8e7d6c5b4a3f2e1d0c"),
    "…and redacts it at the point of construction, not in a later pass");
}

// ===========================================================================
group("taint tracking follows the value, and stops where it should");
// ===========================================================================
{
  const flows = [
    ["direct",        'app.get("/a",(req,res)=>{ db.query("SELECT "+req.query.x); });', true],
    ["via variable",  'app.get("/a",(req,res)=>{ const x=req.query.x; db.query("SELECT "+x); });', true],
    ["via template",  'app.get("/a",(req,res)=>{ const x=req.body.x; db.query(`SELECT ${x}`); });', true],
    ["via destructure",'app.get("/a",(req,res)=>{ const {x}=req.query; db.query("SELECT "+x); });', true],
    ["through concat chain", 'app.get("/a",(req,res)=>{ const x=req.query.x; const y="a"+x; db.query("SELECT "+y); });', true],
  ];
  for (const [label, code, shouldFind] of flows) {
    const out = analyzeFileAst({ path: "t.js", content: code });
    const hit = out.findings.some((f) => f.type === "sql_injection_tainted");
    expect(hit === shouldFind, `taint propagates ${label}`);
  }

  // Sanitizers clear it. This is what makes the finding fixable.
  const cleared = analyzeFileAst({
    path: "t.js",
    content: 'app.get("/a",(req,res)=>{ const x=parseInt(req.query.x,10); db.query("SELECT "+x); });',
  });
  expect(!cleared.findings.some((f) => f.type === "sql_injection_tainted"),
    "…and a recognised coercion clears it");

  // A constant never becomes tainted.
  const constant = analyzeFileAst({
    path: "t.js", content: 'const n = 5; db.query("SELECT * FROM t WHERE x = " + n);',
  });
  expect(!constant.findings.some((f) => f.type === "sql_injection_tainted"),
    "a constant is never reported as a taint flow");

  // Unparseable input is reported as unparsed, never as clean. The whole
  // point of the `parsed` flag.
  const broken = analyzeFileAst({ path: "b.js", content: "function ( { syntax error" });
  expect(broken.parsed === false && broken.findings.length === 0,
    "a file that will not parse reports parsed:false rather than zero findings");

  const ts = scan("x.ts", 'const q: string = "SELECT * FROM t WHERE a = " + b;');
  expect(ts.coverage.astParsed === 0 && ts.findings.length > 0,
    "TypeScript is covered by the pattern engine, with the AST pass correctly skipped");
  expect(isAstParseable("a.js") && !isAstParseable("a.ts"),
    "…which is what isAstParseable reports");
  expect(languageForPath("a.ts") === "typescript" && languageForPath("Dockerfile") === "dockerfile" &&
         languageForPath("x.py") === "python",
    "language detection covers extensions and well-known filenames");
}

// ===========================================================================
group("findings are deduped, fingerprinted and stable");
// ===========================================================================
{
  // One defect, two engines. Both are right; one row is correct.
  const both = scan("d.js",
    'app.get("/a",(req,res)=>{ const id=req.query.id; db.query("SELECT * FROM t WHERE id = " + id); });');
  const sqlFindings = both.findings.filter((f) => f.category === "injection");
  expect(sqlFindings.length === 1,
    `the pattern hit and the taint hit collapse to one row (got ${sqlFindings.length})`);
  expect(sqlFindings[0] && sqlFindings[0].module === "ast-analyzer",
    "…keeping the stronger claim, which is the one carrying the flow");

  // Stability: unrelated edits above must not re-identify the finding.
  const base = 'db.query("SELECT * FROM t WHERE a = " + b);';
  const a = scan("f.js", base);
  const b = scan("f.js", "// a new comment\n// and another\n" + base);
  expect(a.findings[0].fingerprint === b.findings[0].fingerprint,
    "a fingerprint survives lines being inserted above it");
  expect(a.findings[0].line !== b.findings[0].line,
    "…even though the line number moved");

  const other = scan("g.js", base);
  expect(other.findings[0].fingerprint !== a.findings[0].fingerprint,
    "…and differs across files");

  // Two identical bad lines are two findings, not one.
  const twice = scan("h.js", base + "\n" + base);
  expect(twice.findings.length === 2 &&
         twice.findings[0].fingerprint !== twice.findings[1].fingerprint,
    "two identical occurrences keep distinct identities");

  expect(fingerprintOf({ ruleId: "r", path: "p", snippet: "s" }).length === 16,
    "fingerprints are 16 hex characters");

  const ids = vulnResult.findings.map((f) => f.id);
  expect(ids[0] === "VS-0001" && new Set(ids).size === ids.length,
    "findings are numbered VS-0001 upward, uniquely");

  // Sorting: severity descending.
  const ranks = { critical: 5, high: 4, medium: 3, low: 2, info: 1 };
  let sorted = true;
  for (let i = 1; i < vulnResult.findings.length; i++) {
    if (ranks[vulnResult.findings[i - 1].severity] < ranks[vulnResult.findings[i].severity]) sorted = false;
  }
  expect(sorted, "…and ordered by severity, worst first");
}

// ===========================================================================
group("the legacy response shape is intact");
// ===========================================================================
//
// The endpoint predates all of this. Every field an existing caller reads has
// to survive, or the upgrade breaks stored runs and the CI gate.
{
  const f = vulnResult.findings[0];
  for (const key of ["severity", "type", "path", "line", "snippet", "recommendation"]) {
    expect(f[key] !== undefined, `legacy field \`${key}\` is still present`);
  }
  expect(Array.isArray(vulnResult.findings), "`findings` is still an array at the top level");
  expect(vulnResult.summary && vulnResult.coverage,
    "…with `summary` and `coverage` added alongside, not replacing it");
  expect(vulnResult.summary.total === vulnResult.findings.length,
    "the summary total matches the list it summarises");
  const sevSum = Object.values(vulnResult.summary.bySeverity).reduce((a, b) => a + b, 0);
  expect(sevSum === vulnResult.findings.length,
    "…and every finding is counted in exactly one severity bucket");
}

// ===========================================================================
group("a dependency advisory normalizes into the same schema");
// ===========================================================================
{
  const f = advisoryToFinding({
    id: "GHSA-xxxx", package: "lodash", ecosystem: "npm",
    installedVersion: "4.17.20", fixedIn: "4.17.21", severity: "high",
    advisoryUrl: "https://example.test/GHSA-xxxx",
  });
  expect(f.category === "dependency" && f.module === "dependency-analyzer",
    "advisories carry the dependency category and module, so the UI can label them apart");
  expect(f.severity === "high" && /4\.17\.21/.test(f.recommendation),
    "…with the severity kept and the fixed version in the remediation");
  expect(advisoryToFinding({ id: "X", package: "p", severity: "unknown" }).severity === "info",
    "an advisory with no published severity becomes info, never a guess upward");
}

// ===========================================================================
group("SARIF carries source findings to GitHub's Security tab");
// ===========================================================================
{
  const sarif = toSarif({
    advisories: [], scanned: { manifests: [{ filename: "package-lock.json" }] },
    summary: { complete: true },
    source: { status: "ok", findings: vulnResult.findings, coverage: vulnResult.coverage },
  }, { runId: "run_1", siteOrigin: "https://algosize.test" });

  const run = sarif.runs[0];
  expect(run.results.length === vulnResult.findings.length,
    `every source finding becomes a SARIF result (${run.results.length})`);
  const r = run.results[0];
  expect(r.locations[0].physicalLocation.artifactLocation.uri === "app.js" &&
         r.locations[0].physicalLocation.region.startLine > 0,
    "…located at a real file and line, which a dependency advisory cannot offer");
  expect(r.partialFingerprints && r.partialFingerprints.algosizeFinding,
    "…with our line-independent fingerprint, so GitHub tracks it across edits");

  const rule = run.tool.driver.rules.find((x) => x.id === r.ruleId);
  expect(rule && rule.properties.tags.some((t) => /^CWE-/.test(t)),
    "…and the rule carries CWE tags GitHub renders as filters");
  expect(rule && rule.properties.precision,
    "…and a precision derived from our confidence");
  expect(run.properties.sourceScanStatus === "ok",
    "the log records that the source pass actually ran");

  const notRun = toSarif({ advisories: [], scanned: { manifests: [] }, summary: {} });
  expect(notRun.runs[0].properties.sourceScanStatus === "not_run",
    "…and says `not_run` when it did not, rather than looking clean");
}

// ===========================================================================
group("end to end through the handler");
// ===========================================================================
{
  const tree = {
    tree: [
      { type: "blob", path: "package-lock.json", size: 120 },
      { type: "blob", path: "src/app.js", size: VULN.length },
      { type: "blob", path: "node_modules/evil/index.js", size: 50 },
      { type: "blob", path: "scripts/fixtures/bad.js", size: 50 },
    ],
  };
  const lock = JSON.stringify({
    name: "demo", lockfileVersion: 3,
    packages: { "": { name: "demo" }, "node_modules/lodash": { version: "4.17.21" } },
  });

  const fetchImpl = async (url) => {
    const u = String(url);
    if (u.includes("api.github.com") && u.includes("/git/trees/main")) {
      return new Response(JSON.stringify(tree), { status: 200 });
    }
    if (u.includes("api.github.com")) return new Response("nope", { status: 404 });
    if (u.includes("raw.githubusercontent.com")) {
      if (u.endsWith("package-lock.json")) return new Response(lock, { status: 200 });
      if (u.endsWith("src/app.js")) return new Response(VULN, { status: 200 });
      return new Response("not found", { status: 404 });
    }
    if (u.includes("osv.dev")) return new Response(JSON.stringify({ results: [{}] }), { status: 200 });
    return new Response("{}", { status: 200 });
  };

  const req = new Request("https://algosize.test/api/analyze/vuln", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ repoUrl: "https://github.com/acme/demo" }),
  });
  req.user = { userId: "u_1", email: "u@example.test" };

  const res = await analyzeVulnHandler(req, { FETCH: fetchImpl }, null);
  const body = await res.json();

  expect(res.status === 200, `the repo scan answers 200 (got ${res.status})`);
  expect(body.scanned && Array.isArray(body.advisories),
    "…with the dependency audit intact — the contract this endpoint always had");
  expect(body.source && body.source.status === "ok",
    `…and a source block that ran (got ${body.source && body.source.status})`);
  expect(body.source.findings.length > 0,
    `…carrying source findings (${body.source.findings.length})`);
  expect(body.source.coverage.filesScanned === 1,
    `…having skipped node_modules and fixtures (scanned ${body.source.coverage.filesScanned})`);
  expect(!JSON.stringify(body).includes("IOSFODNN7"),
    "…and no credential material anywhere in the response");

  // The soft-fail contract: a source-fetch failure must not cost the audit.
  const throttled = async (url) => {
    const u = String(url);
    if (u.includes("api.github.com") && u.includes("/git/trees/")) {
      // The lockfile discovery gets a good tree; the source pass is throttled.
      return calls++ === 0
        ? new Response(JSON.stringify(tree), { status: 200 })
        : new Response("rate limited", { status: 403 });
    }
    if (u.includes("raw.githubusercontent.com") && u.endsWith("package-lock.json")) {
      return new Response(lock, { status: 200 });
    }
    if (u.includes("osv.dev")) return new Response(JSON.stringify({ results: [{}] }), { status: 200 });
    return new Response("not found", { status: 404 });
  };
  let calls = 0;
  const req2 = new Request("https://algosize.test/api/analyze/vuln", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ repoUrl: "https://github.com/acme/demo" }),
  });
  req2.user = { userId: "u_1", email: "u@example.test" };
  const res2 = await analyzeVulnHandler(req2, { FETCH: throttled }, null);
  const body2 = await res2.json();
  expect(res2.status === 200 && Array.isArray(body2.advisories),
    "a throttled source fetch still returns the dependency audit");
  expect(body2.source && body2.source.status === "unavailable",
    `…and says the source could not be read rather than showing it clean (got ${body2.source && body2.source.status})`);
  expect(body2.source.findings.length === 0 && /could not be read/i.test(body2.source.message),
    "…with an empty list that is explicitly labelled as unread");
}

console.log("");
if (failures === 0) {
  console.log("\x1b[32m  all SAST tests passed\x1b[0m\n");
  process.exit(0);
} else {
  console.log(`\x1b[31m  ${failures} SAST test(s) failed\x1b[0m\n`);
  process.exit(1);
}
