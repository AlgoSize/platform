// The bridge's contract, which is mostly about what it must NOT do.
//
// A bridge that helpfully caches, or retries a metered call, or decides a tool
// list is stale, breaks the product in ways that are hard to see: a stale
// catalog looks like a missing feature, and a retried analysis looks like a
// billing dispute. So the assertions below are as much about absence as
// behaviour.
//
// Run with:  node mcp/test/smoke.test.mjs

import { Readable, Writable } from "node:stream";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readConfig, runBridge, runDegradedBridge, forward, DEFAULT_BASE_URL } from "../src/bridge.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));

let failures = 0;
const ok   = (m) => console.log(`  \x1b[32m✓\x1b[0m ${m}`);
const fail = (m) => { console.log(`  \x1b[31m✗\x1b[0m ${m}`); failures++; };
const expect = (c, l) => (c ? ok(l) : fail(l));
const group  = (n) => console.log(`\n\x1b[1m${n}\x1b[0m\n`);

const KEY = "ask_live_" + "K".repeat(43);

function collector() {
  const chunks = [];
  const stream = new Writable({ write(c, _e, cb) { chunks.push(c.toString()); cb(); } });
  stream.lines = () => chunks.join("").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  return stream;
}

/** A fetch stub that records requests and replays scripted responses. */
function stubFetch(script) {
  const calls = [];
  let i = 0;
  const impl = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body), headers: init.headers });
    const step = typeof script === "function" ? script(calls.length - 1) : script[Math.min(i++, script.length - 1)];
    return {
      status: step.status ?? 200,
      headers: new Map(Object.entries(step.headers || {})),
      text: async () => (step.body === undefined ? "" : JSON.stringify(step.body)),
    };
  };
  impl.calls = calls;
  return impl;
}
// The stub's headers need a .get(); Map provides it.

group("configuration");
{
  const c = readConfig({ ALGOSIZE_API_KEY: KEY });
  expect(c.problems.length === 0, "a valid key configures cleanly");
  expect(c.endpoint === `${DEFAULT_BASE_URL}/api/mcp`, `defaults to the production endpoint (${c.endpoint})`);

  const none = readConfig({});
  expect(none.problems.length === 1, "a missing key is reported");
  expect(/dashboard\/#\/account\/keys/.test(none.problems[0]),
    "…and the message says exactly where to get one, rather than just failing");

  const wrong = readConfig({ ALGOSIZE_API_KEY: "sk-test-not-an-algosize-key" });
  expect(wrong.problems.length === 1 && /ask_live_/.test(wrong.problems[0]),
    "a key of the wrong shape is caught here, not as a bare 401 later");

  const staging = readConfig({ ALGOSIZE_API_KEY: KEY, ALGOSIZE_BASE_URL: "https://staging.algosize.com/" });
  expect(staging.endpoint === "https://staging.algosize.com/api/mcp",
    `ALGOSIZE_BASE_URL is honoured and its trailing slash stripped (${staging.endpoint})`);
}

group("it is a pipe, not a client");
{
  const src = readFileSync(join(__dirname, "..", "src", "bridge.mjs"), "utf8");
  // If the bridge ever knows a tool name, the catalog has two sources of truth
  // and the copy on someone's laptop is the one that goes stale.
  expect(!/algosize_[a-z_]+/.test(src),
    "the bridge names no tool — the catalog lives only in the Worker");
  expect(!/\bcache\b/i.test(src.replace(/\/\/.*$/gm, "").replace(/cache-control/gi, "")),
    "the bridge caches nothing");
}

group("forwarding");
{
  const f = stubFetch([{ status: 200, headers: { "mcp-session-id": "sess-1" }, body: { jsonrpc: "2.0", id: 1, result: { ok: true } } }]);
  const state = { apiKey: KEY, baseUrl: DEFAULT_BASE_URL, endpoint: `${DEFAULT_BASE_URL}/api/mcp`, sessionId: null };
  const reply = await forward({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }, state, { fetchImpl: f });

  expect(f.calls[0].headers.authorization === `Bearer ${KEY}`, "injects the Authorization header");
  expect(state.sessionId === "sess-1", "captures Mcp-Session-Id off the initialize response");
  expect(reply.result.ok === true, "returns the server's reply unchanged");

  // …and sends it back on the next call.
  await forward({ jsonrpc: "2.0", id: 2, method: "tools/list" }, state, { fetchImpl: f });
  expect(f.calls[1].headers["Mcp-Session-Id"] === "sess-1", "replays the session id on later requests");
}

group("a notification gets no reply");
{
  const f = stubFetch([{ status: 202 }]);
  const state = { apiKey: KEY, baseUrl: DEFAULT_BASE_URL, endpoint: "https://x/api/mcp", sessionId: null };
  const reply = await forward({ jsonrpc: "2.0", method: "notifications/initialized" }, state, { fetchImpl: f });
  expect(reply === null, "202 produces nothing on stdout — answering a notification desyncs the host");
}

group("retries");
{
  // A read may be retried.
  const f = stubFetch([
    { status: 500 }, { status: 500 },
    { status: 200, body: { jsonrpc: "2.0", id: 3, result: { tools: [] } } },
  ]);
  const state = { apiKey: KEY, baseUrl: "https://x", endpoint: "https://x/api/mcp", sessionId: null };
  const reply = await forward({ jsonrpc: "2.0", id: 3, method: "tools/list" }, state, { fetchImpl: f });
  expect(f.calls.length === 3, `an idempotent read retries (${f.calls.length} attempts)`);
  expect(reply.result && Array.isArray(reply.result.tools), "…and returns the eventual success");
}
{
  // A tool call may NOT: retrying could run a metered analysis twice and
  // charge for both.
  const f = stubFetch([{ status: 500 }, { status: 200, body: { jsonrpc: "2.0", id: 4, result: {} } }]);
  const state = { apiKey: KEY, baseUrl: "https://x", endpoint: "https://x/api/mcp", sessionId: null };
  const reply = await forward({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "x" } }, state, { fetchImpl: f });
  expect(f.calls.length === 1, `tools/call is attempted exactly once (${f.calls.length})`);
  expect(reply.error && reply.error.code === -32603, "…and the failure is reported rather than retried");
}

group("actionable failures");
{
  const f = stubFetch([{ status: 401 }]);
  const state = { apiKey: KEY, baseUrl: DEFAULT_BASE_URL, endpoint: "https://x/api/mcp", sessionId: null };
  const reply = await forward({ jsonrpc: "2.0", id: 5, method: "tools/list" }, state, { fetchImpl: f });
  expect(/dashboard\/#\/account\/keys/.test(reply.error.message),
    "a 401 says where to get a working key, not just 'unauthorized'");
}
{
  const f = stubFetch([{ status: 404 }]);
  const state = { apiKey: KEY, baseUrl: "https://x", endpoint: "https://x/api/mcp", sessionId: "old" };
  const reply = await forward({ jsonrpc: "2.0", id: 6, method: "tools/list" }, state, { fetchImpl: f });
  expect(state.sessionId === null, "an expired session is cleared so the next initialize can succeed");
  expect(/expired/i.test(reply.error.message), "…and the client is told why");
}

group("end to end over streams");
{
  // Call 1 is the notification, which a spec-compliant server answers with
  // 202 and an empty body. Call 2 deliberately returns a body anyway, to
  // prove the bridge suppresses it on the basis of the message having no id
  // rather than on the basis of the status it happened to get back.
  const f = stubFetch((i) => i === 0
    ? { status: 200, headers: { "mcp-session-id": "s1" }, body: { jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-06-18" } } }
    : i === 1
      ? { status: 200, body: { jsonrpc: "2.0", id: null, result: {} } }
      : { status: 200, body: { jsonrpc: "2.0", id: 2, result: { tools: [{ name: "x" }] } } });

  const out = collector();
  const input = Readable.from([
    JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } }) + "\n",
    JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n",
    JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }) + "\n",
  ]);
  const { done } = runBridge({ input, output: out, config: readConfig({ ALGOSIZE_API_KEY: KEY }), fetchImpl: f });
  await done;

  const lines = out.lines();
  expect(lines.length === 2, `two requests produced two replies, the notification none even though the server sent a body (got ${lines.length})`);
  expect(lines[0].id === 1 && lines[1].id === 2, "replies come back in order");
  expect(f.calls[2].headers["MCP-Protocol-Version"] === "2025-06-18",
    "the negotiated revision rides on later requests");
}

group("a misconfigured bridge explains itself instead of dying");
{
  // Exiting at startup is what this used to do, and an MCP host renders that
  // as "Connection closed" — the stderr line naming the missing variable never
  // reaches the person who has to set it. Staying up and answering is what
  // makes the explanation visible.
  const out = collector();
  const input = Readable.from([
    JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } }) + "\n",
    JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }) + "\n",
    JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n",
    JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "algosize_list_runs" } }) + "\n",
  ]);
  const { done } = runDegradedBridge({
    input, output: out, problems: readConfig({}).problems,
  });
  await done;
  const lines = out.lines();

  expect(lines.length === 3, `answers the three requests and ignores the notification (got ${lines.length})`);
  expect(lines[0].result && lines[0].result.serverInfo.name === "algosize",
    "initialize succeeds, so the host connects and shows the server at all");
  expect(/ALGOSIZE_API_KEY/.test(lines[0].result.instructions),
    "…and the instructions name the variable that is missing");
  expect(/dashboard\/#\/account\/keys/.test(lines[0].result.instructions),
    "…and where to get a value for it");
  expect(lines[1].result && lines[1].result.tools.length === 0,
    "tools/list is empty, so no model is offered a tool that cannot work");
  expect(lines[2].error && /ALGOSIZE_API_KEY/.test(lines[2].error.message),
    "any real call fails with the configuration problem as its text");
}

group("malformed client input");
{
  const out = collector();
  const input = Readable.from(["{not json\n"]);
  const { done } = runBridge({
    input, output: out, config: readConfig({ ALGOSIZE_API_KEY: KEY }),
    fetchImpl: stubFetch([{ status: 200, body: {} }]),
  });
  await done;
  const lines = out.lines();
  expect(lines.length === 1 && lines[0].error.code === -32700,
    "bad JSON from the host is answered, not crashed on");
}

console.log("");
if (failures) {
  console.log(`\x1b[31m  ${failures} bridge test(s) failed\x1b[0m`);
  process.exit(1);
}
console.log("\x1b[32m  all bridge tests passed\x1b[0m");
