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
  MONITOR_ANALYZERS, setMonitorAnalyzers,
} from "../src/monitors/_store.js";
import { scorecardHandler, SCORECARD_COLUMNS } from "../src/handlers/scorecard.js";
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

// ---------------------------------------------------------------------------
console.log("\na skipped analyzer is never graded as a zero\n");
// ---------------------------------------------------------------------------
// The scorecard reported "Architecture 0 — No findings in the last sweep" for
// a repository whose X-ray had never read a single file. On `no_manifests`
// the sweep records an EMPTY baseline on purpose, so a repo that later gains
// a manifest baselines from nothing — and an empty array is indistinguishable
// from "we looked and found none". A zero that cannot be trusted poisons
// every other number in the grid.
{
  const env = makeEnv();
  await seedOrg(env, "org_sk", [{ userId: "u_sk", email: "sk@acme.test", role: "owner" }]);
  const m = await createMonitor(env, {
    orgId: "org_sk", repoUrl: "https://github.com/acme/noman", branch: "main",
    createdBy: "u_sk", analyzers: ["vuln", "arch", "estimate", "algo"],
  });

  // Exactly what a sweep writes when every secondary analyzer declines: an
  // empty arch baseline, plus the skip list migration 0022 added.
  await recordMonitorRun(env, m.monitorId, {
    ranAt: NOW, resultHash: "h", advisoryIds: [],
    severities: { critical: 0, high: 0, medium: 0, low: 0 },
    archKeys: [],
    skips: [
      { analyzer: "arch",     reason: "no_manifests" },
      { analyzer: "estimate", reason: "no_compose" },
      { analyzer: "algo",     reason: "no_config" },
    ],
  });

  const body = await (await scorecardHandler(authed("u_sk"), env)).json();
  const row  = body.rows.find((r) => /noman/.test(r.repo));
  expect(Boolean(row), "the monitored repo appears in the scorecard");

  expect(row.cells.architecture.kind === "unmeasured",
    `a skipped X-ray reads as unmeasured, not a grade (got ${row.cells.architecture.kind})`);
  expect(row.cells.architecture.value === null,
    `…and carries no number at all (got ${JSON.stringify(row.cells.architecture.value)})`);
  expect(/manifests/i.test(row.cells.architecture.note || ""),
    `…and says why, in the same words the analyzer panel uses (got "${row.cells.architecture.note}")`);
  expect(row.cells.cost.kind === "unmeasured" && row.cells.complexity.kind === "unmeasured",
    "the estimator and optimizer get the same treatment — one rule, not three");

  // Security genuinely ran: its zero is a measurement and must survive.
  expect(row.cells.security.kind === "grade",
    `an analyzer that DID run keeps its grade (got ${row.cells.security.kind})`);

  // A monitor swept before 0022 has null skips — unknown, not empty. It must
  // keep its old rendering rather than claim every analyzer ran.
  const legacy = await createMonitor(env, {
    orgId: "org_sk", repoUrl: "https://github.com/acme/legacy", branch: "main",
    createdBy: "u_sk", analyzers: ["vuln", "arch"],
  });
  await recordMonitorRun(env, legacy.monitorId, {
    ranAt: NOW, resultHash: "h2", advisoryIds: [], archKeys: ["a|speed|rule"],
  });
  const body2 = await (await scorecardHandler(authed("u_sk"), env)).json();
  const legacyRow = body2.rows.find((r) => /legacy/.test(r.repo));
  expect(legacyRow.cells.architecture.kind === "grade" &&
         legacyRow.cells.architecture.value === "1",
    "a pre-0022 sweep with real findings still grades normally");
}


// ---------------------------------------------------------------------------
console.log("\nevery analyzer you can schedule has a column, and every empty cell has a fix\n");
// ---------------------------------------------------------------------------
//
// The cloud-spend analyzer shipped complete — a nightly pass, a CI gate, a
// dashboard card, runs in the feed — and the scorecard had no column for it,
// because the grid grades from stored results and the sweep deliberately
// stored none. So the grid silently described a four-analyzer product while
// the monitors screen offered five, and the column labelled "Cost" was the
// compose-file ESTIMATOR: a projection from list prices, sitting under the
// word a reader takes to mean their bill.
//
// The column list is checked against MONITOR_ANALYZERS rather than a literal,
// so the sixth analyzer added to the sweep fails here until it is visible.
{
  // COVERAGE, not bijection. The original form of this test asserted a
  // one-to-one map, which was true when it was written and became wrong the
  // moment the vuln analyzer produced two separately-actionable answers:
  // third-party advisories and findings in the repository's own code. What
  // has to hold is that no schedulable analyzer is INVISIBLE, and that no
  // column grades an analyzer that does not exist — both directions of
  // "nothing silently disappears", without forbidding a second column on an
  // analyzer that genuinely earns one.
  const columnAnalyzers = new Set(SCORECARD_COLUMNS.map((c) => c.analyzer));
  const missing = [...MONITOR_ANALYZERS].filter((a) => !columnAnalyzers.has(a));
  expect(missing.length === 0,
    `every schedulable analyzer has at least one column${
      missing.length ? " — invisible: " + missing.join(", ") : ` (${[...columnAnalyzers].sort().join(", ")})`}`);
  const orphans = [...columnAnalyzers].filter((a) => !MONITOR_ANALYZERS.includes(a));
  expect(orphans.length === 0,
    `no column grades an analyzer that does not exist${orphans.length ? " — orphaned: " + orphans.join(", ") : ""}`);

  const labels = SCORECARD_COLUMNS.map((c) => c.label);
  expect(new Set(labels).size === labels.length,
    `no two columns share a label (${labels.join(" | ")})`);
  expect(new Set(SCORECARD_COLUMNS.map((c) => c.id)).size === SCORECARD_COLUMNS.length,
    "…and no two share an id, which is what the row cells are keyed on");
  expect(!labels.includes("Cost"),
    "and neither money column is called just \"Cost\" — one is a quote, the other is the bill");
  // The same trap, one release later: "Security" over a column that scores
  // only third-party packages let a clean dependency tree read as a secure
  // repository.
  expect(!labels.includes("Security"),
    "and no column is called just \"Security\" — dependencies and your own code are graded apart");
}

{
  const env = makeEnv();
  await seedOrg(env, "org_sp", [{ userId: "u_sp", email: "sp@acme.test", role: "owner" }]);

  // A repo whose committed cost export was read: a real figure to grade.
  const spender = await createMonitor(env, {
    orgId: "org_sp", repoUrl: "https://github.com/acme/spender", branch: "main",
    createdBy: "u_sp", analyzers: ["vuln", "cost"],
  });
  await recordMonitorRun(env, spender.monitorId, {
    ranAt: NOW, resultHash: "h", advisoryIds: [],
    severities: { critical: 0, high: 0, medium: 0, low: 0 },
    cost: { currentSpend: 12_400, totalSavingsPct: 25, suggestions: 3, at: NOW },
  });

  // A repo watching spend that has produced no figure and recorded no skip.
  const waiting = await createMonitor(env, {
    orgId: "org_sp", repoUrl: "https://github.com/acme/waiting", branch: "main",
    createdBy: "u_sp", analyzers: ["vuln", "cost"],
  });
  await recordMonitorRun(env, waiting.monitorId, {
    ranAt: NOW, resultHash: "h", advisoryIds: [],
    severities: { critical: 0, high: 0, medium: 0, low: 0 },
    skips: [{ analyzer: "cost", reason: "no_cur" }],
  });

  const body = await (await scorecardHandler(authed("u_sp"), env)).json();
  expect(body.columns.some((c) => c.id === "spend"),
    `the payload carries the spend column (${body.columns.map((c) => c.id).join(",")})`);

  const spendRow = body.rows.find((r) => /spender/.test(r.repo));
  expect(spendRow.cells.spend.kind === "grade" && /12,400/.test(spendRow.cells.spend.value),
    `a read export grades as the monthly total (got ${spendRow.cells.spend.value})`);
  // Ranked on WASTE, not on size: the most expensive repo you own is not a
  // problem if none of that spend is avoidable.
  expect(spendRow.cells.spend.rank === 3100,
    `…ranked by the recoverable dollars, not the bill (got ${spendRow.cells.spend.rank})`);
  expect(/3 suggestion/.test(spendRow.cells.spend.note),
    `…and says how many suggestions produced that figure (got "${spendRow.cells.spend.note}")`);

  // The estimator column must not have been quietly renamed into this one.
  expect(spendRow.cells.cost.kind === "off",
    "the Infra cost column stays its own analyzer — a monitor watching spend is not estimating");

  const waitRow = body.rows.find((r) => /waiting/.test(r.repo));
  expect(waitRow.cells.spend.kind === "unmeasured",
    `an unnamed CUR reads as not measured (got ${waitRow.cells.spend.kind})`);
  expect(/algosize\.budget\.json/.test(waitRow.cells.spend.fix || ""),
    `…and names the file to change (got "${waitRow.cells.spend.fix}")`);
  expect(waitRow.cells.spend.value === null,
    "…and never a zero, which would read as a repository that costs nothing to run");
}

// ---------------------------------------------------------------------------
console.log("\nan empty cell says whose move it is\n");
// ---------------------------------------------------------------------------
//
// Every blank on this grid was already true and still a dead end. "No compose
// file was found in this repository" leaves a reader with no idea whether the
// next step is theirs or ours — and for the sandbox, the previous wording
// actively sent them to check a config file in which nothing was wrong.
{
  const env = makeEnv();
  await seedOrg(env, "org_fx", [{ userId: "u_fx", email: "fx@acme.test", role: "owner" }]);
  const m = await createMonitor(env, {
    orgId: "org_fx", repoUrl: "https://github.com/acme/blank", branch: "main",
    createdBy: "u_fx", analyzers: ["vuln", "arch", "estimate", "algo"],
  });
  await recordMonitorRun(env, m.monitorId, {
    ranAt: NOW, resultHash: "h", advisoryIds: [],
    severities: { critical: 0, high: 0, medium: 0, low: 0 },
    archKeys: [],
    skips: [
      { analyzer: "estimate", reason: "no_compose" },
      { analyzer: "algo",     reason: "sandbox_not_configured" },
      { analyzer: "arch",     reason: "github_throttled" },
    ],
  });

  const row = (await (await scorecardHandler(authed("u_fx"), env)).json())
    .rows.find((r) => /blank/.test(r.repo));

  expect(/docker-compose/.test(row.cells.cost.fix || ""),
    `the estimator's blank names the file to commit (got "${row.cells.cost.fix}")`);
  expect(/ours/.test(row.cells.complexity.fix || "") &&
         !/optimizer\.config\.json/.test(row.cells.complexity.fix || ""),
    `an unconfigured sandbox says the work is OURS (got "${row.cells.complexity.fix}")`);
  // A throttle clears on its own. Inventing an instruction for a condition the
  // reader cannot act on is how a grid teaches people to ignore its advice.
  expect(row.cells.architecture.fix === null,
    `a self-clearing skip carries no fix at all (got "${row.cells.architecture.fix}")`);
  expect(/rate-limited/i.test(row.cells.architecture.note || ""),
    "…while still saying what happened");
}

// ---------------------------------------------------------------------------
console.log("\nan architecture zero carries the evidence behind it\n");
// ---------------------------------------------------------------------------
//
// "0 · No findings in the last sweep" was the same sentence for a sweep that
// mapped forty services and cleared them and one that parsed a single file.
// A number a reader cannot check is a number they eventually stop reading.
{
  const env = makeEnv();
  await seedOrg(env, "org_ev", [{ userId: "u_ev", email: "ev@acme.test", role: "owner" }]);

  const scoped = await createMonitor(env, {
    orgId: "org_ev", repoUrl: "https://github.com/acme/scoped", branch: "main",
    createdBy: "u_ev", analyzers: ["vuln", "arch"],
  });
  await recordMonitorRun(env, scoped.monitorId, {
    ranAt: NOW, resultHash: "h", advisoryIds: [],
    severities: { critical: 0, high: 0, medium: 0, low: 0 },
    archKeys: [], skips: [],
    archScope: { services: 37, files: 42, complete: true, at: NOW },
  });

  // A row swept before migration 0023 has no scope. It must keep its old
  // wording rather than assert a scope of zero services.
  const legacy = await createMonitor(env, {
    orgId: "org_ev", repoUrl: "https://github.com/acme/oldscope", branch: "main",
    createdBy: "u_ev", analyzers: ["vuln", "arch"],
  });
  await recordMonitorRun(env, legacy.monitorId, {
    ranAt: NOW, resultHash: "h", advisoryIds: [],
    severities: { critical: 0, high: 0, medium: 0, low: 0 },
    archKeys: [], skips: [],
  });

  const rows = (await (await scorecardHandler(authed("u_ev"), env)).json()).rows;
  const s = rows.find((r) => /scoped/.test(r.repo));
  const l = rows.find((r) => /oldscope/.test(r.repo));

  expect(s.cells.architecture.kind === "grade" && s.cells.architecture.value === "0",
    "a measured zero is still a grade — the scope adds evidence, it never removes the number");
  expect(/37 services/.test(s.cells.architecture.note),
    `…and the note says what was read (got "${s.cells.architecture.note}")`);
  expect(!/services/.test(l.cells.architecture.note),
    `a pre-0023 row falls back to the old wording (got "${l.cells.architecture.note}")`);
}

// ---------------------------------------------------------------------------
console.log("\nswitching cloud spend off drops the figure with it\n");
// ---------------------------------------------------------------------------
//
// Spend keeps no diff baseline, so it was tempting to leave the column alone
// on toggle-off. But a figure from whenever the analyzer was last enabled is
// worse than none: it sits on the grid as this month's bill forever.
{
  const env = makeEnv();
  await seedOrg(env, "org_cl", [{ userId: "u_cl", email: "cl@acme.test", role: "owner" }]);
  const m = await createMonitor(env, {
    orgId: "org_cl", repoUrl: "https://github.com/acme/toggler", branch: "main",
    createdBy: "u_cl", analyzers: ["vuln", "cost", "arch"],
  });
  await recordMonitorRun(env, m.monitorId, {
    ranAt: NOW, resultHash: "h", advisoryIds: [],
    cost: { currentSpend: 900, totalSavingsPct: 10, suggestions: 1, at: NOW },
    archKeys: [], archScope: { services: 4, files: 4, complete: true, at: NOW },
  });
  expect((await getMonitorById(env, m.monitorId)).lastCost !== null, "the figure is stored");

  await setMonitorAnalyzers(env, "org_cl", m.monitorId, ["vuln"]);
  const after = await getMonitorById(env, m.monitorId);
  expect(after.lastCost === null, "switching cloud spend off clears the stored figure");
  expect(after.lastArchScope === null,
    "…and switching the X-ray off clears its scope, the same as its keys");
}

// ---------------------------------------------------------------------------
console.log("\na clean dependency tree is not a secure repository\n");
// ---------------------------------------------------------------------------
//
// The scorecard graded one half of the vuln analyzer's output. `Security`
// scored the advisory list, so a repository with no vulnerable packages and a
// critical SQL injection in its own code rendered "A · 0" — a top grade on a
// codebase the scanner had actually READ and found exploitable. That is worse
// than the unmeasured-as-clean bug 0022 fixed: nothing was missing, the
// answer was in hand and withheld from the cell it would have made look bad.
{
  const env = makeEnv();
  await seedOrg(env, "org_code", [{ userId: "u_code", email: "code@acme.test", role: "owner" }]);

  const risky = await createMonitor(env, {
    orgId: "org_code", repoUrl: "https://github.com/acme/risky", branch: "main",
    createdBy: "u_code", analyzers: ["vuln"],
  });
  await recordMonitorRun(env, risky.monitorId, {
    ranAt: NOW, resultHash: "h", advisoryIds: [],
    // No advisories at all: a perfect dependency tree.
    severities: { critical: 0, high: 0, medium: 0, low: 0, unknown: 0 },
    source: {
      total: 3,
      counts: { critical: 1, high: 2, medium: 0, low: 0, info: 0 },
      keys: ["a", "b", "c"], truncated: false, at: NOW,
    },
  });

  const body = await (await scorecardHandler(authed("u_code"), env)).json();
  expect(body.columns.some((c) => c.id === "code"),
    `the payload carries the code column (${body.columns.map((c) => c.id).join(",")})`);
  expect(body.columns.find((c) => c.id === "security").label === "Dependencies",
    "…and the advisory column says what it actually grades");

  const row = body.rows.find((r) => /risky/.test(r.repo));
  expect(row.cells.security.kind === "grade" && /^A/.test(row.cells.security.value),
    `the dependency grade is still an A — it is accurate about packages (got ${row.cells.security.value})`);
  expect(row.cells.code.kind === "grade" && row.cells.code.value === "C · 3",
    `…and the code cell reports the critical beside it (got ${row.cells.code.value})`);
  expect(/critical/.test(row.cells.code.note),
    `…naming the worst severity, which is how a finding list is triaged (got "${row.cells.code.note}")`);

  // Ranked on SEVERITY first. A repository with forty low findings must not
  // outrank one with a single critical, or the board sorts by noise.
  const noisy = await createMonitor(env, {
    orgId: "org_code", repoUrl: "https://github.com/acme/noisy", branch: "main",
    createdBy: "u_code", analyzers: ["vuln"],
  });
  await recordMonitorRun(env, noisy.monitorId, {
    ranAt: NOW, resultHash: "h", advisoryIds: [],
    severities: { critical: 0, high: 0, medium: 0, low: 0, unknown: 0 },
    source: { total: 40, counts: { critical: 0, high: 0, medium: 0, low: 40, info: 0 },
              keys: ["x"], truncated: false, at: NOW },
  });
  const rows2 = (await (await scorecardHandler(authed("u_code"), env)).json()).rows;
  const riskyRank = rows2.find((r) => /risky/.test(r.repo)).cells.code.rank;
  const noisyRank = rows2.find((r) => /noisy/.test(r.repo)).cells.code.rank;
  expect(riskyRank > noisyRank,
    `one critical outranks forty lows (${riskyRank} vs ${noisyRank})`);
}

{
  const env = makeEnv();
  await seedOrg(env, "org_c2", [{ userId: "u_c2", email: "c2@acme.test", role: "owner" }]);

  // Measured and genuinely clean: a real zero, and it must GRADE, not read as
  // pending — the scan ran, read files, and found nothing.
  const clean = await createMonitor(env, {
    orgId: "org_c2", repoUrl: "https://github.com/acme/clean", branch: "main",
    createdBy: "u_c2", analyzers: ["vuln"],
  });
  await recordMonitorRun(env, clean.monitorId, {
    ranAt: NOW, resultHash: "h", advisoryIds: [],
    severities: { critical: 0, high: 0, medium: 0, low: 0, unknown: 0 },
    source: { total: 0, counts: {}, keys: [], truncated: false, at: NOW },
  });

  // Unreadable: the sweep could not fetch the source. This must NOT render as
  // a zero — it is the same distinction the whole grid is built on.
  const dark = await createMonitor(env, {
    orgId: "org_c2", repoUrl: "https://github.com/acme/dark", branch: "main",
    createdBy: "u_c2", analyzers: ["vuln"],
  });
  await recordMonitorRun(env, dark.monitorId, {
    ranAt: NOW, resultHash: "h", advisoryIds: [],
    severities: { critical: 0, high: 0, medium: 0, low: 0, unknown: 0 },
    skips: [{ analyzer: "source", reason: "source_unreadable" }],
  });

  // Swept before migration 0024: unknown, not clean.
  const legacy = await createMonitor(env, {
    orgId: "org_c2", repoUrl: "https://github.com/acme/legacy", branch: "main",
    createdBy: "u_c2", analyzers: ["vuln"],
  });
  await recordMonitorRun(env, legacy.monitorId, {
    ranAt: NOW, resultHash: "h", advisoryIds: [],
    severities: { critical: 0, high: 0, medium: 0, low: 0, unknown: 0 },
  });

  const rows = (await (await scorecardHandler(authed("u_c2"), env)).json()).rows;
  const cleanCell  = rows.find((r) => /clean/.test(r.repo)).cells.code;
  const darkCell   = rows.find((r) => /dark/.test(r.repo)).cells.code;
  const legacyCell = rows.find((r) => /legacy/.test(r.repo)).cells.code;

  expect(cleanCell.kind === "grade" && cleanCell.value === "0",
    `a scan that read the code and found nothing is a real zero (got ${cleanCell.kind}/${cleanCell.value})`);
  expect(darkCell.kind === "unmeasured" && darkCell.value === null,
    `an unreadable repository is NOT a zero (got ${darkCell.kind}/${darkCell.value})`);
  expect(/could not be read/.test(darkCell.note || ""),
    `…and says why (got "${darkCell.note}")`);
  expect(legacyCell.kind === "pending" && legacyCell.value === null,
    `a pre-0024 sweep is pending, never clean (got ${legacyCell.kind}/${legacyCell.value})`);
}

console.log("");
if (failures) {
  console.log(`\x1b[31m  ${failures} monitor-routing test(s) failed\x1b[0m`);
  process.exit(1);
}
console.log("\x1b[32m  all monitor-routing tests passed\x1b[0m");
