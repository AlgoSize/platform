// Tests for CI ingestion — Task #P-9.
//
// The five the task named:
//   1. cookie auth is rejected with 401
//   2. a valid key creates a run visible in the run history for the same org
//   3. an oversized lockfile gets 413 with a clear message
//   4. fail_on="critical" passes a run containing only highs
//   5. the snippet endpoint never leaks a real key
//
// Plus the property that decides whether any of this is trustworthy: the
// Worker computes the report from submitted INPUTS. A run cannot report itself
// clean by posting findings, because findings in the body are ignored — there
// is a test that posts a lying payload and checks the stored advisories came
// from the audit rather than from the client.
//
// Run with:  node scripts/test-ci-ingest.mjs

import worker from "../src/index.js";
import { ciRunHandler, ciSnippetHandler, shouldFail, worstSeverityOf, buildWorkflow } from "../src/handlers/ci.js";
import { listRuns, getRun, persistRun } from "../src/handlers/runs.js";
import { createApiKey } from "../src/handlers/_api_keys.js";
import { toSarif } from "../src/analyzers/sarif.js";
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

const NOW = Math.floor(Date.now() / 1000);

/**
 * OSV double. `vulns` maps package name → advisory id, so a fixture can decide
 * exactly which severities come back without reaching the network.
 */
function makeOsvFetch(vulns = []) {
  return async (url) => {
    const u = String(url);
    if (u.includes("querybatch")) {
      return new Response(JSON.stringify({
        results: vulns.map((v) => ({ vulns: [{ id: v.id }] })),
      }), { status: 200 });
    }
    if (u.includes("/v1/vulns/")) {
      const id = decodeURIComponent(u.split("/vulns/")[1]);
      const v = vulns.find((x) => x.id === id);
      if (!v) return new Response("{}", { status: 404 });
      // CVSS vectors chosen so the computed severity is unambiguous.
      const vector = v.severity === "critical"
        ? "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:C/C:H/I:H/A:H"
        : v.severity === "high"
        ? "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:N/A:N"
        : "CVSS:3.1/AV:N/AC:H/PR:L/UI:R/S:U/C:L/I:N/A:N";
      return new Response(JSON.stringify({
        id: v.id,
        summary: `${v.id} in ${v.package}`,
        severity: [{ type: "CVSS_V3", score: vector }],
        affected: [{
          package: { name: v.package, ecosystem: "npm" },
          ranges: [{ type: "ECOSYSTEM", events: [{ introduced: "0" }, { fixed: v.fixedIn || "9.9.9" }] }],
        }],
      }), { status: 200 });
    }
    return new Response("{}", { status: 404 });
  };
}

function makeEnv(overrides = {}) {
  return {
    JWT_SECRET: "ci-ingest-test-jwt-secret-32-or-more-chars",
    SITE_ORIGIN: "https://algosize.com",
    COOKIE_NAME: "algosize_session",
    SESSIONS: makeKV(),
    USERS:    makeKV(),
    DB:       makeD1(),
    FETCH:    makeOsvFetch([]),
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

const LOCKFILE = JSON.stringify({
  lockfileVersion: 3,
  packages: {
    "node_modules/lodash":  { version: "4.17.20" },
    "node_modules/express": { version: "4.17.1" },
  },
});

function ciRequest(body, { key = null, cookie = null } = {}) {
  const headers = { "content-type": "application/json" };
  if (key) headers["Authorization"] = `Bearer ${key}`;
  if (cookie) headers["Cookie"] = `algosize_session=${cookie}`;
  return new Request("https://algosize.com/api/ci/runs", {
    method: "POST", headers, body: JSON.stringify(body),
  });
}

const payload = (over = {}) => ({
  repo: "acme/widgets",
  ref: "refs/heads/main",
  commit_sha: "abc123def456",
  lockfiles: [{ path: "package-lock.json", content: LOCKFILE }],
  ...over,
});

/**
 * Mint a key for an org, the way the dashboard would. `created_by` is NOT NULL
 * in the schema — a key is always minted by a signed-in owner or admin, even
 * though the key itself later authenticates as the org rather than as them.
 */
async function keyFor(env, orgId) {
  const createdBy = orgId.replace(/^org_/, "");
  const { key } = await createApiKey(env, { orgId, name: "CI", createdBy });
  return key;
}

// ---------------------------------------------------------------------------
console.log("\nfail_on thresholds\n");
// ---------------------------------------------------------------------------

{
  expect(shouldFail({ high: 1 }, "high") === true, "fail_on=high fails on a high");
  expect(shouldFail({ critical: 1 }, "high") === true,
    "fail_on=high ALSO fails on a critical — a worse finding must never pass a lower gate");
  expect(shouldFail({ high: 3 }, "critical") === false, "fail_on=critical passes a run containing only highs");
  expect(shouldFail({ critical: 1 }, "critical") === true, "fail_on=critical fails on a critical");
  expect(shouldFail({ low: 9 }, "medium") === false, "fail_on=medium ignores lows");
  expect(shouldFail({ critical: 5 }, "none") === false, "fail_on=none never fails the build");
  expect(shouldFail({}, "high") === false, "a clean run never fails");

  expect(worstSeverityOf({ low: 2, high: 1 }) === "high", "worstSeverity picks the worst present");
  expect(worstSeverityOf({}) === null, "and is null for a clean run");
}

// ---------------------------------------------------------------------------
console.log("\nauthentication — API key only\n");
// ---------------------------------------------------------------------------

{
  // A cookie session must be refused even though requireAuth would accept it.
  const env = makeEnv();
  await seedOrg(env, { userId: "usr_cookie", email: "cookie@example.com" });

  const req = ciRequest(payload());
  req.user = { userId: "usr_cookie", email: "cookie@example.com" };
  req.authMethod = "session";

  const res = await ciRunHandler(req, env, {});
  const body = await res.json();
  expect(res.status === 401, `a cookie session is rejected with 401 (got ${res.status})`);
  expect(body.error === "api_key_required", "with api_key_required");
  expect(/Bearer ask_live_/.test(body.message), "and tells the caller what credential to use");
}

{
  // Through the real router, with no credential at all.
  const env = makeEnv();
  const res = await worker.fetch(ciRequest(payload()), env, {});
  expect(res.status === 401, `no credential → 401 (got ${res.status})`);
}

{
  // A key that isn't ours.
  const env = makeEnv();
  const res = await worker.fetch(ciRequest(payload(), { key: "ask_live_not_real" }), env, {});
  const body = await res.json();
  expect(res.status === 401 && body.reason === "invalid_api_key",
    `an unknown key → 401 invalid_api_key (got ${res.status})`);
}

// ---------------------------------------------------------------------------
console.log("\na valid key creates a run visible to its org\n");
// ---------------------------------------------------------------------------

{
  const env = makeEnv({ FETCH: makeOsvFetch([
    { id: "GHSA-high", package: "lodash", severity: "high", fixedIn: "4.17.21" },
  ]) });
  const orgId = await seedOrg(env, { userId: "usr_ci", email: "ci@example.com" });
  const key = await keyFor(env, orgId);

  const res = await worker.fetch(ciRequest(payload(), { key }), env, {});
  const body = await res.json();

  expect(res.status === 200, `a valid key → 200 (got ${res.status})`);
  expect(typeof body.runId === "string" && body.runId.length > 0, "the response carries a runId");
  // The DASHBOARD viewer, not /api/runs/:id/report. That API route is
  // requireAuth, so the link this gate posts into a pull request answered 401
  // for any reviewer who was not signed in — and rendered the raw API response
  // for anyone who was. A URL in a review thread has to land on a page a person
  // can read, which is the one property asserted here.
  expect(body.reportUrl === `https://algosize.com/dashboard/#/report/${body.runId}`,
    `and a report URL pointing at that run (got ${body.reportUrl})`);
  expect(!/\/api\//.test(body.reportUrl || ""),
    "and never at the API route, which 401s for a signed-out reviewer");
  expect(body.summary && body.summary.high === 1, `the summary counts the advisory (high=${body.summary && body.summary.high})`);
  expect(body.worstSeverity === "high", "worstSeverity is reported");
  expect(body.failed === true, "and the default fail_on=high fails the build");

  // Visible in the ORG's history — the whole point, since no user ran it.
  const history = await listRuns(env, { orgId }, { limit: 10 });
  expect(history.items.length === 1, `the run is in the org's history (got ${history.items.length})`);
  expect(history.items[0].id === body.runId, "and it's the same run");
  expect(history.items[0].source === "ci", "badged as a CI run so the dashboard can filter it");
  expect(history.items[0].analyzer === "vuln", "stored as a vuln run, using the existing read paths");

  // And visible to a MEMBER of that org through their own session scope.
  const asMember = await listRuns(env, { orgId, userId: "usr_ci" }, { limit: 10 });
  expect(asMember.items.length === 1, "a signed-in member of the org sees the CI run in their history");

  // Not visible to a different org.
  const otherOrg = await seedOrg(env, { userId: "usr_other", email: "other@example.com" });
  const theirs = await listRuns(env, { orgId: otherOrg }, { limit: 10 });
  expect(theirs.items.length === 0, "another org does not see it");

  // The stored record carries the CI context.
  const full = await getRun(env, { orgId }, body.runId);
  expect(full && full.result && full.result.ci && full.result.ci.commitSha === "abc123def456",
    "the stored result records which commit it was computed for");
  expect(full && full.userId === null, "with no user attached — a key authenticates as the org");
  expect(full && Array.isArray(full.input.lockfiles) && full.input.lockfiles[0] === "package-lock.json",
    "and stores lockfile PATHS, not the customer's lockfile content");
  expect(!JSON.stringify(full.input).includes("lockfileVersion"),
    "the submitted lockfile body is not retained in run history");
}

{
  // fail_on=critical passes a run containing only highs.
  const env = makeEnv({ FETCH: makeOsvFetch([
    { id: "GHSA-high-1", package: "lodash",  severity: "high" },
    { id: "GHSA-high-2", package: "express", severity: "high" },
  ]) });
  const orgId = await seedOrg(env, { userId: "usr_thr", email: "thr@example.com" });
  const key = await keyFor(env, orgId);

  const res = await worker.fetch(ciRequest(payload({ fail_on: "critical" }), { key }), env, {});
  const body = await res.json();

  expect(res.status === 200, "the run succeeds");
  expect(body.summary.high === 2 && body.summary.critical === 0, `two highs, no criticals (got ${JSON.stringify(body.summary)})`);
  expect(body.failed === false, "fail_on=critical does NOT fail a run containing only highs");
  expect(body.worstSeverity === "high", "though the worst severity is still reported honestly");
}

{
  // The verdict comes from the audit, not from the caller. A payload that
  // claims to be clean must not be able to store itself as clean.
  const env = makeEnv({ FETCH: makeOsvFetch([
    { id: "GHSA-real", package: "lodash", severity: "critical", fixedIn: "4.17.21" },
  ]) });
  const orgId = await seedOrg(env, { userId: "usr_lie", email: "lie@example.com" });
  const key = await keyFor(env, orgId);

  const lying = payload({
    // Everything below is ignored — the Worker recomputes from the lockfile.
    advisories: [], counts: { critical: 0, high: 0, medium: 0, low: 0 },
    summary: { grade: "A", totalIssues: 0 }, failed: false,
  });
  const res = await worker.fetch(ciRequest(lying, { key }), env, {});
  const body = await res.json();

  expect(body.summary.critical === 1,
    `client-submitted findings are ignored; the Worker's own audit stands (critical=${body.summary.critical})`);
  expect(body.failed === true, "so a build cannot mark itself passing by lying in the body");

  const full = await getRun(env, { orgId }, body.runId);
  expect(full.result.advisories.length === 1, "and the stored report holds the computed advisories");
  expect(full.result.summary.grade !== "A", "not the grade the client claimed");
}

// ---------------------------------------------------------------------------
console.log("\npayload limits\n");
// ---------------------------------------------------------------------------

{
  const env = makeEnv();
  const orgId = await seedOrg(env, { userId: "usr_big", email: "big@example.com" });
  const key = await keyFor(env, orgId);

  // One lockfile over the per-file cap (MAX_LOCKFILE_BYTES is 5 MB).
  const huge = "x".repeat(6 * 1024 * 1024);
  const res = await worker.fetch(
    ciRequest(payload({ lockfiles: [{ path: "package-lock.json", content: huge }] }), { key }), env, {},
  );
  const body = await res.json();
  expect(res.status === 413, `an oversized lockfile → 413 (got ${res.status})`);
  expect(body.error === "lockfile_too_large", "with lockfile_too_large");
  expect(/package-lock\.json/.test(body.message), "naming the offending file");
  expect(/KB/.test(body.message) && /limit/.test(body.message),
    `and stating the actual size and the limit (got: ${body.message})`);
}

{
  const env = makeEnv();
  const orgId = await seedOrg(env, { userId: "usr_none", email: "none@example.com" });
  const key = await keyFor(env, orgId);

  const empty = await worker.fetch(ciRequest(payload({ lockfiles: [] }), { key }), env, {});
  expect(empty.status === 400, `an empty lockfile list → 400 (got ${empty.status})`);

  // Unsupported filenames are dropped, and if nothing survives that's a clear 400.
  const unsupported = await worker.fetch(
    ciRequest(payload({ lockfiles: [{ path: "README.md", content: "# hi" }] }), { key }), env, {},
  );
  const body = await unsupported.json();
  expect(unsupported.status === 400 && body.error === "no_supported_lockfiles",
    `only unsupported files → 400 no_supported_lockfiles (got ${unsupported.status})`);

  const badThreshold = await worker.fetch(ciRequest(payload({ fail_on: "catastrophic" }), { key }), env, {});
  expect(badThreshold.status === 400, `an unknown fail_on → 400 (got ${badThreshold.status})`);
}

{
  // A glob that picks up junk alongside a real lockfile still audits the real
  // one — dropping the unsupported file rather than failing the whole run.
  const env = makeEnv({ FETCH: makeOsvFetch([]) });
  const orgId = await seedOrg(env, { userId: "usr_mix", email: "mix@example.com" });
  const key = await keyFor(env, orgId);

  const res = await worker.fetch(ciRequest(payload({
    lockfiles: [
      { path: "docs/README.md", content: "# not a lockfile" },
      { path: "package-lock.json", content: LOCKFILE },
    ],
  }), { key }), env, {});
  expect(res.status === 200, `a mixed payload still audits the supported file (got ${res.status})`);
}

// ---------------------------------------------------------------------------
console.log("\nthe SARIF report\n");
// ---------------------------------------------------------------------------

{
  const env = makeEnv({ FETCH: makeOsvFetch([
    { id: "GHSA-crit", package: "lodash", severity: "critical", fixedIn: "4.17.21" },
  ]) });
  const orgId = await seedOrg(env, { userId: "usr_sarif", email: "sarif@example.com" });
  const key = await keyFor(env, orgId);

  const run = await (await worker.fetch(ciRequest(payload(), { key }), env, {})).json();

  const res = await worker.fetch(new Request(
    `https://algosize.com/api/runs/${run.runId}/report?format=sarif`,
    { headers: { Authorization: `Bearer ${key}` } },
  ), env, {});

  expect(res.status === 200, `the SARIF report is downloadable with the same key (got ${res.status})`);
  expect((res.headers.get("content-type") || "").includes("sarif"),
    "served as application/sarif+json");

  const sarif = await res.json();
  expect(sarif.version === "2.1.0", "SARIF 2.1.0");
  expect(Array.isArray(sarif.runs) && sarif.runs.length === 1, "one run");
  expect(sarif.runs[0].results.length === 1, `one result per advisory (got ${sarif.runs[0].results.length})`);
  expect(sarif.runs[0].results[0].level === "error", "a critical maps to SARIF level error");
  expect(sarif.runs[0].tool.driver.rules[0].properties["security-severity"] === "9.5",
    "and carries a security-severity GitHub can sort on");
  expect(sarif.runs[0].results[0].locations[0].physicalLocation.artifactLocation.uri === "package-lock.json",
    "attached to the manifest it came from");
  expect(typeof sarif.runs[0].results[0].partialFingerprints.algosizeAdvisory === "string",
    "with a stable fingerprint so GitHub can track it across runs");

  // A different org cannot download it.
  const otherOrg = await seedOrg(env, { userId: "usr_snoop", email: "snoop@example.com" });
  const otherKey = await keyFor(env, otherOrg);
  const denied = await worker.fetch(new Request(
    `https://algosize.com/api/runs/${run.runId}/report?format=sarif`,
    { headers: { Authorization: `Bearer ${otherKey}` } },
  ), env, {});
  expect(denied.status === 404, `another org cannot download the report (got ${denied.status})`);
}

{
  // A clean audit still produces a valid, empty SARIF log — a CI step that
  // crashes on success is a CI step people delete.
  const sarif = toSarif({ advisories: [], scanned: { manifests: [{ filename: "go.sum" }] }, summary: { complete: true } });
  expect(sarif.version === "2.1.0" && sarif.runs[0].results.length === 0,
    "a clean run yields a valid SARIF log with no results");
  expect(sarif.runs[0].properties.complete === true, "and records that the audit was complete");

  const missing = toSarif(null);
  expect(missing.runs[0].results.length === 0, "a missing result degrades to empty rather than throwing");
}

// ---------------------------------------------------------------------------
console.log("\nthe setup snippet\n");
// ---------------------------------------------------------------------------

{
  const env = makeEnv();
  const orgId = await seedOrg(env, { userId: "usr_snip", email: "snip@example.com" });
  const key = await keyFor(env, orgId);

  const req = new Request("https://algosize.com/api/ci/snippet", {
    headers: { Authorization: `Bearer ${key}` },
  });
  const res = await worker.fetch(req, env, {});
  const body = await res.json();

  expect(res.status === 200, `the snippet endpoint returns 200 (got ${res.status})`);
  expect(body.filename === ".github/workflows/algosize-audit.yml", "naming the file to create");
  expect(body.secretName === "ALGOSIZE_API_KEY", "and the secret the workflow reads");

  const yaml = body.workflow;

  // THE property: the snippet must never contain a real key.
  expect(!yaml.includes(key), "the workflow YAML does NOT contain the caller's key");
  expect(!yaml.includes("ask_live_"), "nor any ask_live_ token at all");
  expect(!JSON.stringify(body).includes(key), "and neither does any other field of the response");
  expect(yaml.includes("secrets.ALGOSIZE_API_KEY"),
    "it references the repo secret instead, which is the only way it can work");

  // The workflow does what the task asked for.
  expect(/on:\s*\n\s*pull_request/.test(yaml), "triggers on pull_request");
  expect(yaml.includes("branches: [main, master]"), "and on pushes to the default branch");
  expect(yaml.includes("cron:"), "and on a weekly schedule");
  expect(yaml.includes("/api/ci/runs"), "posts to the ingestion endpoint");
  expect(yaml.includes("format=sarif"), "downloads the SARIF report");
  expect(yaml.includes("github/codeql-action/upload-sarif"), "uploads it to the Security tab");
  expect(yaml.includes("security-events: write"), "with the permission that upload needs");
  expect(yaml.includes("<!-- algosize-audit -->"),
    "and marks its PR comment so it can be updated in place rather than appended");
  expect(/updateComment/.test(yaml) && /createComment/.test(yaml),
    "updating the existing sticky comment when there is one");

  // A pasted workflow must not go red before the key exists. The first thing
  // anyone does with a red required check is delete it.
  expect(yaml.includes("steps.key.outputs.present == 'true'"),
    "every audit step is gated on the secret actually being present");
  expect(/::notice::ALGOSIZE_API_KEY is not set/.test(yaml),
    "and a missing secret produces a notice, not a failed build");

  // The origin is the deployment's own, so a staging install points at staging.
  const staging = await worker.fetch(
    new Request("https://algosize.com/api/ci/snippet", { headers: { Authorization: `Bearer ${key}` } }),
    { ...env, SITE_ORIGIN: "https://staging.algosize.com" }, {},
  );
  const stagingBody = await staging.json();
  expect(stagingBody.workflow.includes("https://staging.algosize.com/api/ci/runs"),
    "the snippet points at the deployment serving it, not a hardcoded host");

  // fail_on is configurable from the wizard.
  const strict = await worker.fetch(new Request(
    "https://algosize.com/api/ci/snippet?fail_on=critical",
    { headers: { Authorization: `Bearer ${key}` } },
  ), env, {});
  expect((await strict.json()).workflow.includes('"fail_on": "critical"'),
    "and honours a fail_on chosen in the wizard");
}

{
  // The committed workflow files are generated from this same function, so
  // they cannot drift from what the dashboard hands out.
  const { readFileSync } = await import("node:fs");
  const generated = buildWorkflow({ origin: "https://algosize.com", failOn: "high" });
  // Paths resolve from scripts/, so the repo root is two levels up.
  for (const path of ["../../.github/workflows/algosize-audit.yml",
                      "../../.github/workflows/algosize-audit.yml.example"]) {
    let onDisk = null;
    try { onDisk = readFileSync(new URL(path, import.meta.url), "utf8"); } catch {}
    expect(onDisk === generated,
      `${path.split("/").pop()} matches what /api/ci/snippet serves`);
    expect(onDisk !== null && !onDisk.includes("ask_live_"),
      `${path.split("/").pop()} contains no key material`);
  }
}

// ---------------------------------------------------------------------------
console.log("\nexisting history behaviour is preserved\n");
// ---------------------------------------------------------------------------

{
  // A dashboard run (user, no org on the row) is still visible to that user —
  // migrations/0007 keeps the user_id read path as a fallback so rows the
  // backfill could not resolve don't vanish.
  const env = makeEnv();
  await seedOrg(env, { userId: "usr_legacy", email: "legacy@example.com" });

  await persistRun(env, {
    userId: "usr_legacy", orgId: null, analyzer: "vuln",
    input: { code: "x" }, result: { counts: { critical: 0 }, advisories: [] },
  });

  const seen = await listRuns(env, { userId: "usr_legacy", orgId: "org_usr_legacy" }, { limit: 10 });
  expect(seen.items.length === 1, "a run with no org_id is still visible to the user who created it");
  expect(seen.items[0].source === null, "and is not badged as CI");
  expect(seen.items[0].repo === null && seen.items[0].commitSha === null,
    "and carries no CI provenance fields");
}

// ---------------------------------------------------------------------------
console.log("\nfeed provenance and the ?source= filter (D-3)\n");
// ---------------------------------------------------------------------------

{
  const env = makeEnv({ FETCH: makeOsvFetch([]) });
  const orgId = await seedOrg(env, { userId: "usr_feed", email: "feed@example.com" });
  const key = await keyFor(env, orgId);

  // One CI run with provenance, one dashboard run without.
  const req = ciRequest(payload(), { key });
  const worker = (await import("../src/index.js")).default;
  const res = await worker.fetch(req, env, { waitUntil() {} });
  expect(res.status === 200, `CI run ingested for the feed test (got ${res.status})`);
  await persistRun(env, {
    userId: "usr_feed", orgId, analyzer: "vuln",
    input: { repoUrl: "https://github.com/acme/x" }, result: { counts: {}, advisories: [] },
  });

  const scope = { userId: "usr_feed", orgId };
  const all = await listRuns(env, scope, { limit: 10 });
  expect(all.items.length === 2, "unfiltered feed lists both runs");

  const ciOnly = await listRuns(env, scope, { limit: 10, source: "ci" });
  expect(ciOnly.items.length === 1 && ciOnly.items[0].source === "ci",
    "source:'ci' filters to CI runs server-side");
  expect(ciOnly.items[0].repo === "acme/widgets" && ciOnly.items[0].commitSha === "abc123def456",
    `CI list items carry repo + commitSha from the stored input (got ${ciOnly.items[0].repo} @ ${ciOnly.items[0].commitSha})`);

  const manualOnly = await listRuns(env, scope, { limit: 10, source: "manual" });
  expect(manualOnly.items.length === 1 && manualOnly.items[0].source === null,
    "source:'manual' filters to dashboard runs (NULL source)");

  // Bare-string scope still works, so nothing that called listRuns(env, userId) broke.
  // Scoped by user alone it sees only the dashboard run — the CI run has no user.
  const byString = await listRuns(env, "usr_feed", { limit: 10 });
  expect(byString.items.length === 1, "listRuns(env, userId) still works for existing callers");
}

// ---------------------------------------------------------------------------
console.log("\narchitecture inputs via CI\n");
// ---------------------------------------------------------------------------
//
// `files` drives the Architecture X-ray from the same request that carries
// `lockfiles`. The two analyzers file separate runs because the runs table
// stores one analyzer per row.

const COMPOSE = [
  "services:",
  "  api:",
  "    image: node:20",
  "    ports: ['8080:8080']",
  "  db:",
  "    image: postgres:16",
].join("\n");

{
  const env = makeEnv();
  const orgId = await seedOrg(env, { userId: "usr_arch", email: "arch@example.com" });
  const key = await keyFor(env, orgId);

  const res = await worker.fetch(ciRequest(payload({
      files: [{ path: "docker-compose.yml", content: COMPOSE }],
    }), { key }), env, {});
  const body = await res.json();

  expect(res.status === 200, `lockfiles + files → 200 (got ${res.status})`);
  expect(body.runId && typeof body.runId === "string",
    "the dependency audit still returns its own runId at the top level");
  expect(body.architecture && typeof body.architecture === "object",
    "an `architecture` block is present when files were submitted");
  expect(body.architecture && body.architecture.runId && body.architecture.runId !== body.runId,
    "architecture files a SEPARATE run from the dependency audit");
  expect(body.architecture && body.architecture.summary
      && typeof body.architecture.summary.clusters === "number",
    "the architecture block carries the analyzer's own summary");
  // An architecture run's artefact is the MAP, so it gets its own route rather
  // than borrowing the report viewer. Before this the gate posted counts and no
  // link at all: the run it had just created was unreachable from the pull
  // request that caused it, and a reader had to take the number on faith.
  expect(body.architecture &&
      body.architecture.mapUrl === `https://algosize.com/dashboard/#/arch/${body.architecture.runId}`,
    `and a map URL pointing at that run (got ${body.architecture && body.architecture.mapUrl})`);

  // Both rows land, each under its own analyzer, both marked source=ci.
  const scope = { orgId, userId: null };
  const all = await listRuns(env, scope, { limit: 10 });
  const analyzers = all.items.map((r) => r.analyzer).sort();
  expect(analyzers.join(",") === "arch,vuln",
    `both runs are filed, one per analyzer (got ${analyzers.join(",") || "none"})`);
  expect(all.items.every((r) => r.source === "ci"),
    "both runs are marked source=ci");
}

// Architecture alone — no lockfiles at all. A repo with no recognisable
// lockfile must still get its architecture analysed rather than a 400.
{
  const env = makeEnv();
  const orgId = await seedOrg(env, { userId: "usr_archonly", email: "archonly@example.com" });
  const key = await keyFor(env, orgId);

  const res = await worker.fetch(ciRequest({
      repo: "acme/widgets",
      files: [{ path: "docker-compose.yml", content: COMPOSE }],
    }, { key }), env, {});
  const body = await res.json();

  expect(res.status === 200, `files with no lockfiles → 200 (got ${res.status})`);
  expect(body.runId === null, "no dependency audit run when no lockfiles were submitted");
  expect(body.architecture && body.architecture.runId,
    "the architecture run is still filed");
  expect(body.failed === false,
    "arch findings do not fail the build by default (arch_fail_on defaults to none)");
}

// Neither input → a single clear error naming both.
{
  const env = makeEnv();
  const orgId = await seedOrg(env, { userId: "usr_none", email: "none@example.com" });
  const key = await keyFor(env, orgId);

  const res = await worker.fetch(ciRequest({ repo: "acme/widgets" }, { key }), env, {});
  const body = await res.json();
  expect(res.status === 400 && body.error === "no_inputs",
    `neither lockfiles nor files → 400 no_inputs (got ${res.status} ${body.error})`);
}

// arch_fail_on is opt-in gating, and is validated like fail_on.
{
  const env = makeEnv();
  const orgId = await seedOrg(env, { userId: "usr_archfail", email: "archfail@example.com" });
  const key = await keyFor(env, orgId);

  const bad = await worker.fetch(ciRequest(payload({ arch_fail_on: "sideways" }), { key }), env, {});
  const badBody = await bad.json();
  expect(bad.status === 400 && badBody.error === "invalid_arch_fail_on",
    `invalid arch_fail_on → 400 invalid_arch_fail_on (got ${bad.status} ${badBody.error})`);

  // A compose file with a database reachable from outside trips at least one
  // finding; gating at "low" turns any finding into a build failure.
  const gated = await worker.fetch(ciRequest(payload({
      files: [{ path: "docker-compose.yml", content: COMPOSE }],
      fail_on: "none",
      arch_fail_on: "low",
    }), { key }), env, {});
  const gatedBody = await gated.json();
  const archFindings = gatedBody.architecture.summary.findings;
  expect(gated.status === 200, "arch_fail_on:'low' still returns 200 with a verdict");
  expect(archFindings === 0 || gatedBody.failed === true,
    `arch_fail_on gates the overall verdict (findings=${archFindings}, failed=${gatedBody.failed})`);
}

// The generated workflow collects architecture inputs, not just lockfiles.
{
  const wf = buildWorkflow({ origin: "https://algosize.com" });
  expect(wf.includes('"files": arch'),
    "the generated workflow posts a `files` array");
  expect(wf.includes("arch_fail_on"),
    "the generated workflow sends arch_fail_on");
  expect(wf.includes("git") && wf.includes("ls-files"),
    "collection is driven by git ls-files, so gitignored build output is excluded");
  expect(!/\.env['"]?\s*:/.test(wf) && wf.includes("is_env"),
    "the collector explicitly excludes .env files from what it uploads");
  expect(wf.includes("steps.collect.outputs.archfiles"),
    "the audit step runs when there are architecture inputs even with no lockfiles");
}

// ---------- summary ----------
// ---------------------------------------------------------------------------
console.log("\nthe optimizer gate can file its report, like every other gate\n");
// ---------------------------------------------------------------------------
//
// The optimizer called no Algosize endpoint at all, so a CI regression and a
// nightly regression lived in two different places and only one of them was
// the product: "Recent runs" never showed a single optimizer run, ever.
//
// It is the one analyzer whose CI measurement happens in the CUSTOMER'S
// runner — grading a function means executing it, and the gate does that
// against the pull request's own checkout — so this endpoint receives a
// finished report rather than input to analyse.
{
  const env = makeEnv();
  const orgId = await seedOrg(env, { userId: "usr_opt", email: "opt@example.com" });
  const key = await keyFor(env, orgId);

  const report = {
    summary: { mode: "all", audited: 2, ok: 1, unknown: 0, regressions: 1, errors: 0 },
    results: [
      { name: "bigo-mean", functionName: "mean", file: "src/bigo.js",
        bigO: { label: "O(n)" }, ceiling: "O(n)", verdict: "ok" },
      { name: "llm-formatMs", functionName: "formatMs", file: "src/llm.js",
        bigO: { label: "O(n^2)" }, ceiling: "O(n)", verdict: "regression" },
    ],
  };

  // Optimizer-only: no lockfiles, no files. Before this that was a 400
  // no_inputs, so the gate had nothing it could legally post.
  const res = await worker.fetch(
    ciRequest(payload({ lockfiles: [], optimizer: report }), { key }), env, {});
  const body = await res.json();

  expect(res.status === 200, `an optimizer-only submission is accepted (got ${res.status})`);
  expect(body.optimizer && typeof body.optimizer.runId === "string",
    "and files a run of its own");
  expect(body.optimizer && body.optimizer.regressions === 1,
    `carrying the regression count (got ${body.optimizer && body.optimizer.regressions})`);

  // The whole point: it is in the feed the user was looking at.
  const history = await listRuns(env, { orgId }, { limit: 10 });
  const algo = history.items.filter((r) => r.analyzer === "algo");
  expect(algo.length === 1, `the optimizer run reaches the runs feed (got ${algo.length})`);
  expect(algo[0] && algo[0].source === "ci", `marked source=ci (got ${algo[0] && algo[0].source})`);

  const stored = await getRun(env, { orgId }, body.optimizer.runId);
  expect(stored && stored.result && stored.result.measuredBy === "ci_runner",
    "and records that the CI runner measured it, not us — every other run in " +
    "this feed was measured here, and a reader comparing the two should see that");
  expect(stored && stored.result && stored.result.entries
      && stored.result.entries.length === 2,
    "the graded entries are stored, so the run says WHICH function regressed");

  // The gate owns its own verdict. Folding it into the top-level `failed`
  // would give one build two sources of truth about whether it passed.
  expect(body.failed === false,
    "a regression does not flip the shared `failed` flag the audit gate reads");

  // Bounded at the boundary: the gate caps what it audits, and so does this.
  const huge = { results: Array.from({ length: 101 }, (_, i) => ({ name: `f${i}`, verdict: "ok" })) };
  const tooMany = await worker.fetch(
    ciRequest(payload({ lockfiles: [], optimizer: huge }), { key }), env, {});
  expect(tooMany.status === 413, `an oversized report is refused (got ${tooMany.status})`);

  // And a submission with nothing in it at all is still a 400 — accepting the
  // optimizer must not have opened a path to filing an empty run.
  const empty = await worker.fetch(ciRequest(payload({ lockfiles: [] }), { key }), env, {});
  expect(empty.status === 400, `no inputs at all is still refused (got ${empty.status})`);
}

console.log("");
if (failures === 0) {
  console.log("\x1b[32m  all ci-ingest tests passed\x1b[0m\n");
  process.exit(0);
} else {
  console.log(`\x1b[31m  ${failures} ci-ingest test(s) failed\x1b[0m\n`);
  process.exit(1);
}
