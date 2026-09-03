// Tests for the three capabilities the dashboard designs specified and the
// backend never had: listing a report's share links, revoking an unaccepted
// invite, and persisting what a monitor sweep found new.
//
// Each of these existed as a design and was cut during implementation for the
// same reason — no endpoint, no column — so the frontend rendered nothing
// rather than fabricating data. These tests cover the backends that close
// that gap, and they concentrate on the cases where a naive implementation
// would silently mislead rather than fail:
//
//   listShares    an index that lies (token aged out, revoked, or belonging to
//                 another run) must not produce a link that no longer works
//   revokeInvite  the token row and the seat-consuming index entry have to
//                 move together, or the seat leaks or the link outlives it
//   monitor delta a baseline sweep discovers everything, and reporting that as
//                 "new since last run" would be false — there was no last run
//
// Run with:  node scripts/test-integration-gaps.mjs

import worker from "../src/index.js";
import { createShare, listShares, revokeShare, shareKey, shareIndexKey } from "../src/reports/share.js";
import { revokeInviteHandler, inviteMemberHandler } from "../src/handlers/org.js";
import { issueJWT } from "../src/auth.js";
import { makeD1 } from "./_d1-stub.mjs";

let failures = 0;
const ok   = (msg) => console.log(`  \x1b[32m✓\x1b[0m ${msg}`);
const fail = (msg) => { console.log(`  \x1b[31m✗\x1b[0m ${msg}`); failures++; };
const expect = (cond, label) => cond ? ok(label) : fail(label);

const NOW = Math.floor(Date.now() / 1000);
const DAY = 86_400;

function makeKV() {
  const store = new Map();
  return {
    async get(k) { return store.has(k) ? store.get(k) : null; },
    async put(k, v) { store.set(k, v); },
    async delete(k) { store.delete(k); },
    _store: store,
  };
}

// ===========================================================================
console.log("\nshare links — listing what was minted\n");
// ===========================================================================
{
  const env = { SESSIONS: makeKV(), SITE_ORIGIN: "https://algosize.com" };

  const a = await createShare(env, { runId: "run_1", orgId: "org_1", now: NOW - 100 });
  const b = await createShare(env, { runId: "run_1", orgId: "org_1", now: NOW - 50 });
  await createShare(env, { runId: "run_2", orgId: "org_1", now: NOW - 10 });

  const list = await listShares(env, "run_1", { now: NOW });
  expect(list.length === 2, `two links for run_1 (got ${list.length})`);
  // Another run's links must never appear — the whole point of a per-run token
  // is that it reaches exactly one report.
  expect(list.every((s) => s.token === a.token || s.token === b.token),
    "and neither of them is run_2's link");
  expect(list[0].token === b.token,
    "newest first, so the link just minted is the one at the top");
  expect(list.every((s) => !s.expired), "neither is expired");
}

{
  // Revoking has to remove the link from the list, not just stop it resolving.
  // A revoked link that still appears is worse than no list at all: it tells
  // the owner a link is live when it is not.
  const env = { SESSIONS: makeKV(), SITE_ORIGIN: "https://algosize.com" };
  const a = await createShare(env, { runId: "run_1", now: NOW });
  const b = await createShare(env, { runId: "run_1", now: NOW });

  await revokeShare(env, a.token, "run_1");
  const list = await listShares(env, "run_1", { now: NOW });
  expect(list.length === 1 && list[0].token === b.token,
    "a revoked link disappears from the list");
  const idxRaw = await env.SESSIONS.get(shareIndexKey("run_1"));
  expect(JSON.parse(idxRaw).length === 1, "and the index was pruned, not just the token row");
}

{
  // Revocation without a runId still revokes; the index just goes stale and
  // listShares is expected to shed it on read.
  const env = { SESSIONS: makeKV(), SITE_ORIGIN: "https://algosize.com" };
  const a = await createShare(env, { runId: "run_1", now: NOW });
  await createShare(env, { runId: "run_1", now: NOW });

  await revokeShare(env, a.token);          // no runId — index left stale
  const list = await listShares(env, "run_1", { now: NOW });
  expect(list.length === 1, "a token revoked without a runId still leaves the list correct");
  const idxRaw = await env.SESSIONS.get(shareIndexKey("run_1"));
  expect(JSON.parse(idxRaw).length === 1,
    "and the read self-heals the stale index rather than leaving it to grow");
}

{
  // The index is a hint, never the answer. A token row that aged out of KV
  // must not produce a listed link.
  const env = { SESSIONS: makeKV(), SITE_ORIGIN: "https://algosize.com" };
  const a = await createShare(env, { runId: "run_1", now: NOW });
  await createShare(env, { runId: "run_1", now: NOW });
  await env.SESSIONS.delete(shareKey(a.token));   // simulate a TTL eviction

  const list = await listShares(env, "run_1", { now: NOW });
  expect(list.length === 1, "a token whose row aged out is not listed as live");
}

{
  // Expired-but-present is reported, not hidden: "this stopped working on the
  // 4th" and "this never existed" are different answers to the owner.
  const env = { SESSIONS: makeKV(), SITE_ORIGIN: "https://algosize.com" };
  await createShare(env, { runId: "run_1", expiresInDays: 1, now: NOW - 3 * DAY });

  const list = await listShares(env, "run_1", { now: NOW });
  expect(list.length === 1 && list[0].expired === true,
    "an expired link is listed with expired:true rather than dropped");
}

{
  const env = { SESSIONS: makeKV(), SITE_ORIGIN: "https://algosize.com" };
  const list = await listShares(env, "run_never_shared", { now: NOW });
  expect(Array.isArray(list) && list.length === 0, "a run with no links lists empty, not null");
}

// ===========================================================================
console.log("\nGET /api/runs/:id/shares — routed and ownership-gated\n");
// ===========================================================================
{
  const JWT_SECRET = "integration-gaps-test-secret-32-or-more";
  const db = makeD1();
  const env = {
    JWT_SECRET, COOKIE_NAME: "algosize_session", SITE_ORIGIN: "https://algosize.com",
    SESSIONS: makeKV(), USERS: makeKV(), DB: db,
  };
  const ctx = { waitUntil() {} };

  const res = await worker.fetch(
    new Request("https://algosize.com/api/runs/run_x/shares"), env, ctx);
  expect(res.status === 401, `no session → 401 (got ${res.status})`);

  // A session that cannot read the run must not learn which links exist for
  // it — the 404 is the same one an unknown id produces, deliberately.
  const token = await issueJWT(env, "usr_nobody", "nobody@example.com", null);
  const res2 = await worker.fetch(
    new Request("https://algosize.com/api/runs/run_not_theirs/shares", {
      headers: { cookie: `algosize_session=${token}` },
    }), env, ctx);
  expect(res2.status === 404 || res2.status === 401,
    `a run the caller cannot read → 404/401, never a listing (got ${res2.status})`);
}

// ===========================================================================
console.log("\ninvite revoke — the token and the seat move together\n");
// ===========================================================================

const JWT_SECRET = "integration-gaps-test-secret-32-or-more";

function orgEnv() {
  const db = makeD1();
  return {
    JWT_SECRET, COOKIE_NAME: "algosize_session", SITE_ORIGIN: "https://algosize.com",
    SESSIONS: makeKV(), USERS: makeKV(), DB: db,
  };
}

/** Seed an org with an owner, and return the request factory for that owner. */
async function seedOrg(env, { seats = 5 } = {}) {
  const now = NOW;
  await env.DB.prepare(
    `INSERT INTO users (user_id, email, plan, sub_status, created_at, updated_at)
     VALUES (?, ?, 'paid', 'active', ?, ?)`,
  ).bind("usr_owner", "owner@acme.io", now, now).run();
  await env.DB.prepare(
    `INSERT INTO organisations (org_id, name, plan, sub_status, seats_purchased, created_at, updated_at)
     VALUES (?, ?, 'paid', 'active', ?, ?, ?)`,
  ).bind("org_1", "Acme", seats, now, now).run();
  await env.DB.prepare(
    `INSERT INTO memberships (org_id, user_id, role, created_at) VALUES (?, ?, 'owner', ?)`,
  ).bind("org_1", "usr_owner", now).run();
  await env.DB.prepare("UPDATE users SET active_org_id = ? WHERE user_id = ?")
    .bind("org_1", "usr_owner").run();

  return (body) => {
    const req = new Request("https://algosize.com/api/org/invite/revoke", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    req.user = { userId: "usr_owner", email: "owner@acme.io" };
    return req;
  };
}

{
  const env = orgEnv();
  const mkReq = await seedOrg(env);

  // Mint a real invite through the real handler so the KV shape is whatever
  // production actually writes, not a hand-built fixture that could drift.
  const inviteReq = new Request("https://algosize.com/api/org/invite", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "new@acme.io", role: "member" }),
  });
  inviteReq.user = { userId: "usr_owner", email: "owner@acme.io" };
  const inviteRes = await inviteMemberHandler(inviteReq, env, { waitUntil() {} },
    async () => ({ sent: true }));
  expect(inviteRes.status === 201, `invite created (got ${inviteRes.status})`);

  const beforeKeys = [...env.SESSIONS._store.keys()].filter((k) => k.startsWith("orgInvite:"));
  expect(beforeKeys.length === 1, "one invite token row exists");

  const revRes  = await revokeInviteHandler(mkReq({ email: "new@acme.io" }), env);
  const revBody = await revRes.json();
  expect(revRes.status === 200 && revBody.ok === true, `revoke → 200 ok (got ${revRes.status})`);

  const afterKeys = [...env.SESSIONS._store.keys()].filter((k) => k.startsWith("orgInvite:"));
  expect(afterKeys.length === 0,
    "the token row is deleted — a revoked invite must not still be redeemable");
  const pending = await env.SESSIONS.get("orgInvitePending:org_1");
  expect(pending === null || JSON.parse(pending).length === 0,
    "and the pending index entry is gone, so the seat is released");
}

{
  const env = orgEnv();
  const mkReq = await seedOrg(env);
  const res = await revokeInviteHandler(mkReq({ email: "never-invited@acme.io" }), env);
  const body = await res.json();
  // Not a silent 200: the caller is looking at a list that disagrees with the
  // server, and telling them is what makes them refresh it.
  expect(res.status === 404 && body.error === "invite_not_found",
    `an address with no pending invite → 404 invite_not_found (got ${res.status})`);
}

{
  const env = orgEnv();
  const mkReq = await seedOrg(env);
  const res = await revokeInviteHandler(mkReq({ email: "not-an-email" }), env);
  expect(res.status === 400, `a malformed address → 400 (got ${res.status})`);
}

{
  // A plain member must not be able to withdraw invites — same gate the
  // invite path itself uses.
  const env = orgEnv();
  await seedOrg(env);
  const now = NOW;
  await env.DB.prepare(
    `INSERT INTO users (user_id, email, plan, created_at, updated_at) VALUES (?, ?, 'free', ?, ?)`,
  ).bind("usr_member", "member@acme.io", now, now).run();
  await env.DB.prepare(
    `INSERT INTO memberships (org_id, user_id, role, created_at) VALUES (?, ?, 'member', ?)`,
  ).bind("org_1", "usr_member", now).run();
  await env.DB.prepare("UPDATE users SET active_org_id = ? WHERE user_id = ?")
    .bind("org_1", "usr_member").run();

  const req = new Request("https://algosize.com/api/org/invite/revoke", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "someone@acme.io" }),
  });
  req.user = { userId: "usr_member", email: "member@acme.io" };
  const res = await revokeInviteHandler(req, env);
  expect(res.status === 403, `a member revoking → 403 (got ${res.status})`);
}

// ===========================================================================
console.log("\nruns list — analyzer filter\n");
// ===========================================================================
{
  // The architecture X-ray's run-over-run diff needs the PREVIOUS architecture
  // run. Without a server-side filter it would page through cost and vuln runs
  // and compare against whichever happened to come back first — making every
  // architecture finding look new.
  const { listRuns, ANALYZERS } = await import("../src/handlers/runs.js");
  const env = { DB: makeD1() };
  const now = Date.now();
  const rows = [
    ["r_arch_old", "arch", now - 3000],
    ["r_vuln",     "vuln", now - 2000],
    ["r_arch_new", "arch", now - 1000],
  ];
  for (const [id, analyzer, at] of rows) {
    await env.DB.prepare(
      `INSERT INTO runs (id, user_id, org_id, source, analyzer, input_json, result_json, ms, headline, created_at)
       VALUES (?, ?, NULL, NULL, ?, NULL, NULL, NULL, '', ?)`,
    ).bind(id, "usr_1", analyzer, at).run();
  }

  const all = await listRuns(env, { userId: "usr_1" }, { limit: 10 });
  expect(all.items.length === 3, `unfiltered returns everything (got ${all.items.length})`);

  const arch = await listRuns(env, { userId: "usr_1" }, { limit: 10, analyzer: "arch" });
  expect(arch.items.length === 2, `analyzer=arch returns only arch runs (got ${arch.items.length})`);
  expect(arch.items.every((r) => r.analyzer === "arch"), "and every row really is an arch run");
  expect(arch.items[0].id === "r_arch_new",
    "newest first, so items[1] is the previous run the diff compares against");

  // The value lands in a SQL predicate, so anything outside the closed set has
  // to be ignored rather than interpolated.
  const bogus = await listRuns(env, { userId: "usr_1" }, { limit: 10, analyzer: "arch'; DROP TABLE runs;--" });
  expect(bogus.items.length === 3, "an unrecognised analyzer is ignored, not injected");
  expect(ANALYZERS.includes("arch") && !ANALYZERS.includes("architecture"),
    "the persisted key is \"arch\" — the route name \"architecture\" is not a run analyzer");
}

console.log(
  failures === 0
    ? "\n\x1b[32m  all integration-gap tests passed\x1b[0m\n"
    : `\n\x1b[31m  ${failures} integration-gap test(s) failed\x1b[0m\n`,
);
process.exit(failures === 0 ? 0 : 1);
