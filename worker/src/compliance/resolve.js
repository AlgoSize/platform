// The one place a control's answer is decided.
//
// Every control on every framework goes through resolveControlResult. Nothing
// else may set a result, because the value of this whole feature is that a
// green row cannot appear without an artifact behind it, and that property is
// only checkable if there is exactly one function to check.
//
// ---------------------------------------------------------------------------
// The safety property: THIS FUNCTION CAN ONLY DOWNGRADE
// ---------------------------------------------------------------------------
// A collector proposes a verdict from what it measured. Everything here either
// keeps that verdict or weakens it. There is no path that turns
// `insufficient_evidence` into `met`, and no path that reaches `met` without a
// collector having said so first. A bug in a collector can therefore make this
// page too pessimistic — never too generous — and "too pessimistic" is a
// complaint someone files, while "too generous" is a compliance incident
// nobody notices.
//
// RESULT_RANK encodes that ordering and `weakenTo` is the only mutator.

import { RESULTS } from "./catalog.js";

// Higher is weaker. Downgrades move up this scale and never back down.
// `not_applicable` sits outside it — it is a human's scoping claim, not a
// measurement, so it is set once and never weakened.
const RESULT_RANK = Object.freeze({
  met: 0,
  not_met: 1,
  attestation_expired: 2,
  insufficient_evidence: 3,
});

/** Two seconds of clock skew is not a reason to call a fresh scan stale. */
const PERIOD_GRACE_SECONDS = 2;

function weakenTo(current, candidate) {
  const a = RESULT_RANK[current];
  const b = RESULT_RANK[candidate];
  if (a === undefined || b === undefined) return current;
  return b > a ? candidate : current;
}

/**
 * @param {object}   control     a catalog entry — id, title, coverage, why?, collector?
 * @param {object?}  evidence    what the collector for this control returned, or null
 * @param {object?}  attestation the live attestation row for this control, or null
 * @param {object}   period      { start, end } unix seconds
 * @param {number}   now         unix seconds
 * @returns {{evidenceState, result, rationale, asserted, provenance,
 *            capturedAt, sourceRunId, sourceAnalyzer, qualifiers}}
 */
export function resolveControlResult({ control, evidence = null, attestation = null,
                                       period, now }) {
  const base = {
    evidenceState: "not_covered",
    result: "insufficient_evidence",
    rationale: "",
    asserted: null,
    provenance: null,
    capturedAt: null,
    sourceRunId: null,
    sourceAnalyzer: null,
    qualifiers: [],
  };

  // -------------------------------------------------------------------------
  // 1. Not covered. The strongest statement on the page, and the one most
  //    likely to be misread, so it is handled first and exits immediately.
  //
  //    A control the catalog marks `not_covered` has NO RESULT. Not "not met"
  //    — that would be a finding about the customer, and this is a fact about
  //    Algosize. `met` is unreachable here by construction: there is no branch
  //    below this return that could assign it.
  // -------------------------------------------------------------------------
  if (control.coverage === "not_covered") {
    return {
      ...base,
      result: "insufficient_evidence",
      rationale: control.why ||
        "This platform has no artifact bearing on this control.",
      qualifiers: ["no_artifact_possible"],
    };
  }

  // -------------------------------------------------------------------------
  // 2. Attested controls. A human claim, and claims expire.
  // -------------------------------------------------------------------------
  if (control.coverage === "attested") {
    // A revoked attestation is not weak evidence, it is no evidence. It is
    // dropped before any of the states below can see it.
    if (!attestation || attestation.revokedAt) {
      return {
        ...base,
        evidenceState: "not_covered",
        result: "insufficient_evidence",
        rationale: attestation && attestation.revokedAt
          ? "The attestation for this control was revoked. Nothing stands in its place."
          : "No analyzer can see this control, and nobody has attested it.",
        qualifiers: attestation ? ["attestation_revoked"] : ["awaiting_attestation"],
      };
    }

    const expired = typeof attestation.expiresAt === "number" &&
                    attestation.expiresAt <= now;

    if (attestation.kind === "not_applicable") {
      // Scoping is a claim someone owns, so it expires like any other.
      return {
        ...base,
        evidenceState: "attested",
        result: expired ? "attestation_expired" : "not_applicable",
        rationale: expired
          ? "The scoping claim that put this control out of scope has expired and has not been renewed."
          : attestation.statement,
        asserted: attestation.statement,
        provenance: attestationProvenance(attestation),
        capturedAt: attestation.attestedAt || null,
        qualifiers: expired ? ["expired"] : ["scoped_out"],
      };
    }

    return {
      ...base,
      evidenceState: "attested",
      // An expired attestation does not keep passing quietly. This is the
      // single most common way an evidence product goes stale without anyone
      // noticing, so expiry is a state of its own rather than a footnote.
      result: expired ? "attestation_expired" : "met",
      rationale: expired
        ? "This attestation expired on " + isoDay(attestation.expiresAt) +
          " and has not been renewed. It carries no weight until it is."
        : attestation.statement,
      asserted: attestation.statement,
      provenance: attestationProvenance(attestation),
      capturedAt: attestation.attestedAt || null,
      qualifiers: expired ? ["expired"] : [],
    };
  }

  // -------------------------------------------------------------------------
  // 3. Automated controls.
  // -------------------------------------------------------------------------

  // No collector output at all. The analyzer that would answer this never ran
  // for this repository, which is not the same as running and finding nothing.
  if (!evidence || evidence.status === "absent") {
    return {
      ...base,
      evidenceState: "automated",
      result: "insufficient_evidence",
      rationale: (evidence && evidence.reason) ||
        "No scan in this evidence period produced the artifact this control reads.",
      qualifiers: ["no_run_in_period"],
    };
  }

  // The artifact exists but predates the period. Real, and not evidence about
  // these three months — a control is a claim about a window, and an older
  // scan cannot speak for it.
  if (evidence.status === "outside_period") {
    return {
      ...base,
      evidenceState: "automated",
      result: "insufficient_evidence",
      rationale: evidence.rationale ||
        ("The most recent artifact for this control is dated " +
         isoDay(evidence.capturedAt) + ", before the evidence period opens on " +
         isoDay(period.start) + "."),
      asserted: evidence.asserted || null,
      provenance: evidence.provenance || null,
      capturedAt: evidence.capturedAt || null,
      sourceRunId: evidence.runId || null,
      sourceAnalyzer: evidence.analyzer || null,
      qualifiers: ["predates_period"],
    };
  }

  // A collector must propose a verdict it can defend. An unrecognised one is
  // treated as no verdict rather than trusted.
  let result = RESULTS.includes(evidence.verdict) && evidence.verdict !== "not_applicable"
    ? evidence.verdict
    : "insufficient_evidence";
  let rationale = evidence.rationale || "";
  const qualifiers = [...(evidence.qualifiers || [])];

  // --- Downgrades. Each is a rule about what a measurement cannot support. ---

  // One scan is a snapshot. Several controls are about doing something as a
  // practice — repeatedly, as part of development — and a single point in a
  // three-month window cannot show that however good the result looks.
  if (qualifiers.includes("single_scan")) {
    result = weakenTo(result, "insufficient_evidence");
    rationale = evidence.rationaleSingleScan || rationale;
  }

  // An SBOM its own generator marks incomplete is provenance for part of a
  // release, which is not provenance for the release.
  if (qualifiers.includes("sbom_incomplete")) {
    result = weakenTo(result, "insufficient_evidence");
    rationale = evidence.rationaleIncomplete || rationale;
  }

  // Coverage reached mostly by line-level pattern matching is real work and a
  // weaker claim than following values from request to sink. It qualifies a
  // control; it does not fail one.
  if (qualifiers.includes("shallow_coverage")) {
    result = weakenTo(result, "insufficient_evidence");
    rationale = evidence.rationaleShallow || rationale;
  }

  return {
    evidenceState: "automated",
    result,
    rationale,
    asserted: evidence.asserted || null,
    provenance: evidence.provenance || null,
    capturedAt: evidence.capturedAt || null,
    sourceRunId: evidence.runId || null,
    sourceAnalyzer: evidence.analyzer || null,
    qualifiers,
  };
}

function attestationProvenance(a) {
  const who = a.ownerEmail ? "owner " + a.ownerEmail : "owner unrecorded";
  const until = typeof a.expiresAt === "number" ? " · expires " + isoDay(a.expiresAt) : "";
  return who + until;
}

/** Unix seconds to YYYY-MM-DD. Dates in a compliance record are read by people
 *  in other timezones and quoted back months later, so they are always UTC and
 *  never carry a time nobody can reproduce. */
export function isoDay(sec) {
  if (typeof sec !== "number" || !isFinite(sec)) return "an unrecorded date";
  return new Date(sec * 1000).toISOString().slice(0, 10);
}

/** Is a captured-at inside the evidence period? Used by collectors so the
 *  period rule is applied identically everywhere. */
export function inPeriod(capturedAt, period) {
  if (typeof capturedAt !== "number") return false;
  return capturedAt >= (period.start - PERIOD_GRACE_SECONDS) &&
         capturedAt <= (period.end + PERIOD_GRACE_SECONDS);
}

/**
 * Counts for the coverage summary.
 *
 * Deliberately returns counts and never a percentage. A denominator here
 * would have to be "all controls in the framework", which would make the
 * number mostly a measure of how much of the framework is about code — a
 * fact about NIST, rendered as if it were a score about the customer.
 */
export function summarize(rows) {
  const byState = { automated: 0, attested: 0, not_covered: 0 };
  const byResult = { met: 0, not_met: 0, insufficient_evidence: 0,
                     not_applicable: 0, attestation_expired: 0 };
  for (const r of rows) {
    if (byState[r.evidenceState] !== undefined) byState[r.evidenceState]++;
    // Results are counted for EVIDENCED controls only. A not-covered control
    // has no result, and rolling its `insufficient_evidence` placeholder into
    // this tally would inflate the one number a reader is most likely to skim.
    if (r.evidenceState !== "not_covered" && byResult[r.result] !== undefined) {
      byResult[r.result]++;
    }
  }
  return { total: rows.length, byState, byResult };
}
