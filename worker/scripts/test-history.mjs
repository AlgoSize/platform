// Tests for the run-history feature (Task #17 + Task #25 D1 migration).
//
// Covers:
//   1. Persisting a run via persistRun writes a D1 row with the expected
//      columns, and the analyze handlers do the same fire-and-forget via
//      ctx.waitUntil.
//   2. GET /api/runs is auth-gated, paginates with a stable cursor, hides
//      90-day-expired entries (read-time WHERE), and strips bulky fields
//      for the list view.
//   3. GET /api/runs/:id is auth-gated, scoped per user (user A cannot
//      read user B's run), and returns the full record.
//   4. CUR uploads (oversized inputs) are persisted with a `_omitted`
//      marker so the dashboard can grey out Re-run.
//   5. summarize() yields a useful one-liner for each analyzer.
//
// Run with:  node scripts/test-history.mjs

import {
  persistRun, listRuns, getRun, summarize,
  listRunsHandler, getRunHandler,
  RUN_TTL_SECONDS, MAX_INDEX_ENTRIES, MAX_INPUT_BYTES,
} from "../src/handlers/runs.js";
import { analyzeAlgoHandler, analyzeVulnHandler, analyzeCostHandler } from "../src/handlers/analyze.js";
import { issueJWT, requireAuth } from "../src/auth.js";
import { makeD1 } from "./_d1-stub.mjs";

const JWT_SECRET = "history-test-jwt-secret-32-or-more-chars-please";

let failures = 0;
const ok   = (msg) => console.log(`  \x1b[32m✓\x1b[0m ${msg}`);
const fail = (msg) => { console.log(`  \x1b[31m✗\x1b[0m ${msg}`); failures++; };
const expect = (cond, label) => cond ? ok(label) : fail(label);

// In-memory KV stub (still needed for SESSIONS + USERS).
function makeKV() {
  const store = new Map();
  return {
    async get(key)             { return store.has(key) ? store.get(key) : null; },
    async put(key, val, o = {}) { store.set(key, val); },
    async delete(key)          { store.delete(key); },
    _store: store,
  };
}

function makeEnv(overrides = {}) {
  return {
    JWT_SECRET,
    SITE_ORIGIN: "http://localhost:5000",
    COOKIE_NAME: "algosize_session",
    SESSIONS: makeKV(),
    USERS:    makeKV(),
    DB:       makeD1(),
    ...overrides,
  };
}

// Synchronous shim for ctx.waitUntil so tests can await persistence
// completion deterministically.
function makeCtx() {
  const pending = [];
  return {
    waitUntil: (p) => pending.push(p),
    drain: () => Promise.all(pending),
  };
}

// Helper: count the rows for a user in the D1 runs table.
async function countRunsFor(env, userId) {
  const row = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM runs WHERE user_id = ?",
  ).bind(userId).first();
  return row ? row.n : 0;
}

console.log("\nsummarize()\n");
expect(summarize("cost", { totalSavingsPct: 32, suggestions: [{}, {}] }) === "32% savings · 2 suggestions",
       "cost summary uses pct + count");
expect(summarize("cost", { totalSavingsPct: 0, suggestions: [{}] }) === "0% savings · 1 suggestion",
       "cost summary singularizes 1 suggestion");
expect(summarize("vuln", { counts: { critical: 1, high: 2, medium: 3, low: 4 } }) ===
       "10 advisories · 1 crit, 2 high",
       "vuln summary collapses severities");
expect(summarize("vuln", { counts: { critical: 0, high: 0, medium: 0, low: 1 } }).startsWith("1 advisory"),
       "vuln summary singularizes 1 advisory");
expect(summarize("algo", { bigO: { label: "O(n²)" }, wallTimeMs: 4.5 }) === "O(n²) · 4.50 ms",
       "algo summary shows Big-O + ms");
expect(summarize("algo", {}) === "unknown · — ms", "algo summary tolerates missing fields");
expect(summarize("nope", {}) === "", "unknown analyzer summarizes to empty string");

console.log("\npersistRun() — writes the row\n");

{
  const env = makeEnv();
  const userId = "usr_writer";
  const rec = await persistRun(env, {
    userId, analyzer: "algo",
    input: { code: "function f(){}", sampleInput: [1, 2] },
    result: { wallTimeMs: 3.1, bigO: { label: "O(n)" }, sampleResult: [1] },
    ms: 3.1,
  });
  expect(rec && rec.id, "persistRun returns the record with an id");
  expect(rec.headline === "O(n) · 3.10 ms", "headline is computed from result");
  expect(rec.userId === userId, "record carries userId");

  const row = await env.DB.prepare(
    "SELECT id, user_id, analyzer, input_json, result_json, ms, headline FROM runs WHERE id = ?",
  ).bind(rec.id).first();
  expect(row && row.user_id === userId, "row stored with the correct user_id");
  expect(row.analyzer === "algo", "row stored with analyzer column");
  expect(JSON.parse(row.input_json).code === "function f(){}", "input_json round-trips");
  expect(row.headline === "O(n) · 3.10 ms", "headline column matches");
}

console.log("\npersistRun() — input size cap\n");

{
  const env = makeEnv();
  const huge = "x".repeat(MAX_INPUT_BYTES + 100);
  const rec = await persistRun(env, {
    userId: "usr_big",
    analyzer: "algo",
    input: { code: huge },
    result: { wallTimeMs: 1, bigO: { label: "O(1)" } },
  });
  expect(rec.input && rec.input._omitted === true, "oversized input is replaced with _omitted marker");
  expect(rec.input.reason === "input_too_large_for_history", "marker carries reason");
}

console.log("\nlistRuns() — pagination + filters expired\n");

{
  const env = makeEnv();
  const userId = "usr_lister";
  for (let i = 0; i < 25; i++) {
    await persistRun(env, {
      userId, analyzer: "cost",
      input: { services: [{ name: `svc-${i}`, monthlySpend: 1000 }] },
      result: { totalSavingsPct: i, suggestions: [], topItems: [] },
    });
  }

  // Default page size is 20.
  const page1 = await listRuns(env, userId, { limit: 20 });
  expect(page1.items.length === 20, "first page returns 20 items");
  // List view strips heavy fields — `result` and `input` should NOT be in the
  // per-item shape (only id, analyzer, headline, ms, createdAt, hasInput).
  const sampleKeys = Object.keys(page1.items[0]).sort().join(",");
  expect(sampleKeys === "analyzer,createdAt,hasInput,headline,id,ms",
         `list-item shape is the 6-field summary (got: ${sampleKeys})`);
  expect(page1.nextCursor && typeof page1.nextCursor === "string", "first page returns nextCursor");

  const page2 = await listRuns(env, userId, { limit: 20, cursor: page1.nextCursor });
  expect(page2.items.length === 5, "second page returns the remaining 5");
  expect(page2.nextCursor === null, "second page has no nextCursor");

  // Simulate 90-day expiry: hand-edit the row's created_at to before the
  // cutoff. listRuns filters at read time via `created_at > cutoff`, so the
  // row must silently drop out of the list.
  const victimId = page1.items[3].id;
  const expired = Date.now() - (RUN_TTL_SECONDS + 60) * 1000;
  await env.DB.prepare("UPDATE runs SET created_at = ? WHERE id = ?")
    .bind(expired, victimId).run();
  // Read-time cutoff filter excludes the expired row, so 24 are visible
  // and the LIMIT-20 page is full again — but the victim id must NOT be
  // among the items.
  const page1After = await listRuns(env, userId, { limit: 20 });
  expect(page1After.items.length === 20, "expired row excluded; page still fills to limit");
  expect(!page1After.items.some(it => it.id === victimId), "expired run id absent from list");
}

console.log("\nlistRuns() — Re-run gating via hasInput\n");

{
  const env = makeEnv();
  const userId = "usr_curupload";
  await persistRun(env, {
    userId, analyzer: "cost",
    input: { _omitted: true, reason: "cur_upload" },
    result: { totalSavingsPct: 14, suggestions: [] },
  });
  await persistRun(env, {
    userId, analyzer: "vuln",
    input: { repoUrl: "https://github.com/x/y" },
    result: { counts: { critical: 0, high: 0, medium: 0, low: 0 } },
  });
  const list = await listRuns(env, userId, { limit: 10 });
  const cur = list.items.find(it => it.analyzer === "cost");
  const vuln = list.items.find(it => it.analyzer === "vuln");
  expect(cur && cur.hasInput === false, "CUR-upload run has hasInput=false");
  expect(vuln && vuln.hasInput === true, "vuln run has hasInput=true");
}

console.log("\ngetRun() — per-user scoping\n");

{
  const env = makeEnv();
  const a = await persistRun(env, {
    userId: "usr_alice", analyzer: "algo",
    input: { code: "function f(){}", sampleInput: [] },
    result: { wallTimeMs: 1, bigO: { label: "O(1)" } },
  });
  const aliceRead = await getRun(env, "usr_alice", a.id);
  expect(aliceRead && aliceRead.id === a.id, "alice can read her own run");
  const bobRead = await getRun(env, "usr_bob", a.id);
  expect(bobRead === null, "bob cannot read alice's run");
}

console.log("\nrouter integration — /api/runs gating + scoping\n");

async function callListRuns(env, token, qs = "") {
  const req = new Request(`http://localhost/api/runs${qs}`, {
    method: "GET",
    headers: token ? { "Cookie": `algosize_session=${encodeURIComponent(token)}` } : {},
  });
  const guard = await requireAuth(req, env);
  if (guard) return guard;
  return listRunsHandler(req, env);
}
async function callGetRun(env, token, id) {
  const req = new Request(`http://localhost/api/runs/${id}`, {
    method: "GET",
    headers: token ? { "Cookie": `algosize_session=${encodeURIComponent(token)}` } : {},
  });
  req.params = { id };
  const guard = await requireAuth(req, env);
  if (guard) return guard;
  return getRunHandler(req, env);
}

{
  const env = makeEnv();
  const res = await callListRuns(env, null);
  expect(res.status === 401, "GET /api/runs without auth → 401");
}

{
  const env = makeEnv();
  const aliceToken = await issueJWT(env, "usr_alice", "alice@example.com", "active");
  const bobToken   = await issueJWT(env, "usr_bob",   "bob@example.com",   "active");

  const aliceRun = await persistRun(env, {
    userId: "usr_alice", analyzer: "algo",
    input: { code: "function f(){return 1}", sampleInput: [] },
    result: { wallTimeMs: 0.5, bigO: { label: "O(1)" }, sampleResult: 1 },
  });
  await persistRun(env, {
    userId: "usr_bob", analyzer: "vuln",
    input: { repoUrl: "https://github.com/b/o" },
    result: { counts: { critical: 1, high: 0, medium: 0, low: 0 } },
  });

  const aliceList = await callListRuns(env, aliceToken);
  const aliceBody = await aliceList.json();
  expect(aliceList.status === 200, "alice list → 200");
  expect(aliceBody.items.length === 1 && aliceBody.items[0].analyzer === "algo",
         "alice sees only her own runs");

  const aliceGet = await callGetRun(env, aliceToken, aliceRun.id);
  const aliceFull = await aliceGet.json();
  expect(aliceGet.status === 200 && aliceFull.input && aliceFull.input.code,
         "GET /api/runs/:id returns the full record (input + result)");

  const bobGet = await callGetRun(env, bobToken, aliceRun.id);
  expect(bobGet.status === 404, "bob cannot fetch alice's run by id (404)");

  const clamped = await callListRuns(env, aliceToken, "?limit=9999");
  expect(clamped.status === 200, "list with absurd limit still 200s (clamped server-side)");

  const missing = await callGetRun(env, aliceToken, "no_such_run_xyz");
  expect(missing.status === 404, "GET /api/runs/<unknown> → 404");
}

console.log("\nanalyze handlers — persist via ctx.waitUntil on success\n");

{
  const env = makeEnv();
  const userId = "usr_runner";
  const req = new Request("http://localhost/api/analyze/algo", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      code: "function f(arr){ return arr.length }",
      sampleInput: [1, 2, 3],
    }),
  });
  req.user = { userId, email: "x@x.test", subStatus: "active" };

  const ctx = makeCtx();
  const res = await analyzeAlgoHandler(req, env, ctx);
  expect(res.status === 200, "algo handler returns 200 for happy-path code");

  await ctx.drain();  // wait for the queued persistence write

  expect(await countRunsFor(env, userId) === 1, "one run persisted into D1");
  const stored = await env.DB.prepare(
    "SELECT analyzer, input_json, result_json, headline FROM runs WHERE user_id = ?",
  ).bind(userId).first();
  expect(stored.analyzer === "algo", "persisted record analyzer=algo");
  const input  = JSON.parse(stored.input_json);
  const result = JSON.parse(stored.result_json);
  expect(input && input.code, "persisted record carries the original input");
  expect(typeof result.wallTimeMs === "number",
         "persisted record carries the analyzer result");
  expect(stored.headline.startsWith("O("), "persisted record carries a headline metric");
}

{
  // Validation error → 200 NEVER fires → no persistence happens.
  const env = makeEnv();
  const userId = "usr_badreq";
  const req = new Request("http://localhost/api/analyze/algo", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "not json at all",
  });
  req.user = { userId, email: "x@x.test", subStatus: "active" };
  const ctx = makeCtx();
  const res = await analyzeAlgoHandler(req, env, ctx);
  expect(res.status === 400, "malformed body → 400");
  await ctx.drain();
  expect(await countRunsFor(env, userId) === 0, "no run persisted for a 400 response");
}

{
  // Unauthenticated handler call (request.user undefined) → no persistence.
  const env = makeEnv();
  const req = new Request("http://localhost/api/analyze/algo", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code: "function f(arr){return arr.length}", sampleInput: [1] }),
  });
  // Deliberately NO req.user.
  const ctx = makeCtx();
  const res = await analyzeAlgoHandler(req, env, ctx);
  expect(res.status === 200, "unauth direct handler call still 200");
  await ctx.drain();
  const total = await env.DB.prepare("SELECT COUNT(*) AS n FROM runs").first();
  expect(total.n === 0, "no persistence when request.user is missing");
}

{
  // Vuln (legacy {code,...} heuristic path) also persists.
  const env = makeEnv();
  const userId = "usr_vuln";
  const req = new Request("http://localhost/api/analyze/vuln", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code: "const apiKey = 'sk_live_REDACTED';" }),
  });
  req.user = { userId, email: "x@x.test", subStatus: "active" };
  const ctx = makeCtx();
  const res = await analyzeVulnHandler(req, env, ctx);
  expect(res.status === 200, "vuln legacy handler returns 200");
  await ctx.drain();
  expect(await countRunsFor(env, userId) === 1, "vuln legacy run was persisted");
  const stored = await env.DB.prepare(
    "SELECT analyzer FROM runs WHERE user_id = ?",
  ).bind(userId).first();
  expect(stored.analyzer === "vuln", "persisted record analyzer=vuln");
}

{
  // CUR upload (cost) persists with input _omitted marker so dashboard knows
  // not to offer Re-run.
  const env = makeEnv();
  const userId = "usr_cur";
  const cur = [
    "lineItem/ProductCode,lineItem/UsageType,lineItem/LineItemType,lineItem/UnblendedCost",
    "AmazonEC2,USE1-BoxUsage:m5.xlarge,Usage,1450.00",
  ].join("\n");
  const req = new Request("http://localhost/api/analyze/cost", {
    method: "POST",
    headers: { "content-type": "text/csv" },
    body: cur,
  });
  req.user = { userId, email: "x@x.test", subStatus: "active" };
  const ctx = makeCtx();
  const res = await analyzeCostHandler(req, env, ctx);
  expect(res.status === 200, "cost CUR handler returns 200");
  await ctx.drain();
  expect(await countRunsFor(env, userId) === 1, "CUR run was persisted");
  const stored = await env.DB.prepare(
    "SELECT input_json FROM runs WHERE user_id = ?",
  ).bind(userId).first();
  const input = JSON.parse(stored.input_json);
  expect(input && input._omitted === true,
         "CUR persisted with _omitted input marker (re-run gracefully disabled)");
}

// ---------- summary ----------
console.log("");
if (failures === 0) {
  console.log("\x1b[32m  all run-history tests passed\x1b[0m\n");
  process.exit(0);
} else {
  console.log(`\x1b[31m  ${failures} run-history test(s) failed\x1b[0m\n`);
  process.exit(1);
}
