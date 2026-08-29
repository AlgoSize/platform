// The monitored half of every tool page (D-9).
//
// The monitors screen could tell you a repo was watched and that something
// changed; the tool pages could not then SHOW you the thing that changed.
// Each had a manual bench and nothing else, so "3 new architecture findings"
// in an email led to a page where you had to re-upload your own codebase by
// hand. GET /api/monitors/:id/result/:analyzer closes that.
//
// Two properties in here are load-bearing and both fail SILENTLY if broken,
// which is why they are tested rather than trusted:
//
//   1. Inspecting NEVER advances a baseline. If it did, opening the X-ray
//      would consume the delta tomorrow's email was going to report — you
//      would look at your findings and the next morning's email would say
//      nothing had changed.
//   2. "Could not read the repo" never renders as an empty result. An empty
//      architecture graph and "no manifests found" look identical on screen
//      and mean opposite things.
//
// Run with:  node scripts/test-monitor-inspect.mjs

import { inspectMonitor, INSPECTABLE } from "../src/monitors/inspect.js";
import { monitorResultHandler } from "../src/handlers/monitors.js";
import { createMonitor, getMonitorById, recordMonitorRun } from "../src/monitors/_store.js";
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
    JWT_SECRET: "inspect-test-jwt-secret-32-or-more-characters",
    SITE_ORIGIN: "https://algosize.com",
    SESSIONS: makeKV(), USERS: makeKV(), DB: makeD1(),
  };
}

async function seedOrg(env, orgId, userId, email) {
  await env.DB.prepare(
    `INSERT INTO organisations (org_id, name, stripe_customer_id, plan, sub_status, seats_purchased, created_at, updated_at)
     VALUES (?, ?, ?, 'paid', 'active', 5, ?, ?)`,
  ).bind(orgId, orgId, `cus_${orgId}`, NOW, NOW).run();
  await env.DB.prepare(
    `INSERT INTO users (user_id, email, stripe_customer_id, plan, sub_status, active_org_id, created_at, updated_at)
     VALUES (?, ?, NULL, 'paid', 'active', ?, ?, ?)`,
  ).bind(userId, email, orgId, NOW, NOW).run();
  await env.DB.prepare(
    "INSERT INTO memberships (org_id, user_id, role, created_at) VALUES (?, ?, 'owner', ?)",
  ).bind(orgId, userId, NOW).run();
}

function authed(userId, monitorId, analyzer) {
  const req = new Request(
    `https://algosize.com/api/monitors/${monitorId}/result/${analyzer}`, { method: "GET" });
  req.user = { userId, email: `${userId}@example.com` };
  req.params = { id: monitorId, analyzer };
  return req;
}

/** A GitHub raw-content fetch stub: path substring → file body. */
function fakeGithub(files) {
  return async (url) => {
    const u = String(url);
    for (const name of Object.keys(files)) {
      if (u.includes(name)) {
        return new Response(files[name], { status: 200 });
      }
    }
    return new Response("Not Found", { status: 404 });
  };
}

const COMPOSE = [
  "services:",
  "  api:",
  "    image: node:20",
  "    ports: ['8080:8080']",
  "  db:",
  "    image: postgres:16",
  "    ports: ['5432:5432']",
  "",
].join("\n");

// ===========================================================================
group("the analyzer set is closed");
// ===========================================================================
{
  expect(INSPECTABLE.length === 4 &&
         ["vuln", "arch", "estimate", "algo"].every((a) => INSPECTABLE.includes(a)),
    `inspectable analyzers are exactly the four a monitor can run (${INSPECTABLE.join(", ")})`);

  const env = makeEnv();
  await seedOrg(env, "org_x", "u_x", "x@acme.test");
  const m = await createMonitor(env, {
    orgId: "org_x", repoUrl: "https://github.com/acme/api", createdBy: "u_x",
    analyzers: ["vuln", "arch"],
  });

  const bogus = await inspectMonitor(env, null, m, "nonsense", fakeGithub({}));
  expect(bogus.status === "unavailable" && bogus.reason === "unknown_analyzer",
    "an unknown analyzer is refused rather than silently treated as one of the four");

  // A monitor only has a baseline for an analyzer it runs. Inspecting one it
  // does not run would show a result with a meaningless "nothing is new".
  const off = await inspectMonitor(env, null, m, "estimate", fakeGithub({}));
  expect(off.status === "not_enabled" && off.reason === "analyzer_off",
    "an analyzer the monitor does not run reports not_enabled, not an empty result");

  const res = await monitorResultHandler(authed("u_x", m.monitorId, "estimate"), env, null);
  const body = await res.json();
  expect(res.status === 200 && body.status === "not_enabled",
    "…and the endpoint answers 200 with that state — the monitor is healthy, the analyzer is just off");
  expect(/switch it on/i.test(body.message || ""),
    "…with a message that names the fix rather than reading as an error");
}

// ===========================================================================
group("a repo that cannot be read never renders as an empty result");
// ===========================================================================
{
  const env = makeEnv();
  await seedOrg(env, "org_y", "u_y", "y@acme.test");
  const m = await createMonitor(env, {
    orgId: "org_y", repoUrl: "https://github.com/acme/bare", createdBy: "u_y",
    analyzers: ["vuln", "arch", "estimate", "algo"],
  });

  // Every fetch 404s: no manifests, no compose, no optimizer config. Handed
  // to the direct calls AND set as env.FETCH — the endpoint call below
  // resolves its fetch from env, and without this it reaches the real
  // network, where a proxy 403 reads as GitHub throttling.
  const empty = fakeGithub({});
  env.FETCH = empty;

  const arch = await inspectMonitor(env, null, m, "arch", empty);
  expect(arch.status === "unavailable" && arch.reason === "no_manifests",
    "an architecture run with nothing to read reports no_manifests, not a graph with zero nodes");
  expect(arch.result === undefined,
    "…and carries no result object at all, so nothing can render it as clean");

  const est = await inspectMonitor(env, null, m, "estimate", empty);
  expect(est.status === "unavailable" && est.reason === "no_compose",
    "an estimate with no compose file reports no_compose, not $0.00/mo");

  const algo = await inspectMonitor(env, null, m, "algo", empty);
  expect(algo.status === "unavailable" && algo.reason === "no_config",
    "an optimizer pass with no config reports no_config, not zero regressions");

  // The endpoint turns each of those into a 200 carrying a sentence — a
  // reason the user can act on, rather than a status code they cannot.
  const res = await monitorResultHandler(authed("u_y", m.monitorId, "arch"), env, null);
  const body = await res.json();
  expect(res.status === 200 && body.status === "unavailable" && body.reason === "no_manifests",
    "the endpoint reports it as a fact about the repo, not as a request failure");
  expect(/no manifests/i.test(body.message || "") && body.message !== body.reason,
    `…explained in a sentence, not just a code (got "${body.message}")`);
  expect(body.result === undefined,
    "…and still ships no result object");
}

// ===========================================================================
group("inspecting NEVER advances a baseline");
// ===========================================================================
{
  const env = makeEnv();
  await seedOrg(env, "org_z", "u_z", "z@acme.test");
  const m = await createMonitor(env, {
    orgId: "org_z", repoUrl: "https://github.com/acme/svc", branch: "main",
    createdBy: "u_z", analyzers: ["vuln", "arch", "estimate"],
  });

  // Give it a baseline from a "sweep", then snapshot every column inspect
  // could plausibly touch.
  await recordMonitorRun(env, m.monitorId, {
    ranAt: NOW, resultHash: "hash-1", advisoryIds: ["GHSA-a/npm/x"],
    severities: { critical: 0, high: 1, medium: 0, low: 0, unknown: 0 },
    archKeys: ["old-key"],
    estimate: { byProvider: { hetzner: 9_000_000 }, at: NOW },
  });
  const before = await getMonitorById(env, m.monitorId);

  const gh = fakeGithub({ "docker-compose.yml": COMPOSE, "compose.yaml": COMPOSE });
  // The handler resolves its fetch from env.FETCH — a stub handed only to
  // inspectMonitor would leave the handler path talking to the real network.
  env.FETCH = gh;

  // Run every inspectable analyzer, including ones that will succeed and
  // produce results DIFFERENT from the stored baseline — the case where a
  // careless implementation would write the new keys back.
  for (const analyzer of ["arch", "estimate"]) {
    await inspectMonitor(env, null, before, analyzer, gh).catch(() => null);
  }
  await monitorResultHandler(authed("u_z", m.monitorId, "arch"), env, null).catch(() => null);
  await monitorResultHandler(authed("u_z", m.monitorId, "estimate"), env, null).catch(() => null);

  const after = await getMonitorById(env, m.monitorId);

  expect(after.lastRunAt === before.lastRunAt,
    "last_run_at is untouched — inspecting is not a run");
  expect(after.lastAttemptAt === before.lastAttemptAt,
    "last_attempt_at is untouched — inspecting is not an attempt either");
  expect(JSON.stringify(after.lastAdvisoryIds) === JSON.stringify(before.lastAdvisoryIds),
    "the advisory baseline is exactly where the sweep left it");
  expect(JSON.stringify(after.lastArchKeys) === JSON.stringify(before.lastArchKeys),
    "the architecture baseline is exactly where the sweep left it");
  expect(JSON.stringify(after.lastEstimate) === JSON.stringify(before.lastEstimate),
    "the estimate baseline is exactly where the sweep left it");
  expect(after.lastResultHash === before.lastResultHash && after.lastStatus === before.lastStatus,
    "the result hash and health are untouched");

  // The property stated as the source rule, so a future edit that adds a
  // write to this module fails here rather than in someone's inbox.
  const src = (await import("node:fs")).readFileSync(
    new URL("../src/monitors/inspect.js", import.meta.url), "utf8");
  expect(!/recordMonitorRun|recordMonitorAttempt|UPDATE monitors|setMonitor/.test(src),
    "monitors/inspect.js contains no write path at all");
}

// ===========================================================================
group("a successful inspection carries the result AND what is new in it");
// ===========================================================================
{
  const env = makeEnv();
  await seedOrg(env, "org_w", "u_w", "w@acme.test");
  const m = await createMonitor(env, {
    orgId: "org_w", repoUrl: "https://github.com/acme/stack", branch: "main",
    createdBy: "u_w", analyzers: ["vuln", "arch", "estimate"],
  });
  const gh = fakeGithub({ "docker-compose.yml": COMPOSE, "compose.yaml": COMPOSE });
  env.FETCH = gh;

  // No baseline yet → this is a baseline read.
  const first = await inspectMonitor(env, null, m, "arch", gh);
  if (first.status !== "ok") {
    fail(`arch inspection should succeed against a compose file (got ${first.status}/${first.reason})`);
  } else {
    ok("an architecture inspection over committed files returns a result");
    expect(first.result && typeof first.result === "object" && "findings" in first.result,
      "…shaped like the manual endpoint's response, so the same renderer draws it");
    expect(first.baseline.isBaseline === true,
      "with no stored baseline it reports isBaseline — the page then shows NO diff affordance");
  }

  // Now store a baseline that shares nothing with the current findings, so
  // every current finding must come back as new.
  await recordMonitorRun(env, m.monitorId, {
    ranAt: NOW, resultHash: "h", advisoryIds: [],
    archKeys: ["a-key-that-no-longer-exists"],
  });
  const reloaded = await getMonitorById(env, m.monitorId);
  const second = await inspectMonitor(env, null, reloaded, "arch", gh);

  if (second.status === "ok") {
    expect(second.baseline.isBaseline === false,
      "with a stored baseline it reports a real comparison");
    expect(Array.isArray(second.delta.newKeys),
      "…and returns which findings are new as keys, not duplicated objects");
    expect(second.delta.resolvedKeys.includes("a-key-that-no-longer-exists"),
      "a finding present last sweep and gone now is reported resolved — the proof that work landed");
  } else {
    fail(`second arch inspection should succeed (got ${second.status}/${second.reason})`);
  }

  // The response dates itself as recomputed, not as the 03:00 snapshot.
  const res = await monitorResultHandler(authed("u_w", m.monitorId, "arch"), env, null);
  const body = await res.json();
  expect(res.status === 200 && typeof body.computedAt === "number",
    "the payload carries computedAt, so the page can say it is showing the repo as it is NOW");
  expect(body.baseline && body.baseline.at === NOW,
    "…alongside the baseline's own timestamp, which is a different fact");
}

// ===========================================================================
group("scoping and not-found");
// ===========================================================================
{
  const env = makeEnv();
  await seedOrg(env, "org_a", "u_a", "a@acme.test");
  await seedOrg(env, "org_b", "u_b", "b@acme.test");
  const mine = await createMonitor(env, {
    orgId: "org_a", repoUrl: "https://github.com/acme/mine", createdBy: "u_a",
  });

  const res = await monitorResultHandler(authed("u_b", mine.monitorId, "vuln"), env, null);
  const body = await res.json();
  expect(res.status === 404 && body.error === "not_found",
    "another organisation's monitor is not readable");

  const bad = await monitorResultHandler(authed("u_a", mine.monitorId, "wat"), env, null);
  const badBody = await bad.json();
  expect(bad.status === 400 && badBody.error === "invalid_analyzer",
    "an unknown analyzer in the path is a 400 naming the valid set");
}

console.log("");
if (failures) {
  console.log(`\x1b[31m  ${failures} monitor-inspect test(s) failed\x1b[0m`);
  process.exit(1);
}
console.log("\x1b[32m  all monitor-inspect tests passed\x1b[0m");
