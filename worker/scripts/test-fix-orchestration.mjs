// The fix-orchestration platform: schemas, providers, validation, pipeline,
// SARIF import, and the surfaces that expose them.
//
// The stakes are different from the scanner's tests. A scanner that is wrong
// annoys someone; a FIX pipeline that is wrong REWRITES SOMEONE'S CODE. So
// the matrix below leans on the refusal paths: a proposal that touches a file
// it was not given, a fix that does not fix, a fix that introduces a worse
// bug, a reply that is not JSON, a provider with no credentials. Each must
// fail loudly, with the reason on the object, and the audit record must exist
// whether or not the attempt succeeded.
//
// Run with:  node scripts/test-fix-orchestration.mjs

import {
  SCHEMAS, validateFixTask, toFixProposal, priorityOf, prioritizeFindings,
  makeAgentExecutionRecord, MAX_FIX_FILE_BYTES, contentHash,
} from "../src/fix/schemas.js";
import { diffFile, diffProposal } from "../src/fix/diff.js";
import { PROVIDERS, resolveProvider, parseFixReply, compareAlternativeFixes } from "../src/fix/providers.js";
import { validateProposal } from "../src/fix/validate.js";
import { fixEligibility, findingToFixTask, runFixPipeline } from "../src/fix/orchestrate.js";
import { fromSarif } from "../src/analyzers/sarif.js";
import { analyzeVuln } from "../src/analyzers/vuln.js";
import {
  proposeFixHandler, validateFixHandler, explainRuleHandler, importSarifHandler,
} from "../src/handlers/fix.js";
import { TOOLS, TOOL_GROUPS } from "../src/mcp/tools/index.js";
import { makeD1 } from "./_d1-stub.mjs";

let failures = 0;
const ok   = (m) => console.log(`  \x1b[32m✓\x1b[0m ${m}`);
const fail = (m) => { console.log(`  \x1b[31m✗\x1b[0m ${m}`); failures++; };
const expect = (c, m) => (c ? ok(m) : fail(m));
const group  = (n) => console.log(`\n\x1b[1m${n}\x1b[0m\n`);

// ---------------------------------------------------------------------------
// Shared material: one genuinely vulnerable file, its genuine fix, and the
// finding the real scanner produces for it. Everything downstream uses the
// SCANNER'S OWN finding rather than a hand-built one, so these tests break
// if the finding shape and the fix pipeline ever drift apart.
// ---------------------------------------------------------------------------

const VULN_SRC = [
  'const express = require("express");',
  "const app = express();",
  'app.get("/u/:id", (req, res) => {',
  '  db.query("SELECT * FROM users WHERE id = " + req.params.id, cb);',
  "});",
  "",
].join("\n");
const FIXED_SRC = VULN_SRC.replace(
  '"SELECT * FROM users WHERE id = " + req.params.id',
  '"SELECT * FROM users WHERE id = ?", [req.params.id]');
const FILES = [{ path: "src/app.js", content: VULN_SRC }];

const scan = analyzeVuln({ files: FILES });
const FINDING = scan.findings.find((f) => f.ruleId === "sast.sql-injection.tainted-query");

/** env.AI stub whose replies are scripted per call. */
function scriptedAI(replies) {
  let call = 0;
  return { run: async () => ({ response: replies[Math.min(call++, replies.length - 1)] }) };
}
const GOOD_REPLY = JSON.stringify({
  explanation: "Replaced string concatenation with a bound parameter.",
  files: [{ path: "src/app.js", content: FIXED_SRC }],
  riskNotes: "Confirm the driver supports ? placeholders.",
});

// ===========================================================================
group("prioritization ranks by likely real impact, not raw severity");
// ===========================================================================
{
  const mk = (severity, confidence, category, evidence) =>
    ({ severity, confidence, category, evidence, path: "a.js", line: 1 });

  const confidentHigh = priorityOf(mk("high", "high", "injection"));
  const shakyCritical = priorityOf(mk("critical", "low", "configuration"));
  expect(confidentHigh.score > shakyCritical.score,
    `a high-confidence injection outranks a low-confidence config critical (${confidentHigh.score} vs ${shakyCritical.score})`);

  const tainted = priorityOf(mk("high", "high", "injection", { source: "req.query.id" }));
  expect(tainted.score > confidentHigh.score,
    "a traced taint path boosts priority — it is evidence a line match cannot have");

  expect(typeof confidentHigh.terms.severity === "number" && typeof confidentHigh.terms.category === "number",
    "…and the score exposes its terms, so a queue can answer 'why is this first?'");

  const queue = prioritizeFindings([mk("low", "high", "crypto"), mk("critical", "high", "injection")]);
  expect(queue[0].finding.severity === "critical", "the queue sorts descending");
}

// ===========================================================================
group("schemas refuse rather than repair");
// ===========================================================================
{
  const t = findingToFixTask(FINDING, FILES).value;
  expect(validateFixTask(t).ok, "a task built by the orchestrator validates");

  const noGoal = { ...t, acceptance: {} };
  expect(!validateFixTask(noGoal).ok && /measurable goal/.test(validateFixTask(noGoal).message),
    "a task with no target fingerprint is refused — it could never be validated");

  const big = { ...t, files: [{ path: "a.js", content: "x".repeat(MAX_FIX_FILE_BYTES + 1) }] };
  expect(!validateFixTask(big).ok, "an oversized context file is refused, not truncated");

  const outside = toFixProposal(
    { files: [{ path: "src/OTHER.js", content: "x" }] }, t, { provider: "kimi" });
  expect(!outside.ok && outside.error === "proposal_outside_allowlist",
    "a proposal touching a file the task did not offer is refused outright");
  expect(!toFixProposal({ files: [] }, t, {}).ok, "an empty proposal is refused");

  const good = toFixProposal(JSON.parse(GOOD_REPLY), t, { provider: "kimi", model: "m" });
  expect(good.ok && good.value.schema === SCHEMAS.FIX_PROPOSAL && good.value.taskId === t.id,
    "a well-formed reply normalizes with schema tag and task linkage");
}

// ===========================================================================
group("the diff is computed from ground truth");
// ===========================================================================
{
  const same = diffFile("a.js", "x\ny\n", "x\ny\n");
  expect(!same.changed && same.patch === "", "identical content diffs to nothing");

  const d = diffFile("src/app.js", VULN_SRC, FIXED_SRC);
  expect(d.changed && d.linesAdded === 1 && d.linesRemoved === 1,
    `the one-line fix diffs as one line each way (+${d.linesAdded}/-${d.linesRemoved})`);
  expect(/^--- a\/src\/app\.js\n\+\+\+ b\/src\/app\.js\n@@ /.test(d.patch),
    "…in unified format with headers git apply understands");

  const t = findingToFixTask(FINDING, FILES).value;
  const p = toFixProposal(JSON.parse(GOOD_REPLY), t, {}).value;
  const { blastRadius } = diffProposal(t, p);
  expect(blastRadius.files === 1 && blastRadius.granularity === "single-hunk",
    "blast radius counts files and names its own granularity");
}

// ===========================================================================
group("provider adapters: transport only, and honest about configuration");
// ===========================================================================
{
  expect(parseFixReply(GOOD_REPLY).ok, "clean JSON parses");
  expect(parseFixReply("```json\n" + GOOD_REPLY + "\n```").ok, "fenced JSON parses — refusing fences fails real fixes over formatting");
  expect(parseFixReply("Sure! Here you go:\n" + GOOD_REPLY + "\nHope that helps!").ok,
    "prose-wrapped JSON parses");
  expect(!parseFixReply("I cannot help with that.").ok, "no JSON at all is invalid_response");

  const none = resolveProvider(null, {});
  expect(!none.ok && none.error === "no_provider_configured",
    "an empty env resolves to no provider, with the remedies named");
  expect(!resolveProvider("kimi", { OPENAI_API_KEY: "sk-x" }).ok,
    "asking for kimi with only an OpenAI key is provider_not_configured — no silent substitution");
  expect(!resolveProvider("gpt5", { OPENAI_API_KEY: "sk-x" }).ok,
    "an unknown provider id is refused");
  expect(resolveProvider(null, { AI: {} }).provider.id === "kimi",
    "the keyless Workers AI binding is the default when present");

  const t = findingToFixTask(FINDING, FILES).value;
  const viaKimi = await PROVIDERS.kimi.createFixProposal(t, { AI: scriptedAI([GOOD_REPLY]) });
  expect(viaKimi.ok && viaKimi.provider === "kimi" && viaKimi.raw.files.length === 1,
    "the kimi adapter returns the normalized contract from the Workers AI leg");

  // Claude adapter, with the Anthropic API stubbed at the fetch seam.
  const anthropicFetch = async (url, init) => {
    const body = JSON.parse(init.body);
    if (!body.system || !Array.isArray(body.messages)) return new Response("bad", { status: 400 });
    return new Response(JSON.stringify({ model: body.model, content: [{ type: "text", text: GOOD_REPLY }] }), { status: 200 });
  };
  const viaClaude = await PROVIDERS.claude.createFixProposal(t, {
    ANTHROPIC_API_KEY: "sk-ant-test", ANTHROPIC_FETCH: anthropicFetch,
  });
  expect(viaClaude.ok && viaClaude.provider === "claude" && typeof viaClaude.model === "string",
    "the claude adapter speaks the messages API and reports its model");

  const compared = await compareAlternativeFixes(t, { AI: scriptedAI([GOOD_REPLY]) }, ["kimi", "claude"]);
  expect(compared.length === 2 && compared[0].ok && !compared[1].ok,
    "compare returns each provider's result AS IT CAME BACK — configured succeeds, unconfigured says so, nothing is ranked for you");
}

// ===========================================================================
group("static validation: the refusal matrix");
// ===========================================================================
{
  const t = findingToFixTask(FINDING, FILES).value;
  const propose = (content) =>
    toFixProposal({ files: [{ path: "src/app.js", content }] }, t, { provider: "test" }).value;

  const goodV = validateProposal(t, propose(FIXED_SRC));
  expect(goodV.result.verdict === "passed_static",
    "the genuine fix passes every static check");
  expect(goodV.result.checksNotRun.some((c) => c.check === "tests"),
    "…and even a pass names the checks a Worker cannot run — 'passed' alone does not exist here");
  expect(goodV.result.findingDelta.targetRemoved === true && goodV.result.findingDelta.resolvedCount >= 1,
    "…with the target finding measured as gone");

  const unchanged = validateProposal(t, propose(VULN_SRC));
  expect(unchanged.result.verdict === "failed" &&
         unchanged.result.checks.find((c) => c.check === "structural" && !c.ok),
    "a byte-identical proposal fails structurally — it cannot have fixed anything");

  const broken = validateProposal(t, propose(FIXED_SRC + "\nfunction oops( {"));
  expect(broken.result.verdict === "failed" &&
         broken.result.checks.some((c) => c.check === "parse" && !c.ok),
    "a fix that breaks the parse fails, with the parse error in the detail");

  const cosmetic = validateProposal(t, propose(VULN_SRC.replace("const app", "const app2") + "// touched\n"));
  expect(cosmetic.result.verdict === "failed" &&
         cosmetic.result.checks.some((c) => c.check === "target_removed" && !c.ok),
    "a fix that changes the file but not the bug fails target_removed");

  const downgrade = validateProposal(t, propose(FIXED_SRC + '\napp.get("/e", (req, res) => eval(req.query.code));\n'));
  expect(downgrade.result.verdict === "failed" &&
         downgrade.result.checks.some((c) => c.check === "no_new_severe" && !c.ok),
    "a fix that introduces a new critical fails as a security downgrade, naming the new finding");
  expect(downgrade.result.findingDelta.newFindings.length >= 1,
    "…and the delta lists exactly what appeared");

  const rewrite = validateProposal(t, propose("// rewritten\n" + Array.from({ length: 600 }, (_, i) => `const x${i} = ${i};`).join("\n")));
  expect(rewrite.result.checks.some((c) => c.check === "blast_radius" && !c.ok),
    "a wholesale rewrite fails blast_radius regardless of how it scans — reviewers approve what they can read");

  // Two instances of the same rule; the task targets one. Fixing exactly that
  // one must pass — the same-rule count check is a decrease, not a zero.
  const TWO = VULN_SRC + '\napp.get("/v", (req, res) => {\n  db.query("SELECT * FROM t WHERE x = " + req.params.id, cb);\n});\n';
  const twoScan = analyzeVuln({ files: [{ path: "src/app.js", content: TWO }] })
    .findings.filter((f) => f.ruleId === "sast.sql-injection.tainted-query");
  expect(twoScan.length === 2, `the two-instance fixture really has two instances (got ${twoScan.length})`);
  const t2 = findingToFixTask(twoScan[0], [{ path: "src/app.js", content: TWO }]).value;
  const oneFixed = TWO.replace('"SELECT * FROM users WHERE id = " + req.params.id',
                               '"SELECT * FROM users WHERE id = ?", [req.params.id]');
  const partial = validateProposal(t2, toFixProposal({ files: [{ path: "src/app.js", content: oneFixed }] }, t2, {}).value);
  expect(partial.result.findingDelta.targetRemoved === true,
    "fixing one of two same-rule instances counts as fixing the target, not as leaving it");
}

// ===========================================================================
group("the pipeline: eligibility, retry, and the audit record");
// ===========================================================================
{
  expect(fixEligibility({ ...FINDING, category: "dependency" }, FILES).reason === "dependency_finding",
    "a dependency advisory is routed to the upgrade generator, not source rewriting");
  expect(fixEligibility(FINDING, []).reason === "file_not_supplied",
    "a finding whose file was not provided is ineligible, with the path named");
  expect(fixEligibility(FINDING, [{ path: "src/app.js", content: "x".repeat(MAX_FIX_FILE_BYTES + 1) }]).reason === "file_too_large_for_fix",
    "an over-cap file is ineligible — a model rewriting a file it cannot fully see deletes code it never read");

  const happy = await runFixPipeline({ finding: FINDING, files: FILES, env: { AI: scriptedAI([GOOD_REPLY]) } });
  expect(happy.ok && happy.applyable && !happy.retried,
    `the happy path: proposal, passed_static, no retry (verdict ${happy.validation.verdict})`);
  expect(typeof happy.patch === "string" && happy.patch.includes("+++ b/src/app.js"),
    "…with a git-applyable patch");

  const flaky = await runFixPipeline({
    finding: FINDING, files: FILES,
    env: { AI: scriptedAI(["I refuse to answer in JSON.", GOOD_REPLY]) },
  });
  expect(flaky.ok && flaky.retried && flaky.applyable,
    "an unparseable first reply earns exactly one constrained retry, and the retry's fix lands");

  const hopeless = await runFixPipeline({
    finding: FINDING, files: FILES,
    env: { AI: scriptedAI(["garbage", "more garbage"]) },
  });
  expect(!hopeless.ok && hopeless.stage === "proposal" && hopeless.record,
    "two bad replies stop — a model that misses twice with the failure spelled out needs a human");
  expect(hopeless.record.ok === false && hopeless.record.errorCode,
    "…and the failure is a first-class audit record, not a missing one");

  const rec = happy.record;
  expect(rec.schema === SCHEMAS.AGENT_EXECUTION && rec.verdict === "passed_static",
    "the execution record carries the verdict");
  const recText = JSON.stringify(rec);
  expect(!recText.includes("SELECT * FROM users"),
    "…and NO source content — hashes only, so the audit log never becomes a copy of the code");
  expect(rec.inputHashes[0].hash !== rec.outputHashes[0].hash &&
         rec.outputHashes[0].hash === contentHash(FIXED_SRC),
    "…while the hashes still prove exactly which bytes went in and out");
}

// ===========================================================================
group("the HTTP surfaces");
// ===========================================================================
{
  const post = (path, body, raw = false) => {
    const req = new Request("https://algosize.test" + path, {
      method: "POST",
      headers: raw ? {} : { "content-type": "application/json" },
      body: raw ? body : JSON.stringify(body),
    });
    req.user = { userId: "u_fix", email: "fix@example.test" };
    return req;
  };

  // propose, end to end, against a real D1 so the audit row is real.
  const env = { AI: scriptedAI([GOOD_REPLY]), DB: makeD1() };
  const res = await proposeFixHandler(post("/api/fix/propose", { finding: FINDING, files: FILES }), env, null);
  const body = await res.json();
  expect(res.status === 200 && body.applyable === true,
    `POST /api/fix/propose returns an applyable fix (got ${res.status})`);
  expect(body.proposal && body.validation && typeof body.patch === "string",
    "…carrying proposal, validation and patch together — one response, one review");

  const audit = await env.DB.prepare("SELECT action, metadata_json FROM audit_log").all();
  const row = (audit.results || [])[0];
  expect(row && row.action === "fix.proposed",
    "every execution writes a fix.proposed audit row");
  expect(row && !String(row.metadata_json).includes("SELECT * FROM users"),
    "…whose metadata is hashes and verdicts, never source");

  // validate: the symmetric path for a fix the CALLER wrote.
  const vres = await validateFixHandler(post("/api/fix/validate", {
    finding: { ruleId: FINDING.ruleId, fingerprint: FINDING.fingerprint, line: FINDING.line },
    original: { path: "src/app.js", content: VULN_SRC },
    fixed:    { path: "src/app.js", content: FIXED_SRC },
  }), {}, null);
  const vbody = await vres.json();
  expect(vres.status === 200 && vbody.applyable === true,
    "POST /api/fix/validate grades an external fix with the same engine");

  const vbad = await validateFixHandler(post("/api/fix/validate", {
    finding: { ruleId: FINDING.ruleId, fingerprint: FINDING.fingerprint },
    original: { path: "a.js", content: "x" }, fixed: { path: "b.js", content: "y" },
  }), {}, null);
  expect(vbad.status === 400, "…and refuses mismatched paths");

  // explain-rule.
  const eres = explainRuleHandler(new Request("https://algosize.test/api/fix/rule?id=" + FINDING.ruleId + "&path=src/app.js"));
  const ebody = await eres.json();
  expect(eres.status === 200 && ebody.rule.remediation && ebody.pathInfo.tier === 1,
    "GET /api/fix/rule returns registry metadata plus the path's scan tier");
  expect((await explainRuleHandler(new Request("https://algosize.test/api/fix/rule?id=nope"))).status === 404,
    "…and 404s an unknown rule");

  // SARIF import through the handler.
  const sarifDoc = JSON.stringify({ runs: [{ tool: { driver: { name: "ExtTool", rules: [] } },
    results: [{ ruleId: "X1", level: "error", message: { text: "boom" },
      locations: [{ physicalLocation: { artifactLocation: { uri: "a.py" }, region: { startLine: 3 } } }] }] }] });
  const ires = await importSarifHandler(post("/api/import/sarif", sarifDoc, true), {}, null);
  const ibody = await ires.json();
  expect(ires.status === 200 && ibody.findings.length === 1 && ibody.findings[0].ruleId === "sarif.exttool.X1",
    "POST /api/import/sarif normalizes external results with namespaced rule ids");
  expect(ibody.findings[0].evidence.importedRuleId === "X1",
    "…preserving the mapping back to the source tool's id");
  expect((await importSarifHandler(post("/api/import/sarif", "not json", true), {}, null)).status === 400,
    "…and rejects a non-SARIF body");
}

// ===========================================================================
group("SARIF import semantics");
// ===========================================================================
{
  const doc = { runs: [{ tool: { driver: { name: "T", rules: [
    { id: "r1", properties: { "security-severity": "9.5" } },
    { id: "r2", properties: { "security-severity": "5.0" } },
  ] } }, results: [
    { ruleId: "r1", level: "note", message: { text: "a" },
      locations: [{ physicalLocation: { artifactLocation: { uri: "x.go" }, region: { startLine: 1 } } }] },
    { ruleId: "r2", message: { text: "b" },
      locations: [{ physicalLocation: { artifactLocation: { uri: "x.go" }, region: { startLine: 2 } } }] },
    { ruleId: "r3", level: "error", message: { text: "c" },
      locations: [{ physicalLocation: { artifactLocation: { uri: "x.go" }, region: { startLine: 3 } } }] },
  ] }] };
  const r = fromSarif(doc);
  const sev = Object.fromEntries(r.findings.map((f) => [f.evidence.importedRuleId, f.severity]));
  expect(sev.r1 === "critical", "security-severity 9.5 beats a 'note' level");
  expect(sev.r2 === "medium", "security-severity 5.0 maps to medium");
  expect(sev.r3 === "high",
    "a bare 'error' maps to high, never critical — three levels cannot express critical and inventing it would overclaim");
  expect(r.findings.every((f) => f.confidence === "medium"),
    "imported confidence caps at medium: we vouch for the mapping, not the finding");
  expect(!fromSarif({ not: "sarif" }).ok, "a document without runs[] is refused");
}

// ===========================================================================
group("MCP: the fix tools are registered and honestly described");
// ===========================================================================
{
  const names = TOOLS.map((t) => t.name);
  for (const n of ["algosize_propose_code_fix", "algosize_validate_fix", "algosize_explain_finding"]) {
    expect(names.includes(n), `${n} is in the tool catalog`);
  }
  const fixGroup = TOOL_GROUPS.find((g) => g.id === "fixes");
  expect(fixGroup && fixGroup.tools.length === 3, "…grouped under Fixes for the dashboard catalog");

  const gen = TOOLS.find((t) => t.name === "algosize_propose_code_fix");
  expect(/tests and builds are YOURS to run/i.test(gen.description),
    "generate_fix's description tells the agent what validation does NOT cover");
  expect(/never pushes code/i.test(gen.description),
    "…and that applying is the client's job — no tool pretends to push");
  const names2 = names.join(",");
  expect(!/apply_patch|create_pr|create_branch/.test(names2),
    "no apply/branch/PR tool exists server-side: a tool that cannot do the thing should not exist");

  // The guard that would have caught this file's own first draft: it named
  // the new tool `algosize_generate_fix`, which analysis.js already uses.
  // Duplicate names are invalid MCP, and `TOOLS.find` silently returns the
  // first — so the catalog looked fine and the wrong tool answered.
  const dupes = names.filter((n, i) => names.indexOf(n) !== i);
  expect(dupes.length === 0, `every tool name is unique${dupes.length ? " — duplicated: " + [...new Set(dupes)].join(", ") : ` (${names.length} tools)`}`);
  expect(names.includes("algosize_generate_fix"),
    "…and the pre-existing advisory fix generator keeps its published name");
}

console.log("");
if (failures === 0) {
  console.log("\x1b[32m  all fix-orchestration tests passed\x1b[0m\n");
  process.exit(0);
} else {
  console.log(`\x1b[31m  ${failures} fix-orchestration test(s) failed\x1b[0m\n`);
  process.exit(1);
}
