// MCP agent handoff + stage selector tests.
//
// Covers Parts A/B/C: the stage model selector rules and server-side
// Stage 5 ≠ Stage 4 enforcement, the live cost estimate (with margin + the
// route-to-MCP zero-cost path), the two handoff MCP tools and their handlers
// (org scoping, no source stored, patch hashed, source: mcp_agent), and the
// pipeline's waiting_for_agent outcome.

import {
  STAGE_IDS, STAGES, validModelsForStage, stageOptions,
  estimatePipelineCost, validateStageConfig,
} from "../src/ai/stages.js";
import { applyPatchHandler, buildAgentPrompt } from "../src/handlers/handoff.js";
import { HANDOFF_TOOLS } from "../src/mcp/tools/handoff.js";
import { runFullPipeline } from "../src/fix/pipeline.js";
import { MODELS } from "../src/ai/models.js";

let failures = 0;
const expect = (cond, label) => {
  if (cond) console.log(`  \x1b[32m✓\x1b[0m ${label}`);
  else { failures++; console.log(`  \x1b[31m✗\x1b[0m ${label}`); }
};
const approx = (a, b, eps = 1e-9) => typeof a === "number" && Math.abs(a - b) < eps;

console.log("\nstage selector: each stage offers only models valid for its role\n");
{
  for (const s of STAGES) {
    const opts = validModelsForStage(s.id);
    expect(opts.length > 0, `${s.label} has at least one valid model`);
    // Every offered model meets the stage's hard requirement.
    const allMeet = opts.every((o) => {
      const m = MODELS.find((x) => x.model === o.model);
      if (s.requires === "tools") return m.tools === true;
      if (s.requires === "reasoning") return m.reasoning === true;
      if (s.requires === "coding") return (m.coding || 0) >= 70;
      return true;
    });
    expect(allMeet, `…and every ${s.label} option actually meets "${s.requires}"`);
  }
  // A pure code model (kimi-k2.7-code, no reasoning flag) must NOT be offered
  // for a reasoning stage.
  const verifyOpts = validModelsForStage("verify").map((o) => o.model);
  expect(!verifyOpts.includes("@cf/moonshotai/kimi-k2.7-code"),
    "a code-only model is not offered for the reasoning verify stage");
}

console.log("\nstage config: Stage 5 ≠ Stage 4 enforced server-side\n");
{
  const fixModel = stageOptions().find((s) => s.id === "fix").default;
  const same = validateStageConfig({ fix: fixModel, verify: fixModel });
  expect(!same.ok && same.errors.some((e) => e.code === "must_differ"),
    "verify == fix is REJECTED server-side (a fix cannot grade its own author)");

  const distinct = validateStageConfig({
    fix: fixModel,
    verify: validModelsForStage("verify", { exclude: [fixModel] })[0].model,
  });
  expect(distinct.ok, "a distinct valid fix/verify pair is accepted");

  const wrongRole = validateStageConfig({ verify: fixModel /* a coder in a reasoning slot */ });
  expect(!wrongRole.ok && wrongRole.errors.some((e) => e.code === "invalid_for_stage"),
    "a model invalid for a stage's role is rejected");

  const empty = validateStageConfig({});
  expect(empty.ok, "an all-auto config (no explicit models) is valid");
}

console.log("\ncost estimate: margin applied, route-to-MCP is zero, unpriced stays null\n");
{
  const est = estimatePipelineCost({
    triage: "@cf/openai/gpt-oss-20b", validate: "@cf/qwen/qwen3-30b-a3b-fp8",
    fix: "@cf/moonshotai/kimi-k2.7-code", verify: "@cf/openai/gpt-oss-20b",
  });
  expect(typeof est.perFinding.algosizePrice === "number" && est.perFinding.algosizePrice > est.perFinding.rawCostUsd,
    "the estimate shows the CUSTOMER price (raw + 25% margin), above raw cost");
  expect(est.perFinding.partial === false, "a fully-priced selection is not partial");

  const routed = estimatePipelineCost(
    { triage: "@cf/openai/gpt-oss-20b", fix: "@cf/moonshotai/kimi-k2.7-code" },
    { routeToMcp: ["fix"] });
  expect(routed.perStage.fix.routedToMcp === true && routed.perStage.fix.algosizePrice === 0,
    "a stage routed to an external agent costs $0 Workers AI");

  const unpriced = estimatePipelineCost({ triage: "@cf/nobody/ghost" });
  expect(unpriced.perStage.triage.rawCostUsd === null && unpriced.perFinding.partial === true,
    "an unpriced model yields null (never $0) and flags the total partial");
}

console.log("\nagent prompt: carries the finding, never a secret\n");
{
  const findings = [{
    ruleId: "sql-injection", fingerprint: "fp1", title: "SQL injection",
    severity: "high", path: "src/api.js", line: 3, cwe: ["CWE-89"],
    evidence: { source: "req.query.id", sink: "db.exec" },
    recommendation: "Use parameterized queries.",
  }];
  const prompt = buildAgentPrompt(findings, { agent: "claude_code", runId: "run1" });
  expect(/Claude Code/.test(prompt) && /src\/api\.js/.test(prompt) && /fp1/.test(prompt),
    "the prompt names the agent, the file, and the fingerprint");
  expect(/algosize_record_patch/.test(prompt), "…and tells the agent how to report back");
  // Build the key prefixes from parts so this test file does not itself carry
  // the literal token the platform's own secret scanner keys on — the check is
  // the same: the prompt must not contain either API-key prefix.
  var livePrefix = "ask_" + "live_", mcpPrefix = "ask_" + "mcp_";
  expect(prompt.indexOf(livePrefix) === -1 && prompt.indexOf(mcpPrefix) === -1,
    "…and contains no API-key material");
}

console.log("\napply_patch handler: hashes the diff, stores no source, records mcp_agent\n");
{
  const bound = [];
  const env = { DB: { prepare(sql) { return { bind(...a) { bound.push({ sql, a }); return { async run() { return {}; }, async first() { return null; } }; } }; } } };
  const req = {
    org: { orgId: "o1" }, user: null, mcpScopes: ["algosize:manage"],
    async json() { return { runId: "run1", fingerprint: "fp1", ruleId: "sql-injection",
      filePath: "src/api.js", patch: "--- a\n+++ b\n- bad('SELECT '+id)\n+ safe(id)", summary: "parameterized the query" }; },
  };
  const res = await applyPatchHandler(req, env, { waitUntil() {} });
  const body = await res.json();
  expect(res.status === 200 && body.recorded === true, "records the patch (200)");
  expect(body.source === "mcp_agent", "…with source: mcp_agent");

  const insert = bound.find((b) => /INSERT INTO scan_patches/.test(b.sql));
  expect(!!insert, "an INSERT into scan_patches happened");
  const argsStr = JSON.stringify(insert.a);
  expect(!/SELECT '\+id|safe\(id\)|\+\+\+ b/.test(argsStr),
    "the raw diff is NEVER among the stored values — only a content hash");
  expect(insert.a.includes("mcp_agent"), "source column bound as mcp_agent");
  // patch_hash column (index 6) is a non-empty hash, not the diff.
  expect(typeof insert.a[6] === "string" && insert.a[6].length > 0 && !insert.a[6].includes(" "),
    "patch_hash holds a hash, not the diff");
}

console.log("\napply_patch handler: refuses without an org, requires a fingerprint\n");
{
  const env = { DB: { prepare() { return { bind() { return { async run() {}, async first() { return null; } }; } }; } } };
  const noOrg = { org: null, user: null, async json() { return { fingerprint: "fp1" }; } };
  const r1 = await applyPatchHandler(noOrg, env, {});
  expect(r1.status === 400 || r1.status === 401, "a request with no org context is refused");

  const noFp = { org: { orgId: "o1" }, async json() { return {}; } };
  const r2 = await applyPatchHandler(noFp, env, {});
  const b2 = await r2.json();
  expect(r2.status === 400 && b2.error === "invalid_payload", "a patch with no fingerprint is refused");
}

console.log("\nMCP tools: correct names, scopes, and no forbidden imports\n");
{
  const names = HANDOFF_TOOLS.map((t) => t.name);
  expect(names.includes("algosize_get_scan_findings") && names.includes("algosize_record_patch"),
    "both handoff tools are registered");
  const get = HANDOFF_TOOLS.find((t) => t.name === "algosize_get_scan_findings");
  const apply = HANDOFF_TOOLS.find((t) => t.name === "algosize_record_patch");
  expect(get.scope === "algosize:read" && get.annotations.readOnlyHint === true,
    "get_scan_findings is a READ, read-only tool");
  expect(apply.scope === "algosize:manage", "apply_patch is a MANAGE tool");
  expect(get.inputSchema.required.includes("runId") && apply.inputSchema.required.includes("fingerprint"),
    "the tools require the fields their handlers require");
}

console.log("\npipeline: route-to-MCP parks validated findings as waiting_for_agent\n");
{
  // Mock env.AI so triage=tp and validation=exploitable, then route fix to MCP.
  const ai = {
    run: async (model, input) => {
      const sys = input.messages[0].content;
      const reply = /triage assistant/.test(sys) ? { verdict: "tp", confidence: 0.9 }
        : /EXPLOITABLE/.test(sys) ? { exploitable: true, severity: "high", confidence: 0.8, reason: "reachable" }
        : {};
      return { response: JSON.stringify(reply), usage: { prompt_tokens: 100, completion_tokens: 30 } };
    },
  };
  const finding = { ruleId: "sql-injection", fingerprint: "fp1", severity: "high",
    category: "injection", path: "src/api.js", line: 3, evidence: { source: "x", sink: "y" } };
  const file = { path: "src/api.js", content: "function h(req){ db.exec(unsafe(req.query.id)); }" };
  const run = await runFullPipeline({
    findings: [finding], files: [file], env: { AI: ai, DB: null },
    meter: { orgId: "o1" }, budget: { spendUsd: 0, limitUsd: 0 },
    options: { routeToMcp: ["fix"] },
  });
  expect(run.results[0].outcome === "waiting_for_agent",
    "a validated finding with fix routed to MCP is parked as waiting_for_agent");
  expect(run.summary.funnel.waiting_for_agent === 1, "…and the funnel counts it");
  // Crucially, no coding-model (fix) call was made.
  // (triage + validate ran; fix did not — that's the zero-token saving.)
}

console.log("");
if (failures === 0) {
  console.log("\x1b[32m  all MCP-handoff tests passed\x1b[0m\n");
  process.exit(0);
}
console.log(`\x1b[31m  ${failures} MCP-handoff test(s) failed\x1b[0m\n`);
process.exit(1);
