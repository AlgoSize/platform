// Which LLM gets called, and over which endpoint.
//
// Kimi K3 is a THIRD-PARTY entry in Cloudflare's catalog (`moonshotai/kimi-k3`,
// no `@cf/` prefix), and three things differ from the first-party K2.x models
// the optimizer used before. Each one fails quietly rather than loudly, which
// is exactly why they are pinned here:
//
//   • a third-party slug sent to /ai/run/<model> 404s, so the REST leg has to
//     switch to the OpenAI-compatible /ai/v1/chat/completions route;
//   • that route returns the payload at the top level, while /ai/run wraps it
//     in `result` — reading the wrong one yields "empty reply" for a call that
//     actually worked;
//   • third-party models need an AI Gateway, so with none configured the code
//     must stay on the proven K2.6 path instead of degrading refactor
//     suggestions to a stub nobody notices.

import { llmChat, extractWorkersAiReply } from "../src/analyzers/llm.js";

let failures = 0;
const ok   = (m) => console.log(`  \x1b[32m✓\x1b[0m ${m}`);
const fail = (m) => { console.log(`  \x1b[31m✗\x1b[0m ${m}`); failures++; };
const expect = (c, l) => (c ? ok(l) : fail(l));
const group  = (n) => console.log(`\n\x1b[1m${n}\x1b[0m\n`);

/** A fetch stub that records what it was asked for. */
function recordingFetch(payload) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body), headers: init.headers });
    return { ok: true, status: 200, json: async () => payload };
  };
  impl.calls = calls;
  return impl;
}

/** A binding stub that records the model, input and options it was handed. */
function recordingBinding(payload) {
  const seen = {};
  return {
    seen,
    run: async (model, input, opts) => {
      seen.model = model; seen.input = input; seen.opts = opts;
      return payload;
    },
  };
}

group("REST leg — no AI Gateway configured");
{
  const f = recordingFetch({ result: { response: "k2.6 reply" } });
  const r = await llmChat({ system: "s", user: "u" }, {
    CLOUDFLARE_ACCOUNT_ID: "acct", CLOUDFLARE_AI_TOKEN: "tok", WORKERS_AI_FETCH: f,
  });
  const call = f.calls[0];
  expect(call.url.endsWith("/ai/run/@cf/moonshotai/kimi-k2.6"),
    `stays on the first-party /ai/run path (got ${call.url.split("/acct")[1]})`);
  expect(call.body.model === undefined,
    "does not put a model in the body — /ai/run names it in the path");
  expect(r.ok && r.reply === "k2.6 reply",
    "reads the reply out of the `result` wrapper /ai/run returns");
}

group("REST leg — AI Gateway configured, so Kimi K3");
{
  const f = recordingFetch({ choices: [{ message: { content: "k3 reply" } }] });
  const r = await llmChat({ system: "s", user: "u" }, {
    AI_GATEWAY_ID: "default",
    CLOUDFLARE_ACCOUNT_ID: "acct", CLOUDFLARE_AI_TOKEN: "tok", WORKERS_AI_FETCH: f,
  });
  const call = f.calls[0];
  expect(call.url.endsWith("/ai/v1/chat/completions"),
    `switches to the OpenAI-compatible route (got ${call.url.split("/acct")[1]})`);
  expect(call.body.model === "moonshotai/kimi-k3",
    `names the model in the body (got ${call.body.model})`);
  expect(!String(call.body.model).startsWith("@cf/"),
    "and does NOT prefix a third-party slug with @cf/");
  expect(r.ok && r.reply === "k3 reply",
    "reads the reply from the top level, not from `result`");
}

group("binding leg");
{
  const ai = recordingBinding({ choices: [{ message: { content: "bound" } }] });
  const r = await llmChat({ system: "s", user: "u" }, {
    AI: ai, AI_GATEWAY_ID: "gw1", WORKERS_AI_REASONING_EFFORT: "max",
  });
  expect(ai.seen.model === "moonshotai/kimi-k3", `uses K3 when a gateway exists (got ${ai.seen.model})`);
  expect(ai.seen.opts && ai.seen.opts.gateway && ai.seen.opts.gateway.id === "gw1",
    "passes the gateway id — a third-party model is unreachable without one");
  expect(ai.seen.input.reasoning_effort === "max",
    "sends reasoning_effort, which K3 uses in place of K2.x's `thinking`");
  expect(r.ok && r.reply === "bound", "returns the reply");
}
{
  const ai = recordingBinding({ response: "bound k2.6" });
  await llmChat({ system: "s", user: "u" }, { AI: ai, WORKERS_AI_REASONING_EFFORT: "max" });
  expect(ai.seen.model === "@cf/moonshotai/kimi-k2.6",
    `falls back to K2.6 with no gateway rather than failing (got ${ai.seen.model})`);
  expect(ai.seen.opts === undefined,
    "passes no gateway option on the first-party path, where a stale id would break a working call");
  expect(ai.seen.input.reasoning_effort === undefined,
    "withholds reasoning_effort from K2.x, which would reject the unknown key");
}

group("an explicit override always wins");
{
  const ai = recordingBinding({ response: "x" });
  await llmChat({ system: "s", user: "u" }, { AI: ai, WORKERS_AI_MODEL: "@cf/meta/llama-3.3-70b-instruct-fp8-fast" });
  expect(ai.seen.model === "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
    "env.WORKERS_AI_MODEL is honoured verbatim");
}
{
  // An operator who names a third-party model without a gateway gets the real
  // attempt and the real failure — not a silent downgrade to something else,
  // which would leave them debugging a model they are not running.
  const ai = recordingBinding({ choices: [{ message: { content: "y" } }] });
  await llmChat({ system: "s", user: "u" }, { AI: ai, WORKERS_AI_MODEL: "moonshotai/kimi-k3" });
  expect(ai.seen.model === "moonshotai/kimi-k3",
    "an explicit third-party slug is not silently swapped when no gateway is set");
}

group("response-shape extraction");
{
  expect(extractWorkersAiReply({ response: "a" }) === "a", "reads the traditional { response } shape");
  expect(extractWorkersAiReply({ choices: [{ message: { content: "b" } }] }) === "b",
    "reads the chat-completions shape K2.6 and K3 both return");
  expect(extractWorkersAiReply(null) === "", "a null result is an empty reply, not a throw");
}

console.log("");
if (failures) {
  console.log(`\x1b[31m  ${failures} llm-routing test(s) failed\x1b[0m`);
  process.exit(1);
}
console.log("\x1b[32m  all llm-routing tests passed\x1b[0m");
