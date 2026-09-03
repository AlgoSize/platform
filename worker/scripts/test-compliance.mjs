// Tests for the Compliance & Release Audit feature.
//
// Every assertion here is an OVERCLAIM VECTOR — a specific way this feature
// could tell a customer their codebase is more evidenced than it is. That is
// the only failure mode that matters: "too pessimistic" is a support ticket,
// "too generous" is a compliance incident nobody notices until an auditor
// finds it.
//
// Run with:  node scripts/test-compliance.mjs

import { makeD1 } from "./_d1-stub.mjs";
import {
  CATALOG_VERSION, FRAMEWORKS, RESULTS, EVIDENCE_STATES,
  controlsFor, collectorsFor, getControl,
} from "../src/compliance/catalog.js";
import { resolveControlResult, summarize, isoDay, inPeriod } from "../src/compliance/resolve.js";
import { COLLECTORS, runCollectors, gatherRuns } from "../src/compliance/evidence.js";
import {
  coverageHandler, createAttestationHandler, publishAuditHandler,
  listFrameworksHandler, downloadPackHandler, redactEvidence,
  MAX_PERIOD_SECONDS,
} from "../src/handlers/compliance.js";
import { AUDIT_ACTIONS } from "../src/audit.js";

let failures = 0;
const ok   = (msg) => console.log(`  \x1b[32m✓\x1b[0m ${msg}`);
const fail = (msg) => { console.log(`  \x1b[31m✗\x1b[0m ${msg}`); failures++; };
const expect = (cond, label) => (cond ? ok(label) : fail(label));

// The period is RELATIVE TO NOW on purpose. Runs stop being readable at 90
// days, so a hardcoded window would quietly stop finding its own fixtures the
// day it aged past that cutoff — the test would go green while measuring
// nothing. 80 days keeps it inside the window with room to spare.
const NOW = Math.floor(Date.now() / 1000);
const DAY = 86400;
const PERIOD = { start: NOW - 80 * DAY, end: NOW };
const isoDayOf = (sec) => new Date(sec * 1000).toISOString().slice(0, 10);

function section(name) { console.log(`\n\x1b[1m${name}\x1b[0m`); }

// ---------------------------------------------------------------------------
section("Catalog integrity");
// ---------------------------------------------------------------------------

{
  let badCoverage = 0, badCollector = 0, missingWhy = 0, dupes = 0;
  const seen = new Set();
  for (const f of FRAMEWORKS) {
    for (const c of f.controls) {
      const key = `${f.id}:${c.id}`;
      if (seen.has(key)) dupes++;
      seen.add(key);
      if (!EVIDENCE_STATES.includes(c.coverage)) badCoverage++;
      if (c.coverage === "automated" && !COLLECTORS[c.collector]) badCollector++;
      // A "not covered" row is the strongest statement on the page. Shipping
      // one without a sentence explaining why leaves a reader to assume the
      // worst about themselves.
      if (c.coverage === "not_covered" && !c.why) missingWhy++;
      if (c.coverage !== "automated" && c.collector) badCollector++;
    }
  }
  expect(dupes === 0, "no duplicate control ids");
  expect(badCoverage === 0, "every control has a known coverage value");
  expect(badCollector === 0, "every automated control names a registered collector, and only those do");
  expect(missingWhy === 0, "every not-covered control explains why in its own words");
  expect(/^\d{4}-\d{2}-\d{2}\.\d+$/.test(CATALOG_VERSION), "CATALOG_VERSION is dated and revisioned");

  const registered = new Set(Object.keys(COLLECTORS));
  const needed = new Set(FRAMEWORKS.flatMap((f) => collectorsFor(f.id)));
  expect([...needed].every((n) => registered.has(n)),
    "every collector the catalog names is exported from evidence.js");
}

// ---------------------------------------------------------------------------
section("Invariant 1 — `met` is unreachable without evidence");
// ---------------------------------------------------------------------------

{
  let leaked = [];
  for (const f of FRAMEWORKS) {
    for (const control of f.controls) {
      const r = resolveControlResult({
        control, evidence: null, attestation: null, period: PERIOD, now: NOW,
      });
      if (r.result === "met") leaked.push(`${f.id}:${control.id}`);
      if (!RESULTS.includes(r.result)) leaked.push(`${f.id}:${control.id} (bad result)`);
    }
  }
  expect(leaked.length === 0,
    `no control reads "met" with no evidence and no attestation${leaked.length ? " — " + leaked.join(", ") : ""}`);
}

// ---------------------------------------------------------------------------
section("Invariant 2 — a not-covered control has no result");
// ---------------------------------------------------------------------------

{
  const control = { id: "X.1", coverage: "not_covered", title: "t", why: "no artifact exists" };
  // Even handed a glowing collector verdict, a not-covered control must not
  // take it: the return happens before any evidence is read.
  const r = resolveControlResult({
    control,
    evidence: { status: "present", verdict: "met", rationale: "looks great", qualifiers: [] },
    attestation: { statement: "we do this", expiresAt: NOW + 86400, kind: "attested" },
    period: PERIOD, now: NOW,
  });
  expect(r.evidenceState === "not_covered", "evidence state stays not_covered");
  expect(r.result !== "met", "result is never met");
  expect(r.result !== "not_met", "result is never not_met — that would be a finding about the customer");
  expect(r.qualifiers.includes("no_artifact_possible"), "carries the no_artifact_possible qualifier");
  expect(r.rationale === "no artifact exists", "quotes the catalog's own sentence");

  const rows = [
    { evidenceState: "not_covered", result: "insufficient_evidence" },
    { evidenceState: "automated", result: "met" },
  ];
  const s = summarize(rows);
  expect(s.byResult.insufficient_evidence === 0,
    "the not-covered placeholder is excluded from the result tally");
  expect(s.byState.not_covered === 1, "but it is counted in the evidence-state tally");
  expect(s.total === 2, "and in the total");
}

// ---------------------------------------------------------------------------
section("Invariant 3-4 — attestation lifecycle");
// ---------------------------------------------------------------------------

{
  const control = { id: "A.1", coverage: "attested", title: "t" };

  const live = resolveControlResult({
    control, evidence: null, period: PERIOD, now: NOW,
    attestation: { statement: "we do this", expiresAt: NOW + 86400, attestedAt: NOW - 10,
                   ownerEmail: "a@b.com", kind: "attested" },
  });
  expect(live.result === "met", "a live attestation reads met");
  expect(live.evidenceState === "attested", "and is labelled attested, not automated");

  const expired = resolveControlResult({
    control, evidence: null, period: PERIOD, now: NOW,
    attestation: { statement: "we do this", expiresAt: NOW - 1, attestedAt: NOW - 100, kind: "attested" },
  });
  expect(expired.result === "attestation_expired",
    "an expired attestation reads attestation_expired, not met");
  expect(expired.rationale.includes(isoDay(NOW - 1)),
    "and the rationale names the date it lapsed");

  const revoked = resolveControlResult({
    control, evidence: null, period: PERIOD, now: NOW,
    attestation: { statement: "we do this", expiresAt: NOW + 86400, revokedAt: NOW - 5, kind: "attested" },
  });
  expect(revoked.result !== "met" && revoked.evidenceState === "not_covered",
    "a revoked attestation is ignored entirely — no evidence, not weak evidence");

  const na = resolveControlResult({
    control, evidence: null, period: PERIOD, now: NOW,
    attestation: { statement: "out of scope", expiresAt: NOW + 86400, kind: "not_applicable" },
  });
  expect(na.result === "not_applicable", "a live not_applicable claim reads not_applicable");

  const naExpired = resolveControlResult({
    control, evidence: null, period: PERIOD, now: NOW,
    attestation: { statement: "out of scope", expiresAt: NOW - 1, kind: "not_applicable" },
  });
  expect(naExpired.result === "attestation_expired",
    "an expired scoping claim expires too — scoping is a claim someone owns");
}

// ---------------------------------------------------------------------------
section("Invariant 5-8 — collector downgrades");
// ---------------------------------------------------------------------------

{
  const control = { id: "Z.1", coverage: "automated", title: "t", collector: "x" };

  const stale = resolveControlResult({
    control, period: PERIOD, now: NOW, attestation: null,
    evidence: { status: "outside_period", verdict: "met", capturedAt: PERIOD.start - 86400 * 30,
                qualifiers: [] },
  });
  expect(stale.result === "insufficient_evidence", "a run outside the period is not evidence for it");
  expect(stale.rationale.includes(isoDay(PERIOD.start)) &&
         stale.rationale.includes(isoDay(PERIOD.start - 86400 * 30)),
    "and the rationale names both the scan date and the period start");

  for (const [q, field] of [["single_scan", "rationaleSingleScan"],
                            ["sbom_incomplete", "rationaleIncomplete"],
                            ["shallow_coverage", "rationaleShallow"]]) {
    const r = resolveControlResult({
      control, period: PERIOD, now: NOW, attestation: null,
      evidence: { status: "present", verdict: "met", rationale: "clean",
                  [field]: `because of ${q}`, qualifiers: [q] },
    });
    expect(r.result === "insufficient_evidence", `${q} downgrades a met verdict`);
    expect(r.rationale === `because of ${q}`, `${q} replaces the rationale with its own reason`);
  }

  const bogus = resolveControlResult({
    control, period: PERIOD, now: NOW, attestation: null,
    evidence: { status: "present", verdict: "definitely_fine", qualifiers: [] },
  });
  expect(bogus.result === "insufficient_evidence",
    "an unrecognised verdict is treated as no verdict rather than trusted");

  const smuggled = resolveControlResult({
    control, period: PERIOD, now: NOW, attestation: null,
    evidence: { status: "present", verdict: "not_applicable", qualifiers: [] },
  });
  expect(smuggled.result === "insufficient_evidence",
    "a collector cannot scope a control out — not_applicable is a human's claim");
}

// ---------------------------------------------------------------------------
section("Invariant 10 — the resolver can only downgrade");
// ---------------------------------------------------------------------------

{
  // Property check over every ordered pair: whatever a collector proposes,
  // adding a qualifier must never move the answer towards `met`.
  const RANK = { met: 0, not_met: 1, attestation_expired: 2, insufficient_evidence: 3 };
  const control = { id: "P.1", coverage: "automated", title: "t", collector: "x" };
  let violations = 0;
  for (const verdict of ["met", "not_met", "insufficient_evidence"]) {
    for (const qualifiers of [[], ["single_scan"], ["sbom_incomplete"], ["shallow_coverage"],
                              ["single_scan", "shallow_coverage"]]) {
      const bare = resolveControlResult({
        control, period: PERIOD, now: NOW, attestation: null,
        evidence: { status: "present", verdict, qualifiers: [] },
      });
      const qualified = resolveControlResult({
        control, period: PERIOD, now: NOW, attestation: null,
        evidence: { status: "present", verdict, qualifiers },
      });
      if (RANK[qualified.result] < RANK[bare.result]) violations++;
    }
  }
  expect(violations === 0, "no qualifier combination strengthens a verdict");
}

// ---------------------------------------------------------------------------
section("Invariant 13 — timestamp units");
// ---------------------------------------------------------------------------

{
  // runs.created_at is MILLISECONDS; everything else here is seconds. Getting
  // this wrong returns no rows and silently empties every audit.
  const env = { DB: makeD1() };
  const orgId = "org_units";
  const createdMs = (PERIOD.start + 86400 * 10) * 1000;
  await env.DB.prepare(
    `INSERT INTO runs (id, user_id, org_id, source, analyzer, input_json, result_json, ms, headline, created_at)
     VALUES (?, NULL, ?, 'monitor', 'vuln', ?, ?, 1, 'h', ?)`,
  ).bind("run_units", orgId,
         JSON.stringify({ repoUrl: "https://github.com/acme/api" }),
         JSON.stringify({ repoUrl: "https://github.com/acme/api", advisories: [], counts: {},
                          packages: [], scanned: { packagesFound: 0, manifests: [] } }),
         createdMs).run();

  const runs = await gatherRuns(env, {
    orgId, repoUrl: "https://github.com/acme/api", period: PERIOD,
  });
  expect(runs.vuln.length === 1, "a run stored in ms is found by a period expressed in seconds");
  expect(runs.vuln[0].capturedAt === Math.floor(createdMs / 1000),
    "and its capturedAt is converted to seconds for the resolver");
  expect(inPeriod(runs.vuln[0].capturedAt, PERIOD), "which then lands inside the period");
}

// ---------------------------------------------------------------------------
section("Collectors read the field they claim to");
// ---------------------------------------------------------------------------

function vulnRun(overrides = {}) {
  return {
    runId: "run_1", analyzer: "vuln", source: "monitor",
    createdAtMs: (PERIOD.start + 86400) * 1000,
    capturedAt: PERIOD.start + 86400,
    input: { repoUrl: "https://github.com/acme/api" },
    result: {
      repoUrl: "https://github.com/acme/api",
      advisories: [], counts: { critical: 0, high: 0 },
      packages: [{ name: "a", version: "1", ecosystem: "npm" }],
      scanned: { packagesFound: 1, manifests: [{ filename: "package-lock.json" }] },
      summary: { complete: true },
      source: {
        status: "ok", findings: [], summary: {},
        coverage: { filesScanned: 40, filesEligible: 40, suppressedInTests: 0 },
        profile: { languages: [{ id: "js", name: "JavaScript", supportTier: 1 }],
                   manifests: [{ path: "package-lock.json", audited: true }],
                   scanPlan: { gaps: [] } },
      },
      ...overrides,
    },
  };
}

{
  // Invariant 7 — algosize:complete === false can never read as met.
  const run = vulnRun();
  run.result.scanned.packagesFound = 9;   // found 9, resolved 1
  const ev = COLLECTORS.sbomProvenance({ runs: { vuln: [run], arch: [] }, period: PERIOD });
  expect(ev.qualifiers.includes("sbom_incomplete"),
    "sbomProvenance flags an SBOM its own generator would mark incomplete");
  const r = resolveControlResult({
    control: getControl("ssdf-1.1", "PS.3.2"), evidence: ev, attestation: null,
    period: PERIOD, now: NOW,
  });
  expect(r.result !== "met", "so PS.3.2 cannot read met");
  const cra = resolveControlResult({
    control: getControl("cra-annex1-ii", "II.1"), evidence: ev, attestation: null,
    period: PERIOD, now: NOW,
  });
  expect(cra.result !== "met", "and neither can CRA II.1, which shares the collector");
}

{
  // Invariant 8 — a tier-3/4 language or a declared gap downgrades PW.7.2.
  const run = vulnRun();
  run.result.source.profile.languages = [{ id: "rb", name: "Ruby", supportTier: 3 }];
  run.result.source.profile.scanPlan.gaps = [
    { kind: "pattern_only_languages", detail: "Ruby is matched by pattern only." },
  ];
  const ev = COLLECTORS.codeAnalysisPerformed({ runs: { vuln: [run, run], arch: [] }, period: PERIOD });
  expect(ev.qualifiers.includes("shallow_coverage"), "codeAnalysisPerformed flags shallow coverage");
  expect(ev.rationaleShallow.includes("Ruby is matched by pattern only."),
    "and quotes the scan plan's own gap sentence verbatim rather than paraphrasing it");
  const r = resolveControlResult({
    control: getControl("ssdf-1.1", "PW.7.2"), evidence: ev, attestation: null,
    period: PERIOD, now: NOW,
  });
  expect(r.result === "insufficient_evidence", "so PW.7.2 downgrades");
}

{
  // Invariant 6 — one scan cannot evidence a practice.
  const run = vulnRun();
  const one = COLLECTORS.repeatedReview({ runs: { vuln: [run], arch: [] }, period: PERIOD });
  expect(one.qualifiers.includes("single_scan"), "one run flags single_scan on RV.1.2");
  const r1 = resolveControlResult({
    control: getControl("ssdf-1.1", "RV.1.2"), evidence: one, attestation: null,
    period: PERIOD, now: NOW,
  });
  expect(r1.result !== "met", "so RV.1.2 cannot read met from a single scan");

  const two = COLLECTORS.repeatedReview({ runs: { vuln: [run, run], arch: [] }, period: PERIOD });
  expect(!two.qualifiers.includes("single_scan"), "two runs clear the flag");
  const r2 = resolveControlResult({
    control: getControl("ssdf-1.1", "RV.1.2"), evidence: two, attestation: null,
    period: PERIOD, now: NOW,
  });
  expect(r2.result === "met", "and RV.1.2 then reads met");
}

{
  // Invariant 9 — a null monitor baseline is unknown, never clean.
  const run = vulnRun();
  const noBaseline = COLLECTORS.advisoryIntake({
    runs: { vuln: [run], arch: [] }, period: PERIOD,
    monitor: { monitorId: "m1", pausedAt: null, lastAdvisoryIds: null },
  });
  expect(noBaseline.status === "absent",
    "a watch with a null advisory baseline yields no evidence, not clean evidence");
  const r = resolveControlResult({
    control: getControl("ssdf-1.1", "RV.1.1"), evidence: noBaseline, attestation: null,
    period: PERIOD, now: NOW,
  });
  expect(r.result === "insufficient_evidence", "so RV.1.1 reads insufficient, not met");

  const paused = COLLECTORS.advisoryIntake({
    runs: { vuln: [run], arch: [] }, period: PERIOD,
    monitor: { monitorId: "m1", pausedAt: NOW - 100, lastAdvisoryIds: ["GHSA-x"] },
  });
  expect(paused.verdict === "not_met", "a paused watch is a measured failure of intake, not a gap");

  const live = COLLECTORS.advisoryIntake({
    runs: { vuln: [run], arch: [] }, period: PERIOD,
    monitor: { monitorId: "m1", pausedAt: null, lastAdvisoryIds: [] },
  });
  expect(live.verdict === "met", "an empty-but-present baseline is a real baseline");
}

{
  // Absence of a secret is not evidence of secure defaults.
  const clean = COLLECTORS.secureBaseline({ runs: { vuln: [vulnRun()], arch: [] }, period: PERIOD });
  expect(clean.verdict === "insufficient_evidence",
    "secureBaseline never proposes met from finding nothing");

  const dirty = vulnRun();
  dirty.result.source.findings = [{ type: "committed_secret", severity: "high", ruleId: "sec.aws" }];
  const bad = COLLECTORS.secureBaseline({ runs: { vuln: [dirty], arch: [] }, period: PERIOD });
  expect(bad.verdict === "not_met", "but a committed credential is a measured failure");
}

{
  // A dependency graph is not a threat model.
  const archRun = {
    runId: "run_a", analyzer: "arch", source: "monitor",
    capturedAt: PERIOD.start + 86400, input: {}, result: { summary: { nodes: 12, edges: 30 } },
  };
  const ev = COLLECTORS.designRecord({ runs: { vuln: [], arch: [archRun] }, period: PERIOD });
  expect(ev.verdict === "insufficient_evidence",
    "designRecord caps below met — an architecture map is supporting material, not a threat model");
  const r = resolveControlResult({
    control: getControl("ssdf-1.1", "PW.1.2"), evidence: ev, attestation: null,
    period: PERIOD, now: NOW,
  });
  expect(r.result !== "met", "so PW.1.2 needs a human claim to go further");
}

{
  // A manual run carries no repository, so it cannot evidence one.
  const env = { DB: makeD1() };
  await env.DB.prepare(
    `INSERT INTO runs (id, user_id, org_id, source, analyzer, input_json, result_json, ms, headline, created_at)
     VALUES (?, 'usr_1', ?, NULL, 'vuln', ?, '{}', 1, 'h', ?)`,
  ).bind("run_manual", "org_r", JSON.stringify({ files: [] }), (PERIOD.start + 100) * 1000).run();
  await env.DB.prepare(
    `INSERT INTO runs (id, user_id, org_id, source, analyzer, input_json, result_json, ms, headline, created_at)
     VALUES (?, NULL, ?, 'ci', 'vuln', ?, '{}', 1, 'h', ?)`,
  ).bind("run_ci", "org_r", JSON.stringify({ repo: "acme/api" }), (PERIOD.start + 200) * 1000).run();

  const runs = await gatherRuns(env, { orgId: "org_r", repoUrl: "https://github.com/acme/api", period: PERIOD });
  expect(runs.vuln.length === 1 && runs.vuln[0].runId === "run_ci",
    "a lockfile someone pasted by hand is not evidence about a repository");
}

{
  // A broken collector must degrade one control, not the page.
  const out = runCollectors(["sbomProvenance", "nosuchcollector"], {
    runs: { vuln: [], arch: [] }, period: PERIOD, monitor: null, patches: [],
  });
  expect(out.nosuchcollector && out.nosuchcollector.status === "absent",
    "an unregistered collector yields absent rather than throwing");
  expect(out.sbomProvenance.status === "absent",
    "and a collector with nothing to read says so plainly");
}

// ---------------------------------------------------------------------------
section("Invariant 11 — redaction");
// ---------------------------------------------------------------------------

{
  const dirty = {
    asserted: "3 findings",
    findings: [{ ruleId: "sast.eval", cwe: ["CWE-95"], file: "a.js", line: 3,
                 snippet: "eval(req.query.q)", evidence: { inTestCode: false } }],
    nested: { deeper: { snippet: "secret", ok: 1 } },
  };
  const clean = redactEvidence(dirty);
  const json = JSON.stringify(clean);
  expect(!json.includes("snippet"), "no snippet key survives redaction at any depth");
  expect(!json.includes("eval(req.query.q)"), "and no matched source text survives");
  expect(json.includes("CWE-95") && json.includes("a.js"),
    "while the rule id, class and location — what an auditor needs — are kept");
}

// ---------------------------------------------------------------------------
section("Handler — period bounds, org scope, attestation rules");
// ---------------------------------------------------------------------------

function makeEnv() {
  return { DB: makeD1(), COOKIE_NAME: "sid", JWT_SECRET: "x".repeat(40) };
}

/** Mirrors seedOwner in test-orgs.mjs — a user, an organisation, a membership. */
async function seedOrg(env, orgId = "org_1", userId = "usr_1") {
  const email = `${userId}@acme.io`;
  await env.DB.prepare(
    `INSERT INTO users (user_id, email, stripe_customer_id, plan, sub_status, created_at, updated_at)
     VALUES (?, ?, NULL, 'free', NULL, ?, ?)`,
  ).bind(userId, email, NOW, NOW).run();
  await env.DB.prepare(
    `INSERT INTO organisations (org_id, name, stripe_customer_id, plan, sub_status,
                                current_period_end, seats_purchased, created_at, updated_at)
     VALUES (?, ?, NULL, 'free', NULL, NULL, 1, ?, ?)`,
  ).bind(orgId, email, NOW, NOW).run();
  await env.DB.prepare(
    `INSERT INTO memberships (org_id, user_id, role, created_at) VALUES (?, ?, 'owner', ?)`,
  ).bind(orgId, userId, NOW).run();
  await env.DB.prepare(`UPDATE users SET active_org_id = ? WHERE user_id = ?`)
    .bind(orgId, userId).run();
  return { orgId, userId };
}

function req(url, { method = "GET", body = null, userId = "usr_1", email = "a@b.com" } = {}) {
  const r = new Request(`https://api.test${url}`, {
    method,
    headers: body ? { "content-type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  r.user = { userId, email };
  return r;
}

{
  const env = makeEnv();
  await seedOrg(env);

  const tooLong = await coverageHandler(
    req(`/api/compliance/coverage?from=${isoDayOf(NOW - 200 * DAY)}&to=${isoDayOf(NOW)}`), env);
  const body = await tooLong.json();
  expect(tooLong.status === 400 && body.error === "period_too_long",
    "a period longer than the evidence window is refused, not answered with false negatives");
  expect(body.message.includes(String(Math.floor(MAX_PERIOD_SECONDS / 86400))),
    "and the message names the limit and the reason");

  const backwards = await coverageHandler(
    req(`/api/compliance/coverage?from=${isoDayOf(NOW)}&to=${isoDayOf(NOW - 30 * DAY)}`), env);
  expect(backwards.status === 400, "a period that ends before it starts is refused");

  const unknown = await coverageHandler(
    req("/api/compliance/coverage?framework=iso-27001"), env);
  expect(unknown.status === 404, "an unknown framework is a 404, not a 500");
}

{
  const env = makeEnv();
  await seedOrg(env);

  const res = await listFrameworksHandler(req("/api/compliance/frameworks"), env);
  const d = await res.json();
  expect(res.status === 200 && d.frameworks.length === FRAMEWORKS.length,
    "the framework list is served from the catalog");
  expect(d.frameworks.every((f) => f.coverage && typeof f.coverage.not_covered === "number"),
    "each carries its own not-covered count, so the honesty is visible before you open it");
  expect(typeof d.disclaimer === "string" && d.disclaimer.length > 80,
    "and the disclaimer travels with it");
}

{
  const env = makeEnv();
  await seedOrg(env);

  // An automated control is answered by an artifact. A signature must not be
  // allowed over the top of a measurement.
  const overridden = await createAttestationHandler(req("/api/compliance/attestations", {
    method: "POST",
    body: { frameworkId: "ssdf-1.1", controlId: "PS.3.2", statement: "trust me",
            ownerEmail: "a@b.com", expiresAt: isoDayOf(NOW + 200 * DAY) },
  }), env, null);
  expect(overridden.status === 400,
    "an attestation cannot override an automated control");

  const perpetual = await createAttestationHandler(req("/api/compliance/attestations", {
    method: "POST",
    body: { frameworkId: "ssdf-1.1", controlId: "PS.1.1", statement: "least privilege enforced",
            ownerEmail: "a@b.com" },
  }), env, null);
  expect(perpetual.status === 400, "an attestation with no end date is refused");

  const past = await createAttestationHandler(req("/api/compliance/attestations", {
    method: "POST",
    body: { frameworkId: "ssdf-1.1", controlId: "PS.1.1", statement: "s",
            ownerEmail: "a@b.com", expiresAt: isoDayOf(NOW - 10 * DAY) },
  }), env, null);
  expect(past.status === 400, "and one that expires in the past is refused");

  const noOwner = await createAttestationHandler(req("/api/compliance/attestations", {
    method: "POST",
    body: { frameworkId: "ssdf-1.1", controlId: "PS.1.1", statement: "s", expiresAt: isoDayOf(NOW + 200 * DAY) },
  }), env, null);
  expect(noOwner.status === 400, "an attestation with no accountable owner is refused");

  const good = await createAttestationHandler(req("/api/compliance/attestations", {
    method: "POST",
    body: { frameworkId: "ssdf-1.1", controlId: "PS.1.1", statement: "Repo access is least-privilege.",
            ownerEmail: "sec@acme.io", expiresAt: isoDayOf(NOW + 300 * DAY) },
  }), env, null);
  expect(good.status === 201, "a complete attestation is stored");

  const cov = await coverageHandler(req("/api/compliance/coverage"), env);
  const d = await cov.json();
  const row = d.controls.find((c) => c.id === "PS.1.1");
  expect(row.result === "met" && row.evidenceState === "attested",
    "and shows up on the coverage map as an attested, met control");
  expect(row.attestation && row.attestation.ownerEmail === "sec@acme.io",
    "carrying its owner, so a reader can see who signed without trusting the verdict");
}

{
  // Org scope: one org's attestation must never surface on another's map.
  const env = makeEnv();
  await seedOrg(env, "org_a", "usr_a");
  await seedOrg(env, "org_b", "usr_b");

  await createAttestationHandler(req("/api/compliance/attestations", {
    method: "POST", userId: "usr_a",
    body: { frameworkId: "ssdf-1.1", controlId: "PS.1.1", statement: "ours",
            ownerEmail: "a@a.io", expiresAt: isoDayOf(NOW + 300 * DAY) },
  }), env, null);

  const other = await coverageHandler(req("/api/compliance/coverage", { userId: "usr_b" }), env);
  const d = await other.json();
  const row = d.controls.find((c) => c.id === "PS.1.1");
  expect(row && !row.attestation && row.result !== "met",
    "another organisation sees no trace of it");
}

// ---------------------------------------------------------------------------
section("Publishing freezes a self-describing record");
// ---------------------------------------------------------------------------

{
  const env = makeEnv();
  await seedOrg(env);
  await env.DB.prepare(
    `INSERT INTO monitors (monitor_id, org_id, repo_url, branch, schedule, created_at)
     VALUES (?, ?, ?, 'main', 'daily', ?)`,
  ).bind("mon_1", "org_1", "https://github.com/acme/api", NOW - 86400).run();

  const res = await publishAuditHandler(req("/api/compliance/audits", {
    method: "POST",
    body: { frameworkId: "ssdf-1.1", monitorId: "mon_1", from: isoDayOf(NOW - 80 * DAY), to: isoDayOf(NOW) },
  }), env, null);
  const { audit } = await res.json();
  expect(res.status === 201, "an audit publishes");
  expect(/^[0-9a-f]{64}$/.test(audit.packSha256), "with a SHA-256 over its canonical form");
  expect(audit.retainUntil === audit.periodEnd + 60 * 60 * 24 * 365,
    "and a one-year retention past the period it describes");
  expect(audit.catalogVersion === CATALOG_VERSION, "stamped with the catalog it was cut against");

  const frozen = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM compliance_audit_controls WHERE audit_id = ?`,
  ).bind(audit.id).first();
  expect(frozen.n === controlsFor("ssdf-1.1").length,
    "one frozen row per control — every one, including the not-covered ones");

  const notCovered = await env.DB.prepare(
    `SELECT result FROM compliance_audit_controls
      WHERE audit_id = ? AND evidence_state = 'not_covered' AND result = 'met'`,
  ).bind(audit.id).all();
  expect((notCovered.results || []).length === 0,
    "and no not-covered control was frozen as met");

  const pack = await downloadPackHandler(
    Object.assign(req(`/api/compliance/audits/${audit.id}/pack`), { params: { id: audit.id } }), env);
  const text = await pack.text();
  expect(pack.status === 200 && pack.headers.get("content-disposition").includes(audit.id),
    "the record downloads as a named file");
  expect(!text.includes("snippet"), "with no source snippet anywhere in it");
  expect(text.includes("neither an audit firm nor a notified body"),
    "and the disclaimer embedded inside the file, not only on the website");

  const parsed = JSON.parse(text);
  expect(parsed.controls.every((c) => c.title && c.rationale),
    "every control in the record carries its own wording and reason, so it still reads after the runs age out");

  // A correction supersedes.
  const res2 = await publishAuditHandler(req("/api/compliance/audits", {
    method: "POST",
    body: { frameworkId: "ssdf-1.1", monitorId: "mon_1", from: isoDayOf(NOW - 80 * DAY), to: isoDayOf(NOW),
            supersedes: audit.id },
  }), env, null);
  const second = (await res2.json()).audit;
  const old = await env.DB.prepare(`SELECT status, superseded_by FROM compliance_audits WHERE id = ?`)
    .bind(audit.id).first();
  expect(old.status === "superseded" && old.superseded_by === second.id,
    "a correction supersedes the record it replaces rather than editing it");
}

{
  const env = makeEnv();
  await seedOrg(env);
  const res = await publishAuditHandler(req("/api/compliance/audits", {
    method: "POST", body: { frameworkId: "ssdf-1.1" },
  }), env, null);
  expect(res.status === 400,
    "publishing with no repository under watch is refused — there is nothing to be an audit about");
}

// ---------------------------------------------------------------------------
section("Frozen enums are registered");
// ---------------------------------------------------------------------------

{
  for (const k of ["COMPLIANCE_ATTESTED", "COMPLIANCE_ATTESTATION_REVOKED",
                   "COMPLIANCE_AUDIT_PUBLISHED", "COMPLIANCE_AUDIT_SUPERSEDED"]) {
    expect(typeof AUDIT_ACTIONS[k] === "string", `AUDIT_ACTIONS.${k} is registered`);
  }

  const adminSrc = await import("node:fs").then((fs) =>
    fs.readFileSync(new URL("../src/handlers/admin.js", import.meta.url), "utf8"));
  expect(adminSrc.includes('id: "0028"'),
    "migration 0028 is in the admin MIGRATIONS manifest");
  expect(adminSrc.includes("compliance_attestations"),
    "and the manifest checks the table that would break silently without it");
}

// ---------------------------------------------------------------------------
console.log();
if (failures === 0) {
  console.log("\x1b[32m  all compliance tests passed\x1b[0m\n");
  process.exit(0);
} else {
  console.log(`\x1b[31m  ${failures} compliance test(s) failed\x1b[0m\n`);
  process.exit(1);
}
