// Alert routing, monitor health and the scorecard (D-8).
//
// Three behaviours that used to be either absent or quietly wrong, tested
// against the real D1 schema through the migration stub:
//
//   ROUTING   the sweep mailed one hardcoded address — the org's billing
//             email — regardless of anybody's notification preferences. The
//             monitor-alerts toggle was a setting that reported saved and
//             changed nothing, and every member except the billing owner got
//             nothing however it was set.
//   HEALTH    a run was recorded only when the audit SUCCEEDED, so a monitor
//             that failed every night rendered forever as "baseline pending"
//             — the same state a healthy monitor shows on its first day.
//   SCORECARD grading needs the severity mix, and the baseline stored only
//             identity keys. Six lows and one critical plus five lows are
//             the same count and a very different repository.
//
// Run with:  node scripts/test-monitor-routing.mjs

import { resolveMonitorRoute, describeRoute, monitorSlackText } from "../src/monitors/routing.js";
import { postToSlack } from "../src/slack.js";
import {
  createMonitor, getMonitorById, recordMonitorRun, recordMonitorAttempt,
  setMonitorSchedule, normalizeHour, isDue, cronSweepsHourly, DEFAULT_SWEEP_HOUR,
} from "../src/monitors/_store.js";
import { scorecardHandler } from "../src/handlers/scorecard.js";
import { runMonitorNowHandler, setMonitorScheduleHandler } from "../src/handlers/monitors.js";
import { writeNotificationPrefs } from "../src/notifications.js";
import { makeD1 } from "./_d1-stub.mjs";

let failures = 0;
const ok   = (msg) => console.log(`  \x1b[32m✓\x1b[0m ${msg}`);
const fail = (msg) => { console.log(`  \x1b[31m✗\x1b[0m ${msg}`); failures++; };
const expect = (cond, label) => (cond ? ok(label) : fail(label));
const group  = (name) => console.log(`\n\x1b[1m${name}\x1b[0m\n`);

const NOW = 1_700_000_000;

function makeKV() {
  const store = new Map();
  return {
    async get(k) { return store.has(k) ? store.get(k) : null; },
    async put(k, v) { store.set(k, v); },
    async delete(k) { store.delete(k); },
  };
}

function makeEnv() {
  return {
    JWT_SECRET: "routing-test-jwt-secret-32-or-more-characters",
    SITE_ORIGIN: "https://algosize.com",
    SESSIONS: makeKV(), USERS: makeKV(), DB: makeD1(),
  };
}

async function seedOrg(env, orgId, members, { slackWebhookUrl = null } = {}) {
  await env.DB.prepare(
    `INSERT INTO organisations (org_id, name, stripe_customer_id, plan, sub_status, seats_purchased, created_at, updated_at)
     VALUES (?, ?, ?, 'paid', 'active', 5, ?, ?)`,
  ).bind(orgId, orgId, `cus_${orgId}`, NOW, NOW).run();
  if (slackWebhookUrl) {
    await env.DB.prepare("UPDATE organisations SET slack_webhook_url = ? WHERE org_id = ?")
      .bind(slackWebhookUrl, orgId).run();
  }
  for (const m of members) {
    await env.DB.prepare(
      `INSERT INTO users (user_id, email, stripe_customer_id, plan, sub_status, active_org_id, created_at, updated_at)
       VALUES (?, ?, NULL, 'paid', 'active', ?, ?, ?)`,
    ).bind(m.userId, m.email, orgId, NOW, NOW).run();
    await env.DB.prepare(
      "INSERT INTO memberships (org_id, user_id, role, created_at) VALUES (?, ?, ?, ?)",
    ).bind(orgId, m.userId, m.role || "member", NOW).run();
  }
}

function authed(userId, { method = "GET", url = "https://algosize.com/api/scorecard", body, params } = {}) {
  const req = new Request(url, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  req.user = { userId, email: `${userId}@example.com` };
  if (params) req.params = params;
  return req;
}

// ===========================================================================
group("who actually receives a monitor alert");
// ===========================================================================
{
  const env = makeEnv();
  await seedOrg(env, "org_a", [
    { userId: "u_owner", email: "owner@acme.test", role: "owner" },
    { userId: "u_dev",   email: "dev@acme.test",   role: "member" },
    { userId: "u_pm",    email: "pm@acme.test",    role: "member" },
  ]);

  // Nobody has touched a preference, so everybody gets the catalog default —
  // monitor:email is on. Before this existed only owner@ was ever mailed.
  let route = await resolveMonitorRoute(env, "org_a");
  const addrs = route.emails.map((e) => e.email).sort();
  expect(addrs.length === 3 && addrs[0] === "dev@acme.test",
    `every member is mailed by default, not just the billing owner (got ${addrs.join(", ")})`);
  expect(route.muted === false, "and the route is not muted");

  // One person opts out. The opt-out must actually take effect — this was
  // the setting that reported saved and changed nothing.
  await writeNotificationPrefs(env, "u_pm", { "monitor:email": false });
  route = await resolveMonitorRoute(env, "org_a");
  expect(route.emails.every((e) => e.email !== "pm@acme.test"),
    "switching monitor email off removes that member from the send");
  expect(route.emails.length === 2, "…and leaves everyone else alone");

  // Everybody opts out. That is a choice, not an outage, and it gets its own
  // reported state so the run feed can say "found something, delivered
  // nowhere" instead of implying a failure.
  await writeNotificationPrefs(env, "u_owner", { "monitor:email": false });
  await writeNotificationPrefs(env, "u_dev",   { "monitor:email": false });
  route = await resolveMonitorRoute(env, "org_a");
  expect(route.muted === true && route.reason === "all_channels_off",
    `an org that silenced every channel reports muted, not an error (reason: ${route.reason})`);
}

// ===========================================================================
group("Slack is delivered once per org, and only when it can be");
// ===========================================================================
{
  const env = makeEnv();
  await seedOrg(env, "org_b", [
    { userId: "u1", email: "a@b.test", role: "owner" },
    { userId: "u2", email: "c@d.test", role: "member" },
  ]);

  // Slack is off by default, so a configured webhook alone delivers nothing.
  let route = await resolveMonitorRoute(env, "org_b");
  expect(route.slack.enabled === false && route.slack.configured === false,
    "no webhook and no subscriber → Slack is not enabled");

  await writeNotificationPrefs(env, "u1", { "monitor:slack": true });
  await writeNotificationPrefs(env, "u2", { "monitor:slack": true });
  route = await resolveMonitorRoute(env, "org_b");
  expect(route.slack.enabled === false && route.slack.subscribers.length === 2,
    "subscribers with no webhook are recorded but deliver nothing");
  const desc = describeRoute(route);
  const slackRow = desc.channels.find((c) => c.id === "slack");
  expect(/no webhook is configured/i.test(slackRow.note),
    "and the card says exactly why, rather than showing the toggle as on");

  await env.DB.prepare("UPDATE organisations SET slack_webhook_url = ? WHERE org_id = ?")
    .bind("https://hooks.slack.com/services/T/B/x", "org_b").run();
  route = await resolveMonitorRoute(env, "org_b");
  expect(route.slack.enabled === true && route.slack.url !== null,
    "webhook + at least one subscriber → Slack is enabled");
  expect(route.slack.subscribers.length === 2,
    "two subscribers, but the webhook posts into one channel — see routing.js");

  // The webhook is a bearer credential. It must never reach a browser.
  const payload = JSON.stringify(describeRoute(route));
  expect(!payload.includes("hooks.slack.com"),
    "describeRoute never echoes the webhook URL back to the client");
}

// ===========================================================================
group("the Slack sender never throws, whatever Slack does");
// ===========================================================================
{
  const env = makeEnv();
  const url = "https://hooks.slack.com/services/T/B/x";

  const okRes = await postToSlack(env, null, url, { text: "hi" },
    async () => new Response("ok", { status: 200 }));
  expect(okRes.sent === true, "a 200 reports sent");

  const gone = await postToSlack(env, null, url, { text: "hi" },
    async () => new Response("no_service", { status: 404 }));
  expect(gone.sent === false && gone.reason === "webhook_rejected",
    "a 4xx is a dead webhook — actionable, and reported as its own reason");

  const down = await postToSlack(env, null, url, { text: "hi" },
    async () => new Response("", { status: 503 }));
  expect(down.sent === false && down.reason === "slack_unavailable",
    "a 5xx is today's outage, distinct from a dead webhook");

  const boom = await postToSlack(env, null, url, { text: "hi" },
    async () => { throw new Error("socket hang up"); });
  expect(boom.sent === false && boom.reason === "network",
    "a thrown fetch resolves rather than propagating into the sweep");

  const bad = await postToSlack(env, null, "https://evil.test/hook", { text: "hi" },
    async () => new Response("ok", { status: 200 }));
  expect(bad.sent === false && bad.reason === "invalid_webhook",
    "a URL that is not a Slack webhook is refused without being called");

  const baseline = monitorSlackText({
    repoUrl: "https://github.com/acme/api", branch: "main",
    newCount: 6, counts: {}, isBaseline: true, dashboardUrl: "https://algosize.com/dashboard/",
  });
  expect(/baseline recorded/i.test(baseline) && !/6 new/i.test(baseline),
    "a baseline run says baseline, never '6 new' for advisories that were always there");
}

// ===========================================================================
group("health: a failing monitor stops looking like a new one");
// ===========================================================================
{
  const env = makeEnv();
  await seedOrg(env, "org_c", [{ userId: "u_c", email: "c@acme.test", role: "owner" }]);
  const m = await createMonitor(env, {
    orgId: "org_c", repoUrl: "https://github.com/acme/api", branch: "main",
    createdBy: "u_c", analyzers: ["vuln"],
  });

  expect(m.lastStatus === null && m.lastRunAt === null,
    "a brand-new monitor has no status and no run — the only honest 'pending'");

  // A permanent failure. Baselines must be untouched, and last_run_at must
  // NOT advance: "when did this last produce a result" is what that answers.
  await recordMonitorAttempt(env, m.monitorId, {
    status: "failed", error: "no_lockfile", at: NOW,
  });
  let after = await getMonitorById(env, m.monitorId);
  expect(after.lastStatus === "failed" && after.lastError === "no_lockfile",
    "a failed attempt is recorded with its reason");
  expect(after.lastRunAt === null && after.lastAdvisoryIds === null,
    "…and neither the run time nor the baseline moved");
  expect(after.lastAttemptAt === NOW,
    "the attempt time is recorded separately, which is what measures staleness");

  // A successful run advances everything.
  await recordMonitorRun(env, m.monitorId, {
    ranAt: NOW + 100, resultHash: "h1", advisoryIds: ["GHSA-a/npm/x"],
    severities: { critical: 0, high: 1, medium: 0, low: 0, unknown: 0 },
  });
  after = await getMonitorById(env, m.monitorId);
  expect(after.lastStatus === "ok" && after.lastRunAt === NOW + 100,
    "a completed run records ok and advances last_run_at");
  expect(after.lastSeverities && after.lastSeverities.high === 1,
    "…and stores the severity mix the scorecard grades");

  // A transient skip afterwards. The baseline from the good run must survive
  // — this is what stops the next successful sweep reporting the whole world
  // as new after a GitHub outage.
  await recordMonitorAttempt(env, m.monitorId, {
    status: "skipped", error: "github_throttled", at: NOW + 200,
  });
  after = await getMonitorById(env, m.monitorId);
  expect(after.lastStatus === "skipped" && after.lastRunAt === NOW + 100,
    "a skip marks the monitor stale without rewinding its last result");
  expect(after.lastAdvisoryIds && after.lastAdvisoryIds.length === 1,
    "…and the diff baseline is exactly where the last good sweep left it");
}

// ===========================================================================
group("time-of-day scheduling");
// ===========================================================================
{
  expect(normalizeHour(0) === 0 && normalizeHour(23) === 23,
    "0 and 23 are both valid hours");
  expect(normalizeHour(24) === null && normalizeHour(-1) === null &&
         normalizeHour(3.5) === null && normalizeHour("x") === null,
    "out-of-range and non-integer values normalize to null rather than being clamped");

  const env = makeEnv();
  await seedOrg(env, "org_d", [{ userId: "u_d", email: "d@acme.test", role: "owner" }]);
  const m = await createMonitor(env, {
    orgId: "org_d", repoUrl: "https://github.com/acme/w", createdBy: "u_d", runAtHour: 14,
  });
  expect(m.runAtHour === 14, "the hour round-trips through create");

  // A monitor that has never run is due whatever the hour, so a new monitor
  // still gets its baseline on the next sweep rather than waiting a day.
  expect(isDue(m, NOW) === true, "a monitor with no previous run is always due");

  // A real timestamp two days after the last run, landing at the requested
  // UTC hour. Built from whole days so the hour is exactly right rather than
  // whatever NOW happens to be.
  const ran = { ...m, lastRunAt: NOW - 86_400 * 2 };
  const dayStart = Math.floor((NOW + 86_400 * 3) / 86_400) * 86_400;
  expect(isDue(ran, dayStart + 14 * 3600) === true,
    "a monitor with an hour is due during that hour");
  expect(isDue(ran, dayStart + 9 * 3600) === false,
    "…and held back outside it");

  // Changing the schedule must never clear a baseline: a schedule edit that
  // wiped one would turn into a silent "everything is new again" email.
  await recordMonitorRun(env, m.monitorId, {
    ranAt: NOW, resultHash: "h", advisoryIds: ["GHSA-x/npm/y"],
  });
  await setMonitorSchedule(env, "org_d", m.monitorId, { runAtHour: 5 });
  const after = await getMonitorById(env, m.monitorId);
  expect(after.runAtHour === 5 && after.lastAdvisoryIds.length === 1,
    "setMonitorSchedule changes the hour and keeps the baseline");

  // An hourly sweep must not move anybody's existing delivery time. A monitor
  // that never chose an hour falls back to the hour the daily cron used to
  // fire at — without that, a 20-hour minimum gap on an hourly tick would
  // walk a "daily" monitor right around the clock.
  const noHour = { ...m, runAtHour: null, lastRunAt: NOW - 86_400 * 2 };
  expect(isDue(noHour, dayStart + DEFAULT_SWEEP_HOUR * 3600, { sweepsHourly: true }) === true,
    "on an hourly sweep an unset hour still means 03:00 UTC");
  expect(isDue(noHour, dayStart + 11 * 3600, { sweepsHourly: true }) === false,
    "…and not every hour of the day");
  expect(isDue(noHour, dayStart + 11 * 3600) === true,
    "on a once-a-day sweep an unset hour means 'this sweep', exactly as before 0017");

  expect(cronSweepsHourly("0 * * * *") === true && cronSweepsHourly("0 */4 * * *") === true,
    "an hourly or every-N-hours cron reads as more than once a day");
  expect(cronSweepsHourly("0 3 * * *") === false && cronSweepsHourly(null) === false,
    "a single-hour cron — and anything unreadable — reads as once a day, the safe answer");

  const res = await setMonitorScheduleHandler(
    authed("u_d", {
      method: "POST", url: "https://algosize.com/api/monitors/x/schedule",
      body: { runAtHour: 99 }, params: { id: m.monitorId },
    }), env);
  const body = await res.json();
  expect(res.status === 400 && body.error === "invalid_hour",
    "the endpoint refuses an out-of-range hour rather than silently clamping it");
}

// ===========================================================================
group("the scorecard grades only what was measured");
// ===========================================================================
{
  const env = makeEnv();
  await seedOrg(env, "org_e", [{ userId: "u_e", email: "e@acme.test", role: "owner" }]);

  // One monitor with every analyzer on and a full set of baselines.
  const full = await createMonitor(env, {
    orgId: "org_e", repoUrl: "https://github.com/acme/full", branch: "main",
    createdBy: "u_e", analyzers: ["vuln", "arch", "estimate", "algo"],
  });
  await recordMonitorRun(env, full.monitorId, {
    ranAt: NOW, resultHash: "h", advisoryIds: ["A/npm/x", "B/npm/y"],
    severities: { critical: 1, high: 0, medium: 0, low: 1, unknown: 0 },
    archKeys: ["k1", "k2", "k3"],
    estimate: { byProvider: { hetzner: 12_400_000, aws: 41_000_000 }, at: NOW },
    algo: { byName: { groupByOwner: "O(n²)", lookup: "O(1)" }, at: NOW },
  });

  // One monitor running the audit alone, never swept.
  await createMonitor(env, {
    orgId: "org_e", repoUrl: "https://github.com/acme/fresh", branch: "main",
    createdBy: "u_e", analyzers: ["vuln"],
  });

  const res  = await scorecardHandler(authed("u_e"), env);
  const data = await res.json();
  expect(res.status === 200 && data.rows.length === 2, "one row per monitored repo");

  const fullRow  = data.rows.find((r) => r.repo === "acme/full");
  const freshRow = data.rows.find((r) => r.repo === "acme/fresh");

  expect(fullRow.cells.security.kind === "grade" && /^F · 2$/.test(fullRow.cells.security.value),
    `one critical caps the grade at F regardless of the count (got ${fullRow.cells.security.value})`);
  expect(fullRow.cells.cost.kind === "grade" && fullRow.cells.cost.value.includes("12"),
    `cost reports the cheapest provider (got ${fullRow.cells.cost.value})`);
  expect(fullRow.cells.complexity.kind === "grade" && fullRow.cells.complexity.value === "O(n²)",
    "complexity reports the WORST measured grade, not the first");
  expect(fullRow.cells.architecture.kind === "grade" && fullRow.cells.architecture.value === "3",
    "architecture reports how many findings are open");

  // The whole point: a repo nobody has swept is not a clean repo.
  expect(freshRow.cells.security.kind === "pending",
    "a never-swept repo reports pending, never a passing grade");
  expect(freshRow.cells.cost.kind === "off" && freshRow.cells.complexity.kind === "off",
    "an analyzer that is switched off reads as 'off', which is a different problem from 'pending'");

  // Staleness is a property of the sweep, so every cell inherits it.
  await recordMonitorAttempt(env, full.monitorId, {
    status: "skipped", error: "github_throttled", at: NOW + 500,
  });
  const stale = await (await scorecardHandler(authed("u_e"), env)).json();
  const staleRow = stale.rows.find((r) => r.repo === "acme/full");
  expect(staleRow.cells.security.kind === "stale" && staleRow.cells.security.value === "F · 2",
    "after a skipped sweep the value is kept and labelled stale, not hidden and not shown as current");
}

// ===========================================================================
group("running a monitor on demand");
// ===========================================================================
{
  const env = makeEnv();
  const queued = [];
  env.SCAN_QUEUE = { send: async (body) => { queued.push(body); } };
  await seedOrg(env, "org_f", [{ userId: "u_f", email: "f@acme.test", role: "owner" }]);
  const m = await createMonitor(env, {
    orgId: "org_f", repoUrl: "https://github.com/acme/r", createdBy: "u_f",
  });

  const res = await runMonitorNowHandler(
    authed("u_f", { method: "POST", url: "https://algosize.com/api/monitors/x/run", params: { id: m.monitorId } }),
    env);
  const body = await res.json();
  expect(res.status === 202 && body.queued === true,
    "a manual run answers 202 accepted — the run is queued, not finished");
  expect(queued.length === 1 && queued[0].monitorId === m.monitorId && queued[0].manual === true,
    "…on the same queue the cron sweep uses, flagged as manual");

  // A paused monitor must not run: it would advance the baseline the owner
  // paused to preserve, so resuming later would report nothing new when
  // plenty had changed.
  await env.DB.prepare("UPDATE monitors SET paused_at = ? WHERE monitor_id = ?")
    .bind(NOW, m.monitorId).run();
  const refused = await runMonitorNowHandler(
    authed("u_f", { method: "POST", url: "https://algosize.com/api/monitors/x/run", params: { id: m.monitorId } }),
    env);
  const refusedBody = await refused.json();
  expect(refused.status === 409 && refusedBody.error === "monitor_paused",
    "a paused monitor refuses the manual run rather than quietly advancing its baseline");
  expect(queued.length === 1, "…and nothing extra reached the queue");
}

console.log("");
if (failures) {
  console.log(`\x1b[31m  ${failures} monitor-routing test(s) failed\x1b[0m`);
  process.exit(1);
}
console.log("\x1b[32m  all monitor-routing tests passed\x1b[0m");
