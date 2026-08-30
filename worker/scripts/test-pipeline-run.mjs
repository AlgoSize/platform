// POST /api/pipeline/run — the endpoint that makes the Fix Pipeline page mean
// something, plus the funnel-blended estimate and the parked handoff it feeds.
//
// WHY THIS FILE EXISTS. fix/pipeline.js shipped with a full test suite and no
// caller: nothing in the Worker ever ran the orchestrator, so `waiting_for_agent`
// was an outcome no finding could reach and the handoff endpoint had no parked
// set to hand over. Unit-testing the orchestrator again would not have caught
// that — the module was always fine. What was missing was the wiring, so these
// tests go through the ROUTER, with a real D1 stub and a stubbed Workers AI
// binding, and assert on what a client actually receives.
//
// Run with:  node scripts/test-pipeline-run.mjs

import worker from "../src/index.js";
import { makeD1 } from "./_d1-stub.mjs";
import { issueJWT } from "../src/auth.js";
import {
  estimatePipelineCost, validateStageConfig, expandRouting,
  stageOptions, FUNNEL_SHARE, validModelsForStage,
} from "../src/ai/stages.js";
import { handoffFindingsHandler } from "../src/handlers/handoff.js";

let failures = 0;
const ok = (m) => console.log(`  \x1b[32m✓\x1b[0m ${m}`);
const fail = (m) => { console.log(`  \x1b[31m✗\x1b[0m ${m}`); failures++; };
const expect = (cond, label) => (cond ? ok(label) : fail(label));
const group = (name) => console.log(`\n\x1b[1m${name}\x1b[0m\n`);
const approx = (a, b, eps = 1e-9) => typeof a === "number" && Math.abs(a - b) < eps;

// ---------------------------------------------------------------------------
// The funnel blend — the number the page quotes
// ---------------------------------------------------------------------------

group("the estimate is blended across the funnel, not charged at full volume");

const FULL = {
  triage: "@cf/openai/gpt-oss-20b",
  validate: "@cf/qwen/qwen3-30b-a3b-fp8",
  fix: "@cf/moonshotai/kimi-k2.7-code",
  verify: validModelsForStage("verify", { exclude: ["@cf/qwen/qwen3-30b-a3b-fp8"] })[0].model,
};

{
  const est = estimatePipelineCost(FULL);
  const stages = est.perStage;

  expect(stages.fix.share === 0.10 && stages.validate.share === 0.15 && stages.triage.share === 1,
    "each stage carries the share of findings that actually reach it");
  expect(approx(stages.fix.algosizePrice, stages.fix.algosizePricePerRun * 0.10),
    "the fix stage contributes its price at a tenth of the volume, because that is how many findings reach it");
  expect(stages.fix.algosizePricePerRun > stages.fix.algosizePrice,
    "…and the per-run figure is kept alongside it, so 'what does one fix cost' is still answerable");

  // The bug this replaces: summing every stage at 100% quoted several times
  // the real cost, because the coding model — the expensive one — sees a tenth
  // of the traffic.
  const naive = Object.values(stages).reduce((n, s) => n + (s.algosizePricePerRun || 0), 0);
  expect(est.perFinding.algosizePrice < naive / 4,
    "the blended total is far below the sum of every stage at full volume (the old, wrong number)");

  expect(approx(est.perFinding.per100Findings, est.perFinding.algosizePrice * 100),
    "the same figure is offered per 100 findings, which is the scale people budget in");
  expect(stages.detect.algosizePrice === 0 && stages.detect.share === 1,
    "Stage 1 is in the breakdown at $0 — deterministic rules run on every finding and call no model");
}

group("an unpriced stage has no total, not a smaller one");

{
  const est = estimatePipelineCost({ ...FULL, validate: "@cf/nobody/ghost" });
  expect(est.perFinding.partial === true && est.perFinding.algosizePrice === null,
    "a quote with an unpriced stage returns NO headline price — a price is not a rollup, " +
    "and the sum of the rest is an incomplete pipeline, not a cheaper one");
  expect(est.perFinding.per100Findings === null,
    "…and the per-100 figure is null for the same reason rather than being derived from a null");
  expect(est.perFinding.unpricedStages.join() === "validate",
    "…and the stage responsible is named, so the gap is fixable rather than mysterious");
  expect(est.perStage.triage.algosizePrice > 0,
    "…while the stages that ARE priced still show their contribution");
}

group("routing the fix stage parks verification with it");

{
  expect(expandRouting(["fix"]).sort().join() === "fix,verify",
    "routing S4 expands to S4+S5 — the agent holds the patch, so nothing here can verify it");
  expect(expandRouting(["triage"]).join() === "triage",
    "…and routing another stage does not drag anything along with it");

  const est = estimatePipelineCost(FULL, { routeToMcp: ["fix"] });
  expect(est.perStage.fix.routedToMcp === true && est.perStage.verify.routedToMcp === true,
    "both stages are billed at $0 Workers AI once the fix is routed");
  expect(est.perFinding.algosizePrice < estimatePipelineCost(FULL).perFinding.algosizePrice,
    "…which is cheaper than running the whole pipeline in-house");

  // The distinct-model rule must not fire on stages Algosize is not running.
  const clash = { ...FULL, verify: FULL.fix };
  expect(validateStageConfig(clash).ok === false,
    "S5 == S4 is rejected when Algosize runs both");
  expect(validateStageConfig(clash, { routeToMcp: ["fix"] }).ok === true,
    "…but NOT when the agent runs both — there is no in-house grader to conflict with, " +
    "and rejecting here would teach someone to clear a field to get past an error about nothing");
}

group("the stage registry describes the whole chain, so a client invents nothing");

{
  const opts = stageOptions();
  expect(opts[0].id === "detect" && opts[0].selectable === false && opts[0].options.length === 0,
    "Stage 1 leads the list as a non-selectable anchor");
  expect(opts.every((s) => typeof s.description === "string" && s.description.length > 0),
    "every stage carries its own description — the copy lives with the rules, not in the frontend");
  expect(opts.filter((s) => s.selectable).every((s) => FUNNEL_SHARE[s.id] === s.share),
    "…and its funnel share, so the UI never hardcodes 15% or 10%");
}

// ---------------------------------------------------------------------------
// The endpoint
// ---------------------------------------------------------------------------

group("POST /api/pipeline/run");

const now = Date.now();
const EMAIL = "dev@algosize.com";

function kv() {
  const m = new Map();
  return {
    async get(k, t) { const v = m.get(k); return t === "json" && v ? JSON.parse(v) : v ?? null; },
    async put(k, v) { m.set(k, v); }, async delete(k) { m.delete(k); },
    async list() { return { keys: [...m.keys()].map((name) => ({ name })) }; },
  };
}

/** A Workers AI stub that says "true positive, exploitable" to everything. */
function aiStub(calls) {
  return {
    async run(model, input) {
      calls.push(model);
      const text = JSON.stringify(input).slice(0, 4000);
      const reply = /verdict/.test(text)
        ? { verdict: "tp", confidence: 0.9, reason: "reachable from a request parameter" }
        : { exploitable: true, severity: "high", confidence: 0.9, reason: "tainted sink" };
      return { response: JSON.stringify(reply), usage: { prompt_tokens: 120, completion_tokens: 40 } };
    },
  };
}

const FINDING = {
  ruleId: "sql-injection", fingerprint: "fp_parked_1", severity: "high",
  category: "injection", title: "SQL injection", path: "src/api.js", line: 3,
  evidence: { source: "req.query.id", sink: "db.exec" },
};

async function makeEnv(calls) {
  const env = {
    DB: makeD1(), SESSIONS: kv(), USERS: kv(),
    JWT_SECRET: "test-secret-value-long-enough-for-hmac",
    COOKIE_NAME: "algosize_session",
    AI: aiStub(calls),
    ENVIRONMENT: "test",
  };
  const q = (sql, ...a) => env.DB.prepare(sql).bind(...a).run();
  const sec = Math.floor(now / 1000);
  await q(`INSERT INTO organisations (org_id, name, created_at, updated_at) VALUES (?, ?, ?, ?)`,
          "org_a", "Aster", sec, sec);
  await q(`INSERT INTO users (user_id, email, active_org_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
          "usr_1", EMAIL, "org_a", sec, sec);
  // A stored scan run whose source findings the pipeline will consume.
  await q(`INSERT INTO runs (id, user_id, org_id, source, analyzer, input_json, result_json, ms, headline, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          "run_scan_1", "usr_1", "org_a", "dashboard", "vuln",
          JSON.stringify({ repoUrl: null }),
          JSON.stringify({ source: { findings: [FINDING] } }),
          10, "1 issue", now);
  return env;
}

async function post(env, path, body) {
  const token = await issueJWT(env, "usr_1", EMAIL, "active");
  const res = await worker.fetch(new Request(`https://algosize.com${path}`, {
    method: "POST",
    headers: { Cookie: `algosize_session=${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  }), env, { waitUntil() {} });
  return { status: res.status, body: await res.json() };
}

{
  const calls = [];
  const env = await makeEnv(calls);

  // An invalid config must cost nothing at all.
  const rejected = await post(env, "/api/pipeline/run", {
    runId: "run_scan_1", config: { fix: FULL.fix, verify: FULL.fix },
  });
  expect(rejected.status === 422 && rejected.body.errors.some((e) => e.code === "must_differ"),
    "a config that would let a fix grade its own author is rejected 422");
  expect(calls.length === 0,
    "…before any model is called, so an invalid configuration is free");

  const missing = await post(env, "/api/pipeline/run", { runId: "run_nope" });
  expect(missing.status === 404, "a run the caller cannot see is 404, not an empty result");

  const noInput = await post(env, "/api/pipeline/run", {});
  expect(noInput.status === 400, "neither a runId nor inline findings is a 400");
}

{
  const calls = [];
  const env = await makeEnv(calls);
  const run = await post(env, "/api/pipeline/run", {
    runId: "run_scan_1", config: FULL, routeToMcp: ["fix"],
  });

  expect(run.status === 200, "a valid run returns 200");
  expect(run.body.parked === 1 && run.body.summary.funnel.waiting_for_agent === 1,
    "a finding that survives triage and validation with the fix routed is PARKED for an agent");
  expect(run.body.routeToMcp.sort().join() === "fix,verify",
    "…and the response says both stages were routed, not just the one that was asked for");
  expect(calls.every((m) => !/kimi|coder/i.test(m)),
    "…and no coding model was called — that saving is the entire point of routing");
  expect(run.body.attached === true,
    "the result is attached to the scan run so the handoff can find the parked findings");

  // The handoff must now hand over the PARKED set, not the raw scan.
  const req = {
    url: "https://algosize.com/api/fix/handoff?runId=run_scan_1&agent=claude_code",
    user: { userId: "usr_1", email: EMAIL }, org: null,
  };
  const res = await handoffFindingsHandler(req, env, { waitUntil() {} });
  const handoff = await res.json();
  expect(handoff.selection === "parked" && handoff.parked === 1,
    "the handoff reports that it is handing over findings the pipeline parked");
  expect(handoff.findings.length === 1 && handoff.findings[0].fingerprint === "fp_parked_1",
    "…and hands over exactly that finding");
  expect(/claude mcp add algosize/.test(handoff.prompt),
    "the prompt carries the MCP connect command for the chosen agent, so it is paste-able as-is");
  expect(/Never print its/.test(handoff.prompt) && handoff.prompt.indexOf("ask_" + "live_") === -1,
    "…names the key by variable only, and tells the agent never to print it");
}

{
  // No pipeline result on the run → the handoff still answers, and says which
  // set it is returning rather than implying these findings were triaged.
  const calls = [];
  const env = await makeEnv(calls);
  const req = {
    url: "https://algosize.com/api/fix/handoff?runId=run_scan_1",
    user: { userId: "usr_1", email: EMAIL }, org: null,
  };
  const res = await handoffFindingsHandler(req, env, { waitUntil() {} });
  const handoff = await res.json();
  expect(handoff.selection === "all_findings" && handoff.parked === null,
    "a scan the pipeline never ran over returns the raw findings AND says so — " +
    "an agent must not be told untriaged noise survived a funnel it never entered");
}

{
  // Inline mode: the caller holds the source. No run row involved.
  const calls = [];
  const env = await makeEnv(calls);
  const inline = await post(env, "/api/pipeline/run", {
    findings: [FINDING],
    files: [{ path: "src/api.js", content: "function h(req){ db.exec(unsafe(req.query.id)); }" }],
    config: FULL, routeToMcp: ["fix"],
  });
  expect(inline.status === 200 && inline.body.sourceMode === "inline",
    "a caller holding its own checkout can run the pipeline without a stored scan");
  expect(inline.body.runId === null && inline.body.attached === false,
    "…and nothing is attached anywhere, because there is no run to attach it to");
}

group("the pipeline result is written to the run it was computed from, and no other");

{
  const calls = [];
  const env = await makeEnv(calls);
  const sec = Math.floor(now / 1000);
  const q = (sql, ...a) => env.DB.prepare(sql).bind(...a).run();
  // A second tenant with its own scan run.
  await q(`INSERT INTO organisations (org_id, name, created_at, updated_at) VALUES (?, ?, ?, ?)`,
          "org_b", "Beacon", sec, sec);
  await q(`INSERT INTO runs (id, user_id, org_id, source, analyzer, input_json, result_json, ms, headline, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          "run_other_tenant", "usr_2", "org_b", "dashboard", "vuln",
          "{}", JSON.stringify({ source: { findings: [FINDING] } }), 10, "1 issue", now);

  const stolen = await post(env, "/api/pipeline/run", { runId: "run_other_tenant", config: FULL });
  expect(stolen.status === 404,
    "a run belonging to another tenant is 404 — the pipeline cannot be pointed at it");

  const row = await env.DB.prepare("SELECT result_json FROM runs WHERE id = ?")
    .bind("run_other_tenant").first();
  expect(JSON.parse(row.result_json).pipeline === undefined,
    "…and nothing was written to it: the attach is pinned to the owner the scoped read returned, " +
    "so there is no shape of that UPDATE that lands on another tenant's row");

  // The legitimate write still lands.
  await post(env, "/api/pipeline/run", { runId: "run_scan_1", config: FULL, routeToMcp: ["fix"] });
  const mine = await env.DB.prepare("SELECT result_json FROM runs WHERE id = ?")
    .bind("run_scan_1").first();
  expect(JSON.parse(mine.result_json).pipeline.summary.funnel.waiting_for_agent === 1,
    "…while the caller's own run does get its pipeline result");
}

console.log("");
if (failures) {
  console.log(`\x1b[31m  ${failures} pipeline-run test(s) failed\x1b[0m\n`);
  process.exit(1);
}
console.log("\x1b[32m  all pipeline-run tests passed\x1b[0m\n");
