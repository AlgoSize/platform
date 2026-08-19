// Characterization tests for secret detection — written BEFORE the shared
// detector was extracted, and deliberately asserting CURRENT behaviour rather
// than desired behaviour.
//
// Why this file exists separately from test-vuln.mjs: it pins the exact
// semantics of BOTH detectors in the codebase, including the places where they
// deliberately disagree. Those disagreements are the reason they were not
// merged into one detector — see analyzers/secrets.js for the full argument.
// If a future refactor unifies them, these tests fail loudly and name which
// side changed, instead of silently weakening a critical detector.
//
// Run with:  node scripts/test-secrets-baseline.mjs

import { analyzeVuln } from "../src/analyzers/vuln.js";
import { buildGraph } from "../src/analyzers/architecture/graph.js";

let failures = 0;
const ok   = (m) => console.log(`  \x1b[32m✓\x1b[0m ${m}`);
const fail = (m) => { console.log(`  \x1b[31m✗\x1b[0m ${m}`); failures++; };
const expect = (c, m) => c ? ok(m) : fail(m);

// Split so this file never contains a string matching its own detectors.
const AWS   = "AKIA" + "IOSFODNN7EXAMPLE";
const GHP   = "ghp_" + "a".repeat(36);
const GHPAT = "github_pat_" + "b".repeat(82);
const STRIPE= "sk_live_" + "c".repeat(24);
const SLACK = "xoxb-" + "1234567890abcdef";

const vuln = (content, path = "config.js") =>
  analyzeVuln({ files: [{ path, content }] });
const typesFor = (content, path) => vuln(content, path).findings.map((f) => f.type);

console.log("\nvuln.js — every high-confidence value pattern\n");

{
  const cases = [
    ["hardcoded_aws_access_key",              `KEY = "${AWS}"`,    "critical"],
    ["hardcoded_github_personal_token",       `T = "${GHP}"`,      "critical"],
    ["hardcoded_github_fine_grained_token",   `T = "${GHPAT}"`,    "critical"],
    ["hardcoded_stripe_live_key",             `K = "${STRIPE}"`,   "critical"],
    ["hardcoded_slack_token",                 `T = "${SLACK}"`,    "high"],
  ];
  for (const [type, content, severity] of cases) {
    const f = vuln(content).findings.find((x) => x.type === type);
    expect(!!f, `${type} is detected`);
    expect(f && f.severity === severity, `${type} severity is "${severity}"`);
    expect(f && typeof f.recommendation === "string" && f.recommendation.length > 20,
      `${type} carries an actionable recommendation`);
  }
}

console.log("\nvuln.js — redaction never echoes the secret back\n");

{
  // The whole point of the global redaction pass: a finding's snippet must
  // never contain the credential, even for findings from OTHER detectors that
  // happen to share the line.
  for (const [label, secret] of [["AWS", AWS], ["GitHub PAT", GHP], ["Stripe", STRIPE], ["Slack", SLACK]]) {
    const out = vuln(`const k = "${secret}"`);
    const leaked = out.findings.filter((f) => f.snippet && f.snippet.includes(secret));
    expect(leaked.length === 0, `${label} value never appears in any finding snippet`);
  }
}

{
  // Cross-detector redaction: an eval() finding on a line that also holds a
  // key must still have the key scrubbed from its snippet.
  const out = vuln(`eval(fetchCode("${AWS}"))`);
  const anyLeak = out.findings.some((f) => f.snippet && f.snippet.includes(AWS));
  expect(!anyLeak, "a secret is redacted even in a finding emitted by a different detector");
  expect(out.findings.some((f) => f.type !== "hardcoded_aws_access_key"),
    "and that other detector still fires on the same line");
}

console.log("\nvuln.js — generic key/value heuristic\n");

{
  expect(typesFor('const apiKey = "abc12345xyzqwerty"').includes("hardcoded_generic_secret"),
    "quoted generic assignment is flagged");
  // vuln's generic pattern REQUIRES quotes — unquoted is graph.js's job.
  expect(!typesFor("apiKey = abc12345xyzqwerty").includes("hardcoded_generic_secret"),
    "UNQUOTED generic assignment is NOT flagged (quotes are required here)");
}

{
  // Comments are scanned, not stripped: a leaked secret in a comment is leaked.
  // This is the direct opposite of graph.js and must not regress.
  const out = vuln(`// const apiKey = "abc12345xyzqwerty"`);
  const f = out.findings.find((x) => x.type === "hardcoded_generic_secret");
  expect(!!f, "a secret inside a COMMENT is still flagged");
  expect(f && f.severity === "low", "but downgraded to low severity when commented");
}

{
  // vuln's placeholder list, matched as a SUBSTRING anywhere in the line.
  const placeholders = [
    'const apiKey = "YOUR_KEY_HERE"',
    "const apiKey = process.env.API_KEY",
    "const apiKey = `${SECRET}`",
    'const apiKey = "example-placeholder-1234"',
    'const apiKey = "replace-me-in-production"',
    'const apiKey = "fake-key-for-tests"',
    'const apiKey = "todo-fixme-later"',
  ];
  let bad = null;
  for (const code of placeholders) {
    if (typesFor(code).includes("hardcoded_generic_secret")) { bad = code; break; }
  }
  expect(bad === null, `vuln placeholder list suppresses false positives${bad ? ` (leaked on: ${bad})` : ""}`);
}

{
  // Values graph.js WOULD suppress but vuln does NOT. This asymmetry is the
  // reason the two placeholder lists cannot be merged: adopting graph's
  // anchored list here would silently stop flagging these.
  const onlyGraphSuppresses = ['const apiKey = "test1234"', 'const apiKey = "password1234"'];
  for (const code of onlyGraphSuppresses) {
    expect(typesFor(code).includes("hardcoded_generic_secret"),
      `vuln still flags ${code.match(/"([^"]+)"/)[1]} (graph.js would suppress it — lists must stay separate)`);
  }
}

console.log("\ngraph.js — key-name heuristic over manifests\n");

const graphSecrets = (path, content) => buildGraph([{ path, content }]).secrets;

{
  const hits = graphSecrets(".env", "DATABASE_PASSWORD=hunter2hunter2");
  expect(hits.length === 1, "an env-file secret assignment is detected");
  expect(hits[0] && hits[0].key === "DATABASE_PASSWORD", "the KEY name is reported");
  expect(hits[0] && !JSON.stringify(hits[0]).includes("hunter2hunter2"),
    "and the VALUE is never included in the finding");
  expect(hits[0] && hits[0].line === 1 && hits[0].file === ".env",
    "with file and line for the citation");
}

{
  expect(graphSecrets(".env", "API_KEY=realvalue12345").length === 1, "unquoted values are accepted");
  expect(graphSecrets(".env", 'API_KEY="realvalue12345"').length === 1, "quoted values are accepted");
  expect(graphSecrets(".env", "export API_KEY=realvalue12345").length === 1, "`export` prefix is accepted");
}

{
  // graph.js STRIPS comments — the exact opposite of vuln.js.
  expect(graphSecrets(".env", "# API_KEY=realvalue12345").length === 0,
    "a secret inside a COMMENT is ignored (opposite of vuln.js — deliberate)");
}

{
  expect(graphSecrets(".env", "API_KEY=short").length === 0, "values under 8 chars are ignored");
  expect(graphSecrets(".env", "DEBUG=verbose-but-not-secret").length === 0,
    "keys without a secret-ish name are ignored");
}

{
  // graph's placeholder list is ANCHORED: it must match the WHOLE value.
  for (const v of ["changeme", "your-key-here", "${SECRET}", "placeholder", "test", "null", "none"]) {
    expect(graphSecrets(".env", `API_KEY=${v}`).length === 0,
      `graph suppresses the exact placeholder "${v}"`);
  }
  // ...so a placeholder word EMBEDDED in a longer real-looking value still fires.
  expect(graphSecrets(".env", "API_KEY=test-aB3xQ9zLmP0w").length === 1,
    "but a placeholder word inside a longer value does NOT suppress (anchored, not substring)");
}

console.log("\nsecrets.js — the shared API surface\n");

{
  const { detectSecrets, redactSecrets, assertNoSecrets, SecretDetectedError } =
    await import("../src/analyzers/secrets.js");

  // detectSecrets over multi-line text, with correct line attribution.
  const text = `line one is clean\nconst k = "${AWS}"\nstill clean`;
  const found = detectSecrets(text);
  expect(found.length === 1 && found[0].type === "hardcoded_aws_access_key",
    "detectSecrets(text) finds a credential in multi-line text");
  expect(found[0] && found[0].line === 2, "and attributes it to the right line");

  // redactSecrets removes the value but keeps the surrounding text readable.
  const red = redactSecrets(text);
  expect(!red.includes(AWS), "redactSecrets removes the credential");
  expect(red.includes("still clean") && red.includes("***REDACTED***"),
    "and leaves the rest of the text intact");

  // assertNoSecrets: clean input passes, credential-bearing input throws.
  let threw = null;
  try { assertNoSecrets("cpu: 500m\nmemory: 512Mi"); } catch (e) { threw = e; }
  expect(threw === null, "assertNoSecrets passes clean infrastructure config");

  threw = null;
  try { assertNoSecrets(`aws_secret_access_key: ${"z".repeat(40)}`); } catch (e) { threw = e; }
  expect(threw instanceof SecretDetectedError, "assertNoSecrets throws on a banned key name");
  expect(threw && threw.code === "secrets_detected", "with a stable error code");

  // THE critical property: the error must never carry the value.
  const serialized = JSON.stringify(threw ? threw.toSafeJSON() : {});
  expect(!serialized.includes("z".repeat(40)),
    "and the safe JSON form never echoes the credential value back");
  expect(serialized.includes("aws_secret_access_key"),
    "while still naming the offending key so the user can find it");
  expect(!String(threw && threw.message).includes("z".repeat(40)),
    "the error MESSAGE is also free of the value");

  // Banned keys are rejected on the key alone, even with a fake-looking value.
  for (const key of ["kubeconfig", "private_key", "refresh_token", "client_secret"]) {
    let e = null;
    try { assertNoSecrets(`${key}: whatever-goes-here`); } catch (err) { e = err; }
    expect(e instanceof SecretDetectedError, `assertNoSecrets rejects "${key}" on the key name alone`);
  }

  // A value-format key is caught even when the field name is innocuous.
  let e2 = null;
  try { assertNoSecrets(`harmless_field = "${AWS}"`); } catch (err) { e2 = err; }
  expect(e2 instanceof SecretDetectedError,
    "assertNoSecrets catches a real AWS key under an innocent field name");

  // lastIndex hygiene: the /g regexes must not poison a subsequent scan.
  const twice = [detectSecrets(`k="${AWS}"`).length, detectSecrets(`k="${AWS}"`).length];
  expect(twice[0] === 1 && twice[1] === 1,
    `repeated scans give identical results (no lastIndex leak) — got ${twice.join(",")}`);
}

console.log("");
if (failures === 0) {
  console.log("\x1b[32m  all secret-detection baseline tests passed\x1b[0m\n");
  process.exit(0);
} else {
  console.log(`\x1b[31m  ${failures} secret-detection baseline test(s) failed\x1b[0m\n`);
  process.exit(1);
}
