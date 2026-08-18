// Concurrency tests for the free-tier quota (the UsageCounter Durable Object).
//
// These exist because the previous KV-only implementation passed every
// sequential test in scripts/test-quota.mjs while being trivially bypassable:
// it read the counter, ran the handler, and incremented afterwards, so
// concurrent callers all observed the same pre-increment value. Measured
// against the old code, 20 concurrent requests from a fresh free user produced
// 20 successful runs and left the counter at 1 — and since the counter never
// advanced, the burst was repeatable forever.
//
// Sequential tests cannot catch that. Every assertion below issues its
// requests with Promise.all and asserts on how many were ALLOWED, which is the
// only shape of test that would have failed on the old implementation.
//
// The DurableObjectNamespace stub models the two guarantees the real runtime
// provides and the fix depends on:
//   1. idFromName(x) routes every request for one meter id to one object.
//   2. blockConcurrencyWhile serialises callbacks on that object, so no other
//      event is delivered between a read and its matching write.
// Storage operations are given a deliberate async delay so that a missing lock
// would interleave and fail these tests rather than passing by accident.
//
// Run with:  node scripts/test-quota-concurrency.mjs

import { UsageCounter } from "../src/usage-counter.js";
import {
  enforceQuota, reserveRun, releaseRun, peekUsage,
  quotaKey, FREE_MONTHLY_LIMIT,
} from "../src/quota.js";

let failures = 0;
const ok   = (msg) => console.log(`  \x1b[32m✓\x1b[0m ${msg}`);
const fail = (msg) => { console.log(`  \x1b[31m✗\x1b[0m ${msg}`); failures++; };
const expect = (cond, label) => cond ? ok(label) : fail(label);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Stubs
// ---------------------------------------------------------------------------

function makeKV() {
  const store = new Map();
  return {
    async get(k) { await sleep(1); return store.has(k) ? store.get(k) : null; },
    async put(k, v) { await sleep(1); store.set(k, v); },
    _store: store,
  };
}

/**
 * DurableObjectState stub.
 *
 * `blockConcurrencyWhile` is a real mutex: callbacks queue on a promise chain,
 * so a second caller cannot enter until the first has fully returned. Storage
 * awaits a tick, which means an implementation that read and wrote WITHOUT the
 * lock would reliably interleave and be caught.
 */
function makeState() {
  const storage = new Map();
  let chain = Promise.resolve();
  return {
    storage: {
      async get(k) { await sleep(1); return storage.get(k); },
      async put(k, v) { await sleep(1); storage.set(k, v); },
    },
    blockConcurrencyWhile(fn) {
      const result = chain.then(() => fn());
      // Keep the chain alive even if a callback rejects.
      chain = result.then(() => {}, () => {});
      return result;
    },
    _storage: storage,
  };
}

/**
 * DurableObjectNamespace stub — one UsageCounter instance per name.
 *
 * The stub returned by get() must accept `fetch(url, init)` and hand the
 * object a real Request, the way the runtime's DurableObjectStub does. An
 * earlier version of this file passed both arguments straight through, so the
 * object received a URL string, `request.json()` threw, every call 400ed, and
 * every assertion silently exercised the KV fallback instead of the DO. The
 * tests failed loudly, which is the only reason that was caught — but it is
 * worth naming, because a stub that is wrong in the permissive direction turns
 * this whole file into a test of the thing it is supposed to be replacing.
 */
function makeUsageNamespace(env) {
  const objects = new Map();
  return {
    idFromName(name) { return { name, toString: () => name }; },
    get(id) {
      const name = id.name;
      if (!objects.has(name)) objects.set(name, new UsageCounter(makeState(), env));
      const obj = objects.get(name);
      return { fetch: (input, init) => obj.fetch(new Request(input, init)) };
    },
    _objects: objects,
  };
}

/** D1 stub that always resolves the user as free-tier. */
function makeFreeD1() {
  return {
    prepare() {
      return {
        bind() { return this; },
        async first() {
          return {
            user_id: "u1", email: "free@example.com",
            plan: "free", sub_status: null, active_org_id: null,
          };
        },
        async all() { return { results: [] }; },
        async run() { return {}; },
      };
    },
  };
}

/** An env with the USAGE binding wired to the stub namespace. */
function makeEnv({ withDo = true } = {}) {
  const USERS = makeKV();
  const env = { USERS, DB: makeFreeD1(), SITE_ORIGIN: "https://algosize.com" };
  if (withDo) env.USAGE = makeUsageNamespace(env);
  return env;
}

const TS = new Date("2026-08-18T00:00:00Z");

/** A handler that takes real time — the race window used to be exactly this. */
function slowHandler(status = 200, ms = 25) {
  let calls = 0;
  const handler = async () => {
    calls++;
    await sleep(ms);
    return new Response(JSON.stringify({ ok: status === 200 }), {
      status, headers: { "content-type": "application/json" },
    });
  };
  return { handler, calls: () => calls };
}

/** Fire `n` requests through the wrapped handler simultaneously. */
async function burst(env, wrapped, n) {
  const pending = [];
  const ctx = { waitUntil: (p) => pending.push(p) };
  const request = { user: { userId: "u1", email: "free@example.com" }, org: null, headers: new Headers() };
  const responses = await Promise.all(
    Array.from({ length: n }, () => wrapped(request, env, ctx)),
  );
  await Promise.all(pending);
  return {
    allowed: responses.filter((r) => r.status === 200).length,
    blocked: responses.filter((r) => r.status === 402).length,
    other:   responses.filter((r) => r.status !== 200 && r.status !== 402).length,
  };
}

// ---------------------------------------------------------------------------

console.log("\nquota concurrency — the gate holds under simultaneous requests\n");

{
  const env = makeEnv();
  const stub = slowHandler();
  const wrapped = enforceQuota(stub.handler, { now: () => TS });

  const r = await burst(env, wrapped, 20);
  expect(r.allowed === FREE_MONTHLY_LIMIT,
    `20 concurrent requests on a fresh free user → exactly ${FREE_MONTHLY_LIMIT} allowed (got ${r.allowed})`);
  expect(r.blocked === 20 - FREE_MONTHLY_LIMIT,
    `the other ${20 - FREE_MONTHLY_LIMIT} get 402 (got ${r.blocked})`);
  expect(stub.calls() === FREE_MONTHLY_LIMIT,
    `the handler ran only ${FREE_MONTHLY_LIMIT} times — blocked requests never reach it (got ${stub.calls()})`);
  expect(await peekUsage(env, "u1", TS) === FREE_MONTHLY_LIMIT,
    `counter lands exactly on the limit, not below it (got ${await peekUsage(env, "u1", TS)})`);
}

{
  // The boundary is where an off-by-one would hide: 4 already spent, so
  // exactly one of ten simultaneous callers may proceed.
  const env = makeEnv();
  await reserveRun(env, "u1", TS, FREE_MONTHLY_LIMIT);
  await reserveRun(env, "u1", TS, FREE_MONTHLY_LIMIT);
  await reserveRun(env, "u1", TS, FREE_MONTHLY_LIMIT);
  await reserveRun(env, "u1", TS, FREE_MONTHLY_LIMIT);

  const stub = slowHandler();
  const wrapped = enforceQuota(stub.handler, { now: () => TS });
  const r = await burst(env, wrapped, 10);
  expect(r.allowed === 1, `at the boundary (4 of 5 spent), 10 concurrent → exactly 1 allowed (got ${r.allowed})`);
  expect(r.blocked === 9, `the other 9 get 402 (got ${r.blocked})`);
}

{
  // A burst that is entirely refused must not move the counter, or a user
  // could be pushed further over by requests that were rejected anyway.
  const env = makeEnv();
  for (let i = 0; i < FREE_MONTHLY_LIMIT; i++) await reserveRun(env, "u1", TS, FREE_MONTHLY_LIMIT);
  const stub = slowHandler();
  const wrapped = enforceQuota(stub.handler, { now: () => TS });
  const r = await burst(env, wrapped, 10);
  expect(r.allowed === 0 && r.blocked === 10, "already at the limit → all 10 refused");
  expect(stub.calls() === 0, "the handler is never invoked once the limit is reached");
  expect(await peekUsage(env, "u1", TS) === FREE_MONTHLY_LIMIT,
    "refused requests leave the counter exactly at the limit");
}

console.log("\nquota concurrency — reserve/release keeps failures free\n");

{
  // The property the old increment-on-success design gave for free, and which
  // reserving at the gate has to buy back explicitly.
  const env = makeEnv();
  const stub = slowHandler(400);
  const wrapped = enforceQuota(stub.handler, { now: () => TS });

  const r = await burst(env, wrapped, 10);
  // Only FREE_MONTHLY_LIMIT reservations exist to be had, so five callers run
  // (and fail with 400) while the other five are refused. Those 402s are a
  // real consequence of reserving rather than incrementing: at the instant
  // they were refused, all five slots genuinely WERE held. They come back the
  // moment the failed runs release, which the next assertion checks. A
  // sequential caller would never see this; a client retrying a burst gets a
  // transient 402 that resolves on retry, which is the price of the gate
  // actually holding.
  expect(r.other === FREE_MONTHLY_LIMIT,
    `${FREE_MONTHLY_LIMIT} concurrent runs get a reservation and fail with 400 (got ${r.other})`);
  expect(r.blocked === 10 - FREE_MONTHLY_LIMIT,
    `the rest are refused while those reservations are still held (got ${r.blocked})`);
  expect(await peekUsage(env, "u1", TS) === 0,
    `every reservation was released — counter back to 0 (got ${await peekUsage(env, "u1", TS)})`);

  // And the quota is genuinely still spendable afterwards.
  const good = slowHandler(200);
  const okWrapped = enforceQuota(good.handler, { now: () => TS });
  const r2 = await burst(env, okWrapped, 10);
  expect(r2.allowed === FREE_MONTHLY_LIMIT,
    `after 10 failed runs the user still has all ${FREE_MONTHLY_LIMIT} runs (got ${r2.allowed})`);
}

{
  // A handler that throws is a crashed run, not a consumed one.
  const env = makeEnv();
  const wrapped = enforceQuota(async () => { throw new Error("sandbox exploded"); }, { now: () => TS });
  const request = { user: { userId: "u1", email: "free@example.com" }, org: null, headers: new Headers() };
  let threw = false;
  try { await wrapped(request, env, { waitUntil: (p) => p }); } catch { threw = true; }
  expect(threw, "a throwing handler still propagates its error");
  expect(await peekUsage(env, "u1", TS) === 0, "and its reservation was released");
}

{
  // Releases must floor at zero, or a duplicated release mints quota.
  const env = makeEnv();
  await reserveRun(env, "u1", TS, FREE_MONTHLY_LIMIT);
  await releaseRun(env, "u1", TS);
  await releaseRun(env, "u1", TS);
  await releaseRun(env, "u1", TS);
  expect(await peekUsage(env, "u1", TS) === 0,
    `repeated releases floor at 0, never negative (got ${await peekUsage(env, "u1", TS)})`);
}

console.log("\nquota concurrency — month rollover and KV migration\n");

{
  const env = makeEnv();
  for (let i = 0; i < FREE_MONTHLY_LIMIT; i++) await reserveRun(env, "u1", TS, FREE_MONTHLY_LIMIT);
  const nextMonth = new Date("2026-09-01T00:00:00Z");
  const r = await reserveRun(env, "u1", nextMonth, FREE_MONTHLY_LIMIT);
  expect(r.allowed && r.used === 1, "a spent month does not block the next one — count restarts at 1");
  expect(await peekUsage(env, "u1", nextMonth) === 1, "and the new month reads back as 1");
  // DO storage has no TTL, so a per-month key would accumulate forever on an
  // object that lives as long as the account. One record, rewritten in place.
  const obj = env.USAGE._objects.get("u1");
  expect(obj.state._storage.size === 1,
    `the object holds exactly one record regardless of how many months pass (got ${obj.state._storage.size})`);
}

{
  // Deploying mid-month must not hand every free user a fresh set of runs.
  const env = makeEnv();
  env.USERS._store.set(quotaKey("u1", TS), "4");
  const r = await reserveRun(env, "u1", TS, FREE_MONTHLY_LIMIT);
  expect(r.allowed && r.used === 5,
    `the DO seeds from the legacy KV counter on first touch (4 → reserved 5, got ${r.used})`);
  const r2 = await reserveRun(env, "u1", TS, FREE_MONTHLY_LIMIT);
  expect(!r2.allowed, "so the 6th run this month is still refused after migration");
}

{
  const env = makeEnv();
  const r = await reserveRun(env, "u1", TS, FREE_MONTHLY_LIMIT);
  expect(r.atomic === true, "with a USAGE binding, reservations report themselves as atomic");
}

console.log("\nquota concurrency — degraded (no USAGE binding)\n");

{
  // The fallback is knowingly racy; what it must not do is stop metering or
  // start throwing. Asserted sequentially, because that is the only thing the
  // KV path actually guarantees.
  const env = makeEnv({ withDo: false });
  const stub = slowHandler();
  const wrapped = enforceQuota(stub.handler, { now: () => TS });
  const request = { user: { userId: "u1", email: "free@example.com" }, org: null, headers: new Headers() };

  let allowed = 0, blocked = 0;
  for (let i = 0; i < 8; i++) {
    const pending = [];
    const res = await wrapped(request, env, { waitUntil: (p) => pending.push(p) });
    await Promise.all(pending);
    if (res.status === 200) allowed++; else if (res.status === 402) blocked++;
  }
  expect(allowed === FREE_MONTHLY_LIMIT && blocked === 3,
    `without a DO the KV path still meters sequentially (${allowed} allowed, ${blocked} blocked)`);

  const r = await reserveRun(env, "u2", TS, FREE_MONTHLY_LIMIT);
  expect(r.atomic === false, "and reports itself as non-atomic so the weaker guarantee is visible");
}

{
  // A DO that errors must degrade to KV rather than take the analyzers down.
  const env = makeEnv();
  env.USAGE = {
    idFromName(name) { return { name }; },
    get() { return { async fetch() { throw new Error("DO unreachable"); } }; },
  };
  const r = await reserveRun(env, "u1", TS, FREE_MONTHLY_LIMIT);
  expect(r.allowed && r.atomic === false,
    "a failing USAGE binding falls back to KV instead of 500ing the request");
}

console.log(
  failures === 0
    ? "\n\x1b[32m  all quota concurrency tests passed\x1b[0m\n"
    : `\n\x1b[31m  ${failures} quota concurrency test(s) failed\x1b[0m\n`,
);
process.exit(failures === 0 ? 0 : 1);
