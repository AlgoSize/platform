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
import { ciSnippetHandler, ciOptimizerSnippetHandler,
         ciEstimateSnippetHandler, ciArchitectureSnippetHandler } from "../src/handlers/ci.js";
import { getReferralsHandler } from "../src/handlers/referrals.js";
import { listMonitorsHandler } from "../src/handlers/monitors.js";
import { scorecardHandler } from "../src/handlers/scorecard.js";
import { monitorRouteHandler } from "../src/handlers/monitors.js";
import { meHandler } from "../src/handlers/me.js";
import { listRunsHandler } from "../src/handlers/runs.js";
import { createMonitor, recordMonitorRun } from "../src/monitors/_store.js";
import { getRunHandler } from "../src/handlers/runs.js";
import { analyzeArchitecture } from "../src/analyzers/architecture.js";
import { persistRun } from "../src/handlers/runs.js";
import { aggregateOf } from "../src/handlers/estimate_history.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dirname, "..", "..", "tests", "fixtures");

// A fixed instant, 2026-08-01T00:00:00Z.
//
// The whole clock is frozen to it, not just this constant. Handlers stamp
// their own timestamps from Date.now() — a referral window, a run's
// created_at, a membership date — and chasing each one individually is a
// losing game: the next handler to add a timestamp reintroduces the churn.
// Freezing the source means regenerating with no code change produces a
// byte-identical file, so the one field that actually moved is the only
// thing in the diff.
const NOW = 1_785_542_400;

const FROZEN_MS = NOW * 1000;
Date.now = () => FROZEN_MS;
const RealDate = Date;
globalThis.Date = class extends RealDate {
  constructor(...args) { super(...(args.length ? args : [FROZEN_MS])); }
  static now() { return FROZEN_MS; }
};
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

  // One run per analyzer, so the report renderer is exercised for every
  // layout rather than only the one that existed first. The architecture
  // result comes from the REAL analyzer — a hand-written graph would drift
  // from what the renderer is given.
  let archResult;
  try {
    archResult = analyzeArchitecture({
      files: [
        { path: "src/index.js", content: "import { a } from './api.js';\nimport { b } from './db.js';\n" },
        { path: "src/api.js",   content: "import { b } from './db.js';\nimport { c } from './index.js';\n" },
        { path: "src/db.js",    content: "export const b = 1;\n" },
      ],
    });
  } catch { archResult = null; }
  if (archResult) {
    await persistRun(env, {
      orgId: ORG, userId: USER, analyzer: "arch", source: "manual",
      input: { fileCount: 3, paths: ["src/index.js", "src/api.js", "src/db.js"] },
      result: archResult, ms: 18.2,
    });
  }

  await persistRun(env, {
    orgId: ORG, userId: USER, analyzer: "algo", source: "ci", ms: 640.1,
    input: { name: "groupByOwner", ceiling: "O(n log n)" },
    result: {
      bigO: { label: "O(n²)", confidence: "high" },
      wallTimeMs: 612.4,
      samples: [
        { n: 100, ms: 0.42 }, { n: 200, ms: 1.61 },
        { n: 400, ms: 6.38 }, { n: 800, ms: 25.9 },
      ],
      notes: "Timings taken on a shared runner; treat a one-bucket move as noise.",
    },
  });

  // Through aggregateOf(), so the stored shape is the one the recorder
  // actually produces rather than a hand-written guess at it. A fixture that
  // carries fields the recorder strips would let the report render data that
  // never reaches it in production.
  await persistRun(env, {
    orgId: ORG, userId: USER, analyzer: "estimate", source: "manual", ms: 31.7,
    input: { inputType: "compose", resourceCount: 3 },
    result: aggregateOf({
      normalizedSpec: { name: "acme-stack", resources: [
        { name: "api", quantity: 3, cpuMilli: 500, memoryMilliGiB: 1024, storageMilliGiB: 0 },
        { name: "worker", quantity: 1, cpuMilli: 1000, memoryMilliGiB: 2048, storageMilliGiB: 0 },
        { name: "postgres", quantity: 1, cpuMilli: 2000, memoryMilliGiB: 4096, storageMilliGiB: 100000 },
      ] },
      providers: [
        { providerId: "hetzner", providerName: "Hetzner Cloud", currency: "USD",
          estimatedTotalMicroUsd: 12_400_000, confidence: "medium" },
        { providerId: "aws", providerName: "Amazon Web Services", currency: "USD",
          estimatedTotalMicroUsd: 41_000_000,
          lowerBoundMicroUsd: 36_000_000, upperBoundMicroUsd: 48_500_000,
          confidence: "low" },
      ],
      warnings: ["No duration was declared, so one month was assumed.",
                 "Storage class was not specified; standard block storage was priced."],
      duration: "1mo", currency: "USD", pricingCatalogVersion: "2026-08", inputType: "compose",
      disclaimer: "List prices against the submitted specification. Not a quote, and not your bill.",
    }),
  });

  await persistRun(env, {
    orgId: ORG, userId: USER, analyzer: "cost", source: "manual", ms: 88.4,
    input: { file: "cur-2026-08.csv" },
    result: {
      totalSavingsPct: 23,
      suggestions: [
        { title: "Rightsize 4 over-provisioned EC2 instances", service: "EC2",
          monthlySavingsUsd: 412.9, severity: "high",
          detail: "Four m5.2xlarge instances averaged 8% CPU across the billing period.",
          action: "Move to m5.large and re-measure after a full week." },
        { title: "Delete 1.2 TB of unattached EBS volumes", service: "EBS",
          monthlySavingsUsd: 96.0, severity: "medium",
          detail: "Eleven volumes have had no attachment for the whole period.",
          action: "Snapshot, then delete." },
      ],
    },
  });
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
  await cap("/api/ci/snippet", ciSnippetHandler);
  await cap("/api/ci/optimizer-snippet", ciOptimizerSnippetHandler);
  await cap("/api/ci/estimate-snippet", ciEstimateSnippetHandler);
  await cap("/api/ci/architecture-snippet", ciArchitectureSnippetHandler);
  await cap("/api/monitors", listMonitorsHandler);
  await cap("/api/monitors/route", monitorRouteHandler);
  await cap("/api/scorecard", scorecardHandler);
  await cap("/api/runs", listRunsHandler);

  // One report payload per analyzer, keyed by run id, so the visual audit can
  // open each report layout.
  const runs = await env.DB.prepare(
    "SELECT id, analyzer FROM runs ORDER BY created_at DESC").all();
  out.__runs = (runs.results || []).map((r) => ({ id: r.id, analyzer: r.analyzer }));
  for (const r of (runs.results || [])) {
    await cap(`/api/runs/${r.id}`, getRunHandler, { params: { id: r.id } });
  }

  // Every generated identifier is random or time-derived, so a no-op refresh
  // would rewrite dozens of ids and bury the one field that actually moved —
  // and people stop reading a diff that is noise by default. Each family is
  // remapped to a stable name before the file is written.
  let json = JSON.stringify(out, null, 2);

  // Run ids: `<ms>_<hex>`. Keyed by analyzer, which is all a consumer cares about.
  for (const r of out.__runs || []) json = json.split(r.id).join(`run_${r.analyzer}`);

  // Monitor ids: random hex, numbered in list order.
  const monitors = (out["/api/monitors"] && out["/api/monitors"].monitors) || [];
  monitors.forEach((m, i) => { json = json.split(m.monitorId).join(`mon_${i + 1}`); });

  // Referral code: random suffix, and it appears inside the link too.
  const code = out["/api/referrals"] && out["/api/referrals"].code;
  if (code) json = json.split(code).join("acme-referral-code");

  // With the clock frozen every run shares one created_at, so the feed's
  // ORDER is a tie the database breaks arbitrarily. Sorted by analyzer so the
  // list is stable; the timestamps are already identical and honest about it.
  const shaped = JSON.parse(json);
  const feed = shaped["/api/runs"];
  if (feed && Array.isArray(feed.items)) {
    feed.items.sort((a, b) => (a.analyzer < b.analyzer ? -1 : a.analyzer > b.analyzer ? 1 : 0));
  }
  json = JSON.stringify(shaped, null, 2);

  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, "ui-payloads.json"), json + "\n");

  const broken = Object.entries(out).filter(([, v]) => v && v.__generatorError);
  for (const [k, v] of broken) console.log(`  ! ${k}: ${v.__generatorError}`);
  console.log(`  wrote ${Object.keys(out).length} payloads to tests/fixtures/ui-payloads.json` +
              (broken.length ? ` (${broken.length} could not be generated)` : ""));
};

run().catch((e) => { console.error(e); process.exit(1); });
