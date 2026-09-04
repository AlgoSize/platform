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
import { sweepDueMonitors, runMonitorCheck, handleMonitorQueue, handleMonitorDlq } from "../src/monitors/run.js";
import { discoverArchFiles, runArchForMonitor, MAX_ARCH_TREE_FILES,
         splitPricedProviders } from "../src/monitors/analyzers.js";
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
  // …and beside it, what the X-ray actually READ (migrations/0023). Without
  // this the finding count is unfalsifiable: "0 findings in the last sweep"
  // is the same sentence whether forty services were mapped and cleared or
  // one file was parsed and had nothing to say.
  expect(after1.lastArchScope && typeof after1.lastArchScope.services === "number" &&
         after1.lastArchScope.at === NOW,
    `the sweep records the X-ray's scope (got ${JSON.stringify(after1.lastArchScope)})`);
  expect(after1.lastEstimate && Object.keys(after1.lastEstimate.byProvider).length > 0,
    "the estimate baseline holds per-provider totals");
  expect(after1.lastAlgo && after1.lastAlgo.byName.sum === "O(n)",
    `the algo baseline graded sum as O(n) (got ${after1.lastAlgo && after1.lastAlgo.byName.sum})`);

  // Every analyzer that produced a result files a run, and each headline has
  // to summarise the thing that analyzer actually measured. The trap here is
  // "algo": a sweep grades every entry in optimizer.config.json, while a
  // single run grades one function — so the single-function headline shape
  // ("O(n) · 1.50 ms") does not fit, and falling through to it produced
  // "unknown · — ms", indistinguishable from a grading that failed.
  {
    const { listRuns } = await import("../src/handlers/runs.js");
    const filed = await listRuns(env, { orgId }, { limit: 20, source: "monitor" });
    const by = {};
    filed.items.forEach((x) => { by[x.analyzer] = x; });
    expect(["vuln", "arch", "estimate", "algo"].every((a) => by[a]),
      `all four analyzers file a run (got ${Object.keys(by).sort().join(",")})`);
    expect(by.algo && /1 function · worst O\(n\)/.test(by.algo.headline),
      `the algo headline summarises the sweep, not one function (got "${by.algo && by.algo.headline}")`);
    expect(by.algo && !/unknown/.test(by.algo.headline),
      "…and never reads as a failed grading when the grading succeeded");
    expect(by.estimate && /\$/.test(by.estimate.headline),
      `the estimate headline names a price (got "${by.estimate && by.estimate.headline}")`);
    expect(by.arch && /cluster/.test(by.arch.headline),
      `the arch headline counts clusters (got "${by.arch && by.arch.headline}")`);
    expect(filed.items.every((x) => x.repo === "https://github.com/o/multi"),
      "and every one names the repository it read");
  }

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
  // Scoped to the three SECONDARY analyzers. The source scanner also skips on
  // a throttled night and records its own reason; asserting over the whole
  // list would conflate "the secondaries all skipped" with "exactly three
  // things skipped", and the second is not what this test is about.
  const r4secondary = r4.skips.filter((s) => ["arch", "estimate", "algo"].includes(s.analyzer));
  expect(r4secondary.length === 3 && r4secondary.every((s) => s.reason === "github_throttled"),
    `all three secondaries report the throttle (got ${JSON.stringify(r4.skips)})`);
  // …and the source scan does not quietly go missing on that same night: a
  // sweep that could not read the code must say so, or the Code column shows
  // an empty finding list as a clean codebase.
  const r4source = r4.skips.find((s) => s.analyzer === "source");
  expect(r4source && r4source.reason === "source_unreadable",
    `the source scan reports its own failure too (got ${JSON.stringify(r4source)})`);
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
  expect(res.skips.filter((s) => ["arch", "estimate", "algo"].includes(s.analyzer))
           .map((s) => s.reason).sort().join(",") === "no_compose,no_config,no_manifests",
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

// ---------------------------------------------------------------------------
// A sweep files its audit as a run
// ---------------------------------------------------------------------------
// Until this existed, "what did the nightly monitor find" had no answer that
// outlived the next sweep: the result went onto the monitor row, which holds
// only the latest one. A CI audit and a scheduled audit are the same work on
// the same repository, and only one of them was answerable.
{
  const { listRuns, listRunsHandler } = await import("../src/handlers/runs.js");
  const { peekUsage } = await import("../src/quota.js");

  const env = makeEnv();
  const orgId = await seedOrg(env, { userId: "usr_file", email: "file@example.com" });
  const m = await createMonitor(env, { orgId, repoUrl: "https://github.com/a/b" });

  const mailbox = makeMailbox();
  env.FETCH = makeAuditFetch({ vulns: [{ id: "GHSA-f1", package: "lodash", fixedIn: "4.17.21" }] });
  const r1 = await runMonitorCheck(env, m.monitorId, {}, { now: NOW, sendTransactional: mailbox.send });

  expect(r1.runIds && typeof r1.runIds.vuln === "string",
    `the sweep reports the run id it filed (got ${JSON.stringify(r1.runIds)})`);

  const all = await listRuns(env, { orgId }, { limit: 20 });
  const filed = all.items.find((x) => x.id === r1.runIds.vuln);
  expect(!!filed, "the audit is in run history like any other run");
  expect(filed && filed.source === "monitor",
    `…tagged monitor, not ci and not manual (got ${filed && filed.source})`);
  expect(filed && filed.analyzer === "vuln", "…under the analyzer that produced it");
  expect(filed && filed.repo === "https://github.com/a/b",
    `…naming the repository it read (got ${filed && filed.repo})`);
  expect(filed && filed.monitorId === m.monitorId,
    "…and the monitor that scheduled it, so a run nobody started can say why it happened");

  // The whole reason a sweep is worth filing: the history survives the next
  // sweep, which the monitor row's single last_* result never did.
  env.FETCH = makeAuditFetch({ vulns: [
    { id: "GHSA-f1", package: "lodash", fixedIn: "4.17.21" },
    { id: "GHSA-f2", package: "express", fixedIn: "4.18.0" },
  ] });
  const r2 = await runMonitorCheck(env, m.monitorId, {}, { now: NOW + DAY, sendTransactional: mailbox.send });
  const after = await listRuns(env, { orgId }, { limit: 20, source: "monitor" });
  expect(after.items.length === 2,
    `a second sweep adds a second run rather than overwriting the first (got ${after.items.length})`);
  expect(after.items.some((x) => x.id === r1.runIds.vuln) &&
         after.items.some((x) => x.id === r2.runIds.vuln),
    "…and both are still readable");

  // Scheduled work must not spend the allowance the customer is keeping for
  // work they are actually doing. A nightly monitor would empty a free plan
  // inside a week and the first symptom would be an unexplained refusal.
  expect(await peekUsage(env, orgId) === 0 && await peekUsage(env, "usr_file") === 0,
    "a sweep consumes no quota — neither the org's meter nor the owner's");

  // The filter, from the outside. This is the request an assistant makes.
  const req = authed("usr_file", { url: "https://algosize.com/api/runs?source=monitor&limit=20" });
  const res = await listRunsHandler(req, env);
  const body = await res.json();
  expect(res.status === 200 && body.items.length === 2,
    `?source=monitor returns the swept runs (got ${res.status}, ${body.items && body.items.length})`);
  expect(body.items.every((x) => x.source === "monitor"), "…and only those");

  const manual = await listRuns(env, { orgId }, { limit: 20, source: "manual" });
  expect(manual.items.length === 0,
    "a swept run is not 'manual' either — manual means a person started it");

  // An unrecognised filter must not quietly widen to everything. That failure
  // reads as "there are no runs of that kind", which is the opposite of true
  // and is exactly what ?source=monitor did before monitor was a real value.
  const bad = await listRunsHandler(
    authed("usr_file", { url: "https://algosize.com/api/runs?source=nightly" }), env);
  expect(bad.status === 400,
    `an unknown source is refused rather than ignored (got ${bad.status})`);
  const badBody = await bad.json();
  expect(/monitor/.test(badBody.message || ""),
    "…and the refusal names the values that do work");
}

// ---------------------------------------------------------------------------
console.log("\nthe dead-letter consumer\n");
// ---------------------------------------------------------------------------
// algosize-scans-dlq existed in production for months with no consumer bound
// to it, which made it a hole rather than a safety net: a message that
// exhausted its three retries was retained for the queue's window and then
// purged, with no alert and no record. A permanently-broken monitor simply
// went quiet — indistinguishable from a repository that stopped having
// problems.
{
  const env = makeEnv();
  const orgId = await seedOrg(env, { userId: "usr_dlq", email: "dlq@example.com" });
  const m = await createMonitor(env, { orgId, repoUrl: "https://github.com/o/dead" });

  const acked = [], retried = [];
  const mk = (monitorId) => ({
    body: { monitorId },
    attempts: 3,
    ack:   () => acked.push(monitorId),
    retry: () => retried.push(monitorId),
  });

  await handleMonitorDlq(
    { queue: "algosize-scans-dlq", messages: [mk(m.monitorId), mk(null)] }, env, {});

  // Always ack. retry() here returns the message to the DLQ it is already in,
  // and a DLQ with nowhere onward to go retries until retention expires —
  // turning one dead message into hundreds of duplicate alerts.
  expect(retried.length === 0,
    "nothing is retried out of the dead-letter queue — there is nowhere for it to go");
  expect(acked.length === 2,
    `every message is resolved exactly once (got ${acked.length})`);

  // The monitor row should say so, rather than sitting at whatever the last
  // retryable attempt left behind.
  const after = await getMonitorById(env, m.monitorId);
  expect(after.lastStatus === "failed",
    `the monitor is marked failed (got ${after.lastStatus})`);
  expect(after.lastError === "dead_lettered",
    `…with a reason that names what happened (got ${after.lastError})`);
  // recordMonitorAttempt touches no baseline by construction, so a dead-letter
  // cannot corrupt the diff the next successful sweep produces.
  expect(after.lastRunAt === null,
    "…and last_run_at is NOT advanced — a failure did not produce a result");

  // A message with no monitorId is still acked rather than stranded.
  expect(acked.includes(null) || acked.length === 2,
    "a malformed dead-letter message is acked too, not left to expire silently");
}

// The routing decision, which is the part that would do real damage if wrong:
// one queue() entrypoint serves every bound queue, so a dead-lettered batch
// sent to handleMonitorQueue would re-run the very sweep that already failed
// three times, then retry it back into the DLQ it came from, indefinitely.
{
  const worker = (await import("../src/index.js")).default;
  const env = makeEnv();
  const orgId = await seedOrg(env, { userId: "usr_route", email: "route@example.com" });
  const m = await createMonitor(env, { orgId, repoUrl: "https://github.com/o/route" });

  // If this batch reached handleMonitorQueue it would call runMonitorCheck,
  // which needs FETCH. Leaving FETCH unset means a wrong route shows up as a
  // thrown error or a retry rather than a silent pass.
  const acked = [], retried = [];
  const msg = {
    body: { monitorId: m.monitorId }, attempts: 3,
    ack: () => acked.push("ack"), retry: () => retried.push("retry"),
  };

  await worker.queue({ queue: "algosize-scans-dlq", messages: [msg] }, env, {});
  expect(acked.length === 1 && retried.length === 0,
    "a batch from algosize-scans-dlq is acked by the dead-letter handler, never retried");

  // Discriminate on lastError, NOT lastStatus. handleMonitorQueue's own
  // failure path also marks a monitor "failed", so asserting the status alone
  // passes whether or not the dispatch exists — verified by deleting the
  // dispatch and watching the status assertion still pass. "dead_lettered" is
  // written by handleMonitorDlq and nothing else, so it is the only value that
  // proves which handler ran.
  const after = await getMonitorById(env, m.monitorId);
  expect(after.lastError === "dead_lettered",
    `…and took the dead-letter path, not the re-run path (lastError=${after.lastError})`);

  // Suffix matching, so staging routes correctly from the same rule.
  const env2 = makeEnv();
  const orgId2 = await seedOrg(env2, { userId: "usr_stg", email: "stg@example.com" });
  const m2 = await createMonitor(env2, { orgId: orgId2, repoUrl: "https://github.com/o/stg" });
  const acked2 = [];
  await worker.queue({
    queue: "algosize-scans-staging-dlq",
    messages: [{ body: { monitorId: m2.monitorId }, attempts: 3,
                 ack: () => acked2.push("ack"), retry: () => { throw new Error("must not retry"); } }],
  }, env2, {});
  const after2 = await getMonitorById(env2, m2.monitorId);
  expect(acked2.length === 1 && after2.lastError === "dead_lettered",
    `staging's dead-letter queue routes the same way — the rule matches the -dlq suffix, not one exact name (lastError=${after2.lastError})`);
}

// ---------- summary ----------
// ---------------------------------------------------------------------------
console.log("\nthe X-ray reaches manifests below the repository root\n");
// ---------------------------------------------------------------------------
// The failure this pins hit production on our own repository: every manifest
// lives in a subdirectory (worker/wrangler.toml), the root-name fetch found
// nothing, and "Draw the map" reported nothing to map for a repo with three
// deployable units — while the sweep skipped quietly and the monitor badge
// showed the vuln audit's clean result. Discovery now goes through the git
// tree; these tests bind that path, and the binding was verified by
// reverting runArchForMonitor to the names-only fetch and watching the
// end-to-end case report no_manifests again.

const DEEP_WRANGLER = 'name = "api"\n[[d1_databases]]\nbinding = "DB"\ndatabase_name = "app"\n';

function makeTreeFetch({ tree, raw = {}, treeStatus = 200, rawThrottle = false }) {
  return async (url, init) => {
    const u = String(url);
    if (u.includes("api.github.com") && u.includes("/git/trees/")) {
      if (treeStatus !== 200) return new Response("nope", { status: treeStatus });
      return new Response(JSON.stringify({ tree, truncated: false }), { status: 200 });
    }
    if (u.includes("raw.githubusercontent.com")) {
      if (rawThrottle) return new Response("rate limited", { status: 403 });
      const path = decodeURIComponent(u.split("/").slice(6).join("/"));
      if (path in raw) return new Response(raw[path], { status: 200 });
      return new Response("not found", { status: 404 });
    }
    return new Response("not found", { status: 404 });
  };
}

{
  const blob = (path, size = 100) => ({ path, type: "blob", size });
  const tree = [
    blob("worker/wrangler.toml"),
    blob("worker-sandbox/wrangler.toml"),
    blob("infra/k8s/app.yaml"),
    blob("src/index.js"),
    blob("src/lib/helpers.js"),                 // not an entry point — ignored
    blob("node_modules/dep/wrangler.toml"),     // excluded directory
    blob("tests/fixtures/docker-compose.yml"),  // excluded directory
    blob("docs/notes.md"),                      // not a manifest
    blob("big/terraform.tf", 999999999),        // over the size cap
    { path: "worker", type: "tree" },           // directories are not files
  ];
  const raw = {
    "worker/wrangler.toml":         DEEP_WRANGLER,
    "worker-sandbox/wrangler.toml": 'name = "sandbox"\n',
    "infra/k8s/app.yaml":           "kind: Deployment\nmetadata:\n  name: app\n",
    "src/index.js":                 "import { x } from './lib/helpers.js';\n",
  };
  const fetchImpl = makeTreeFetch({ tree, raw });

  const got = await discoverArchFiles({ owner: "o", repo: "deep", branch: "main" }, fetchImpl, {});
  const paths = got.files.map((f) => f.path).sort();
  expect(paths.join(",") === "infra/k8s/app.yaml,src/index.js,worker-sandbox/wrangler.toml,worker/wrangler.toml",
    `discovery finds manifests, k8s yaml and entry sources below the root (got ${paths.join(",")})`);
  expect(!paths.some((x) => x.includes("node_modules") || x.startsWith("tests/")),
    "…and never reads vendored or fixture directories");
  expect(!paths.includes("big/terraform.tf"),
    "…and skips a file the tree already says is over the size cap");

  // The cap spends itself on manifests first.
  const many = [];
  for (let i = 0; i < 40; i++) many.push(blob(`services/s${String(i).padStart(2, "0")}/wrangler.toml`));
  many.push(blob("src/index.js"));
  const capped = await discoverArchFiles({ owner: "o", repo: "wide", branch: "main" },
    makeTreeFetch({ tree: many, raw: Object.fromEntries(many.filter((e) => e.type === "blob").map((e) => [e.path, DEEP_WRANGLER])) }), {});
  expect(capped.files.length === MAX_ARCH_TREE_FILES,
    `the fetch is bounded at ${MAX_ARCH_TREE_FILES} files`);
  expect(!capped.files.some((f) => f.path === "src/index.js"),
    "…and when it bites, a manifest beats a source entry for the last slot");

  // GitHub saying "slow down" must not read as "these files no longer exist".
  const throttled = await discoverArchFiles({ owner: "o", repo: "deep", branch: "main" },
    makeTreeFetch({ tree, treeStatus: 403 }), {});
  expect(throttled.throttled === true, "a rate-limited tree listing is throttled, not empty");
  const rawThrottled = await discoverArchFiles({ owner: "o", repo: "deep", branch: "main" },
    makeTreeFetch({ tree, rawThrottle: true }), {});
  expect(rawThrottled.throttled === true, "…and so is a rate-limited content fetch after a good listing");

  // A tree that cannot be listed at all (404 — private, renamed) says so, so
  // the caller can fall back to the root-name fetch instead of reporting a
  // repo with unreachable metadata as having no architecture.
  const gone = await discoverArchFiles({ owner: "o", repo: "deep", branch: "main" },
    makeTreeFetch({ tree, treeStatus: 404 }), {});
  expect(gone.unavailable === true && gone.throttled === false,
    "an unlistable tree reports unavailable, which routes to the fallback");

  // End to end: the exact production shape — every manifest below the root.
  const arch = await runArchForMonitor(
    { repoUrl: "https://github.com/o/deep", branch: "main" }, {}, fetchImpl);
  expect(arch.status === "ok",
    `a repo whose only manifests live in subdirectories now maps (got ${arch.status})`);

  // And the fallback end to end: tree 404s, but a root wrangler.toml exists.
  const rootOnly = async (url, init) => {
    const u = String(url);
    if (u.includes("api.github.com")) return new Response("nope", { status: 404 });
    if (u.includes("raw.githubusercontent.com") && u.endsWith("/wrangler.toml")
        && !u.split("/").slice(6).join("/").includes("/")) {
      return new Response(DEEP_WRANGLER, { status: 200 });
    }
    return new Response("not found", { status: 404 });
  };
  const viaFallback = await runArchForMonitor(
    { repoUrl: "https://github.com/o/rootonly", branch: "main" }, {}, rootOnly);
  expect(viaFallback.status === "ok",
    "a repo the tree API cannot list still maps from its root manifests — no regression");
}


// ---------------------------------------------------------------------------
console.log("\ncloud spend can be watched, which it could not be before\n");
// ---------------------------------------------------------------------------
//
// The cost analyzer was the only one that could not be scheduled. The
// dashboard said so: "This one reads a file you upload and keeps nothing, so
// there is no standing result to show." Every other tool had a nightly half
// because every other tool reads something a repository already contains; a
// CUR is a billing export nobody commits by default, so it needed a way to be
// pointed AT one.
{
  const CUR = [
    "lineItem/ProductCode,lineItem/UsageType,lineItem/UnblendedCost",
    "AmazonEC2,BoxUsage:m5.large,120.50",
    "AmazonEC2,BoxUsage:m5.large,118.25",
    "AmazonS3,TimedStorage-ByteHrs,45.10",
  ].join("\n");

  // Named and committed: a standing result.
  const env = makeEnv();
  const orgId = await seedOrg(env, { userId: "usr_cur", email: "cur@example.com" });
  const m = await createMonitor(env, {
    orgId, repoUrl: "https://github.com/o/spend", analyzers: ["vuln", "cost"],
  });
  env.FETCH = makeMultiFetch({ vulns: [], repoFiles: {
    "algosize.budget.json": JSON.stringify({ cur: "billing/cur.csv" }),
    "billing/cur.csv": CUR,
  } });
  const mailbox = makeMailbox();
  const res = await runMonitorCheck(env, m.monitorId, {}, { now: NOW, sendTransactional: mailbox.send });
  expect(!res.skips.some((s) => s.analyzer === "cost"),
    `a committed CUR is read rather than skipped (got ${JSON.stringify(res.skips)})`);

  // The whole ask was a STANDING RESULT — so the run has to be filed, not
  // merely computed and dropped.
  const { listRuns } = await import("../src/handlers/runs.js");
  const runs = await listRuns(env, { orgId }, { limit: 10 });
  const costRuns = runs.items.filter((r) => r.analyzer === "cost");
  expect(costRuns.length === 1, `the sweep files a cost run (got ${costRuns.length})`);
  expect(costRuns[0] && costRuns[0].source === "monitor",
    `marked source=monitor, not ci (got ${costRuns[0] && costRuns[0].source})`);

  // Deliberately no baseline and no alert: a bill differs every day, so a diff
  // would report Tuesday differing from Monday as a finding.
  expect(mailbox.sent.length === 0, "and sends no email — a bill changing is not an alert");

  // …but "keeps nothing to diff against" and "keeps nothing at all" are two
  // different decisions, and only the first one was ever argued for. The
  // scorecard grades exclusively from stored results, so with nothing stored
  // the one analyzer you could schedule was the one the grid could not see.
  // migrations/0023 stores the LATEST figures, never a comparison.
  const swept = await getMonitorById(env, m.monitorId);
  expect(swept.lastCost && swept.lastCost.currentSpend > 0,
    `the sweep stores the spend figure (got ${JSON.stringify(swept.lastCost)})`);
  expect(swept.lastCost.at === NOW,
    "…dated, so the scorecard can say how old the bill it is showing is");
  expect(typeof swept.lastCost.suggestions === "number",
    "…with how many savings it found, so a figure can say what is recoverable");
}

{
  // Not named at all. That is consent, not an error: a repository that has not
  // named a CUR is telling us not to read its billing data.
  const env = makeEnv();
  const orgId = await seedOrg(env, { userId: "usr_nocur", email: "nocur@example.com" });
  const m = await createMonitor(env, {
    orgId, repoUrl: "https://github.com/o/nocur", analyzers: ["vuln", "cost"],
  });
  env.FETCH = makeMultiFetch({ vulns: [], repoFiles: {} });
  const res = await runMonitorCheck(env, m.monitorId, {}, { now: NOW, sendTransactional: makeMailbox().send });
  const skip = res.skips.find((s) => s.analyzer === "cost");
  expect(skip && skip.reason === "no_cur",
    `an unnamed CUR is a quiet skip, not a failure (got ${JSON.stringify(skip)})`);
  expect(res.status !== "failed", `and the sweep still succeeds (got ${res.status})`);
}

{
  // Named but missing is a DIFFERENT answer from never named, and the reader
  // needs to know which: one repo opted out, the other meant to opt in.
  const env = makeEnv();
  const orgId = await seedOrg(env, { userId: "usr_gone", email: "gone@example.com" });
  const m = await createMonitor(env, {
    orgId, repoUrl: "https://github.com/o/gone", analyzers: ["vuln", "cost"],
  });
  env.FETCH = makeMultiFetch({ vulns: [], repoFiles: {
    "algosize.budget.json": JSON.stringify({ cur: "billing/missing.csv" }),
  } });
  const res = await runMonitorCheck(env, m.monitorId, {}, { now: NOW, sendTransactional: makeMailbox().send });
  const skip = res.skips.find((s) => s.analyzer === "cost");
  expect(skip && skip.reason === "cur_missing",
    `a named-but-absent export says so distinctly (got ${JSON.stringify(skip)})`);

  const { explainUnavailable } = await import("../src/handlers/monitors.js");
  expect(explainUnavailable("no_cur") !== explainUnavailable("cur_missing"),
    "and the two read differently in the panel, because the fixes differ");
  expect(explainUnavailable("cur_missing") !== explainUnavailable("__unknown__"),
    "rather than falling through to the generic sentence");
}

// ---------------------------------------------------------------------------
console.log("\nthe sweep grades the code it already reads\n");
// ---------------------------------------------------------------------------
//
// runLockfileAudit has performed a full SAST scan on every scheduled sweep
// since the source scanner shipped, and returned it as `source`. The sweep
// read `advisories` beside it and dropped the rest — a GitHub tree listing,
// up to 120 file fetches and a full parse, paid for and discarded.
//
// The visible consequence was not a missing feature. It was the scorecard
// grading a repository on its dependency list alone, so a repo with no CVEs
// and a critical injection finding in its own code rendered "A · 0". These
// tests pin the storage, the diff, and the two ways it must refuse to imply
// clean code. Verified by reverting the `source:` argument out of
// recordMonitorRun and watching the baseline assertions fail.
{
  // A repository whose only lockfile is clean and whose source is not.
  const VULN_SRC = [
    'const express = require("express");',
    'const app = express();',
    'app.get("/u/:id", (req, res) => {',
    '  db.query("SELECT * FROM users WHERE id = " + req.params.id, cb);',
    "});",
  ].join("\n");
  const LOCK = JSON.stringify({
    name: "demo", lockfileVersion: 3,
    packages: { "": { name: "demo" }, "node_modules/lodash": { version: "4.17.21" } },
  });

  const treeFetch = ({ files }) => async (url) => {
    const u = String(url);
    if (u.includes("api.github.com") && u.includes("/git/trees/")) {
      return new Response(JSON.stringify({
        tree: Object.keys(files).map((path) => ({ path, type: "blob", size: files[path].length })),
        truncated: false,
      }), { status: 200 });
    }
    if (u.includes("raw.githubusercontent.com")) {
      const path = decodeURIComponent(u.split("/").slice(6).join("/"));
      if (path in files) return new Response(files[path], { status: 200 });
      return new Response("not found", { status: 404 });
    }
    if (u.includes("api.osv.dev")) {
      return new Response(JSON.stringify({ results: [{}] }), { status: 200 });
    }
    return new Response("not found", { status: 404 });
  };

  const env = makeEnv();
  const orgId = await seedOrg(env, { userId: "usr_src", email: "src@example.com" });
  const m = await createMonitor(env, {
    orgId, repoUrl: "https://github.com/o/srcscan", analyzers: ["vuln"],
  });
  env.FETCH = treeFetch({ files: { "package-lock.json": LOCK, "src/app.js": VULN_SRC } });

  const mailbox = makeMailbox();
  const r1 = await runMonitorCheck(env, m.monitorId, {}, { now: NOW, sendTransactional: mailbox.send });

  const after1 = await getMonitorById(env, m.monitorId);
  expect(after1.lastSource && after1.lastSource.total > 0,
    `the sweep stores what the source scan found (got ${JSON.stringify(after1.lastSource)})`);
  expect(after1.lastSource && Array.isArray(after1.lastSource.keys) && after1.lastSource.keys.length > 0,
    "…including fingerprints, which is what makes tomorrow's diff possible");
  expect(after1.lastSource && (after1.lastSource.counts.critical > 0 || after1.lastSource.counts.high > 0),
    `…and the severity mix, so the Code column can grade the worst one (got ${JSON.stringify(after1.lastSource && after1.lastSource.counts)})`);
  expect(after1.lastSource.at === NOW, "…dated, so a stale grade can say how old it is");

  // A first sweep must not mail the whole codebase. Every finding in a repo
  // is "new" the first time it is read, and calling that tonight's regression
  // is false — there was no previous night.
  expect(r1.sourceNewCount === 0 || !mailbox.sent.some((e) => /new code finding/.test(e.subject)),
    `the baseline sweep does not alert on pre-existing code findings (subjects: ${mailbox.sent.map((e) => e.subject).join(" | ")})`);

  // Second sweep, unchanged code: silent.
  const r2 = await runMonitorCheck(env, m.monitorId, {}, { now: NOW + DAY, sendTransactional: mailbox.send });
  expect(r2.status === "no_change", `unchanged source is no_change (got ${r2.status})`);

  // Third sweep: a new vulnerable line appears. THIS is the alert.
  const WORSE = VULN_SRC + "\napp.get(\"/x\", (req, res) => res.redirect(req.query.next));\n";
  env.FETCH = treeFetch({ files: { "package-lock.json": LOCK, "src/app.js": WORSE } });
  const before = mailbox.sent.length;
  const r3 = await runMonitorCheck(env, m.monitorId, {}, { now: NOW + 2 * DAY, sendTransactional: mailbox.send });
  expect(r3.sourceNewCount >= 1,
    `a newly-introduced finding is reported as new (got ${r3.sourceNewCount})`);
  expect(mailbox.sent.length > before && /code finding/.test(mailbox.sent[mailbox.sent.length - 1].subject),
    `…and the subject names it (got "${mailbox.sent.length > before ? mailbox.sent[mailbox.sent.length - 1].subject : "no email"}")`);

  // The email is the one surface that must not carry the matched line.
  const body = mailbox.sent[mailbox.sent.length - 1];
  expect(/src\/app\.js:/.test(body.text),
    "the email names file and line, which is enough to act on");
  expect(!/req\.query\.next/.test(body.text) && !/req\.query\.next/.test(body.html),
    "…and never the source line itself — an alert is broadcast and retained, and a snippet is the customer's code");
}

{
  // An unreadable repository must never grade as clean code. This is the
  // whole reason `source.status` exists rather than an empty findings list.
  const env = makeEnv();
  const orgId = await seedOrg(env, { userId: "usr_dark", email: "dark@example.com" });
  const m = await createMonitor(env, {
    orgId, repoUrl: "https://github.com/o/dark", analyzers: ["vuln"],
  });
  env.FETCH = makeMultiFetch({ vulns: [], repoFiles: {} });
  const res = await runMonitorCheck(env, m.monitorId, {}, { now: NOW, sendTransactional: makeMailbox().send });

  const skip = res.skips.find((s) => s.analyzer === "source");
  expect(skip && skip.reason === "source_unreadable",
    `an unreadable source records a skip (got ${JSON.stringify(skip)})`);
  const after = await getMonitorById(env, m.monitorId);
  expect(after.lastSource === null,
    "…and stores NO baseline, so the cell reads 'not measured' rather than zero findings");
}

{
  // A truncated baseline cannot be diffed. If last night stored 500 of 700
  // fingerprints, the 200 it dropped are absent from the set and would all be
  // reported tonight as brand-new criticals — an alert storm produced
  // entirely by our own cap, on a codebase where nothing changed.
  const { diffSourceFindings, MAX_SOURCE_BASELINE_KEYS } = await import("../src/monitors/analyzers.js");
  const findings = Array.from({ length: MAX_SOURCE_BASELINE_KEYS + 50 }, (_, i) => ({
    fingerprint: `fp${i}`, severity: "high",
  }));

  const first = diffSourceFindings(findings, null);
  expect(first.isBaseline && first.shouldAlert === false,
    "a first scan is a baseline and never alerts");
  expect(first.truncated === true && first.currentKeys.length === MAX_SOURCE_BASELINE_KEYS,
    `an oversized scan stores the cap and records that it was capped (got ${first.currentKeys.length})`);

  const second = diffSourceFindings(findings, {
    keys: first.currentKeys, truncated: true, total: findings.length, counts: {},
  });
  expect(second.isBaseline === true && second.shouldAlert === false,
    "a TRUNCATED baseline re-baselines instead of reporting the overflow as new");

  // The ordinary case still diffs.
  const small = findings.slice(0, 3);
  const base = diffSourceFindings(small, null);
  const grew = diffSourceFindings(
    small.concat([{ fingerprint: "brand-new", severity: "critical" }]),
    { keys: base.currentKeys, truncated: false, total: 3, counts: {} });
  expect(grew.newFindings.length === 1 && grew.newFindings[0].fingerprint === "brand-new",
    `an untruncated baseline reports exactly what is new (got ${grew.newFindings.length})`);
}

// ---------------------------------------------------------------------------
console.log("\na sweep survives a database that is behind on migrations\n");
// ---------------------------------------------------------------------------
//
// Migrations here are applied BY HAND, on purpose, so there is always a window
// where the deployed Worker writes a column the database does not have yet.
//
// Unguarded, that window was not a degraded feature. D1 raises "no such
// column", the UPDATE throws, and the sweep dies before recording anything —
// so the organisation loses its DEPENDENCY alert too, the baseline stays
// frozen, and the queue retries the same failure every night. A diagnostic
// column taking the whole audit down with it is the wrong trade in every
// direction, and this pins that it cannot happen again for any future column.
{
  const env = makeEnv();
  // Roll the database back behind two migrations, exactly as production sits
  // between a deploy and a `wrangler d1 execute`.
  await env.DB.prepare("ALTER TABLE monitors DROP COLUMN last_source_json").run();
  await env.DB.prepare("ALTER TABLE monitors DROP COLUMN last_cost_json").run();

  const orgId = await seedOrg(env, { userId: "usr_mig", email: "mig@example.com" });
  const m = await createMonitor(env, {
    orgId, repoUrl: "https://github.com/o/behind", analyzers: ["vuln"],
  });

  const recorded = await recordMonitorRun(env, m.monitorId, {
    ranAt: NOW, resultHash: "h", advisoryIds: ["GHSA-x"],
    severities: { critical: 1, high: 0, medium: 0, low: 0 },
    source: { total: 3, counts: { critical: 1 }, keys: ["a"], truncated: false, at: NOW },
    cost:   { currentSpend: 100, totalSavingsPct: 5, suggestions: 1, at: NOW },
  });

  expect(Array.isArray(recorded.droppedColumns) && recorded.droppedColumns.length === 2,
    `the write reports which columns were missing (got ${JSON.stringify(recorded && recorded.droppedColumns)})`);
  expect(recorded.droppedColumns.includes("last_source_json") &&
         recorded.droppedColumns.includes("last_cost_json"),
    "…naming them, so an operator knows which migration to run");

  // The whole point: everything the database CAN hold was still written.
  const after = await getMonitorById(env, m.monitorId);
  expect(after.lastRunAt === NOW && JSON.stringify(after.lastAdvisoryIds) === '["GHSA-x"]',
    `the advisory baseline still lands (ranAt ${after.lastRunAt}, ids ${JSON.stringify(after.lastAdvisoryIds)})`);
  expect(after.lastSeverities && after.lastSeverities.critical === 1,
    "…and so does the severity mix the scorecard grades from");

  // A real error must still propagate. A safety net that swallows everything
  // is the silent failure it was built to prevent.
  let threw = false;
  try {
    await recordMonitorRun({ DB: { prepare() { throw new Error("D1_ERROR: database is locked"); } } },
      m.monitorId, { ranAt: NOW, resultHash: "h", advisoryIds: [] });
  } catch { threw = true; }
  expect(threw, "a non-schema failure still throws rather than being swallowed");
}

// ===========================================================================
console.log("\na provider that priced nothing is not the cheapest provider\n");
// ===========================================================================
{
  // engine.js sums an empty lineItems array to 0, so "could not price a single
  // resource" and "genuinely free" arrive at every consumer as the same number.
  // byProvider is ranked by that number and the first entry wins — on the
  // scorecard cell, on the nightly watch chip, and in the alert diff. Before
  // this split, the provider that knew LEAST always won all three.
  const providers = [
    { providerId: "aws",          providerName: "AWS",          estimatedTotalMicroUsd: 0, lineItems: [] },
    { providerId: "digitalocean", providerName: "DigitalOcean", estimatedTotalMicroUsd: 12_340_000,
      lineItems: [{ estimatedCostMicroUsd: 12_340_000 }] },
  ];
  const { byProvider, unpriced } = splitPricedProviders(providers);

  expect(!("aws" in byProvider),
    "a provider with no line items is kept out of byProvider entirely");
  expect(unpriced.length === 1 && unpriced[0] === "aws",
    "and is named as unpriced, because 'we could not read it' is a fact worth keeping");
  expect(byProvider.digitalocean === 12_340_000 && Object.keys(byProvider).length === 1,
    "the provider that actually priced something is the only one left to rank");

  // The exact ranking every consumer performs. This is the assertion that
  // fails if the split is reverted.
  const cheapest = Object.entries(byProvider).sort((a, b) => a[1] - b[1])[0];
  expect(cheapest && cheapest[0] === "digitalocean",
    "so the cheapest provider is one with a price, not one with no information");

  // A real zero is not the same thing and must survive. A provider that priced
  // a free tier produced a line item; only the empty list is disqualifying.
  const free = splitPricedProviders([
    { providerId: "fly", estimatedTotalMicroUsd: 0, lineItems: [{ estimatedCostMicroUsd: 0 }] },
  ]);
  expect(free.byProvider.fly === 0 && free.unpriced.length === 0,
    "a measured zero still counts — line items are the test, not the total");
}

console.log("");
if (failures === 0) {
  console.log("\x1b[32m  all monitor tests passed\x1b[0m\n");
  process.exit(0);
} else {
  console.log(`\x1b[31m  ${failures} monitor test(s) failed\x1b[0m\n`);
  process.exit(1);
}
