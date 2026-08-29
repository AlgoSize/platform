// The MCP endpoint end to end: framing, sessions, scopes, and the tool call.
//
// Driven through worker.fetch rather than by calling handlers, because the
// things most likely to be wrong live in the wiring — the route order, the
// auth composition, the session header — and a test that calls the handler
// directly proves none of it.
//
// Run with:  node scripts/test-mcp-protocol.mjs

import worker from "../src/index.js";
import { makeD1 } from "./_d1-stub.mjs";
import { SCOPES } from "../src/mcp/tokens.js";

let failures = 0;
const ok   = (m) => console.log(`  \x1b[32m✓\x1b[0m ${m}`);
const fail = (m) => { console.log(`  \x1b[31m✗\x1b[0m ${m}`); failures++; };
const expect = (c, l) => (c ? ok(l) : fail(l));
const group  = (n) => console.log(`\n\x1b[1m${n}\x1b[0m\n`);

const NOW = 1_700_000_000;
const ORG = "org_mcp";

function makeKV() {
  const m = new Map();
  return {
    async get(k) { return m.has(k) ? m.get(k) : null; },
    async put(k, v) { m.set(k, v); },
    async delete(k) { m.delete(k); },
    async list() { return { keys: [...m.keys()].map((name) => ({ name })) }; },
  };
}

const ctx = { waitUntil: (p) => { if (p && p.catch) p.catch(() => {}); } };

function makeEnv(extra = {}) {
  return {
    JWT_SECRET: "mcp-test-secret-at-least-32-characters-long",
    SITE_ORIGIN: "https://algosize.com",
    MCP_ENABLED: "true",
    SESSIONS: makeKV(), USERS: makeKV(), DB: makeD1(),
    ...extra,
  };
}

// sha256 hex, matching handlers/_api_keys.js — the key is stored as a hash.
async function sha256Hex(input) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(d)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

const API_KEY = "ask_live_" + "T".repeat(43);

async function seed(env) {
  await env.DB.prepare(
    `INSERT INTO organisations (org_id, name, stripe_customer_id, plan, sub_status, seats_purchased, created_at, updated_at)
     VALUES (?,?,'cus_mcp','paid','active',5,?,?)`,
  ).bind(ORG, "Acme", NOW, NOW).run();
  await env.DB.prepare(
    `INSERT INTO api_keys (key_id, org_id, name, key_hash, prefix, created_by, created_at)
     VALUES ('key_mcp', ?, 'MCP', ?, ?, 'u_mcp', ?)`,
  ).bind(ORG, await sha256Hex(API_KEY), API_KEY.slice(0, 16), NOW).run();
}

/** POST one JSON-RPC message (or batch) to /api/mcp. */
function rpc(body, { sessionId = null, key = API_KEY, origin = null } = {}) {
  const headers = { "content-type": "application/json" };
  if (key) headers.authorization = `Bearer ${key}`;
  if (sessionId) headers["Mcp-Session-Id"] = sessionId;
  if (origin) headers.Origin = origin;
  return new Request("https://algosize.com/api/mcp", {
    method: "POST", headers, body: JSON.stringify(body),
  });
}

const INIT = {
  jsonrpc: "2.0", id: 1, method: "initialize",
  params: { protocolVersion: "2025-06-18", clientInfo: { name: "test", version: "1" }, capabilities: {} },
};

// ---------------------------------------------------------------------------
group("initialize");
let sessionId = null;
{
  const env = makeEnv(); await seed(env);
  const res = await worker.fetch(rpc(INIT), env, ctx);
  const body = await res.json();
  sessionId = res.headers.get("Mcp-Session-Id");

  expect(res.status === 200, `initialize returns 200 (got ${res.status})`);
  expect(Boolean(sessionId), "a session id comes back in the Mcp-Session-Id header");
  expect((res.headers.get("Access-Control-Expose-Headers") || "").includes("Mcp-Session-Id"),
    "…and is exposed to browsers, without which a browser host never sees it");
  expect(body.result && body.result.protocolVersion === "2025-06-18",
    "negotiates the revision the client asked for");
  expect(body.result && body.result.serverInfo && body.result.serverInfo.name === "algosize",
    "identifies the server");
  expect(Boolean(body.result && body.result.instructions),
    "ships instructions, so a model knows analyses cost runs");
  expect(body.result.capabilities.tools.listChanged === true, "advertises tools");
}

// ---------------------------------------------------------------------------
group("version negotiation");
{
  const env = makeEnv(); await seed(env);
  const res = await worker.fetch(rpc({ ...INIT, params: { ...INIT.params, protocolVersion: "1999-01-01" } }), env, ctx);
  const body = await res.json();
  expect(body.error && body.error.code === -32000,
    `an unknown revision is refused rather than silently downgraded (got ${JSON.stringify(body.error || body.result)})`);
  expect(body.error && body.error.data && Array.isArray(body.error.data.supported),
    "…and the refusal lists what IS supported");
}

// ---------------------------------------------------------------------------
group("framing");
{
  const env = makeEnv(); await seed(env);
  const init = await worker.fetch(rpc(INIT), env, ctx);
  const sid = init.headers.get("Mcp-Session-Id");

  // A notification has no id and must produce no response at all.
  const notif = await worker.fetch(
    rpc({ jsonrpc: "2.0", method: "notifications/initialized" }, { sessionId: sid }), env, ctx);
  expect(notif.status === 202, `a notification-only post is 202 (got ${notif.status})`);
  expect((await notif.text()) === "", "…with an empty body, not an empty array");

  // id 0 is a REQUEST. `if (msg.id)` would drop it and hang the client.
  const zero = await worker.fetch(
    rpc({ jsonrpc: "2.0", id: 0, method: "ping" }, { sessionId: sid }), env, ctx);
  const zeroBody = await zero.json();
  expect(zeroBody.id === 0, `id 0 is answered as a request (got id ${JSON.stringify(zeroBody.id)})`);

  const bad = await worker.fetch(new Request("https://algosize.com/api/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${API_KEY}` },
    body: "{not json",
  }), env, ctx);
  expect((await bad.json()).error.code === -32700, "malformed JSON is a parse error");

  const unknown = await worker.fetch(
    rpc({ jsonrpc: "2.0", id: 9, method: "nope/nope" }, { sessionId: sid }), env, ctx);
  expect((await unknown.json()).error.code === -32601, "an unknown method is -32601");

  const batch = await worker.fetch(rpc([
    { jsonrpc: "2.0", id: "a", method: "ping" },
    { jsonrpc: "2.0", id: "b", method: "ping" },
  ], { sessionId: sid }), env, ctx);
  const batchBody = await batch.json();
  expect(Array.isArray(batchBody) && batchBody.length === 2, "a batch gets an array of replies");
}

// ---------------------------------------------------------------------------
group("sessions");
{
  const env = makeEnv(); await seed(env);
  const noSession = await worker.fetch(rpc({ jsonrpc: "2.0", id: 2, method: "tools/list" }), env, ctx);
  expect((await noSession.json()).error.code === -32001,
    "a method other than initialize needs a session");

  const stale = await worker.fetch(
    rpc({ jsonrpc: "2.0", id: 3, method: "tools/list" }, { sessionId: "nope" }), env, ctx);
  expect(stale.status === 404,
    `an unknown session is 404 so the client re-initializes (got ${stale.status})`);
}

// ---------------------------------------------------------------------------
group("cross-tenant safety");
{
  // A valid credential for org B presenting org A's session id.
  const env = makeEnv(); await seed(env);
  const OTHER = "ask_live_" + "Z".repeat(43);
  await env.DB.prepare(
    `INSERT INTO organisations (org_id, name, stripe_customer_id, plan, sub_status, seats_purchased, created_at, updated_at)
     VALUES ('org_other','Other','cus_o','paid','active',5,?,?)`).bind(NOW, NOW).run();
  await env.DB.prepare(
    `INSERT INTO api_keys (key_id, org_id, name, key_hash, prefix, created_by, created_at)
     VALUES ('key_other','org_other','Other',?,?, 'u_o', ?)`,
  ).bind(await sha256Hex(OTHER), OTHER.slice(0, 16), NOW).run();

  const init = await worker.fetch(rpc(INIT), env, ctx);
  const sidA = init.headers.get("Mcp-Session-Id");
  const stolen = await worker.fetch(
    rpc({ jsonrpc: "2.0", id: 4, method: "tools/list" }, { sessionId: sidA, key: OTHER }), env, ctx);
  expect(stolen.status === 404,
    `org B cannot resume org A's session (got ${stolen.status})`);
}

// ---------------------------------------------------------------------------
group("origin check");
{
  const env = makeEnv(); await seed(env);
  const evil = await worker.fetch(rpc(INIT, { origin: "https://evil.example" }), env, ctx);
  expect(evil.status === 403, `a foreign browser origin is refused (got ${evil.status})`);

  const claude = await worker.fetch(rpc(INIT, { origin: "https://claude.ai" }), env, ctx);
  expect(claude.status === 200, `claude.ai is allowed (got ${claude.status})`);

  // The lookalike an endsWith check would wave through.
  const lookalike = await worker.fetch(rpc(INIT, { origin: "https://claude.ai.evil.example" }), env, ctx);
  expect(lookalike.status === 403, `a lookalike host is refused (got ${lookalike.status})`);

  // No Origin at all is a native client, which rebinding cannot reach.
  const native = await worker.fetch(rpc(INIT), env, ctx);
  expect(native.status === 200, "a request with no Origin (native client) is allowed");
}

// ---------------------------------------------------------------------------
group("auth");
{
  const env = makeEnv(); await seed(env);
  const anon = await worker.fetch(new Request("https://algosize.com/api/mcp", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(INIT),
  }), env, ctx);
  expect(anon.status === 401, `an unauthenticated call is 401 (got ${anon.status})`);
  const wwwAuth = anon.headers.get("WWW-Authenticate") || "";
  expect(wwwAuth.includes("resource_metadata="),
    "…carrying the resource_metadata hint that starts the OAuth flow");
  expect(wwwAuth.includes("/.well-known/oauth-protected-resource"),
    "…pointing at the protected-resource document");
}

// ---------------------------------------------------------------------------
group("the feature flag fails shut");
{
  const env = makeEnv({ MCP_ENABLED: "false" }); await seed(env);
  const res = await worker.fetch(rpc(INIT), env, ctx);
  expect(res.status === 404,
    `with the flag off the endpoint is invisible (got ${res.status})`);
}

// ---------------------------------------------------------------------------
group("tools/list");
{
  const env = makeEnv(); await seed(env);
  const init = await worker.fetch(rpc(INIT), env, ctx);
  const sid = init.headers.get("Mcp-Session-Id");
  const res = await worker.fetch(
    rpc({ jsonrpc: "2.0", id: 5, method: "tools/list" }, { sessionId: sid }), env, ctx);
  const tools = (await res.json()).result.tools;

  expect(tools.length >= 20, `lists the catalog (${tools.length} tools)`);
  expect(tools.every((t) => t.name.startsWith("algosize_")), "every tool is namespaced");
  expect(tools.every((t) => t.inputSchema && t.inputSchema.additionalProperties === false),
    "every input schema is strict — a loose one invites a model to burn a run on a 400");
  expect(tools.every((t) => t.description && t.description.length > 40),
    "every tool has a description written for a model");
  const share = tools.find((t) => t.name === "algosize_share_run");
  expect(share && share.annotations.openWorldHint === true,
    "the share tool is marked open-world — it mints a public link");
  expect(!tools.some((t) => /api.?key|billing|invoice|member/i.test(t.name)),
    "nothing that mints credentials or moves money is listed");
}

// ---------------------------------------------------------------------------
group("tools/call");
{
  const env = makeEnv(); await seed(env);
  const init = await worker.fetch(rpc(INIT), env, ctx);
  const sid = init.headers.get("Mcp-Session-Id");

  // A read-only tool against an org with no runs: a real dispatch through
  // callHandler, the real handler, and the real org scoping.
  const res = await worker.fetch(rpc({
    jsonrpc: "2.0", id: 6, method: "tools/call",
    params: { name: "algosize_list_runs", arguments: { limit: 5 } },
  }, { sessionId: sid }), env, ctx);
  const out = (await res.json()).result;

  expect(out && Array.isArray(out.content) && out.content[0].type === "text",
    "a tool result carries a text block");
  expect(out.isError === false, "…and is not an error");
  expect(out.structuredContent && Array.isArray(out.structuredContent.items),
    "…and structuredContent matching the output schema");

  // A tool failure must be an isError RESULT, not a JSON-RPC error: a host
  // renders an RPC error as a broken connection the model cannot recover from.
  const bad = await worker.fetch(rpc({
    jsonrpc: "2.0", id: 7, method: "tools/call",
    params: { name: "algosize_get_run", arguments: { runId: "does_not_exist" } },
  }, { sessionId: sid }), env, ctx);
  const badBody = await bad.json();
  expect(!badBody.error, "a failing tool is not a JSON-RPC error");
  expect(badBody.result && badBody.result.isError === true,
    "…it is an isError result the model can read and act on");

  const unknown = await worker.fetch(rpc({
    jsonrpc: "2.0", id: 8, method: "tools/call", params: { name: "algosize_nope", arguments: {} },
  }, { sessionId: sid }), env, ctx);
  expect((await unknown.json()).error.code === -32602, "an unknown tool name is a params error");

  // The usage row must exist, and must not contain arguments or results.
  const row = await env.DB.prepare(
    "SELECT tool_name, org_id, status FROM mcp_tool_calls WHERE org_id = ? ORDER BY id DESC LIMIT 1",
  ).bind(ORG).first();
  expect(row && row.tool_name === "algosize_get_run", "each call is recorded in mcp_tool_calls");
  expect(row && row.org_id === ORG, "…scoped to the calling org");
  const cols = await env.DB.prepare("SELECT * FROM mcp_tool_calls LIMIT 1").first();
  expect(cols && !("arguments" in cols) && !("result" in cols),
    "…and the table has nowhere to put arguments or results, which are customer code");
}

// ---------------------------------------------------------------------------
group("metered tools carry a tighter limit than the envelope");
{
  const env = makeEnv(); await seed(env);
  // A ctx that can be awaited, because the assertions below read the row that
  // ctx.waitUntil writes. The shared ctx swallows the promise, which would
  // make this test pass or fail on scheduler timing.
  const waits = [];
  const wctx = { waitUntil: (p) => { waits.push(Promise.resolve(p).catch(() => {})); } };

  const init = await worker.fetch(rpc(INIT), env, wctx);
  const sid = init.headers.get("Mcp-Session-Id");

  // Seed the bucket at its limit rather than driving twenty real analyses
  // through it. The guard runs before dispatch, so the guard is what is under
  // test; twenty analyzer round-trips would test the analyzers instead and
  // take a minute of wall clock to do it. Both the current window and the
  // next one, so a run that crosses a minute boundary mid-test asserts the
  // same thing it would have a millisecond earlier.
  const w = Math.floor(Math.floor(Date.now() / 1000) / 60);
  await env.SESSIONS.put(`rl:org:${ORG}:mcp_metered:${w}`, "20");
  await env.SESSIONS.put(`rl:org:${ORG}:mcp_metered:${w + 1}`, "20");

  const res = await worker.fetch(rpc({
    jsonrpc: "2.0", id: 20, method: "tools/call",
    params: { name: "algosize_analyze_cost",
              arguments: { services: [{ name: "RDS", monthlyCost: 900 }] } },
  }, { sessionId: sid }), env, wctx);
  const body = await res.json();
  const text = body.result && body.result.content && body.result.content[0].text || "";

  expect(!body.error,
    "a rate-limited analysis is not a JSON-RPC error — that renders as a dead connection");
  expect(body.result && body.result.isError === true,
    "…it is an isError result the model can read, wait on, and retry");
  expect(/rate limited/i.test(text), "…and says so in words rather than a bare code");
  expect(/\b\d+s\b/.test(text), "…including how long to wait");

  // The whole point of a separate bucket: a full metered bucket must not stop
  // the model checking what it already has. Sharing the envelope bucket would
  // have locked the connection out entirely.
  const read = await worker.fetch(rpc({
    jsonrpc: "2.0", id: 21, method: "tools/call",
    params: { name: "algosize_list_runs", arguments: { limit: 5 } },
  }, { sessionId: sid }), env, wctx);
  const readBody = await read.json();
  expect(readBody.result && readBody.result.isError === false,
    "a read-only tool is untouched by the metered bucket");

  // And a refusal is not silence: an org hitting this needs it to show up in
  // the usage feed, or the connection just looks intermittently broken.
  await Promise.all(waits);
  const row = await env.DB.prepare(
    `SELECT tool_name, status, error_code, run_id FROM mcp_tool_calls
      WHERE org_id = ? AND status = 'rate_limited' ORDER BY id DESC LIMIT 1`,
  ).bind(ORG).first();
  expect(row && row.tool_name === "algosize_analyze_cost",
    "the refusal is recorded against the tool that was refused");
  expect(row && row.error_code === "rate_limited", "…with an error code the usage feed can group on");
  expect(row && row.run_id == null,
    "…and no run id, because no run was spent — that is the entire point of refusing");
}

// ---------------------------------------------------------------------------
group("scope enforcement");
{
  const env = makeEnv(); await seed(env);
  const init = await worker.fetch(rpc(INIT), env, ctx);
  const sid = init.headers.get("Mcp-Session-Id");
  // Narrow the session's scopes to read-only, then call a manage tool.
  const raw = await env.SESSIONS.get(`mcp:sess:${sid}`);
  const rec = JSON.parse(raw);
  rec.scopes = [SCOPES.READ];
  await env.SESSIONS.put(`mcp:sess:${sid}`, JSON.stringify(rec));

  // The API key still grants all three at the request level, so this asserts
  // the request's own scopes are what count — which is what an OAuth token
  // with a narrow grant relies on.
  const { mcpAuth } = await import("../src/mcp/auth.js");
  const req = { headers: new Headers(), org: { orgId: ORG }, authMethod: "api_key" };
  await mcpAuth(req, env, ctx);
  expect(req.mcpScopes.length === 3, "an API key grants all three scopes");

  const narrow = { headers: new Headers(), org: { orgId: ORG }, authMethod: "mcp_oauth", mcpScopes: [SCOPES.READ] };
  const { requestHasScope } = await import("../src/mcp/auth.js");
  expect(requestHasScope(narrow, SCOPES.READ), "a read grant holds read");
  expect(!requestHasScope(narrow, SCOPES.MANAGE), "…and does not hold manage");
}

// ---------------------------------------------------------------------------
group("resources and prompts");
{
  const env = makeEnv(); await seed(env);
  const init = await worker.fetch(rpc(INIT), env, ctx);
  const sid = init.headers.get("Mcp-Session-Id");

  const resources = (await (await worker.fetch(
    rpc({ jsonrpc: "2.0", id: 10, method: "resources/list" }, { sessionId: sid }), env, ctx)).json()).result;
  expect(resources.resources.length >= 3, "resources are listed");

  const templates = (await (await worker.fetch(
    rpc({ jsonrpc: "2.0", id: 11, method: "resources/templates/list" }, { sessionId: sid }), env, ctx)).json()).result;
  expect(templates.resourceTemplates.some((t) => t.uriTemplate.includes("{runId}")),
    "templated resource URIs are offered so a host can complete them");

  const read = (await (await worker.fetch(
    rpc({ jsonrpc: "2.0", id: 12, method: "resources/read", params: { uri: "algosize://runs/recent" } },
      { sessionId: sid }), env, ctx)).json()).result;
  expect(read && read.contents && read.contents[0].uri === "algosize://runs/recent",
    "a resource reads through the same adapter a tool would");

  const missing = await worker.fetch(
    rpc({ jsonrpc: "2.0", id: 13, method: "resources/read", params: { uri: "algosize://nope" } },
      { sessionId: sid }), env, ctx);
  expect((await missing.json()).error.code === -32602, "an unknown resource URI is refused, never guessed");

  const prompts = (await (await worker.fetch(
    rpc({ jsonrpc: "2.0", id: 14, method: "prompts/list" }, { sessionId: sid }), env, ctx)).json()).result;
  expect(prompts.prompts.length >= 3, "prompts are listed");

  const got = (await (await worker.fetch(
    rpc({ jsonrpc: "2.0", id: 15, method: "prompts/get",
          params: { name: "audit_repository", arguments: { repoUrl: "https://github.com/a/b" } } },
      { sessionId: sid }), env, ctx)).json()).result;
  expect(got.messages[0].content.text.includes("https://github.com/a/b"),
    "a prompt interpolates its arguments");

  const noArg = await worker.fetch(
    rpc({ jsonrpc: "2.0", id: 16, method: "prompts/get", params: { name: "audit_repository", arguments: {} } },
      { sessionId: sid }), env, ctx);
  expect((await noArg.json()).error.code === -32602, "a missing required argument is refused");
}

// ---------------------------------------------------------------------------
group("session teardown");
{
  const env = makeEnv(); await seed(env);
  const init = await worker.fetch(rpc(INIT), env, ctx);
  const sid = init.headers.get("Mcp-Session-Id");
  const del = await worker.fetch(new Request("https://algosize.com/api/mcp", {
    method: "DELETE",
    headers: { authorization: `Bearer ${API_KEY}`, "Mcp-Session-Id": sid },
  }), env, ctx);
  expect(del.status === 204, `DELETE tears the session down (got ${del.status})`);
  const after = await worker.fetch(
    rpc({ jsonrpc: "2.0", id: 17, method: "tools/list" }, { sessionId: sid }), env, ctx);
  expect(after.status === 404, "…and the id no longer resolves");
}

// ---------------------------------------------------------------------------
group("discovery documents");
{
  const env = makeEnv(); await seed(env);
  for (const path of ["/.well-known/oauth-protected-resource",
                      "/api/.well-known/oauth-protected-resource"]) {
    const res = await worker.fetch(new Request("https://algosize.com" + path), env, ctx);
    const doc = await res.json();
    expect(res.status === 200, `${path} is public`);
    expect(doc.resource === "https://algosize.com/api/mcp",
      `…and names the MCP endpoint as the resource (got ${doc.resource})`);
  }
  const as = await (await worker.fetch(
    new Request("https://algosize.com/.well-known/oauth-authorization-server"), env, ctx)).json();
  expect(JSON.stringify(as.code_challenge_methods_supported) === JSON.stringify(["S256"]),
    "only S256 is advertised — `plain` is not a challenge at all");
  expect(as.issuer === "https://algosize.com", "the issuer matches the origin serving it");

  const manifest = await (await worker.fetch(
    new Request("https://algosize.com/api/mcp/manifest"), env, ctx)).json();
  expect(Array.isArray(manifest.tools) && manifest.tools.length >= 20,
    "the manifest is readable with no credential");
  expect(JSON.stringify(manifest).indexOf("ask_live_") === -1,
    "…and contains no credential material");
}

console.log("");
if (failures) {
  console.log(`\x1b[31m  ${failures} mcp-protocol test(s) failed\x1b[0m`);
  process.exit(1);
}
console.log("\x1b[32m  all mcp-protocol tests passed\x1b[0m");
