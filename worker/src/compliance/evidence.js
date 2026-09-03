// Collectors — the only place stored analyzer output becomes compliance evidence.
//
// A collector reads runs this organisation already paid for and proposes a
// verdict it can defend from a named field. It never decides the final answer:
// everything it returns goes through resolveControlResult (resolve.js), which
// can weaken a verdict but never strengthen one. That split is deliberate — a
// bug in here makes the page too pessimistic, not too generous.
//
// ---------------------------------------------------------------------------
// UNITS. Read this before touching a timestamp.
// ---------------------------------------------------------------------------
// `runs.created_at`      MILLISECONDS (migrations/0001_init.sql:43, and the
//                        comment there says why it stayed that way).
// `monitors.*_at`        seconds.
// `scan_patches.created_at`  seconds.
// `capturedAt` on the evidence object  SECONDS — isoDay() multiplies by 1000.
//
// The period arrives in seconds and is converted once, at the query. Getting
// this wrong does not throw: it silently returns no rows, and every automated
// control reads "insufficient evidence" for a reason the page cannot explain.

import { RUN_TTL_SECONDS } from "../handlers/runs.js";
import { normaliseRepo } from "../repo-key.js";
import { inPeriod, isoDay } from "./resolve.js";

/** Analyzers a collector might need. Queried once each, not once per control. */
const NEEDED_ANALYZERS = Object.freeze(["vuln", "arch"]);

/** Above this the "several scans" claim holds; at or below it is a snapshot. */
const PRACTICE_MIN_RUNS = 2;

/** Support tiers 3 and 4 are line-level pattern matching, not dataflow. A
 *  control evidenced mostly by them is qualified, never failed. */
const SHALLOW_TIER = 3;

// ---------------------------------------------------------------------------
// Gathering
// ---------------------------------------------------------------------------

/**
 * Every run this org stored for the monitored repository inside the period.
 *
 * NOTE ON `source`: this query deliberately does NOT filter on it. `listRuns`
 * maps the "manual" filter to `source IS NULL` (handlers/runs.js:335) while
 * estimate_history.js:119 writes the literal string 'manual' — a filter on that
 * column under-counts the inventory and makes a control read as unevidenced
 * when the evidence is sitting in the table. Filter on repo instead, below.
 */
export async function gatherRuns(env, { orgId, repoUrl, period }) {
  const out = {};
  for (const analyzer of NEEDED_ANALYZERS) out[analyzer] = [];
  if (!env || !env.DB || !orgId) return out;

  // The 90-day read-time cutoff applies here for the same reason it applies in
  // listRuns: rows older than it are not visible anywhere else in the product,
  // and an audit that could see them would be asserting facts the customer
  // cannot open. Bounds are milliseconds; the period is seconds.
  const cutoffMs = Date.now() - RUN_TTL_SECONDS * 1000;
  const fromMs = period.start * 1000;
  const toMs = period.end * 1000;

  for (const analyzer of NEEDED_ANALYZERS) {
    let rows = [];
    try {
      const res = await env.DB.prepare(
        `SELECT id, analyzer, created_at, source, input_json, result_json
           FROM runs
          WHERE org_id = ?
            AND analyzer = ?
            AND created_at BETWEEN ? AND ?
            AND created_at > ?
          ORDER BY created_at DESC
          LIMIT 200`,
      ).bind(orgId, analyzer, fromMs, toMs, cutoffMs).all();
      rows = (res && res.results) || [];
    } catch {
      // A missing table or an unapplied migration must not take the page down.
      // An empty list reads as "no run in period", which is true and honest.
      rows = [];
    }
    out[analyzer] = rows.map(decodeRun).filter((r) => r && matchesRepo(r, repoUrl));
  }
  return out;
}

function decodeRun(row) {
  if (!row) return null;
  let input = null;
  let result = null;
  try { input = row.input_json ? JSON.parse(row.input_json) : null; } catch { input = null; }
  try { result = row.result_json ? JSON.parse(row.result_json) : null; } catch { result = null; }
  return {
    runId: row.id,
    analyzer: row.analyzer,
    createdAtMs: row.created_at,
    // Every consumer downstream works in seconds. Converted once, here.
    capturedAt: Math.floor(row.created_at / 1000),
    source: row.source || null,
    input,
    result,
  };
}

/**
 * Does this run belong to the audited repository?
 *
 * `runs` has no repo column — the repository lives in `input_json`, and is only
 * trustworthy on a CI or monitor run (handlers/runs.js:402). A manual run of an
 * arbitrary lockfile carries no repository at all, so it cannot be counted as
 * evidence about one. That exclusion is the point, not a limitation.
 */
function matchesRepo(run, repoUrl) {
  if (!repoUrl) return false;
  const target = normaliseRepo(repoUrl);
  const candidates = [];
  if (run.input && typeof run.input === "object") {
    for (const k of ["repoUrl", "repo", "repository"]) {
      if (typeof run.input[k] === "string") candidates.push(run.input[k]);
    }
  }
  if (run.result && typeof run.result === "object" && typeof run.result.repoUrl === "string") {
    candidates.push(run.result.repoUrl);
  }
  return candidates.some((c) => normaliseRepo(c) === target);
}

// `normaliseRepo` moved to ../repo-key.js when the accepted-risk register
// became its second caller. Re-exported so this module's own callers are
// untouched, and so there is exactly one definition of the repository key.
export { normaliseRepo };

/** Patches an external agent reported applying inside the period. Seconds. */
export async function gatherPatches(env, { orgId, period }) {
  if (!env || !env.DB || !orgId) return [];
  try {
    const res = await env.DB.prepare(
      `SELECT id, run_id, fingerprint, rule_id, status, created_at
         FROM scan_patches
        WHERE org_id = ? AND created_at BETWEEN ? AND ?`,
    ).bind(orgId, period.start, period.end).all();
    return (res && res.results) || [];
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Collector helpers
// ---------------------------------------------------------------------------

const absent = (reason) => ({ status: "absent", reason });

/** The newest run of an analyzer, or an "absent" evidence object saying so. */
function newest(runs, analyzer, what) {
  const list = runs[analyzer] || [];
  if (!list.length) {
    return {
      run: null,
      missing: absent(
        `No ${analyzer} scan of this repository ran inside the evidence period, so ${what} was never produced.`,
      ),
    };
  }
  return { run: list[0], missing: null };
}

function provenanceOf(run) {
  const where = run.source === "ci" ? "CI" : run.source === "monitor" ? "nightly sweep" : "dashboard";
  return `${where} run ${run.runId} · ${isoDay(run.capturedAt)}`;
}

function baseFrom(run, extra) {
  return {
    status: "present",
    capturedAt: run.capturedAt,
    runId: run.runId,
    analyzer: run.analyzer,
    provenance: provenanceOf(run),
    qualifiers: [],
    ...extra,
  };
}

/** Source-scan block off a vuln run, or null when the scan could not run. */
function sourceBlock(run) {
  const s = run && run.result && run.result.source;
  return s && s.status === "ok" ? s : null;
}

/** Languages the profile could only pattern-match, plus the plan's own gaps. */
function shallowness(source) {
  const profile = (source && source.profile) || null;
  const langs = (profile && profile.languages) || [];
  const shallow = langs
    .filter((l) => typeof l.supportTier === "number" && l.supportTier >= SHALLOW_TIER)
    .map((l) => l.name || l.id);
  const gaps = ((profile && profile.scanPlan && profile.scanPlan.gaps) || [])
    .map((g) => (g && g.detail) || "")
    .filter(Boolean);
  return { shallow, gaps, any: shallow.length > 0 || gaps.length > 0 };
}

/** One sentence quoting the scan plan's own words rather than paraphrasing. */
function shallowRationale({ shallow, gaps }) {
  const parts = [];
  if (shallow.length) {
    parts.push(
      `${shallow.join(", ")} ${shallow.length === 1 ? "was" : "were"} matched line by line rather than followed from input to sink, which is a weaker claim than the rest of the scan.`,
    );
  }
  for (const g of gaps) parts.push(g);
  return parts.join(" ");
}

// ---------------------------------------------------------------------------
// The collectors
// ---------------------------------------------------------------------------

/**
 * PO.3.3 — the toolchain is integrated into the development pipeline.
 *
 * Evidenced by scans that ran as part of CI or on a schedule. A dashboard run
 * someone kicked off by hand is a person doing a scan; it is not a toolchain
 * integrated into anything, so it does not count towards this control.
 */
export function toolchainArtifacts({ runs, monitor, period }) {
  const all = [...(runs.vuln || []), ...(runs.arch || [])];
  const automated = all.filter((r) => r.source === "ci" || r.source === "monitor");
  if (!automated.length) {
    return absent(
      "No scan inside the evidence period ran from CI or from a schedule — every run was started by hand, which shows a person using the tool rather than a toolchain integrated into the pipeline.",
    );
  }
  const ci = automated.filter((r) => r.source === "ci").length;
  const scheduled = automated.length - ci;
  const configured = monitorAnalyzers(monitor);
  const newestRun = automated[0];

  return baseFrom(newestRun, {
    verdict: "met",
    asserted: `${automated.length} automated scan${automated.length === 1 ? "" : "s"} · ${ci} from CI, ${scheduled} scheduled`,
    rationale:
      `The toolchain ran without anyone asking it to, ${automated.length} time${automated.length === 1 ? "" : "s"} between ${isoDay(period.start)} and ${isoDay(period.end)}. ` +
      `The watch is configured for ${configured.join(", ")}.`,
    qualifiers: automated.length < PRACTICE_MIN_RUNS ? ["single_scan"] : [],
    rationaleSingleScan:
      "One automated run in three months shows the toolchain can run, not that it is part of the pipeline. Two or more is the difference.",
  });
}

/** `analyzers` is a JSON array; NULL means the original vuln-only default. */
function monitorAnalyzers(monitor) {
  if (!monitor) return ["vuln"];
  const raw = monitor.analyzers;
  if (Array.isArray(raw) && raw.length) return raw;
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length) return parsed;
    } catch { /* fall through to the default */ }
  }
  return ["vuln"];
}

/**
 * PS.3.2 / CRA II.1 — provenance data for every component of a release.
 *
 * The flagship control, and the one with the sharpest failure mode. The SBOM is
 * not stored: toCycloneDX (analyzers/cyclonedx.js:145) builds it on demand from
 * the run, and its `algosize:complete` property is computed at cyclonedx.js:169
 * as `packagesFound <= components`. That same arithmetic is repeated here so
 * the compliance answer and the SBOM the auditor downloads cannot disagree.
 *
 * An SBOM its own generator marks incomplete is provenance for part of a
 * release, which is not provenance for the release.
 */
export function sbomProvenance({ runs }) {
  const { run, missing } = newest(runs, "vuln", "a bill of materials");
  if (missing) return missing;

  const result = run.result || {};
  const packages = Array.isArray(result.packages) ? result.packages : [];
  const refs = new Set(packages.map((p) => `${p.ecosystem || "?"}:${p.name}@${p.version || ""}`));
  const scanned = result.scanned || {};
  const found = typeof scanned.packagesFound === "number" ? scanned.packagesFound : refs.size;
  const complete = found <= refs.size;
  const manifests = Array.isArray(scanned.manifests) ? scanned.manifests.length : 0;

  return baseFrom(run, {
    verdict: "met",
    asserted: `${refs.size} components · ${manifests} manifest${manifests === 1 ? "" : "s"}`,
    rationale:
      `A CycloneDX 1.5 bill of materials covering ${refs.size} components with package URLs is generated from this scan on request.`,
    qualifiers: complete ? [] : ["sbom_incomplete"],
    rationaleIncomplete:
      `The scan found ${found} packages but could only resolve ${refs.size} into components, so the generated SBOM marks itself incomplete. Provenance for part of a release is not provenance for the release.`,
  });
}

/**
 * PW.4.1 / CRA II.2 — components are well-secured, and known problems get fixed.
 *
 * This is the one control where `not_met` is the right answer rather than
 * `insufficient_evidence`: an unfixed critical advisory against a shipped
 * dependency is a measured fact about the codebase, not a gap in what we saw.
 */
export function componentHealth({ runs }) {
  const { run, missing } = newest(runs, "vuln", "a dependency advisory count");
  if (missing) return missing;

  const result = run.result || {};
  const counts = result.counts || {};
  const critical = counts.critical || 0;
  const high = counts.high || 0;
  const summary = result.summary || {};
  // `complete === false` means the counts are a FLOOR (analyzers/audit.js:193).
  // A floor of zero is not zero.
  const complete = summary.complete !== false;

  const clean = critical === 0 && high === 0;
  return baseFrom(run, {
    verdict: clean ? "met" : "not_met",
    asserted: `${critical} critical · ${high} high · ${result.advisories ? result.advisories.length : 0} total`,
    rationale: clean
      ? "No critical or high-severity published advisory affects a dependency this repository ships."
      : `${critical + high} advisor${critical + high === 1 ? "y" : "ies"} at high or critical severity affect dependencies this repository ships, and were still open at the last scan in the period.`,
    qualifiers: complete ? [] : ["sbom_incomplete"],
    rationaleIncomplete:
      "The scan truncated before it finished, so these counts are a floor rather than a total. A floor of zero is not the same as zero.",
  });
}

/**
 * PW.4.4 — verify that acquired components are what they claim to be.
 *
 * Evidenced by which manifests the audit could actually parse. A manifest the
 * profiler saw but could not audit is the honest gap here: those dependencies
 * were never checked, and counting them would be the overclaim.
 */
export function componentVerification({ runs }) {
  const { run, missing } = newest(runs, "vuln", "a manifest inventory");
  if (missing) return missing;

  const source = sourceBlock(run);
  const profile = (source && source.profile) || null;
  const declared = (profile && profile.manifests) || [];
  const audited = declared.filter((m) => m && m.audited);
  const unaudited = declared.filter((m) => m && !m.audited);
  const scanned = (run.result && run.result.scanned) || {};
  const parsed = Array.isArray(scanned.manifests) ? scanned.manifests.length : audited.length;

  if (!parsed) {
    return absent(
      "The scan parsed no dependency manifest, so nothing in this repository's supply chain was verified against a published advisory database.",
    );
  }

  return baseFrom(run, {
    verdict: "met",
    asserted: `${parsed} manifest${parsed === 1 ? "" : "s"} audited${unaudited.length ? ` · ${unaudited.length} not audited` : ""}`,
    rationale:
      `Every package in ${parsed} parsed manifest${parsed === 1 ? "" : "s"} was resolved to a name and version and checked against OSV.`,
    qualifiers: unaudited.length ? ["shallow_coverage"] : [],
    rationaleShallow: unaudited.length
      ? `${unaudited.length} manifest${unaudited.length === 1 ? " was" : "s were"} found but not audited (${unaudited.map((m) => m.path || m.file).filter(Boolean).join(", ")}). Their dependencies were never checked.`
      : "",
  });
}

/**
 * PW.5.1 — implement software using secure coding practices.
 *
 * Read from what the source scan found, not from what it did not find. An empty
 * finding list on a shallow scan is not evidence of secure coding, which is why
 * the shallow qualifier is attached here as well as on PW.7.2.
 */
export function secureCoding({ runs }) {
  const { run, missing } = newest(runs, "vuln", "a source-code scan");
  if (missing) return missing;

  const source = sourceBlock(run);
  if (!source) {
    return absent(
      "The source scan did not complete for this repository, so no claim about coding practice can be read from it.",
    );
  }

  const findings = Array.isArray(source.findings) ? source.findings : [];
  // OPEN critical/high, not all of them. A finding a named person has signed
  // for, with a written reason and a date it runs out, is not an unremediated
  // defect — and PW.5.1 asking "did you follow secure coding practice" is
  // answered by the acceptance as much as by the absence. What keeps that
  // honest is that the acceptance TRAVELS: every accepted high is named
  // below, with its owner and expiry, into the rationale a published pack
  // carries. A count would be skimmable into a lie; a list is not.
  const isSevere = (f) => f.severity === "critical" || f.severity === "high";
  const high = findings.filter((f) => isSevere(f) && !f.accepted);
  const acceptedHigh = findings.filter((f) => isSevere(f) && f.accepted);
  const shallow = shallowness(source);
  const coverage = source.coverage || {};

  const acceptedNote = acceptedHigh.length
    ? " " + acceptedHigh.map((f) =>
        `${f.path} (${f.ruleId}) accepted by ${f.acceptance.ownerEmail} until ${f.acceptance.expiresOn}`).join("; ") + "."
    : "";

  return baseFrom(run, {
    verdict: high.length === 0 ? "met" : "not_met",
    asserted: `${findings.length} finding${findings.length === 1 ? "" : "s"} across ${coverage.filesScanned || 0} files` +
      (acceptedHigh.length
        ? ` · ${acceptedHigh.length} accepted` : ""),
    rationale: (high.length === 0
      ? `No critical or high-severity code finding was open across ${coverage.filesScanned || 0} scanned files.`
      : `${high.length} critical or high-severity code finding${high.length === 1 ? "" : "s"} remained open at the last scan in the period.`) +
      (acceptedHigh.length
        ? ` ${acceptedHigh.length} ${acceptedHigh.length === 1 ? "was" : "were"} signed for as an accepted risk:${acceptedNote}`
        : ""),
    // `accepted_risk` does NOT weaken the result. A named owner, a written
    // reason and an expiry IS the answer this control asks for; what would be
    // dishonest is the acceptance not travelling with it, which is why the
    // rationale above names every one.
    qualifiers: [
      ...(shallow.any ? ["shallow_coverage"] : []),
      ...(acceptedHigh.length ? ["accepted_risk"] : []),
    ],
    rationaleShallow: shallowRationale(shallow),
  });
}

/**
 * PW.7.2 / CRA II.3 — review or analyse human-readable code against a standard.
 *
 * Tier-qualified. The language profile knows which languages got dataflow
 * analysis and which got pattern matching, and it publishes its own gaps. Both
 * are quoted verbatim rather than summarised — a paraphrase of a coverage gap
 * is how a coverage gap stops being one.
 */
export function codeAnalysisPerformed({ runs, period }) {
  const list = runs.vuln || [];
  if (!list.length) {
    return absent(
      "No source-code analysis ran against this repository inside the evidence period.",
    );
  }
  const run = list[0];
  const source = sourceBlock(run);
  if (!source) {
    const status = (run.result && run.result.source && run.result.source.status) || "unknown";
    return absent(
      `The most recent scan reached the repository but its source analysis ended as "${status}", so no code was reviewed by this tool inside the period.`,
    );
  }

  const coverage = source.coverage || {};
  const findings = Array.isArray(source.findings) ? source.findings : [];
  const rules = new Set(findings.map((f) => f.ruleId).filter(Boolean));
  const shallow = shallowness(source);
  const suppressed = coverage.suppressedInTests || 0;

  const qualifiers = [];
  if (shallow.any) qualifiers.push("shallow_coverage");
  if (list.length < PRACTICE_MIN_RUNS) qualifiers.push("single_scan");

  return baseFrom(run, {
    verdict: "met",
    asserted:
      `${coverage.filesScanned || 0} of ${coverage.filesEligible || coverage.filesScanned || 0} files · ${rules.size} rule${rules.size === 1 ? "" : "s"} raised` +
      (suppressed ? ` · ${suppressed} capped in test code` : ""),
    rationale:
      `Automated analysis ran over ${coverage.filesScanned || 0} files, ${list.length} time${list.length === 1 ? "" : "s"} between ${isoDay(period.start)} and ${isoDay(period.end)}.` +
      (coverage.truncated ? " The file list was truncated, so this is a subset of the repository." : ""),
    qualifiers,
    rationaleShallow: shallowRationale(shallow),
    rationaleSingleScan:
      "One analysis in the period is a snapshot. This control is about review as a practice during development, which a single point cannot show however good the result looks.",
  });
}

/**
 * PW.9.1 — configure software to have secure settings by default.
 *
 * Only the negative half is measurable: a committed credential proves the
 * default was not secure. Finding none proves nothing, which is why a clean
 * result caps at `insufficient_evidence` rather than reading as met.
 */
export function secureBaseline({ runs }) {
  const { run, missing } = newest(runs, "vuln", "a secrets scan");
  if (missing) return missing;

  const source = sourceBlock(run);
  if (!source) {
    return absent("The source scan did not complete, so no secrets baseline was produced.");
  }
  const findings = Array.isArray(source.findings) ? source.findings : [];
  const secrets = findings.filter(
    (f) => f.type === "committed_secret" || (f.ruleId || "").includes("secret"),
  );

  if (secrets.length) {
    return baseFrom(run, {
      verdict: "not_met",
      asserted: `${secrets.length} committed credential${secrets.length === 1 ? "" : "s"}`,
      rationale:
        `${secrets.length} credential${secrets.length === 1 ? " was" : "s were"} found committed to the repository. Whatever the intended default configuration is, this is not it.`,
    });
  }

  return baseFrom(run, {
    // Deliberately not `met`. The absence of a committed secret is a negative
    // signal about one failure mode, not evidence that defaults are secure.
    verdict: "insufficient_evidence",
    asserted: "no committed credentials found",
    rationale:
      "No credential was found committed to the repository. That rules out one specific failure; it is not evidence that the software ships with secure default settings, which this tool cannot see.",
  });
}

// PW.1.2's `designRecord` collector was RETIRED here, and the reason is worth
// keeping where the next person will look for it.
//
// It read the architecture map, hardcoded `insufficient_evidence`, and told
// the reader to "attest this control to say who owns that record" — while
// PW.1.2 was classified `automated`, which means the resolver never reads an
// attestation for it and the API refuses to create one ("An attestation cannot
// override a measurement"). The remedy it printed was one the product forbade.
//
// The collector's sentence was right and the classification was wrong. PW.1.2
// is now `attested`: a dependency graph describes what the system IS, not
// which risks were weighed against it, and that is a records practice no
// analyzer can evidence. The standing threat model at site/compliance/ is what
// an attestation now points to.
//
// Nothing replaced it. A collector that can only ever say "insufficient" is
// not evidence, it is a placeholder that looks like evidence.

/**
 * RV.1.1 — gather information about vulnerabilities from public sources.
 *
 * A NULL baseline on the monitor means the watch has never completed a run
 * (monitors/_store.js:60). That reads as unknown. It must never read as clean,
 * which is the single most common way an intake control goes quietly green.
 */
export function advisoryIntake({ runs, monitor }) {
  const list = runs.vuln || [];
  if (!monitor) {
    return absent(
      "This repository is not under watch, so nothing is polling advisory feeds for it between scans.",
    );
  }
  if (monitor.pausedAt) {
    return {
      status: "present",
      verdict: "not_met",
      capturedAt: list.length ? list[0].capturedAt : null,
      runId: list.length ? list[0].runId : null,
      analyzer: "vuln",
      provenance: `watch ${monitor.monitorId} · paused ${isoDay(Math.floor(monitor.pausedAt))}`,
      asserted: "watch paused",
      rationale:
        "The watch on this repository is paused. No advisory feed is being read for it, so new disclosures against its dependencies go unnoticed.",
      qualifiers: [],
    };
  }
  if (monitor.lastAdvisoryIds === null || monitor.lastAdvisoryIds === undefined) {
    return absent(
      "The watch on this repository has never completed a run, so it holds no advisory baseline. That is unknown, not clean.",
    );
  }
  if (!list.length) {
    return absent(
      "The watch is active but no scan of this repository landed inside the evidence period.",
    );
  }

  const run = list[0];
  const ids = Array.isArray(monitor.lastAdvisoryIds) ? monitor.lastAdvisoryIds : [];
  return baseFrom(run, {
    verdict: "met",
    asserted: `${list.length} scan${list.length === 1 ? "" : "s"} · baseline of ${ids.length} advisor${ids.length === 1 ? "y" : "ies"}`,
    rationale:
      `An active watch reads OSV for this repository's dependencies and keeps a baseline of ${ids.length} known advisor${ids.length === 1 ? "y" : "ies"}, so a newly published one is identified as new rather than merged into the existing list.`,
  });
}

/**
 * RV.1.2 — review vulnerability information repeatedly, as a practice.
 *
 * The word in the control is "repeatedly". One scan in a three-month window
 * cannot evidence it, which is exactly what the `single_scan` downgrade is for.
 */
export function repeatedReview({ runs, period }) {
  const list = runs.vuln || [];
  if (!list.length) {
    return absent("No vulnerability review of this repository ran inside the evidence period.");
  }
  const run = list[0];
  const first = list[list.length - 1];

  return baseFrom(run, {
    verdict: "met",
    asserted: `${list.length} review${list.length === 1 ? "" : "s"} · ${isoDay(first.capturedAt)} → ${isoDay(run.capturedAt)}`,
    rationale:
      `Vulnerability information was reviewed ${list.length} time${list.length === 1 ? "" : "s"} between ${isoDay(period.start)} and ${isoDay(period.end)}.`,
    qualifiers: list.length < PRACTICE_MIN_RUNS ? ["single_scan"] : [],
    rationaleSingleScan:
      "A single review inside the period shows the review happened once. This control asks for it to happen repeatedly, and one point cannot show a practice.",
  });
}

/**
 * RV.2.1 — analyse each vulnerability to gather enough information about risk.
 *
 * Evidenced by movement: the open advisory count at the start of the period
 * against the end, plus any patch an agent recorded applying. Movement needs
 * two measurements, so one run downgrades.
 */
export function riskInformation({ runs, patches }) {
  const list = runs.vuln || [];
  if (!list.length) {
    return absent("No scan inside the evidence period produced an advisory list to analyse.");
  }
  const newestRun = list[0];
  const oldestRun = list[list.length - 1];
  const openNow = countAdvisories(newestRun);
  const openThen = countAdvisories(oldestRun);
  const scored = advisoriesWithScore(newestRun);
  const applied = (patches || []).filter((p) => p.status === "applied").length;

  const delta = openThen - openNow;
  const movement = delta > 0
    ? `${delta} closed`
    : delta < 0
      ? `${-delta} newly open`
      : "unchanged";

  return baseFrom(newestRun, {
    verdict: "met",
    asserted: `${openNow} open · ${movement}${applied ? ` · ${applied} patch${applied === 1 ? "" : "es"} recorded` : ""}`,
    rationale:
      `Every advisory carries its CVSS score and vector where the source published one — ${scored} of ${openNow} do — which is what makes a risk decision reviewable rather than a matter of opinion.`,
    qualifiers: list.length < PRACTICE_MIN_RUNS ? ["single_scan"] : [],
    rationaleSingleScan:
      "Only one scan landed inside the period, so there is a count but no movement. Whether anything was analysed and acted on cannot be read from a single measurement.",
  });
}

function countAdvisories(run) {
  const a = run && run.result && run.result.advisories;
  return Array.isArray(a) ? a.length : 0;
}

function advisoriesWithScore(run) {
  const a = (run && run.result && run.result.advisories) || [];
  return a.filter((x) => typeof x.cvssScore === "number").length;
}

/**
 * RV.3.3 — review the software for similar vulnerabilities of the same class.
 *
 * A class sweep is a rule finding the same shape in more than one place. That is
 * exactly what a rule engine does, so the evidence is the rule-to-file spread.
 */
export function classSweep({ runs }) {
  const { run, missing } = newest(runs, "vuln", "a rule sweep");
  if (missing) return missing;

  const source = sourceBlock(run);
  if (!source) {
    return absent("The source scan did not complete, so no rule sweep was recorded.");
  }
  const findings = Array.isArray(source.findings) ? source.findings : [];
  const byRule = new Map();
  for (const f of findings) {
    if (!f.ruleId) continue;
    byRule.set(f.ruleId, (byRule.get(f.ruleId) || 0) + 1);
  }
  const classes = new Set(findings.map((f) => f.cwe).filter(Boolean).flat());
  const repeated = [...byRule.values()].filter((n) => n > 1).length;
  const shallow = shallowness(source);

  return baseFrom(run, {
    verdict: "met",
    asserted: `${byRule.size} rule${byRule.size === 1 ? "" : "s"} · ${classes.size} CWE class${classes.size === 1 ? "" : "es"} · ${repeated} found in more than one place`,
    rationale:
      "Every rule runs against every eligible file rather than against the location a finding was first reported, so a class of defect is swept repository-wide by construction.",
    qualifiers: shallow.any ? ["shallow_coverage"] : [],
    rationaleShallow: shallowRationale(shallow),
  });
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

/** Name → collector. The keys are the `collector` values in catalog.js. */
export const COLLECTORS = Object.freeze({
  toolchainArtifacts,
  sbomProvenance,
  componentHealth,
  componentVerification,
  secureCoding,
  codeAnalysisPerformed,
  secureBaseline,
  advisoryIntake,
  repeatedReview,
  riskInformation,
  classSweep,
});

/**
 * Run each named collector once and return `{ [collectorName]: evidence }`.
 *
 * A collector that throws yields `absent` rather than a 500: a broken collector
 * should make one control read as unevidenced, not take the whole page down —
 * and "unevidenced" is the safe direction to fail in.
 */
export function runCollectors(names, context) {
  const out = {};
  for (const name of names) {
    const fn = COLLECTORS[name];
    if (!fn) {
      out[name] = absent(`No collector named "${name}" is registered.`);
      continue;
    }
    try {
      const ev = fn(context);
      out[name] = stampPeriod(ev, context.period);
    } catch (err) {
      out[name] = absent(
        `The collector for this control failed to read its evidence (${err && err.message ? err.message : "unknown error"}).`,
      );
    }
  }
  return out;
}

/**
 * A present artifact dated outside the window is real evidence about a
 * different window. Marking it here rather than in each collector means the
 * period rule is applied identically to all twelve.
 */
function stampPeriod(ev, period) {
  if (!ev || ev.status !== "present") return ev;
  if (typeof ev.capturedAt !== "number") return ev;
  if (inPeriod(ev.capturedAt, period)) return ev;
  return { ...ev, status: "outside_period" };
}
