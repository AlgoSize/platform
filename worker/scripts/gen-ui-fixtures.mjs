// Generate UI fixtures by calling the REAL handlers.
//
// The responsive and spacing audits need every screen to render populated,
// which means feeding the frontend payloads shaped exactly like production's.
// Hand-written fixtures do that until the day someone renames a field, at
// which point the audit quietly starts measuring error panels instead of UI
// — which is precisely what happened the first time these were written by
// hand: five Account sections were rendering "could not be displayed" and
// every spacing check passed anyway.
//
// So the fixtures are not written, they are DERIVED: seed the D1 stub with
// the same migrations production runs, call each handler through its real
// entry point, and dump what comes back. A renamed field breaks this
// generator or changes its output, and either way somebody finds out.
//
// Run with:  node scripts/gen-ui-fixtures.mjs
// Writes:    tests/fixtures/ui-payloads.json

import { writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { makeD1 } from "./_d1-stub.mjs";

import { getAccountHandler, listSessionsHandler, listLoginsHandler,
         getNotificationsHandler } from "../src/handlers/account.js";
import { billingSummaryHandler, billingInvoicesHandler } from "../src/handlers/billing.js";
import { listApiKeysHandler } from "../src/handlers/keys.js";
import { getOrgHandler } from "../src/handlers/org.js";
import { getReferralsHandler } from "../src/handlers/referrals.js";
import { listMonitorsHandler } from "../src/handlers/monitors.js";
import { scorecardHandler } from "../src/handlers/scorecard.js";
import { monitorRouteHandler } from "../src/handlers/monitors.js";
import { meHandler } from "../src/handlers/me.js";
import { listRunsHandler } from "../src/handlers/runs.js";
import { createMonitor, recordMonitorRun } from "../src/monitors/_store.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dirname, "..", "..", "tests", "fixtures");

const NOW = Math.floor(Date.now() / 1000) - 120;
const USER = "usr_fixture";
const ORG  = "org_fixture";
const EMAIL = "dana@acme.test";

function makeKV() {
  const m = new Map();
  return { async get(k) { return m.has(k) ? m.get(k) : null; },
           async put(k, v) { m.set(k, v); },
           async delete(k) { m.delete(k); },
           async list() { return { keys: [...m.keys()].map((name) => ({ name })) }; } };
}

const env = {
  JWT_SECRET: "fixture-jwt-secret-that-is-at-least-32-chars",
  SITE_ORIGIN: "https://algosize.com",
  COOKIE_NAME: "algosize_session",
  ADMIN_EMAILS: EMAIL,
  SESSIONS: makeKV(), USERS: makeKV(), DB: makeD1(),
};

function req(path, { method = "GET", body, params } = {}) {
  const r = new Request("https://algosize.com" + path, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  r.user = { userId: USER, email: EMAIL, subStatus: null };
  if (params) r.params = params;
  return r;
}

async function seed() {
  await env.DB.prepare(
    `INSERT INTO users (user_id, email, stripe_customer_id, plan, sub_status, active_org_id, created_at, updated_at)
     VALUES (?, ?, NULL, 'free', NULL, ?, ?, ?)`,
  ).bind(USER, EMAIL, ORG, NOW - 86400 * 40, NOW).run();
  await env.DB.prepare("UPDATE users SET display_name = ?, avatar_url = NULL WHERE user_id = ?")
    .bind("Dana Reyes", USER).run();

  await env.DB.prepare(
    `INSERT INTO organisations (org_id, name, stripe_customer_id, plan, sub_status, seats_purchased, created_at, updated_at)
     VALUES (?, ?, NULL, 'free', NULL, 1, ?, ?)`,
  ).bind(ORG, "Acme Corporation Holdings International", NOW - 86400 * 40, NOW).run();
  await env.DB.prepare("INSERT INTO memberships (org_id, user_id, role, created_at) VALUES (?, ?, 'owner', ?)")
    .bind(ORG, USER, NOW - 86400 * 40).run();

  // A second member, so the Team table has more than one row and the
  // alert-routing card has more than one address.
  await env.DB.prepare(
    `INSERT INTO users (user_id, email, stripe_customer_id, plan, sub_status, active_org_id, created_at, updated_at)
     VALUES (?, ?, NULL, 'free', NULL, ?, ?, ?)`,
  ).bind("usr_second", "engineering-oncall@acme.test", ORG, NOW - 86400 * 10, NOW).run();
  await env.DB.prepare("INSERT INTO memberships (org_id, user_id, role, created_at) VALUES (?, ?, 'member', ?)")
    .bind(ORG, "usr_second", NOW - 86400 * 10).run();

  // Two monitors: one fully graded and stale, one that has never swept. The
  // pair is what makes the scorecard show every cell kind at once.
  const m1 = await createMonitor(env, {
    orgId: ORG, repoUrl: "https://github.com/acme/api-gateway-with-a-long-name",
    branch: "main", createdBy: USER, analyzers: ["vuln", "arch", "estimate", "algo"],
    runAtHour: 14,
  });
  await recordMonitorRun(env, m1.monitorId, {
    ranAt: NOW - 3600, resultHash: "h1",
    advisoryIds: ["GHSA-a/npm/lodash", "GHSA-b/npm/axios"],
    severities: { critical: 1, high: 1, medium: 0, low: 0, unknown: 0 },
    delta: { total: 2, counts: { critical: 1, high: 1 }, at: NOW - 3600 },
    archKeys: ["k1", "k2", "k3"],
    estimate: { byProvider: { hetzner: 12_400_000, aws: 41_000_000 }, at: NOW - 3600 },
    algo: { byName: { groupByOwner: "O(n²)", lookup: "O(1)" }, at: NOW - 3600 },
  });
  await createMonitor(env, {
    orgId: ORG, repoUrl: "https://github.com/acme/billing-worker",
    branch: "main", createdBy: USER, analyzers: ["vuln"],
  });

  // One finished run, so the runs feed and the report link have something.
  // Columns per migrations/0007 (`id`/`analyzer`, not `run_id`/`type`), and
  // created_at in MILLISECONDS, which is what the runs pipeline stores.
  await env.DB.prepare(
    `INSERT INTO runs (id, user_id, org_id, source, analyzer, input_json, result_json, ms, headline, created_at)
     VALUES (?, ?, ?, 'ci', 'vuln', ?, ?, 412.5, ?, ?)`,
  ).bind("run_fixture", USER, ORG,
         JSON.stringify({ repoUrl: "https://github.com/acme/api-gateway-with-a-long-name" }),
         JSON.stringify({
           advisories: [
             { id: "GHSA-a", package: "lodash", ecosystem: "npm", severity: "critical",
               installedVersion: "4.17.11", fixedIn: "4.17.21",
               summary: "Prototype pollution in lodash" },
             { id: "GHSA-b", package: "axios", ecosystem: "npm", severity: "high",
               installedVersion: "0.21.0", fixedIn: "0.21.2",
               summary: "SSRF in axios" },
           ],
           summary: { securityScore: 39, grade: "F", totalIssues: 2,
                      counts: { critical: 1, high: 1, medium: 0, low: 0, unknown: 0 },
                      worstSeverity: "critical", sourceFindings: 0,
                      dependencyAdvisories: 2, remediation: [], complete: true },
         }),
         "F · 2 advisories, worst critical",
         (NOW - 3600) * 1000).run();
}

async function body(res) {
  try { return await res.json(); } catch { return { __status: res.status }; }
}

const run = async () => {
  await seed();

  const out = {};
  const cap = async (path, handler, opts) => {
    try { out[path] = await body(await handler(req(path, opts), env, null)); }
    catch (err) { out[path] = { __generatorError: String(err && err.message) }; }
  };

  await cap("/api/me", meHandler);
  await cap("/api/account", getAccountHandler);
  await cap("/api/account/profile", getAccountHandler);   // same payload, alias route
  await cap("/api/account/sessions", listSessionsHandler);
  await cap("/api/account/logins", listLoginsHandler);
  await cap("/api/account/notifications", getNotificationsHandler);
  await cap("/api/billing/summary", billingSummaryHandler);
  await cap("/api/billing/invoices", billingInvoicesHandler);
  await cap("/api/keys", listApiKeysHandler);
  await cap("/api/org", getOrgHandler);
  await cap("/api/account/org", getOrgHandler);   // alias the Account page uses
  await cap("/api/referrals", getReferralsHandler);
  await cap("/api/monitors", listMonitorsHandler);
  await cap("/api/monitors/route", monitorRouteHandler);
  await cap("/api/scorecard", scorecardHandler);
  await cap("/api/runs", listRunsHandler);

  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, "ui-payloads.json"), JSON.stringify(out, null, 2) + "\n");

  const broken = Object.entries(out).filter(([, v]) => v && v.__generatorError);
  for (const [k, v] of broken) console.log(`  ! ${k}: ${v.__generatorError}`);
  console.log(`  wrote ${Object.keys(out).length} payloads to tests/fixtures/ui-payloads.json` +
              (broken.length ? ` (${broken.length} could not be generated)` : ""));
};

run().catch((e) => { console.error(e); process.exit(1); });
