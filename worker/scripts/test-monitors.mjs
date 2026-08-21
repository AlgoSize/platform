// Tests for scheduled monitoring — Task #P-5.
//
// The feature's whole value rests on one property: an email arrives when
// something NEW is wrong, and does not arrive otherwise. A monitor that
// re-sends last night's advisories every night gets filtered to spam within a
// week, and then the one night it has something real to say, nobody reads it.
// So most of this file is about what does NOT get sent.
//
// Covers, per the task spec:
//   - diffing suppresses unchanged findings
//   - a newly introduced critical does alert
//   - paused monitors are skipped
//   - the repo limit returns 402
//
// Plus the things that make those true in production rather than only in the
// pure functions: the sweep enqueues rather than running inline, a paused
// monitor is skipped at BOTH the sweep and the consumer, and a failed audit
// distinguishes "retry this" from "this repo is misconfigured".
//
// Run with:  node scripts/test-monitors.mjs

import {
  advisoryKey, advisoryKeySet, hashKeySet, diffAdvisories, groupBySeverity,
} from "../src/monitors/diff.js";
import { sweepDueMonitors, runMonitorCheck, handleMonitorQueue } from "../src/monitors/run.js";
import {
  createMonitor, getMonitorById, listMonitorsDue, isDue, monitorLimitFor, setMonitorPaused,
  normalizeAnalyzers, recordMonitorRun,
} from "../src/monitors/_store.js";
import {
  listMonitorsHandler, createMonitorHandler, deleteMonitorHandler, pauseMonitorHandler,
  setMonitorAnalyzersHandler,
} from "../src/handlers/monitors.js";
import {
  diffArchFindings, diffEstimate, diffAlgoGrades, bigORank, archFindingKey, formatMicroUsd,
} from "../src/monitors/analyzers.js";
import { ciOptimizerSnippetHandler } from "../src/handlers/ci.js";
import { makeD1 } from "./_d1-stub.mjs";

let failures = 0;
const ok   = (msg) => console.log(`  \x1b[32m✓\x1b[0m ${msg}`);
const fail = (msg) => { console.log(`  \x1b[31m✗\x1b[0m ${msg}`); failures++; };
const expect = (cond, label) => cond ? ok(label) : fail(label);

function makeKV() {
  const store = new Map();
  return {
    async get(k) { return store.has(k) ? store.get(k) : null; },
    async put(k, v) { store.set(k, v); },
    async delete(k) { store.delete(k); },
    _store: store,
  };
}

function makeMailbox() {
  const sent = [];
  return { sent, send: async (env, ctx, msg) => { sent.push(msg); return { sent: true }; } };
}

/** Records what the sweep put on the queue instead of talking to Cloudflare. */
function makeQueue() {
  const messages = [];
  return { messages, send: async (body) => { messages.push(body); } };
}

const NOW = 1_700_000_000;
const DAY = 86_400;

function makeEnv(overrides = {}) {
  return {
    JWT_SECRET:  "monitors-test-jwt-secret-32-or-more-chars",
    SITE_ORIGIN: "https://algosize.com",
    COOKIE_NAME: "algosize_session",
    SESSIONS: makeKV(),
    USERS:    makeKV(),
    DB:       makeD1(),
    ...overrides,
  };
}

async function seedOrg(env, { userId, email, plan = "paid", subStatus = "active" }) {
  const orgId = `org_${userId}`;
  await env.DB.prepare(
    `INSERT INTO users (user_id, email, stripe_customer_id, plan, sub_status, active_org_id, created_at, updated_at)
     VALUES (?, ?, NULL, 'free', NULL, ?, ?, ?)`,
  ).bind(userId, email, orgId, NOW, NOW).run();
  await env.DB.prepare(
    `INSERT INTO organisations (org_id, name, stripe_customer_id, plan, sub_status, seats_purchased, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 1, ?, ?)`,
  ).bind(orgId, email, plan === "paid" ? `cus_${userId}` : null, plan, subStatus, NOW, NOW).run();
  await env.DB.prepare(
    "INSERT INTO memberships (org_id, user_id, role, created_at) VALUES (?, ?, 'owner', ?)",
  ).bind(orgId, userId, NOW).run();
  return orgId;
}

function authed(userId, { method = "GET", url = "https://algosize.com/api/monitors", body, params } = {}) {
  const req = new Request(url, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  req.user = { userId, email: `${userId}@example.com` };
  if (params) req.params = params;
  return req;
}

const adv = (id, pkg, severity, extra = {}) => ({
  id, package: pkg, ecosystem: "npm", severity,
  installedVersion: "1.0.0", fixedIn: "1.0.1",
  summary: `${id} in ${pkg}`, ...extra,
});

// ---------------------------------------------------------------------------
console.log("\ndiffing — the rule that decides whether an email is sent\n");
// ---------------------------------------------------------------------------

{
  const a = adv("GHSA-aaa", "lodash", "high");
  expect(advisoryKey(a) === "GHSA-aaa/npm/lodash", `advisory identity is id/ecosystem/package (got ${advisoryKey(a)})`);

  // The identity deliberately excludes the installed version: a patch bump
  // that doesn't fix the advisory must not re-alert.
  const bumped = { ...a, installedVersion: "1.0.5" };
  expect(advisoryKey(a) === advisoryKey(bumped),
    "a version bump that doesn't fix the advisory keeps the same identity");

  // The same advisory in a different package IS a different problem.
  expect(advisoryKey({ ...a, package: "underscore" }) !== advisoryKey(a),
    "the same CVE in a different package is a distinct identity");
}

{
  // Unchanged run → nothing to say.
  const previous = advisoryKeySet([adv("GHSA-1", "lodash", "high"), adv("GHSA-2", "minimist", "medium")]);
  const d = diffAdvisories([adv("GHSA-2", "minimist", "medium"), adv("GHSA-1", "lodash", "high")], previous);

  expect(d.newAdvisories.length === 0, "an identical result set produces no new advisories");
  expect(d.shouldAlert === false, "and no alert — this is the nightly-repetition case the diff exists to prevent");
  expect(hashKeySet(d.currentKeys) === hashKeySet(previous),
    "the result hash is stable across reordering, so ordering alone never looks like a change");
}

{
  // A newly introduced critical DOES alert, and only it is reported.
  const previous = advisoryKeySet([adv("GHSA-old", "lodash", "high")]);
  const d = diffAdvisories(
    [adv("GHSA-old", "lodash", "high"), adv("GHSA-new", "express", "critical")],
    previous,
  );

  expect(d.shouldAlert === true, "a newly introduced critical alerts");
  expect(d.newAdvisories.length === 1, `only the new advisory is reported (got ${d.newAdvisories.length})`);
  expect(d.newAdvisories[0].id === "GHSA-new", "and it's the right one");
  expect(!d.newAdvisories.some((a) => a.id === "GHSA-old"),
    "the advisory they already knew about is NOT repeated");
}

{
  // Resolved-only runs are silent. "Something you fixed is still fixed" is
  // not news, and making it an email would put this back in the noise pile.
  const previous = advisoryKeySet([adv("GHSA-1", "lodash", "high"), adv("GHSA-2", "minimist", "low")]);
  const d = diffAdvisories([adv("GHSA-1", "lodash", "high")], previous);

  expect(d.shouldAlert === false, "advisories disappearing does not trigger an email");
  expect(d.resolvedKeys.length === 1, "but the resolution is still tracked");
}

{
  // First run has no baseline: report everything, and say it's a baseline.
  const d = diffAdvisories([adv("GHSA-1", "lodash", "critical")], null);
  expect(d.isBaseline === true, "a monitor's first run is flagged as a baseline");
  expect(d.shouldAlert === true, "and does alert — silently swallowing a first-run critical would be worse");

  const empty = diffAdvisories([], null);
  expect(empty.shouldAlert === false, "a clean first run sends nothing");
}

{
  const groups = groupBySeverity([
    adv("a", "p1", "low"), adv("b", "p2", "critical"), adv("c", "p3", "high"), adv("d", "p4", "critical"),
  ]);
  expect(groups[0].severity === "critical" && groups[0].items.length === 2,
    "groups are ordered worst-first, with criticals together");
  expect(groups.map((g) => g.severity).join(",") === "critical,high,low",
    `empty severities are omitted (got ${groups.map((g) => g.severity).join(",")})`);
}

// ---------------------------------------------------------------------------
console.log("\ndue-ness and the sweep\n");
// ---------------------------------------------------------------------------

{
  const never  = { pausedAt: null, lastRunAt: null, schedule: "daily" };
  const today  = { pausedAt: null, lastRunAt: NOW - 3600, schedule: "daily" };
  const yday   = { pausedAt: null, lastRunAt: NOW - DAY, schedule: "daily" };
  const weekly = { pausedAt: null, lastRunAt: NOW - 3 * DAY, schedule: "weekly" };
  const weekOld = { pausedAt: null, lastRunAt: NOW - 8 * DAY, schedule: "weekly" };
  const paused = { pausedAt: NOW - DAY, lastRunAt: null, schedule: "daily" };

  expect(isDue(never, NOW) === true,   "a monitor that has never run is due");
  expect(isDue(today, NOW) === false,  "a daily monitor run an hour ago is not due again");
  expect(isDue(yday, NOW) === true,    "a daily monitor run yesterday is due");
  expect(isDue(weekly, NOW) === false, "a weekly monitor run 3 days ago is not due");
  expect(isDue(weekOld, NOW) === true, "a weekly monitor run 8 days ago is due");
  expect(isDue(paused, NOW) === false, "a paused monitor is never due, even having never run");
}

{
  // Paused monitors are skipped by the sweep — and skipped in SQL, so they
  // never even become a queue message.
  const env = makeEnv();
  const orgId = await seedOrg(env, { userId: "usr_sweep", email: "sweep@example.com" });
  const active = await createMonitor(env, { orgId, repoUrl: "https://github.com/a/active" });
  const paused = await createMonitor(env, { orgId, repoUrl: "https://github.com/a/paused" });
  await setMonitorPaused(env, orgId, paused.monitorId, true);

  const due = await listMonitorsDue(env, NOW);
  expect(due.length === 1, `only the active monitor is due (got ${due.length})`);
  expect(due[0].monitorId === active.monitorId, "and it's the un-paused one");

  const queue = makeQueue();
  const summary = await sweepDueMonitors({ ...env, SCAN_QUEUE: queue }, {}, { now: NOW });
  expect(summary.enqueued === 1, `the sweep enqueued exactly one message (got ${summary.enqueued})`);
  expect(queue.messages[0].monitorId === active.monitorId, "carrying the active monitor's id");
  expect(!queue.messages.some((m) => m.monitorId === paused.monitorId),
    "the paused monitor was never enqueued — pausing costs nothing, it doesn't just discard results");
}

{
  // A missing queue binding must be loud, not a silent inline fallback.
  const env = makeEnv();
  const orgId = await seedOrg(env, { userId: "usr_noq", email: "noq@example.com" });
  await createMonitor(env, { orgId, repoUrl: "https://github.com/a/b" });

  const summary = await sweepDueMonitors(env, {}, { now: NOW });
  expect(summary.enqueued === 0 && summary.skipped === "no_queue_binding",
    "with no SCAN_QUEUE binding the sweep refuses to run monitors inline");
  expect(summary.due === 1, "and still reports what it would have run");
}

// ---------------------------------------------------------------------------
console.log("\nrunning a monitor end to end\n");
// ---------------------------------------------------------------------------

// runLockfileAudit fetches from GitHub then OSV. Rather than stub both
// protocols, drive env.FETCH — which the audit already routes through — and
// return a repo with one lockfile plus a controllable OSV response.
function makeAuditFetch({ vulns = [] }) {
  return async (url) => {
    const u = String(url);
    if (u.includes("raw.githubusercontent.com") || u.includes("api.github.com")) {
      if (u.endsWith("package-lock.json")) {
        return new Response(JSON.stringify({
          lockfileVersion: 3,
          packages: { "node_modules/lodash": { version: "4.17.20" }, "node_modules/express": { version: "4.17.1" } },
        }), { status: 200 });
      }
      return new Response("not found", { status: 404 });
    }
    if (u.includes("osv.dev") && u.includes("querybatch")) {
      return new Response(JSON.stringify({
        results: vulns.map((v) => ({ vulns: [{ id: v.id }] })),
      }), { status: 200 });
    }
    if (u.includes("osv.dev/v1/vulns/")) {
      const id = decodeURIComponent(u.split("/vulns/")[1]);
      const v = vulns.find((x) => x.id === id);
      if (!v) return new Response("{}", { status: 404 });
      return new Response(JSON.stringify({
        id: v.id,
        summary: v.summary || `${v.id} summary`,
        severity: [{ type: "CVSS_V3", score: v.vector || "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H" }],
        affected: [{ package: { name: v.package, ecosystem: "npm" }, ranges: [{ type: "ECOSYSTEM", events: [{ introduced: "0" }, { fixed: v.fixedIn || "9.9.9" }] }] }],
      }), { status: 200 });
    }
    return new Response("{}", { status: 404 });
  };
}

{
  // A paused monitor that somehow reaches the consumer (paused in the window
  // between sweep and consume) is still skipped — the pause wins.
  const env = makeEnv();
  const orgId = await seedOrg(env, { userId: "usr_race", email: "race@example.com" });
  const m = await createMonitor(env, { orgId, repoUrl: "https://github.com/a/b" });
  await setMonitorPaused(env, orgId, m.monitorId, true);

  const mailbox = makeMailbox();
  const res = await runMonitorCheck(env, m.monitorId, {}, { now: NOW, sendTransactional: mailbox.send });
  expect(res.status === "paused", `a monitor paused after enqueue is skipped at consume time (got ${res.status})`);
  expect(mailbox.sent.length === 0, "and sends nothing");
}

{
  // A monitor deleted between sweep and consume returns quietly rather than
  // retrying forever.
  const env = makeEnv();
  const mailbox = makeMailbox();
  const res = await runMonitorCheck(env, "mon_does_not_exist", {}, { now: NOW, sendTransactional: mailbox.send });
  expect(res.status === "gone", `a deleted monitor is not retried (got ${res.status})`);
}

{
  // Full path: first run establishes a baseline and emails it; second run
  // with the same result sends nothing; third run with a new critical emails
  // only the critical.
  const env = makeEnv();
  const orgId = await seedOrg(env, { userId: "usr_run", email: "owner@example.com" });
  const m = await createMonitor(env, { orgId, repoUrl: "https://github.com/a/b" });

  // Run 1 — one high advisory. Baseline.
  const mailbox = makeMailbox();
  env.FETCH = makeAuditFetch({ vulns: [{ id: "GHSA-old", package: "lodash", fixedIn: "4.17.21" }] });
  const r1 = await runMonitorCheck(env, m.monitorId, {}, { now: NOW, sendTransactional: mailbox.send });

  expect(r1.status === "alerted", `first run alerts (got ${r1.status})`);
  expect(r1.isBaseline === true, "and is flagged as the baseline");
  expect(mailbox.sent.length === 1, "one email sent");
  expect(/baseline/i.test(mailbox.sent[0].subject), "whose subject says it's a baseline, not a change");
  expect(mailbox.sent[0].to === "owner@example.com", "addressed to the org's billing owner");

  const afterFirst = await getMonitorById(env, m.monitorId);
  expect(afterFirst.lastRunAt === NOW, "the run is recorded");
  expect(Array.isArray(afterFirst.lastAdvisoryIds) && afterFirst.lastAdvisoryIds.length === 1,
    "and the advisory set is persisted as the next baseline");

  // Run 2 — identical result. Silence.
  const r2 = await runMonitorCheck(env, m.monitorId, {}, { now: NOW + DAY, sendTransactional: mailbox.send });
  expect(r2.status === "no_change", `an unchanged second run reports no_change (got ${r2.status})`);
  expect(mailbox.sent.length === 1, "and sends NO second email — this is the whole point of the diff");

  // Run 3 — a new critical appears alongside the known high.
  env.FETCH = makeAuditFetch({ vulns: [
    { id: "GHSA-old", package: "lodash", fixedIn: "4.17.21" },
    { id: "GHSA-new", package: "express", fixedIn: "4.18.0" },
  ] });
  const r3 = await runMonitorCheck(env, m.monitorId, {}, { now: NOW + 2 * DAY, sendTransactional: mailbox.send });

  expect(r3.status === "alerted", `a newly introduced advisory alerts (got ${r3.status})`);
  expect(r3.newCount === 1, `exactly one advisory is reported as new (got ${r3.newCount})`);
  expect(mailbox.sent.length === 2, "a second email is sent");

  const body = mailbox.sent[1].text;
  expect(body.includes("GHSA-new"), "the email names the new advisory");
  expect(!body.includes("GHSA-old"), "and does NOT repeat the one they already knew about");
  expect(/fixed in/i.test(body), "and carries the fixed version");
  expect(/npm audit fix/.test(body), "and the fix command");
}

{
  // A 4xx from the audit (bad repo, no lockfile) is the monitor's own
  // misconfiguration — reported, not retried forever, and never emailed as
  // if it were a vulnerability change.
  const env = makeEnv();
  const orgId = await seedOrg(env, { userId: "usr_bad", email: "bad@example.com" });
  const m = await createMonitor(env, { orgId, repoUrl: "https://github.com/a/empty" });
  const mailbox = makeMailbox();

  env.FETCH = async () => new Response("not found", { status: 404 });
  const res = await runMonitorCheck(env, m.monitorId, {}, { now: NOW, sendTransactional: mailbox.send });

  expect(res.status === "audit_error", `a repo with no lockfile reports audit_error (got ${res.status})`);
  expect(res.retryable === false, "and is marked non-retryable — nightly retries won't create a lockfile");
  expect(mailbox.sent.length === 0, "and sends no email");
}

{
  // The queue consumer acks the ones that worked and retries only the one
  // that failed — a batch-mate's failure must not re-email the successes.
  const env = makeEnv();
  const orgId = await seedOrg(env, { userId: "usr_batch", email: "batch@example.com" });
  const good = await createMonitor(env, { orgId, repoUrl: "https://github.com/a/good" });
  env.FETCH = makeAuditFetch({ vulns: [] });

  const acked = [], retried = [];
  const mk = (monitorId) => ({
    body: { monitorId },
    ack:   () => acked.push(monitorId),
    retry: () => retried.push(monitorId),
  });

  await handleMonitorQueue(
    { messages: [mk(good.monitorId), mk(null), mk("mon_missing")] },
    env, {}, { now: NOW, sendTransactional: makeMailbox().send },
  );

  expect(acked.includes(good.monitorId), "a successful monitor is acked");
  expect(acked.includes("mon_missing"), "a deleted monitor is acked, not retried forever");
  expect(retried.length === 0, "nothing was retried in this batch");
  expect(acked.length === 3, `every message was resolved exactly once (got ${acked.length})`);
}

// ---------------------------------------------------------------------------
console.log("\nroutes and the tier limit\n");
// ---------------------------------------------------------------------------

{
  const env = makeEnv();
  await seedOrg(env, { userId: "usr_api", email: "api@example.com" });

  const created = await createMonitorHandler(
    authed("usr_api", { method: "POST", body: { repoUrl: "https://github.com/owner/repo.git" } }), env,
  );
  const body = await created.json();
  expect(created.status === 201, `creating a monitor → 201 (got ${created.status})`);
  expect(body.monitor.repoUrl === "https://github.com/owner/repo",
    `the .git suffix is normalised away (got ${body.monitor.repoUrl})`);
  expect(body.monitor.knownAdvisoryCount === null,
    "a fresh monitor reports null known advisories, distinct from 0 (= we looked and found none)");

  const dup = await createMonitorHandler(
    authed("usr_api", { method: "POST", body: { repoUrl: "https://github.com/owner/repo" } }), env,
  );
  expect(dup.status === 409, `adding the same repo twice is refused with 409 (got ${dup.status})`);

  const bad = await createMonitorHandler(
    authed("usr_api", { method: "POST", body: { repoUrl: "https://gitlab.com/owner/repo" } }), env,
  );
  expect(bad.status === 400, `a non-GitHub URL is rejected (got ${bad.status})`);

  const badSchedule = await createMonitorHandler(
    authed("usr_api", { method: "POST", body: { repoUrl: "https://github.com/o/r2", schedule: "hourly" } }), env,
  );
  expect(badSchedule.status === 400, `an unsupported schedule is rejected (got ${badSchedule.status})`);
}

{
  // The repo limit returns 402 — a purchase, not a permission.
  const env = makeEnv({ MONITOR_LIMIT_PAID: "2" });
  await seedOrg(env, { userId: "usr_lim", email: "lim@example.com" });

  for (const n of [1, 2]) {
    const res = await createMonitorHandler(
      authed("usr_lim", { method: "POST", body: { repoUrl: `https://github.com/o/r${n}` } }), env,
    );
    expect(res.status === 201, `monitor ${n} of 2 created`);
  }

  const over = await createMonitorHandler(
    authed("usr_lim", { method: "POST", body: { repoUrl: "https://github.com/o/r3" } }), env,
  );
  const overBody = await over.json();
  expect(over.status === 402, `exceeding the repo limit → 402 (got ${over.status})`);
  expect(overBody.error === "monitor_limit_reached", "with monitor_limit_reached");
  expect(overBody.monitorsUsed === 2 && overBody.monitorLimit === 2,
    `naming the numbers (${overBody.monitorsUsed} of ${overBody.monitorLimit})`);
  expect(typeof overBody.upgradeUrl === "string", "and where to upgrade");
}

{
  // A free org gets a smaller limit than a paid one, from the same resolver
  // the analyzer gate uses.
  const env = makeEnv();
  await seedOrg(env, { userId: "usr_free", email: "free@example.com", plan: "free", subStatus: null });

  const first = await createMonitorHandler(
    authed("usr_free", { method: "POST", body: { repoUrl: "https://github.com/o/one" } }), env,
  );
  expect(first.status === 201, "a free org can create its first monitor");

  const second = await createMonitorHandler(
    authed("usr_free", { method: "POST", body: { repoUrl: "https://github.com/o/two" } }), env,
  );
  expect(second.status === 402, `a free org is capped below a paid one (got ${second.status})`);

  expect(monitorLimitFor(env, { active: true }) > monitorLimitFor(env, { active: false }),
    "the paid limit is strictly larger than the free one");
}

{
  // Pause toggle, list, delete.
  const env = makeEnv();
  const orgId = await seedOrg(env, { userId: "usr_crud", email: "crud@example.com" });
  const m = await createMonitor(env, { orgId, repoUrl: "https://github.com/o/crud" });

  const paused = await pauseMonitorHandler(
    authed("usr_crud", { method: "POST", params: { id: m.monitorId } }), env,
  ).then((r) => r.json());
  expect(paused.monitor.paused === true, "an unqualified pause request toggles to paused");

  const resumed = await pauseMonitorHandler(
    authed("usr_crud", { method: "POST", params: { id: m.monitorId }, body: { paused: false } }), env,
  ).then((r) => r.json());
  expect(resumed.monitor.paused === false, "an explicit {paused:false} resumes");

  const listed = await listMonitorsHandler(authed("usr_crud"), env).then((r) => r.json());
  expect(listed.monitors.length === 1, "the monitor is listed");
  expect(typeof listed.monitorLimit === "number" && listed.monitorsUsed === 1,
    "with the limit and usage, so the UI can show a meter");

  const gone = await deleteMonitorHandler(
    authed("usr_crud", { method: "DELETE", params: { id: m.monitorId } }), env,
  );
  expect(gone.status === 200, "deleting works");
  const after = await listMonitorsHandler(authed("usr_crud"), env).then((r) => r.json());
  expect(after.monitors.length === 0, "and the monitor is gone");
}

{
  // Cross-org isolation: one org cannot see, pause or delete another's.
  const env = makeEnv();
  const orgA = await seedOrg(env, { userId: "usr_oa", email: "oa@example.com" });
  await seedOrg(env, { userId: "usr_ob", email: "ob@example.com" });
  const mA = await createMonitor(env, { orgId: orgA, repoUrl: "https://github.com/o/secret" });

  const listB = await listMonitorsHandler(authed("usr_ob"), env).then((r) => r.json());
  expect(listB.monitors.length === 0, "org B does not see org A's monitors");

  const delAttempt = await deleteMonitorHandler(
    authed("usr_ob", { method: "DELETE", params: { id: mA.monitorId } }), env,
  );
  expect(delAttempt.status === 404, `org B cannot delete org A's monitor by id (got ${delAttempt.status})`);

  const pauseAttempt = await pauseMonitorHandler(
    authed("usr_ob", { method: "POST", params: { id: mA.monitorId } }), env,
  );
  expect(pauseAttempt.status === 404, `nor pause it (got ${pauseAttempt.status})`);

  const stillThere = await getMonitorById(env, mA.monitorId);
  expect(stillThere && stillThere.pausedAt === null, "org A's monitor is untouched");
}

// ---------------------------------------------------------------------------
console.log("\nanalyzer sets — normalization, the API, and baseline clearing\n");
// ---------------------------------------------------------------------------

{
  expect(normalizeAnalyzers(null) === null && normalizeAnalyzers("arch") === null,
    "a non-array reads as 'not provided', never as an empty set");
  expect(JSON.stringify(normalizeAnalyzers([])) === '["vuln"]',
    "the audit is forced into every set — a monitor that watches nothing still occupies a slot");
  expect(JSON.stringify(normalizeAnalyzers(["algo", "arch", "vuln"])) === '["vuln","arch","algo"]',
    "sets come back in canonical order regardless of request order");
  expect(JSON.stringify(normalizeAnalyzers(["arch", "bogus", 42])) === '["vuln","arch"]',
    "unknown entries are dropped, not stored");
}

{
  const env = makeEnv();
  await seedOrg(env, { userId: "usr_az", email: "az@example.com" });

  const created = await createMonitorHandler(
    authed("usr_az", { method: "POST",
      body: { repoUrl: "https://github.com/o/az", analyzers: ["estimate", "arch"] } }), env,
  );
  const body = await created.json();
  expect(created.status === 201, `creating with analyzers → 201 (got ${created.status})`);
  expect(JSON.stringify(body.monitor.analyzers) === '["vuln","arch","estimate"]',
    `the stored set is normalised (got ${JSON.stringify(body.monitor.analyzers)})`);
  expect(body.monitor.archFindingCount === null && body.monitor.lastEstimate === null && body.monitor.lastAlgo === null,
    "every secondary baseline starts null — 'never ran', distinct from 'ran and found nothing'");

  const bad = await createMonitorHandler(
    authed("usr_az", { method: "POST",
      body: { repoUrl: "https://github.com/o/az2", analyzers: "all" } }), env,
  );
  const badBody = await bad.json();
  expect(bad.status === 400 && badBody.error === "invalid_analyzers",
    `a non-array analyzers value is a 400, not a silent default (got ${bad.status})`);

  const plain = await createMonitorHandler(
    authed("usr_az", { method: "POST", body: { repoUrl: "https://github.com/o/az3" } }), env,
  ).then((r) => r.json());
  expect(JSON.stringify(plain.monitor.analyzers) === '["vuln"]',
    "a monitor created without choosing runs exactly what monitors always ran");
}

{
  // The toggle endpoint, and the baseline-clearing rule: switching an
  // analyzer OFF forgets its baseline, so switching it back on later starts
  // with an honest baseline run rather than diffing against an arbitrary
  // point in the past.
  const env = makeEnv();
  const orgId = await seedOrg(env, { userId: "usr_tog", email: "tog@example.com" });
  const m = await createMonitor(env, {
    orgId, repoUrl: "https://github.com/o/tog", analyzers: ["vuln", "arch", "estimate"],
  });
  await recordMonitorRun(env, m.monitorId, {
    ranAt: NOW, resultHash: "h", advisoryIds: [],
    archKeys: ["web|reliability|single-instance"],
    estimate: { byProvider: { digitalocean: 12_340_000 }, at: NOW },
  });

  const before = await getMonitorById(env, m.monitorId);
  expect(before.lastArchKeys.length === 1 && before.lastEstimate.byProvider.digitalocean === 12_340_000,
    "both secondary baselines are recorded");

  const res = await setMonitorAnalyzersHandler(
    authed("usr_tog", { method: "POST", params: { id: m.monitorId },
      body: { analyzers: ["vuln", "estimate"] } }), env,
  );
  const resBody = await res.json();
  expect(res.status === 200 && JSON.stringify(resBody.monitor.analyzers) === '["vuln","estimate"]',
    "the endpoint stores the explicit full set");
  const after = await getMonitorById(env, m.monitorId);
  expect(after.lastArchKeys === null, "the switched-off analyzer's baseline is cleared");
  expect(after.lastEstimate && after.lastEstimate.byProvider.digitalocean === 12_340_000,
    "and the still-on analyzer's baseline is untouched");

  const notArray = await setMonitorAnalyzersHandler(
    authed("usr_tog", { method: "POST", params: { id: m.monitorId }, body: { analyzers: "arch" } }), env,
  );
  expect(notArray.status === 400, `a non-array set is refused (got ${notArray.status})`);

  const missing = await setMonitorAnalyzersHandler(
    authed("usr_tog", { method: "POST", params: { id: "mon_nope" }, body: { analyzers: ["vuln"] } }), env,
  );
  expect(missing.status === 404, `an unknown monitor id is a 404 (got ${missing.status})`);
}

// ---------------------------------------------------------------------------
console.log("\nsecondary diffs — the same null-vs-empty contract as advisories\n");
// ---------------------------------------------------------------------------

{
  const f = (target, lens, rule) => ({ target, lens, rule, title: rule });
  expect(archFindingKey(f("web", "cost", "oversized")) === "web|cost|oversized",
    "an arch finding's identity is target|lens|rule");

  const base = diffArchFindings([f("web", "cost", "a")], ["web|cost|a"], null);
  expect(base.isBaseline && base.shouldAlert, "a first arch run with findings alerts as a baseline");
  expect(diffArchFindings([], [], null).shouldAlert === false, "a clean first arch run is silent");

  const same = diffArchFindings([f("web", "cost", "a")], ["web|cost|a"], ["web|cost|a"]);
  expect(same.shouldAlert === false, "unchanged arch findings send nothing");

  const grown = diffArchFindings(
    [f("web", "cost", "a"), f("db", "reliability", "b")],
    ["db|reliability|b", "web|cost|a"], ["web|cost|a"]);
  expect(grown.shouldAlert && grown.newFindings.length === 1 && grown.newFindings[0].rule === "b",
    "only the finding they haven't seen is reported");
}

{
  expect(diffEstimate({ digitalocean: 1 }, null).shouldAlert === true,
    "a first estimate alerts — it's the number they turned the analyzer on to see");
  expect(diffEstimate({}, null).shouldAlert === false, "an empty first estimate is silent");
  expect(diffEstimate({ digitalocean: 5 }, { byProvider: { digitalocean: 5 } }).shouldAlert === false,
    "an unchanged total sends nothing");

  const moved = diffEstimate({ digitalocean: 6 }, { byProvider: { digitalocean: 5 } });
  expect(moved.shouldAlert && moved.changes[0].from === 5 && moved.changes[0].to === 6,
    "a moved total names both numbers");
  const swapped = diffEstimate({ aws: 5 }, { byProvider: { digitalocean: 5 } });
  expect(swapped.changes.length === 2, "a provider appearing and one disappearing are both changes");
  expect(formatMicroUsd(12_340_000) === "$12.34", "micro-USD renders as dollars in one place");
}

{
  expect(bigORank("unknown") > bigORank("O(n^3)"),
    "'unknown' ranks worst — a grade becoming unmeasurable is a change worth hearing about");
  expect(bigORank("O(n²)") === bigORank("O(n^2)") && bigORank("O(n³)") === bigORank("O(n^3)"),
    "the analyzer's superscript labels and the human-typed caret spellings rank identically");
  expect(bigORank("O(n³)") > bigORank("O(n²)"),
    "and n³ still ranks worse than n² — the regression the spellings must not mask");
  expect(bigORank("O(n^4.2)") > bigORank("O(n^3)") && bigORank("O(n^4.2)") < bigORank("unknown"),
    "open-ended exponents rank between O(n³) and unmeasurable");

  expect(diffAlgoGrades({ f: "O(n^2)" }, null).shouldAlert === false,
    "the baseline algo run records silently — a grade isn't actionable until it moves");

  const reg = diffAlgoGrades({ f: "O(n^2)", g: "O(1)" }, { byName: { f: "O(n)", g: "O(n)" } });
  expect(reg.shouldAlert && reg.regressions.length === 1 && reg.regressions[0].to === "O(n^2)",
    "a grade moving to a worse bucket is a regression");
  expect(reg.improvements.length === 1 && reg.improvements[0].name === "g",
    "an improvement rides along but never triggers");
  expect(diffAlgoGrades({ h: "O(n^3)" }, { byName: { f: "O(n)" } }).shouldAlert === false,
    "a newly-watched function's first grade is its baseline, not a regression");
}

// ---------------------------------------------------------------------------
console.log("\nmulti-analyzer run end to end\n");
// ---------------------------------------------------------------------------

const COMPOSE_2G = `
services:
  web:
    image: nginx
    deploy:
      replicas: 2
      resources:
        limits:
          cpus: "1.0"
          memory: 2G
`;
const COMPOSE_4G = COMPOSE_2G.replace("memory: 2G", "memory: 4G");
const OPT_CONFIG = JSON.stringify({
  entries: [{ name: "sum", file: "src/sum.js", functionName: "sum", sampleInput: [1, 2, 3] }],
});
const SUM_SRC = "export function sum(arr) { let t = 0; for (const x of arr) t += x; return t; }\n";

/**
 * env.FETCH covering the audit (lockfile + OSV, via makeAuditFetch) and the
 * secondary analyzers' raw-content fetches. `repoFiles` maps root-relative
 * path → content; `throttleSecondary` 403s everything that isn't the
 * lockfile, which is exactly what a GitHub rate limit looks like.
 */
function makeMultiFetch({ vulns = [], repoFiles = {}, throttleSecondary = false }) {
  const audit = makeAuditFetch({ vulns });
  return async (url) => {
    const u = String(url);
    if (u.includes("raw.githubusercontent.com")) {
      const name = decodeURIComponent(u.split("/").slice(6).join("/"));
      // The audit's lockfile names (SUPPORTED_FILES in analyzers/lockfile.js)
      // stay with the audit stub even under throttleSecondary — the throttle
      // being simulated hits only the secondaries' extra fetches.
      if (!/(package-lock\.json|yarn\.lock|requirements\.txt|Gemfile\.lock|go\.sum)$/.test(name)) {
        if (throttleSecondary) return new Response("rate limited", { status: 403 });
        if (name in repoFiles) return new Response(repoFiles[name], { status: 200 });
        return new Response("not found", { status: 404 });
      }
    }
    return audit(url);
  };
}

/** A sandbox whose run time is an exact function of input size — so the
 *  Big-O fit is deterministic instead of hostage to test-host timing. */
function makeSandbox(msForN) {
  return {
    fetch: async (url, init) => {
      const { input } = JSON.parse(init.body);
      const n = Array.isArray(input) ? input.length : (typeof input === "number" ? input : 1);
      return new Response(JSON.stringify({ ok: true, ms: msForN(n), result: 0, heapBytes: 1024 }));
    },
  };
}
const LINEAR    = (n) => n * 0.01;         // slope 1 → O(n)
const QUADRATIC = (n) => n * n * 0.0001;   // slope 2 → O(n^2)

{
  const env = makeEnv();
  const orgId = await seedOrg(env, { userId: "usr_multi", email: "multi@example.com" });
  const m = await createMonitor(env, {
    orgId, repoUrl: "https://github.com/o/multi",
    analyzers: ["vuln", "arch", "estimate", "algo"],
  });
  const mailbox = makeMailbox();
  const files = {
    "docker-compose.yml": COMPOSE_2G,
    "optimizer.config.json": OPT_CONFIG,
    "src/sum.js": SUM_SRC,
  };

  // Run 1 — baselines. The estimate is the only section that alerts on a
  // baseline (it's the number the analyzer exists to produce); arch found
  // nothing new to a fresh baseline unless the compose trips a rule, and the
  // algo baseline is silent by design.
  env.FETCH = makeMultiFetch({ vulns: [], repoFiles: files });
  env.SANDBOX = makeSandbox(LINEAR);
  const r1 = await runMonitorCheck(env, m.monitorId, {}, { now: NOW, sendTransactional: mailbox.send });
  expect(r1.status === "alerted", `the baseline estimate alerts (got ${r1.status})`);
  expect(r1.estimateChanged === true && r1.algoRegressions === 0,
    "for the estimate, not the optimizer");
  expect(mailbox.sent.length === 1 && /baseline cost estimate/.test(mailbox.sent[0].subject),
    `the subject says baseline cost estimate (got "${mailbox.sent.length && mailbox.sent[0].subject}")`);
  expect(/not a bill/i.test(mailbox.sent[0].text), "and the body repeats that an estimate is not a bill");

  const after1 = await getMonitorById(env, m.monitorId);
  expect(Array.isArray(after1.lastArchKeys), "the arch baseline is recorded");
  expect(after1.lastEstimate && Object.keys(after1.lastEstimate.byProvider).length > 0,
    "the estimate baseline holds per-provider totals");
  expect(after1.lastAlgo && after1.lastAlgo.byName.sum === "O(n)",
    `the algo baseline graded sum as O(n) (got ${after1.lastAlgo && after1.lastAlgo.byName.sum})`);

  // Run 2 — nothing moved. Silence, across all four analyzers.
  const r2 = await runMonitorCheck(env, m.monitorId, {}, { now: NOW + DAY, sendTransactional: mailbox.send });
  expect(r2.status === "no_change", `an unchanged multi-analyzer run is no_change (got ${r2.status})`);
  expect(mailbox.sent.length === 1, "and sends nothing");

  // Run 3 — the compose doubles its memory and sum degrades to O(n^2).
  env.FETCH = makeMultiFetch({ vulns: [], repoFiles: { ...files, "docker-compose.yml": COMPOSE_4G } });
  env.SANDBOX = makeSandbox(QUADRATIC);
  const r3 = await runMonitorCheck(env, m.monitorId, {}, { now: NOW + 2 * DAY, sendTransactional: mailbox.send });
  expect(r3.status === "alerted", `a moved estimate + algo regression alerts (got ${r3.status})`);
  expect(r3.estimateChanged === true && r3.algoRegressions === 1,
    `both sections report (estimateChanged ${r3.estimateChanged}, regressions ${r3.algoRegressions})`);
  expect(mailbox.sent.length === 2, "one email carries both");
  const subject3 = mailbox.sent[1].subject;
  expect(/estimated cost changed/.test(subject3) && /1 complexity regression/.test(subject3),
    `the subject names both sections (got "${subject3}")`);
  expect(/sum/.test(mailbox.sent[1].text) && mailbox.sent[1].text.includes("O(n²)"),
    "the body names the regressed function and its new grade");

  const after3 = await getMonitorById(env, m.monitorId);
  expect(after3.lastAlgo.byName.sum === "O(n²)", "the algo baseline advanced to the new grade");

  // Run 4 — GitHub throttles the secondary fetches. Every secondary skips,
  // and crucially every baseline stays where run 3 left it: an outage costs
  // a night's coverage, never a false "everything is new again" email.
  env.FETCH = makeMultiFetch({ vulns: [], throttleSecondary: true });
  const r4 = await runMonitorCheck(env, m.monitorId, {}, { now: NOW + 3 * DAY, sendTransactional: mailbox.send });
  expect(r4.status === "no_change", `a throttled night is no_change, not an alert (got ${r4.status})`);
  expect(r4.skips.length === 3 && r4.skips.every((s) => s.reason === "github_throttled"),
    `all three secondaries report the throttle (got ${JSON.stringify(r4.skips)})`);
  const after4 = await getMonitorById(env, m.monitorId);
  expect(after4.lastAlgo.byName.sum === "O(n²)" &&
         JSON.stringify(after4.lastEstimate.byProvider) === JSON.stringify(after3.lastEstimate.byProvider) &&
         JSON.stringify(after4.lastArchKeys) === JSON.stringify(after3.lastArchKeys),
    "no baseline moved — the transient skip left every one untouched");
  expect(mailbox.sent.length === 2, "and no email was sent about the outage");
}

{
  // Permanent absence: the repo simply has none of the files the secondary
  // analyzers read. Each records an EMPTY baseline — a fact ("we looked,
  // nothing there"), not an unknown — and the run is quiet.
  const env = makeEnv();
  const orgId = await seedOrg(env, { userId: "usr_none", email: "none@example.com" });
  const m = await createMonitor(env, {
    orgId, repoUrl: "https://github.com/o/none",
    analyzers: ["vuln", "arch", "estimate", "algo"],
  });
  env.FETCH = makeMultiFetch({ vulns: [], repoFiles: {} });
  const mailbox = makeMailbox();
  const res = await runMonitorCheck(env, m.monitorId, {}, { now: NOW, sendTransactional: mailbox.send });
  expect(res.status === "no_change", `a repo with no secondary files runs quietly (got ${res.status})`);
  expect(res.skips.map((s) => s.reason).sort().join(",") === "no_compose,no_config,no_manifests",
    `each analyzer states why it had nothing to do (got ${JSON.stringify(res.skips)})`);
  const after = await getMonitorById(env, m.monitorId);
  expect(Array.isArray(after.lastArchKeys) && after.lastArchKeys.length === 0 &&
         after.lastEstimate && Object.keys(after.lastEstimate.byProvider).length === 0 &&
         after.lastAlgo && Object.keys(after.lastAlgo.byName).length === 0,
    "and each recorded an explicit empty baseline, not null");
  expect(mailbox.sent.length === 0, "no email");
}

// ---------------------------------------------------------------------------
console.log("\nthe optimizer CI snippet\n");
// ---------------------------------------------------------------------------

{
  const env = makeEnv();
  const res = ciOptimizerSnippetHandler(new Request("https://algosize.com/api/ci/optimizer-snippet"), env);
  const body = await res.json();
  expect(res.status === 200, `the snippet endpoint answers (got ${res.status})`);
  expect(body.filename === ".github/workflows/algosize-optimizer.yml" &&
         body.configFilename === "optimizer.config.json" &&
         body.secretName === "ALGOSIZE_API_KEY",
    "and names the three files/secrets the wizard shows");
  const cfg = JSON.parse(body.configExample);
  expect(Array.isArray(cfg.entries) && cfg.entries.length > 0 &&
         typeof cfg.entries[0].file === "string" && typeof cfg.entries[0].functionName === "string",
    "the config example is valid JSON in the shape the sweep and workflow both read");
  expect(body.workflow.includes("/api/analyze/algo"),
    "the workflow grades through the same API endpoint as the dashboard");
  expect(body.workflow.includes("ALGOSIZE_API_KEY") && /skip/i.test(body.workflow),
    "and skips itself with a notice while the secret is missing — never a red build");
}

// ---------- summary ----------
console.log("");
if (failures === 0) {
  console.log("\x1b[32m  all monitor tests passed\x1b[0m\n");
  process.exit(0);
} else {
  console.log(`\x1b[31m  ${failures} monitor test(s) failed\x1b[0m\n`);
  process.exit(1);
}
