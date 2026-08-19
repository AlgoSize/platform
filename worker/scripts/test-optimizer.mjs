// Tests for the extracted optimizer core (analyzers/optimizer.js), the
// per-finding fix generator (analyzers/fixgen.js + /api/fix), and the CI
// entrypoint's pure helpers (extraction, regression ranking).
//
// Big-O CLASSIFICATION cases use an injected runner with synthetic timings so
// they are deterministic — real wall-clock at the fixed probe sizes sits near
// the noise floor and would make exact-label assertions flaky. One
// real-sandbox case proves the pipeline itself runs headless under Node.

import { runOptimizer, validateOptimizerInput, synthInputForSize, PROBE_SIZES } from "../src/analyzers/optimizer.js";
import { validateFixInput, buildFixPrompt, generateFix } from "../src/analyzers/fixgen.js";
import { generateFixHandler } from "../src/handlers/fix.js";
import { llmChat, extractWorkersAiReply } from "../src/analyzers/llm.js";
import { extractFunction, rankOf } from "./optimizer-ci.mjs";

let failures = 0;
const ok   = (msg) => console.log(`  \x1b[32m✓\x1b[0m ${msg}`);
const fail = (msg) => { console.log(`  \x1b[31m✗\x1b[0m ${msg}`); failures++; };
const expect = (cond, label) => cond ? ok(label) : fail(label);

// A runner whose timing is an exact function of input size: ms = f(n).
// Non-array inputs (the sample run) get n = 1.
const syntheticRunner = (f) => async (code, input) => {
  const n = Array.isArray(input) ? input.length : typeof input === "number" ? input : 1;
  return { ok: true, ms: f(n), heapBytes: 0, result: null };
};

console.log("\noptimizer core — validation\n");

{
  const v = validateOptimizerInput({});
  expect(!v.ok && v.error === "invalid_payload" && /`code`/.test(v.message),
    "empty input → invalid_payload naming `code` (the Worker contract; " +
    "the dashboard's 'Paste a function first.' is frontend pre-validation)");
  const v2 = validateOptimizerInput({ code: "   " });
  expect(!v2.ok, "whitespace-only code → invalid_payload");
  const v3 = validateOptimizerInput({ code: "function f(x){return x}" });
  expect(v3.ok && Array.isArray(v3.value.sampleInput) && v3.value.sampleInput.length === 100,
    "sampleInput defaults to a length-100 array");
}

console.log("\noptimizer core — Big-O classification (synthetic timings)\n");

{
  // ms proportional to n → slope 1 → O(n).
  const r = await runOptimizer(
    { code: "function f(a){return a}", sampleInput: [1, 2, 3] },
    { runner: syntheticRunner((n) => n / 100), enableRefactor: false },
  );
  expect(r.ok && r.bigO.label === "O(n)", `linear timings → O(n) (got ${r.ok && r.bigO.label})`);
  expect(r.bigO.points.length === PROBE_SIZES.length, "probe ran at all 3 sizes");
}

{
  // ms proportional to n² → slope 2 → O(n²).
  const r = await runOptimizer(
    { code: "function f(a){return a}", sampleInput: [1, 2, 3] },
    { runner: syntheticRunner((n) => (n / 100) ** 2), enableRefactor: false },
  );
  expect(r.ok && r.bigO.label === "O(n²)", `quadratic timings → O(n²) (got ${r.ok && r.bigO.label})`);
}

{
  // Object-shaped sample input → probe skipped with a stated reason.
  const r = await runOptimizer(
    { code: "function f(a){return a}", sampleInput: { a: 1 } },
    { runner: syntheticRunner(() => 1), enableRefactor: false },
  );
  expect(r.ok && r.bigO.label === "unknown" && /not an array or number/.test(r.bigO.reason),
    "object input → unknown with explanatory reason");
}

console.log("\noptimizer core — real sandbox, headless Node\n");

{
  // No injected runner: the in-process sandbox_runner executes for real —
  // the property the CI entrypoint depends on. Only pipeline-shape is
  // asserted, not the label (real timings are noisy at these sizes).
  const r = await runOptimizer(
    { code: "function total(a){var s=0;for(var i=0;i<a.length;i++){s+=a[i];}return s}", sampleInput: [1, 2, 3] },
    { enableRefactor: false },
  );
  expect(r.ok === true, "in-process sandbox runs under plain Node");
  expect(typeof r.wallTimeMs === "number" && typeof r.bigO.label === "string",
    "returns measured wall time and a Big-O label");
  const bad = await runOptimizer({ code: "function f(){require('fs')}", sampleInput: 1 }, {});
  expect(!bad.ok && bad.error === "forbidden_import", "hostile code → forbidden_import, not a crash");
}

console.log("\noptimizer core — refactor flag\n");

{
  let llmCalled = false;
  const env = {
    OPENAI_API_KEY: "sk-test",
    OPENAI_FETCH: async () => { llmCalled = true; return { ok: true, json: async () => ({ choices: [{ message: { content: "x" } }] }) }; },
  };
  const off = await runOptimizer(
    { code: "function f(a){return a}", sampleInput: [1] },
    { runner: syntheticRunner((n) => n / 100), env, enableRefactor: false },
  );
  expect(off.ok && off.suggestion.provider === "disabled" && llmCalled === false,
    "enableRefactor:false → provider 'disabled', LLM never called");

  const envOff = { ...env, ENABLE_REFACTOR_SUGGESTIONS: "false" };
  const viaEnv = await runOptimizer(
    { code: "function f(a){return a}", sampleInput: [1] },
    { runner: syntheticRunner((n) => n / 100), env: envOff },
  );
  expect(viaEnv.suggestion.provider === "disabled" && llmCalled === false,
    "ENABLE_REFACTOR_SUGGESTIONS=false in env → also disabled");

  const on = await runOptimizer(
    { code: "function f(a){return a}", sampleInput: [1] },
    { runner: syntheticRunner((n) => n / 100), env, enableRefactor: true },
  );
  expect(on.suggestion.provider === "openai" && llmCalled === true,
    "enableRefactor:true → LLM called (default web behavior unchanged)");
}

console.log("\nllmChat — Workers AI provider chain\n");

{
  // Binding first.
  const env = { AI: { run: async (model, opts) => ({ response: "prose\n```js\ncode()\n```" }) } };
  const r = await llmChat({ system: "s", user: "u" }, env);
  expect(r.ok && r.provider === "workers-ai", "AI binding present → provider workers-ai");

  // REST when no binding (the CI path).
  const rest = await llmChat({ system: "s", user: "u" }, {
    CLOUDFLARE_ACCOUNT_ID: "acct", CLOUDFLARE_AI_TOKEN: "tok",
    WORKERS_AI_FETCH: async (url) => {
      expect(/accounts\/acct\/ai\/run\/@cf\//.test(url), "REST URL targets the account's ai/run route");
      return { ok: true, json: async () => ({ result: { response: "hi" }, success: true }) };
    },
  });
  expect(rest.ok && rest.provider === "workers-ai", "REST creds, no binding → workers-ai via REST");

  // Binding failure falls through to OpenAI when configured.
  const fallthrough = await llmChat({ system: "s", user: "u" }, {
    AI: { run: async () => { throw new Error("model cold"); } },
    OPENAI_API_KEY: "sk-x",
    OPENAI_FETCH: async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: "y" } }] }) }),
  });
  expect(fallthrough.ok && fallthrough.provider === "openai",
    "binding failure falls through to OpenAI");

  // Nothing configured.
  const none = await llmChat({ system: "s", user: "u" }, {});
  expect(!none.ok && none.configured === false, "no provider → configured:false");

  // Chat-completion-shaped Workers AI response (Kimi and other chat models)
  // — reading only `.response` against this shape used to return "", which
  // callers reported as "Workers AI returned an empty reply" even though the
  // model answered. Both the binding and REST paths must read it correctly.
  expect(extractWorkersAiReply({ choices: [{ message: { content: "kimi says hi" } }] }) === "kimi says hi",
    "extractWorkersAiReply reads the OpenAI-compatible choices[0].message.content shape");
  expect(extractWorkersAiReply({ response: "llama says hi" }) === "llama says hi",
    "extractWorkersAiReply still reads the traditional { response } shape");
  expect(extractWorkersAiReply({}) === "" && extractWorkersAiReply(null) === "",
    "extractWorkersAiReply returns '' rather than throwing on neither shape / no result");

  const bindingChatShape = await llmChat({ system: "s", user: "u" }, {
    AI: { run: async () => ({ choices: [{ message: { content: "prose\n```js\ncode()\n```" } }] }) },
  });
  expect(bindingChatShape.ok && bindingChatShape.provider === "workers-ai" && /prose/.test(bindingChatShape.reply),
    "AI binding returning the chat-completion shape is read correctly, not reported as empty");

  const restChatShape = await llmChat({ system: "s", user: "u" }, {
    CLOUDFLARE_ACCOUNT_ID: "acct", CLOUDFLARE_AI_TOKEN: "tok",
    WORKERS_AI_FETCH: async () => ({
      ok: true, json: async () => ({ result: { choices: [{ message: { content: "hi via rest" } }] }, success: true }),
    }),
  });
  expect(restChatShape.ok && restChatShape.reply === "hi via rest",
    "Workers AI REST path also reads the chat-completion shape, not just { response }");

  // max_tokens floor: a reasoning model can spend its whole budget on hidden
  // reasoning before the visible answer, so the request sent to Workers AI
  // must never be capped at the caller's low default (800) — a caller that
  // asks for more than the floor keeps its own higher value.
  let sentBindingTokens = null;
  await llmChat({ system: "s", user: "u" }, {
    AI: { run: async (model, opts) => { sentBindingTokens = opts.max_tokens; return { response: "ok" }; } },
  });
  expect(sentBindingTokens >= 4096, `AI binding call raises max_tokens to the reasoning-model floor (got ${sentBindingTokens})`);

  let sentRestTokens = null;
  await llmChat({ system: "s", user: "u" }, {
    CLOUDFLARE_ACCOUNT_ID: "acct", CLOUDFLARE_AI_TOKEN: "tok",
    WORKERS_AI_FETCH: async (url, opts) => {
      sentRestTokens = JSON.parse(opts.body).max_tokens;
      return { ok: true, json: async () => ({ result: { response: "ok" } }) };
    },
  });
  expect(sentRestTokens >= 4096, `Workers AI REST call also raises max_tokens to the floor (got ${sentRestTokens})`);

  let sentOpenAiTokens = null;
  await llmChat({ system: "s", user: "u" }, {
    OPENAI_API_KEY: "sk-x",
    OPENAI_FETCH: async (url, opts) => {
      sentOpenAiTokens = JSON.parse(opts.body).max_tokens;
      return { ok: true, json: async () => ({ choices: [{ message: { content: "ok" } }] }) };
    },
  });
  expect(sentOpenAiTokens === 800, `OpenAI's budget is left at the caller's default, not raised — it isn't a reasoning model (got ${sentOpenAiTokens})`);

  let sentHigherBindingTokens = null;
  await llmChat({ system: "s", user: "u", maxTokens: 9000 }, {
    AI: { run: async (model, opts) => { sentHigherBindingTokens = opts.max_tokens; return { response: "ok" }; } },
  });
  expect(sentHigherBindingTokens === 9000, `a caller-requested budget above the floor is respected, not clamped down (got ${sentHigherBindingTokens})`);
}

console.log("\nper-finding fix generation\n");

{
  const bad = validateFixInput({ kind: "cost", finding: {} });
  expect(!bad.ok && bad.error === "invalid_kind", "kind outside vuln/arch → invalid_kind");
  expect(!validateFixInput({ kind: "vuln" }).ok, "missing finding → rejected");

  const vp = buildFixPrompt({ kind: "vuln", finding: {
    id: "GHSA-x", package: "lodash", installedVersion: "4.17.11", fixedIn: "4.17.21", severity: "critical",
  }, context: null });
  expect(/GHSA-x/.test(vp.user) && /4\.17\.21/.test(vp.user) && /security engineer/.test(vp.system),
    "vuln prompt carries advisory id + fixedIn");

  const ap = buildFixPrompt({ kind: "arch", finding: {
    rule: "committed_secret", lens: "security", severity: "critical",
    target: ".github/workflows/e2e.yml", why: "literal secret",
    evidence: [{ file: "e2e.yml", line: 68, detail: "JWT_SECRET=..." }],
  }, context: null });
  expect(/committed_secret/.test(ap.user) && /e2e\.yml:68/.test(ap.user),
    "arch prompt carries rule + file:line evidence");

  // Unconfigured env → 503-shaped refusal, not a fake fix.
  const un = await generateFix({ kind: "vuln", finding: { id: "GHSA-x" }, context: null }, {});
  expect(!un.ok && un.status === 503 && un.error === "fix_generation_unavailable",
    "no AI provider → fix_generation_unavailable (503)");

  // Happy path through the HTTP handler with a mocked binding.
  const env = { AI: { run: async () => ({ response: "Do this.\n```js\nnpm i lodash@4.17.21\n```" }) } };
  const req = new Request("https://x/api/fix", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ kind: "vuln", finding: { id: "GHSA-x", package: "lodash" } }),
  });
  const res = await generateFixHandler(req, env, null);
  const body = await res.json();
  expect(res.status === 200 && body.fix && body.fix.provider === "workers-ai",
    "handler → 200 with provider workers-ai");
  expect(/npm i lodash/.test(body.fix.code || ""), "fenced block extracted into fix.code");
}

console.log("\nCI entrypoint helpers\n");

{
  expect(rankOf("O(1)") < rankOf("O(n)") && rankOf("O(n)") < rankOf("O(n²)"),
    "severity ladder orders O(1) < O(n) < O(n²)");
  expect(rankOf("O(n^2)") === rankOf("O(n²)"), "ASCII O(n^2) normalises to O(n²)");
  expect(rankOf("O(n^4.7)") > rankOf("O(n³)"), "unrecognised labels rank worst");

  const src = "const A = 1;\nexport function foo(a) { return a; }\nfunction bar(b) {\n  return b + 1;\n}\n";
  expect(extractFunction(src, "bar") === "function bar(b) {\n  return b + 1;\n}",
    "extractFunction slices a plain declaration verbatim");
  expect(/^export function foo/.test("export " + extractFunction(src, "foo")),
    "extractFunction finds exported declarations too");
  expect(extractFunction(src, "nope") === null, "missing function → null, not a throw");
}

console.log("\nsynthetic input shapes\n");

{
  expect(synthInputForSize([7, 8], 6).join(",") === "7,8,7,8,7,8", "arrays cycle the sample values");
  expect(synthInputForSize(5, 1000) === 1000, "numbers scale to n");
  expect(synthInputForSize("str", 10) === null, "other shapes → null (probe skipped)");
}

// ---------- summary ----------
console.log("");
if (failures === 0) {
  console.log("\x1b[32m  all optimizer tests passed\x1b[0m\n");
  process.exit(0);
} else {
  console.log(`\x1b[31m  ${failures} optimizer test(s) failed\x1b[0m\n`);
  process.exit(1);
}
