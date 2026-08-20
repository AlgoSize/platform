// Tests for the client-facing report pipeline — Task #P-6.
//
// The four the task named:
//   1. SARIF validates against the schema shape we assert
//   2. the SBOM lists every parsed package
//   3. an expired share token is rejected
//   4. white-label branding applies only to entitled orgs
//
// Plus the ones that decide whether this is safe to hand to a stranger. A
// report is a document we actively encourage customers to forward outside
// their company, and a share link is the only unauthenticated read path in the
// product — so: external text is escaped, a logo URL cannot carry a script, a
// token reaches exactly one run and no others, and a missing R2 bucket
// degrades to on-demand rendering rather than to an error.
//
// Run with:  node scripts/test-reports.mjs

import worker from "../src/index.js";
import { auditManifests } from "../src/handlers/analyze.js";
import { persistRun, getRunReportHandler, createRunShareHandler, sharedReportHandler } from "../src/handlers/runs.js";
import { updateOrgBrandingHandler, getOrgHandler } from "../src/handlers/org.js";
import { toSarif } from "../src/analyzers/sarif.js";
import { toCycloneDX, purlFor } from "../src/analyzers/cyclonedx.js";
import { toAuditCsv, csvCell } from "../src/analyzers/csv.js";
import { renderReportHtml, escapeHtml } from "../src/reports/html.js";
import { tierForOrg, safeLogoUrl } from "../src/reports/branding.js";
import { storeReportFor, reportHtmlFor } from "../src/reports/render.js";
import { createShare, readShare, clampShareDays, DEFAULT_SHARE_DAYS, MAX_SHARE_DAYS } from "../src/reports/share.js";
import { reportKey, getReport } from "../src/reports/store.js";
import { makeD1 } from "./_d1-stub.mjs";

let failures = 0;
const ok   = (msg) => console.log(`  \x1b[32m✓\x1b[0m ${msg}`);
const fail = (msg) => { console.log(`  \x1b[31m✗\x1b[0m ${msg}`); failures++; };
const expect = (cond, label) => cond ? ok(label) : fail(label);

const NOW  = Math.floor(Date.now() / 1000);
const DAY  = 86_400;

// Tier price ids, matching the STRIPE_PRICE_<PLAN>_<INTERVAL> config the
// checkout path reads (src/stripe.js).
const PRICE_FIRM_MONTHLY     = "price_firm_m";
const PRICE_PRACTICE_MONTHLY = "price_practice_m";

function makeKV() {
  const store = new Map();
  return {
    async get(k) { return store.has(k) ? store.get(k) : null; },
    async put(k, v) { store.set(k, v); },
    async delete(k) { store.delete(k); },
    _store: store,
  };
}

/** R2 double — only the three methods src/reports/store.js actually calls. */
function makeR2() {
  const store = new Map();
  return {
    async put(key, value, opts) { store.set(key, { value, opts }); return { key }; },
    async get(key) {
      if (!store.has(key)) return null;
      const { value } = store.get(key);
      return { text: async () => value };
    },
    async delete(key) { store.delete(key); },
    _store: store,
  };
}

/** OSV double: one critical advisory against lodash, nothing else. */
function makeOsvFetch(vulns = []) {
  return async (url) => {
    const u = String(url);
    if (u.includes("querybatch")) {
      // One result slot per queried package, in order. Only the packages named
      // in `vulns` come back with anything.
      return new Response(JSON.stringify({
        results: vulns.map((v) => ({ vulns: [{ id: v.id }] })),
      }), { status: 200 });
    }
    if (u.includes("/v1/vulns/")) {
      const id = decodeURIComponent(u.split("/vulns/")[1]);
      const v = vulns.find((x) => x.id === id);
      if (!v) return new Response("{}", { status: 404 });
      const vector = v.severity === "critical"
        ? "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:C/C:H/I:H/A:H"
        : "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:N/A:N";
      return new Response(JSON.stringify({
        id: v.id,
        summary: v.summary || `${v.id} in ${v.package}`,
        aliases: v.aliases || [],
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
    JWT_SECRET: "reports-test-jwt-secret-32-or-more-chars-ok",
    SITE_ORIGIN: "https://algosize.com",
    COOKIE_NAME: "algosize_session",
    STRIPE_PRICE_FIRM_MONTHLY:     PRICE_FIRM_MONTHLY,
    STRIPE_PRICE_PRACTICE_MONTHLY: PRICE_PRACTICE_MONTHLY,
    SESSIONS: makeKV(),
    USERS:    makeKV(),
    DB:       makeD1(),
    REPORTS:  makeR2(),
    ...overrides,
  };
}

async function seedOrg(env, {
  userId, email, plan = "paid", subStatus = "active",
  priceId = null, currentPeriodEnd = null,
  brandCompanyName = null, brandLogoUrl = null,
}) {
  const orgId = `org_${userId}`;
  await env.DB.prepare(
    `INSERT INTO users (user_id, email, stripe_customer_id, plan, sub_status, active_org_id, created_at, updated_at)
     VALUES (?, ?, NULL, 'free', NULL, ?, ?, ?)`,
  ).bind(userId, email, orgId, NOW, NOW).run();
  await env.DB.prepare(
    `INSERT INTO organisations
       (org_id, name, stripe_customer_id, plan, sub_status, current_period_end,
        seats_purchased, price_id, brand_company_name, brand_logo_url, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)`,
  ).bind(orgId, email, `cus_${userId}`, plan, subStatus, currentPeriodEnd,
         priceId, brandCompanyName, brandLogoUrl, NOW, NOW).run();
  await env.DB.prepare(
    "INSERT INTO memberships (org_id, user_id, role, created_at) VALUES (?, ?, 'owner', ?)",
  ).bind(orgId, userId, NOW).run();
  return orgId;
}

const LOCKFILE = JSON.stringify({
  lockfileVersion: 3,
  packages: {
    "node_modules/lodash":      { version: "4.17.20" },
    "node_modules/express":     { version: "4.17.1" },
    "node_modules/@scope/thing": { version: "2.0.1" },
  },
});

const REQUIREMENTS = "flask==2.0.1\nrequests==2.25.0\n";

/** Run a real audit through the real code path and persist it. */
async function auditAndPersist(env, { orgId, userId = null, vulns = [], manifests = null, source = null }) {
  const audit = await auditManifests(
    manifests || [{ filename: "package-lock.json", path: "package-lock.json", content: LOCKFILE }],
    makeOsvFetch(vulns),
    { env },
  );
  if (!audit.ok) throw new Error(`audit failed: ${JSON.stringify(audit.body)}`);
  const run = await persistRun(env, {
    orgId, userId, analyzer: "vuln", source,
    input: { repo: "acme/widgets", lockfiles: ["package-lock.json"] },
    result: audit.result,
  });
  return { run, result: audit.result };
}

const authedRequest = (url, { method = "GET", userId, body = null, params = null } = {}) => {
  const req = new Request(url, {
    method,
    headers: body ? { "content-type": "application/json" } : {},
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  // The handlers read request.user / request.params directly; requireAuth and
  // itty-router's param extraction are covered by test-auth.mjs and the
  // routing block at the bottom of this file, so these tests inject the
  // resolved identity and params rather than minting a JWT for every case.
  req.user = { userId };
  req.authMethod = "session";
  if (params) req.params = params;
  return req;
};

/** An unauthenticated request to a share link, as a stranger would make it. */
const shareRequest = (token, qs = "") => {
  const req = new Request(`https://algosize.com/api/share/${token}${qs}`);
  req.params = { token };
  return req;
};

// ===========================================================================
console.log("\nSARIF 2.1.0 shape\n");
// ===========================================================================
{
  const env = makeEnv();
  const orgId = await seedOrg(env, { userId: "u_sarif", email: "sarif@example.com" });
  const { run, result } = await auditAndPersist(env, {
    orgId, userId: "u_sarif",
    vulns: [
      { id: "GHSA-crit", package: "lodash", severity: "critical", fixedIn: "4.17.21" },
      { id: "GHSA-high", package: "express", severity: "high" },
    ],
  });

  const sarif = toSarif(result, { runId: run.id, siteOrigin: "https://algosize.com" });

  expect(sarif.version === "2.1.0", "version is exactly 2.1.0");
  expect(typeof sarif.$schema === "string" && sarif.$schema.includes("sarif-schema-2.1.0"),
    "$schema points at the 2.1.0 schema");
  expect(Array.isArray(sarif.runs) && sarif.runs.length === 1, "exactly one run");

  const r = sarif.runs[0];
  expect(r.tool && r.tool.driver && r.tool.driver.name === "Algosize", "tool.driver.name is set");
  expect(typeof r.tool.driver.informationUri === "string", "tool.driver.informationUri is set");
  expect(Array.isArray(r.tool.driver.rules) && r.tool.driver.rules.length === 2,
    "one rule per distinct advisory");
  expect(Array.isArray(r.results) && r.results.length === 2, "one result per advisory");

  // Rule shape — every field GitHub's ingester reads.
  const ruleOk = r.tool.driver.rules.every((rule) =>
    typeof rule.id === "string" && rule.id.startsWith("algosize/") &&
    rule.shortDescription && typeof rule.shortDescription.text === "string" &&
    rule.fullDescription  && typeof rule.fullDescription.text === "string" &&
    rule.help && typeof rule.help.text === "string" && typeof rule.help.markdown === "string" &&
    typeof rule.helpUri === "string" &&
    rule.properties && Array.isArray(rule.properties.tags) &&
    typeof rule.properties["security-severity"] === "string");
  expect(ruleOk, "every rule carries id, descriptions, help, helpUri, tags and security-severity");

  // security-severity has to parse as a number or GitHub ignores it silently.
  const sevNumeric = r.tool.driver.rules.every((rule) =>
    Number.isFinite(parseFloat(rule.properties["security-severity"])));
  expect(sevNumeric, "security-severity parses as a number");

  // Result shape.
  const resultOk = r.results.every((res) =>
    typeof res.ruleId === "string" &&
    ["error", "warning", "note"].includes(res.level) &&
    res.message && typeof res.message.text === "string" &&
    Array.isArray(res.locations) && res.locations.length === 1 &&
    res.locations[0].physicalLocation.artifactLocation.uri &&
    res.locations[0].physicalLocation.region.startLine >= 1 &&
    res.partialFingerprints && typeof res.partialFingerprints.algosizeAdvisory === "string");
  expect(resultOk, "every result carries ruleId, a valid level, message, location and fingerprint");

  // Every result's ruleId must exist in the rules array — a dangling ruleId
  // makes GitHub drop the finding without saying why.
  const ruleIds = new Set(r.tool.driver.rules.map((x) => x.id));
  expect(r.results.every((res) => ruleIds.has(res.ruleId)), "no result references an undeclared rule");

  // critical and high both map to "error"; that is what makes them block.
  expect(r.results.filter((res) => res.level === "error").length === 2,
    "critical and high both map to level error");

  expect(r.properties && r.properties.algosizeRunId === run.id, "run id travels in run.properties");
  expect(Array.isArray(r.properties.manifestsScanned) && r.properties.manifestsScanned.length === 1,
    "scanned manifests are recorded");
  expect(typeof r.properties.complete === "boolean", "completeness is stated, not implied");

  // The whole document must survive a round trip — a SARIF file GitHub cannot
  // parse is worse than no SARIF file.
  let roundTripped = false;
  try { roundTripped = !!JSON.parse(JSON.stringify(sarif)); } catch { /* stays false */ }
  expect(roundTripped, "serialises to valid JSON");
}

// ===========================================================================
console.log("\nCycloneDX 1.5 SBOM\n");
// ===========================================================================
{
  const env = makeEnv();
  const orgId = await seedOrg(env, { userId: "u_sbom", email: "sbom@example.com" });
  const { run, result } = await auditAndPersist(env, {
    orgId, userId: "u_sbom",
    manifests: [
      { filename: "package-lock.json", path: "package-lock.json", content: LOCKFILE },
      { filename: "requirements.txt",  path: "requirements.txt",  content: REQUIREMENTS },
    ],
    vulns: [{ id: "GHSA-crit", package: "lodash", severity: "critical", fixedIn: "4.17.21", aliases: ["CVE-2020-1"] }],
  });

  const bom = toCycloneDX(result, {
    runId: run.id, siteOrigin: "https://algosize.com",
    serialNumber: "urn:uuid:11111111-1111-1111-1111-111111111111",
    timestamp: "2026-08-17T00:00:00.000Z",
  });

  expect(bom.bomFormat === "CycloneDX", "bomFormat is CycloneDX");
  expect(bom.specVersion === "1.5", "specVersion is 1.5");
  expect(bom.version === 1, "document version is 1");
  expect(typeof bom.serialNumber === "string" && bom.serialNumber.startsWith("urn:uuid:"),
    "serialNumber is a urn:uuid");
  expect(!!bom.metadata.timestamp && !!bom.metadata.tools, "metadata carries timestamp and tools");

  // THE assertion the task names: every package the audit parsed is in the BOM.
  const parsed = result.packages;
  expect(Array.isArray(parsed) && parsed.length === 5,
    `audit parsed all 5 packages across both manifests (got ${parsed && parsed.length})`);

  const componentNames = new Set(bom.components.map((c) => `${c.name}@${c.version}`));
  const missing = parsed.filter((p) => !componentNames.has(`${p.name}@${p.version}`));
  expect(missing.length === 0,
    `every parsed package appears as a component (missing: ${missing.map((m) => m.name).join(", ") || "none"})`);
  expect(bom.components.length === parsed.length,
    `component count matches parsed package count (${bom.components.length} vs ${parsed.length})`);

  // Both ecosystems present, so this isn't passing by only covering npm.
  expect(componentNames.has("flask@2.0.1") && componentNames.has("lodash@4.17.20"),
    "components span every scanned ecosystem, not just the first");

  const everyComponentWellFormed = bom.components.every((c) =>
    c.type === "library" && c["bom-ref"] && c.name && c.version);
  expect(everyComponentWellFormed, "every component has type, bom-ref, name and version");

  // purls, including the two shapes that are easy to get wrong.
  expect(purlFor("npm", "@scope/thing", "2.0.1") === "pkg:npm/%40scope/thing@2.0.1",
    "npm scoped package percent-encodes the @ but keeps the path separator");
  expect(purlFor("PyPI", "flask", "2.0.1") === "pkg:pypi/flask@2.0.1", "PyPI maps to pkg:pypi");
  expect(purlFor("RubyGems", "rails", "7.0") === "pkg:gem/rails@7.0", "RubyGems maps to pkg:gem, not pkg:rubygems");
  expect(purlFor("Go", "github.com/foo/bar", "v1.2.3") === "pkg:golang/github.com/foo/bar@v1.2.3",
    "Go module paths keep their slashes");
  expect(purlFor("npm", "x", null) === null, "a package with no version yields no purl rather than a wrong one");

  // Vulnerabilities are tied back into the inventory by bom-ref.
  expect(bom.vulnerabilities.length === 1, "one vulnerability entry");
  const v = bom.vulnerabilities[0];
  expect(v.id === "GHSA-crit", "vulnerability carries the advisory id");
  expect(v.source && v.source.name === "OSV", "vulnerability names its source");
  expect(Array.isArray(v.ratings) && v.ratings[0].severity === "critical", "rating carries the severity");
  expect(v.ratings[0].method === "CVSSv31" && typeof v.ratings[0].vector === "string",
    "rating names the CVSS revision and carries the vector");
  expect(typeof v.ratings[0].score === "number", "rating carries the computed numeric score");
  expect(typeof v.recommendation === "string" && v.recommendation.includes("4.17.21"),
    "recommendation names the fixed version");

  const affectedRef = v.affects[0] && v.affects[0].ref;
  expect(bom.components.some((c) => c["bom-ref"] === affectedRef),
    "affects[].ref resolves to a component in this same BOM");

  expect(bom.metadata.properties.some((p) => p.name === "algosize:complete" && p.value === "true"),
    "a complete audit says so in metadata");

  let roundTripped = false;
  try { roundTripped = !!JSON.parse(JSON.stringify(bom)); } catch { /* stays false */ }
  expect(roundTripped, "serialises to valid JSON");
}

// A truncated audit must not present itself as a full inventory.
{
  const bom = toCycloneDX({
    packages: [{ name: "a", version: "1", ecosystem: "npm" }],
    advisories: [],
    scanned: { manifests: [{ filename: "package-lock.json" }], totalPackages: 1, packagesFound: 4000 },
  }, {});
  const complete = bom.metadata.properties.find((p) => p.name === "algosize:complete");
  const caveat   = bom.metadata.properties.find((p) => p.name === "algosize:completenessCaveat");
  expect(complete && complete.value === "false", "a truncated audit reports complete=false");
  expect(!!caveat && caveat.value.includes("4000"), "the caveat names how many packages were actually found");
}

// ===========================================================================
console.log("\nShare links\n");
// ===========================================================================
{
  const env = makeEnv();
  const orgId = await seedOrg(env, { userId: "u_share", email: "share@example.com" });
  const { run } = await auditAndPersist(env, { orgId, userId: "u_share", vulns: [] });

  // --- minting ---
  const res = await createRunShareHandler(
    authedRequest(`https://algosize.com/api/runs/${run.id}/share`, {
      method: "POST", userId: "u_share", params: { id: run.id },
    }),
    env,
  );
  const body = await res.json();
  expect(res.status === 201, `share link created (got ${res.status})`);
  expect(typeof body.token === "string" && body.token.length >= 32, "token is long and random");
  expect(body.url === `https://algosize.com/api/share/${body.token}`, "returned URL embeds the token");
  expect(body.expiresInDays === DEFAULT_SHARE_DAYS, `default expiry is ${DEFAULT_SHARE_DAYS} days`);
  expect(body.expiresAt > NOW, "expiresAt is in the future");

  // --- following, with no session at all ---
  const shared = await sharedReportHandler(shareRequest(body.token), env, null);
  expect(shared.status === 200, `an unauthenticated reader can open the link (got ${shared.status})`);
  expect((shared.headers.get("content-type") || "").includes("text/html"), "defaults to the HTML report");
  expect((shared.headers.get("x-robots-tag") || "").includes("noindex"), "shared report is marked noindex");
  expect((shared.headers.get("cache-control") || "").includes("no-store"), "shared report is not cacheable");

  // --- the assertion the task names: an expired token is rejected ---
  // Minted with a clock 8 days in the past, so its 7-day window has closed
  // while the KV row is still present. That is the case a TTL alone misses.
  const expired = await createShare(env, {
    runId: run.id, orgId, createdBy: "u_share", now: NOW - 8 * DAY,
  });
  const expiredResolved = await readShare(env, expired.token);
  expect(!expiredResolved.ok && expiredResolved.reason === "expired",
    "readShare reports an elapsed token as expired, not as valid");

  const expiredRes = await sharedReportHandler(shareRequest(expired.token), env, null);
  const expiredBody = await expiredRes.json();
  expect(expiredRes.status === 410, `an expired share token is rejected with 410 (got ${expiredRes.status})`);
  expect(expiredBody.error === "share_expired", "the refusal names expiry rather than a generic not-found");

  // A token that never existed is a different answer, deliberately.
  const bogusRes = await sharedReportHandler(shareRequest("not-a-real-token"), env, null);
  expect(bogusRes.status === 404, "an unknown token is a 404, distinct from an expired one");

  // --- scope: a token grants ONE run, not the org ---
  const other = await auditAndPersist(env, { orgId, userId: "u_share", vulns: [] });
  const sneaky = await sharedReportHandler(shareRequest(body.token), env, null);
  const sneakyHtml = await sneaky.text();
  expect(sneakyHtml.includes(run.id) && !sneakyHtml.includes(other.run.id),
    "a share token serves only its own run, not the org's other runs");

  // --- lifetimes are clamped ---
  expect(clampShareDays(undefined) === DEFAULT_SHARE_DAYS, "an absent lifetime falls back to the default");
  expect(clampShareDays(0) === DEFAULT_SHARE_DAYS, "a zero lifetime falls back to the default");
  expect(clampShareDays("banana") === DEFAULT_SHARE_DAYS, "a nonsense lifetime falls back to the default");
  expect(clampShareDays(9999) === MAX_SHARE_DAYS, `an unbounded lifetime is capped at ${MAX_SHARE_DAYS} days`);
  expect(clampShareDays(30) === 30, "a reasonable lifetime is honoured");
}

// A share link cannot be minted for a run belonging to someone else's org.
{
  const env = makeEnv();
  const orgA = await seedOrg(env, { userId: "u_a", email: "a@example.com" });
  await seedOrg(env, { userId: "u_b", email: "b@example.com" });
  const { run } = await auditAndPersist(env, { orgId: orgA, userId: "u_a", vulns: [] });

  const res = await createRunShareHandler(
    authedRequest(`https://algosize.com/api/runs/${run.id}/share`, {
      method: "POST", userId: "u_b", params: { id: run.id },
    }),
    env,
  );
  expect(res.status === 404, `a user cannot mint a share link for another org's run (got ${res.status})`);
}

// ===========================================================================
console.log("\nWhite-label branding\n");
// ===========================================================================

// Tier resolution is the gate everything else hangs off.
{
  const env = makeEnv();
  expect(tierForOrg(env, { priceId: PRICE_FIRM_MONTHLY }) === "firm", "the Firm price resolves to the firm tier");
  expect(tierForOrg(env, { priceId: PRICE_PRACTICE_MONTHLY }) === "practice", "the Practice price resolves to practice");
  expect(tierForOrg(env, { priceId: "price_legacy_29" }) === null,
    "the legacy single price is not a tier, and specifically not the top one");
  expect(tierForOrg(env, { priceId: null }) === null, "an org with no price is on no tier");
}

// The matrix the task asks for: branding applies only to an entitled top tier.
{
  const cases = [
    { label: "entitled Firm org",        priceId: PRICE_FIRM_MONTHLY,     subStatus: "active",   plan: "paid", expect: true  },
    { label: "Firm org past its period", priceId: PRICE_FIRM_MONTHLY,     subStatus: "canceled", plan: "paid", expect: false, currentPeriodEnd: NOW - DAY },
    { label: "entitled Practice org",    priceId: PRICE_PRACTICE_MONTHLY, subStatus: "active",   plan: "paid", expect: false },
    { label: "legacy paid org",          priceId: "price_legacy_29",      subStatus: "active",   plan: "paid", expect: false },
    { label: "free org",                 priceId: null,                   subStatus: null,       plan: "free", expect: false },
  ];

  for (const c of cases) {
    const env = makeEnv();
    const userId = `u_${c.label.replace(/\W+/g, "_")}`;
    const orgId = await seedOrg(env, {
      userId, email: `${userId}@example.com`,
      plan: c.plan, subStatus: c.subStatus, priceId: c.priceId,
      currentPeriodEnd: c.currentPeriodEnd ?? null,
      brandCompanyName: "Northwind Security",
      brandLogoUrl: "https://cdn.example.com/logo.png",
    });

    const { run } = await auditAndPersist(env, { orgId, userId, vulns: [] });
    const { html } = await reportHtmlFor(env, null, run);

    const branded = html.includes("Northwind Security");
    expect(branded === c.expect,
      `${c.label}: report ${c.expect ? "carries" : "does not carry"} the custom branding`);
    // Whichever way it went, the document must name someone.
    expect(branded || html.includes("Algosize"), `${c.label}: report always names a preparer`);
    if (!c.expect) {
      expect(!html.includes("cdn.example.com/logo.png"),
        `${c.label}: the saved logo is not rendered either`);
    }
  }
}

// The write path is gated on the same rule as the render path.
{
  const env = makeEnv();
  const practiceOrg = await seedOrg(env, {
    userId: "u_practice", email: "practice@example.com",
    priceId: PRICE_PRACTICE_MONTHLY, subStatus: "active",
  });
  const res = await updateOrgBrandingHandler(
    authedRequest("https://algosize.com/api/org/branding", {
      method: "PUT", userId: "u_practice", body: { companyName: "Nope Ltd" },
    }),
    env,
  );
  const body = await res.json();
  expect(res.status === 402, `a Practice org is refused branding with 402 (got ${res.status})`);
  expect(body.error === "white_label_not_available" && body.requiredTier === "firm",
    "the refusal names the tier that includes it");

  // And nothing was written.
  const row = await env.DB.prepare("SELECT brand_company_name FROM organisations WHERE org_id = ?")
    .bind(practiceOrg).first();
  expect(!row.brand_company_name, "a refused request writes nothing");
}

{
  const env = makeEnv();
  await seedOrg(env, {
    userId: "u_firm", email: "firm@example.com",
    priceId: PRICE_FIRM_MONTHLY, subStatus: "active",
  });

  const put = async (body) => {
    const res = await updateOrgBrandingHandler(
      authedRequest("https://algosize.com/api/org/branding", { method: "PUT", userId: "u_firm", body }),
      env,
    );
    return { status: res.status, body: await res.json() };
  };

  const good = await put({ companyName: "Northwind Security", logoUrl: "https://cdn.example.com/logo.png" });
  expect(good.status === 200 && good.body.branding.companyName === "Northwind Security",
    "a Firm org can set its branding");

  // The logo ends up in an <img src> in a forwarded document, so the scheme
  // rules are enforced, not advisory.
  for (const bad of ["javascript:alert(1)", "data:text/html;base64,PHNjcmlwdD4=", "http://cdn.example.com/l.png", "//cdn.example.com/l.png", "not a url"]) {
    const r = await put({ logoUrl: bad });
    expect(r.status === 400 && r.body.error === "invalid_logo_url", `logo URL "${bad.slice(0, 28)}" is refused`);
  }
  expect(safeLogoUrl("https://cdn.example.com/l.png") === "https://cdn.example.com/l.png",
    "an https logo URL is accepted");
  expect(safeLogoUrl("HTTPS://CDN.example.com/l.png") !== null, "scheme matching is case-insensitive");

  // Clearing one field must not clear the other.
  await put({ logoUrl: null });
  const after = await getOrgHandler(authedRequest("https://algosize.com/api/org", { userId: "u_firm" }), env);
  const orgBody = await after.json();
  expect(orgBody.branding.logoUrl === null && orgBody.branding.companyName === "Northwind Security",
    "clearing the logo leaves the company name alone");
  expect(orgBody.branding.available === true, "GET /api/org reports branding as available on the top tier");
  expect(orgBody.org.tier === "firm", "GET /api/org reports the resolved tier");
}

// ===========================================================================
console.log("\nHTML report\n");
// ===========================================================================
{
  const env = makeEnv();
  const orgId = await seedOrg(env, { userId: "u_html", email: "html@example.com" });
  const { run } = await auditAndPersist(env, {
    orgId, userId: "u_html", source: "ci",
    vulns: [
      { id: "GHSA-crit", package: "lodash", severity: "critical", fixedIn: "4.17.21", summary: "Prototype pollution" },
      { id: "GHSA-high", package: "express", severity: "high" },
    ],
  });
  const { html } = await reportHtmlFor(env, null, run);

  expect(html.startsWith("<!doctype html>"), "renders a complete standalone document");
  expect(html.includes("</html>"), "the document is closed");
  expect(/<title>[^<]+<\/title>/.test(html), "has a title");

  // The seven things the task says the report must contain.
  expect(html.includes("Summary") && html.includes("Critical") && html.includes("High"),
    "carries a severity summary");
  expect(html.includes("GHSA-crit") && html.includes("lodash") && html.includes("4.17.21"),
    "carries a findings table with package, advisory and fixed version");
  expect(html.includes("What to do, in order"), "carries a remediation order");
  expect(html.includes("CVSS:3.1/AV:N"), "carries the CVSS vectors");
  expect(html.includes("What this report covers") && html.includes("package-lock.json"),
    "carries the scope");
  expect(html.includes("UTC") && html.includes("Report generated"), "carries a generated-at timestamp");
  expect(html.includes(run.id), "carries the run id");

  // The PDF story: a print stylesheet, and nothing that needs a browser we run.
  expect(html.includes("@media print"), "carries a print stylesheet");
  expect(html.includes("@page"), "sets print page margins");
  expect(html.includes("display: table-header-group"), "repeats table headers across printed pages");
  expect(html.includes("break-inside: avoid"), "keeps findings and steps whole across page breaks");
  expect(html.includes("window.print()"), "offers a print/save-as-PDF affordance");

  // Self-contained: no remote CSS, no remote script, no font CDN.
  expect(!/<link[^>]+stylesheet/i.test(html), "no external stylesheet");
  expect(!/<script[^>]+src=/i.test(html), "no external script");

  // Severity is never colour alone.
  expect(html.includes(">Critical<") && html.includes(">High<"),
    "severity is stated in words, not only in colour");
}

// The summary tiles must account for every row in the findings table.
//
// They did not: an advisory OSV publishes with no usable severity data is
// counted as `unknown`, caps the grade at C, and appears in the table — but the
// tiles only showed critical/high/medium/low, so a report with an unrated
// finding showed four tiles summing to one less than the table listed. A reader
// who adds up the summary and gets a different number from the table below
// stops believing the document, which is the one thing this document cannot
// afford.
{
  const advisories = ["critical", "high", "medium", "low", "unknown"].map((severity, i) => ({
    id: `GHSA-${severity}`, ecosystem: "npm", package: `pkg-${i}`, installedVersion: "1.0.0",
    severity, fixedIn: null, summary: `${severity} finding`,
    advisoryUrl: `https://osv.dev/vulnerability/GHSA-${severity}`,
  }));
  const counts = { critical: 1, high: 1, medium: 1, low: 1, unknown: 1 };
  const html = renderReportHtml({
    id: "run_counts", orgId: "o", analyzer: "vuln", createdAt: Date.now(), input: {},
    result: { advisories, counts, summary: { grade: "F", securityScore: 39, counts } },
  }, {});

  const tiles = [...html.matchAll(/<div class="count count-(\w+)">\s*<span class="n">(\d+)<\/span>/g)];
  const tileTotal = tiles.reduce((n, m) => n + parseInt(m[2], 10), 0);
  expect(tileTotal === advisories.length,
    `the summary tiles account for every finding (${tileTotal} vs ${advisories.length} rows)`);
  expect(tiles.some((m) => m[1] === "unknown"), "an unrated finding gets its own tile rather than vanishing");

  // The grade note has to describe the cap that actually bound THIS grade.
  const note = /grade-note">([^<]+)/.exec(html)[1];
  expect(note.includes("critical"), "the grade note names the cap that actually applied");

  // ...and on a clean report it must not warn about a cap that did not apply.
  const cleanCounts = { critical: 0, high: 0, medium: 0, low: 0, unknown: 0 };
  const cleanHtml = renderReportHtml({
    id: "run_clean", orgId: "o", analyzer: "vuln", createdAt: Date.now(), input: {},
    result: { advisories: [], counts: cleanCounts, summary: { grade: "A", securityScore: 100, counts: cleanCounts } },
  }, {});
  const cleanTiles = [...cleanHtml.matchAll(/<div class="count count-(\w+)">/g)].map((m) => m[1]);
  expect(!cleanTiles.includes("unknown"), "an empty unrated tile is not shown");
  expect(/grade-note">No severity cap applied/.test(cleanHtml),
    "a clean report says no cap applied rather than reciting the cap rules");
}

// External text is escaped. Advisory summaries come from OSV and package names
// from the customer's lockfile — both arrive in a document meant to be forwarded.
{
  const hostile = {
    id: "GHSA-xss",
    package: "<script>alert('pkg')</script>",
    installedVersion: "1.0.0",
    ecosystem: "npm",
    severity: "critical",
    summary: `<img src=x onerror="alert('summary')">`,
    cvssVector: "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H",
    cvssScore: 9.8,
    advisoryUrl: "https://osv.dev/vulnerability/GHSA-xss",
  };
  const html = renderReportHtml({
    id: "run_x", orgId: "org_x", analyzer: "vuln", createdAt: Date.now(),
    input: {}, result: { advisories: [hostile], counts: { critical: 1 }, summary: { grade: "F", counts: { critical: 1 } } },
  }, {});

  expect(!html.includes("<script>alert('pkg')</script>"), "a hostile package name is escaped");
  expect(!html.includes(`onerror="alert('summary')"`), "a hostile advisory summary is escaped");
  expect(html.includes("&lt;script&gt;"), "the hostile text is still shown, escaped");
  expect(escapeHtml(`<>&"'`) === "&lt;&gt;&amp;&quot;&#39;", "escapeHtml covers all five characters");
}

// A white-labelled report cannot be used to inject via the company name.
{
  const html = renderReportHtml(
    { id: "r", orgId: "o", analyzer: "vuln", createdAt: Date.now(), input: {}, result: {} },
    { branding: { companyName: `Acme"><script>alert(1)</script>`, logoUrl: null, whiteLabel: true } },
  );
  expect(!html.includes("<script>alert(1)</script>"), "a hostile company name is escaped in the masthead");
}

// A clean run reads as clean, and says what "clean" means.
{
  const env = makeEnv();
  const orgId = await seedOrg(env, { userId: "u_clean", email: "clean@example.com" });
  const { run } = await auditAndPersist(env, { orgId, userId: "u_clean", vulns: [] });
  const { html } = await reportHtmlFor(env, null, run);
  expect(html.includes("No known advisories"), "a clean run says so explicitly");
  expect(html.includes("not a guarantee"), "and does not overclaim what clean means");
}

// ===========================================================================
console.log("\nR2 storage\n");
// ===========================================================================
{
  const env = makeEnv();
  const orgId = await seedOrg(env, { userId: "u_r2", email: "r2@example.com" });
  const { run } = await auditAndPersist(env, { orgId, userId: "u_r2", vulns: [] });

  expect(reportKey(orgId, run.id) === `reports/${orgId}/${run.id}.html`,
    "the R2 key is reports/<orgId>/<runId>.html");

  const key = await storeReportFor(env, null, run);
  expect(key === reportKey(orgId, run.id), "a completed audit stores its report at that key");

  const stored = await getReport(env, { orgId, runId: run.id });
  expect(typeof stored === "string" && stored.includes(run.id), "the stored object is the rendered report");
  expect((env.REPORTS._store.get(key).opts.httpMetadata.contentType || "").includes("text/html"),
    "stored with an HTML content type");

  // A served report comes from R2 rather than being re-rendered.
  const served = await reportHtmlFor(env, null, run);
  expect(served.source === "r2", "a subsequent read is served from R2");
}

// The bucket is not provisioned yet in any environment, so the whole feature
// has to work without it.
{
  const env = makeEnv({ REPORTS: undefined });
  const orgId = await seedOrg(env, { userId: "u_nor2", email: "nor2@example.com" });
  const { run } = await auditAndPersist(env, { orgId, userId: "u_nor2", vulns: [] });

  expect(await storeReportFor(env, null, run) === null, "storing is a no-op with no bucket bound");

  const served = await reportHtmlFor(env, null, run);
  expect(served.source === "rendered" && served.html.includes(run.id),
    "the report still renders on demand with no bucket bound");

  const req = authedRequest(`https://algosize.com/api/runs/${run.id}/report?format=html`, { userId: "u_nor2", params: { id: run.id } });
  const res = await getRunReportHandler(req, env, null);
  expect(res.status === 200, `the report route still answers 200 with no bucket (got ${res.status})`);
}

// Non-vuln runs produce no report rather than an empty one.
{
  const env = makeEnv();
  const orgId = await seedOrg(env, { userId: "u_algo", email: "algo@example.com" });
  const run = await persistRun(env, {
    orgId, userId: "u_algo", analyzer: "algo",
    input: {}, result: { bigO: { label: "O(n)" }, wallTimeMs: 1 },
  });
  expect(await storeReportFor(env, null, run) === null, "an algo run stores no report");

  for (const format of ["html", "sarif", "cyclonedx"]) {
    const req = authedRequest(`https://algosize.com/api/runs/${run.id}/report?format=${format}`, { userId: "u_algo", params: { id: run.id } });
    const res = await getRunReportHandler(req, env, null);
    const body = await res.json();
    expect(res.status === 400 && body.error === "unsupported_format",
      `${format} on a non-audit run is refused with a reason`);
  }
}

// ===========================================================================
console.log("\nReport route\n");
// ===========================================================================
{
  const env = makeEnv();
  const orgId = await seedOrg(env, { userId: "u_fmt", email: "fmt@example.com" });
  const { run } = await auditAndPersist(env, {
    orgId, userId: "u_fmt",
    vulns: [{ id: "GHSA-crit", package: "lodash", severity: "critical", fixedIn: "4.17.21" }],
  });

  const get = async (qs) => {
    const req = authedRequest(`https://algosize.com/api/runs/${run.id}/report${qs}`, { userId: "u_fmt", params: { id: run.id } });
    return getRunReportHandler(req, env, null);
  };

  const expectations = [
    ["?format=html",      "text/html",                        "inline"],
    ["?format=sarif",     "application/sarif+json",           "attachment"],
    ["?format=cyclonedx", "application/vnd.cyclonedx+json",   "attachment"],
    ["?format=csv",       "text/csv",                         "attachment"],
    ["?format=json",      "application/json",                 null],
  ];
  for (const [qs, contentType, disposition] of expectations) {
    const res = await get(qs);
    const ct = res.headers.get("content-type") || "";
    const cd = res.headers.get("content-disposition") || "";
    expect(res.status === 200 && ct.includes(contentType),
      `${qs} responds 200 as ${contentType} (got ${res.status} ${ct})`);
    if (disposition) {
      expect(cd.startsWith(disposition), `${qs} is served ${disposition}`);
    }
  }

  // The HTML report gets a locked-down CSP: it is a document we encourage
  // people to forward, so it must not be able to fetch anything.
  const htmlRes = await get("?format=html");
  const csp = htmlRes.headers.get("content-security-policy") || "";
  expect(csp.includes("default-src 'none'"), "the HTML report is served with a default-src 'none' CSP");
  expect(csp.includes("frame-ancestors 'none'"), "and refuses to be framed");

  // Defaults and refusals.
  const bare = await get("");
  expect((bare.headers.get("content-type") || "").includes("application/json"),
    "no format defaults to the raw JSON result, unchanged from before");

  const bad = await get("?format=docx");
  const badBody = await bad.json();
  expect(bad.status === 400 && badBody.error === "unsupported_format",
    "an unknown format is refused with the list of supported ones");

  // Cross-org isolation on every format, not just the one that was tested before.
  await seedOrg(env, { userId: "u_other", email: "other@example.com" });
  for (const format of ["html", "sarif", "cyclonedx", "csv", "json"]) {
    const req = authedRequest(`https://algosize.com/api/runs/${run.id}/report?format=${format}`, { userId: "u_other", params: { id: run.id } });
    const res = await getRunReportHandler(req, env, null);
    expect(res.status === 404, `another org cannot read this run as ${format}`);
  }
}

// ===========================================================================
console.log("\nCSV export\n");
// ===========================================================================
{
  // RFC-4180 first: Excel is the least forgiving reader this file will meet.
  expect(csvCell('with,comma') === '"with,comma"', "a comma forces quoting");
  expect(csvCell('say "hi"') === '"say ""hi"""', "quotes are doubled inside a quoted cell");
  expect(csvCell(null) === "" && csvCell(undefined) === "", "null/undefined render as empty, not the word");

  const run = {
    id: "run_csv1",
    input: { repo: "acme/api-gateway" },
    result: {
      scanned: { manifests: ["package-lock.json"], totalPackages: 412 },
      summary: {
        securityScore: 27, grade: "F", totalIssues: 2, worstSeverity: "critical",
        counts: { critical: 1, high: 1, medium: 0, low: 0, unknown: 0 },
        complete: false,
        partialReason: "This audit hit an internal cap.",
        remediation: [
          { priority: "high", action: "Upgrade lodash, it's got a \"gadget\" chain", why: "Fix exists.", command: "npm install lodash@4.17.21" },
        ],
      },
      advisories: [
        { id: "GHSA-crit", package: "lodash", ecosystem: "npm", installedVersion: "4.17.11",
          fixedIn: "4.17.21", severity: "critical", cvssScore: 9.1, cvssVersion: "3.1",
          approximate: false, cvssVector: "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:N" },
        { id: "GHSA-nofix", package: "node-fetch-npm", ecosystem: "npm", installedVersion: "2.0.2",
          fixedIn: null, severity: "high", cvssScore: null, cvssVersion: null,
          approximate: false, cvssVector: null },
      ],
    },
  };
  const csv = toAuditCsv(run);
  const lines = csv.split("\r\n");

  expect(csv.includes("\r\n"), "lines end CRLF for Excel");
  expect(lines[0].includes("acme/api-gateway"), "the repo rides in the file, not just on the page");
  expect(csv.includes("Score 27/100") && csv.includes("grade F"), "score and grade ride along too");
  expect(csv.includes("COVERAGE INCOMPLETE"), "a truncated audit says so IN the spreadsheet");
  expect(csv.includes("This audit hit an internal cap."), "with the Worker's own partialReason verbatim");

  const header = lines.find((l) => l.startsWith("severity,package"));
  expect(!!header && header.includes("cvss_vector") && header.includes("upgrade_command"),
    "findings header carries the columns a remediation tracker needs");
  const lodash = lines.find((l) => l.includes("GHSA-crit"));
  expect(!!lodash && lodash.includes("npm install lodash@4.17.21"),
    "a fixable advisory row carries its upgrade command");
  expect(lodash.includes("published"), "a published CVSS score is labeled published");
  const nofix = lines.find((l) => l.includes("GHSA-nofix"));
  expect(!!nofix && nofix.includes("none") && !nofix.includes("npm install node-fetch"),
    "an unfixable advisory has no invented command and no invented score");

  expect(lines.some((l) => l === "critical,1"), "the severity tally section is present");
  const rem = lines.find((l) => l.includes("Upgrade lodash"));
  expect(!!rem && rem.includes('""gadget""'),
    "remediation text with embedded quotes survives quoting");

  // The one-click PDF hook: the printable page auto-prints when asked to.
  const html = renderReportHtml(run, { generatedAt: Date.UTC(2026, 7, 20) });
  expect(html.includes('has("print")') && html.includes("window.print()"),
    "the HTML report carries the ?print=1 autoprint hook for the dashboard's PDF export");
}

// ===========================================================================
console.log("\nRouting\n");
// ===========================================================================
{
  // The share route must be reachable with no credentials at all — if it were
  // accidentally placed behind requireAuth the feature would be dead on
  // arrival, and every other test here calls the handler directly.
  const env = makeEnv();
  const res = await worker.fetch(
    new Request("https://algosize.com/api/share/definitely-not-a-token"),
    env,
    { waitUntil() {} },
  );
  expect(res.status !== 401, `GET /api/share/:token is not behind auth (got ${res.status})`);
  const body = await res.json();
  expect(res.status === 404 && body.error === "share_not_found",
    "an unknown token routes to the share handler and 404s there");
}

console.log();
if (failures === 0) {
  console.log("\x1b[32m  all report tests passed\x1b[0m\n");
  process.exit(0);
} else {
  console.log(`\x1b[31m  ${failures} report test(s) failed\x1b[0m\n`);
  process.exit(1);
}
