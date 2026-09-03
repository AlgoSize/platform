// Accepted risks — the one place a true finding becomes "signed for".
//
// ---------------------------------------------------------------------------
// PURE ON PURPOSE
// ---------------------------------------------------------------------------
// No env, no D1, no fetch. The analyzers are pure so `scripts/selfscan.mjs`
// can run them with no Worker runtime, and the same must be true here: the
// matching rule has to be callable from a Node script, from the Worker, and
// (when the committed-file form ships) from CI, or the three will drift into
// three policies. risk/store.js does the D1 half and decides nothing.
//
// ---------------------------------------------------------------------------
// WHAT AN ACCEPTANCE IS, AND IS NOT
// ---------------------------------------------------------------------------
// It is: a named person, a written reason, and a date it runs out, recorded
// against one finding in one file in one repository.
//
// It is NOT a way to make a number go down. Every function here adds fields
// and removes nothing. The finding is still found, still listed, still
// exported to SARIF. What changes is which bucket it counts in — and the
// accepted count is rendered beside the open one everywhere, so "0 open" can
// never appear without "1 accepted" beside it.

/**
 * Categories no signature can cover.
 *
 * `secrets` — the same hard refusal `testCodePolicyFor` already makes about
 * capping them: a credential does not care where it leaks from. Accepting a
 * committed key does not make it un-leaked; the only remediation is rotation,
 * and an acceptance form here would be a place to record that you did not
 * rotate it. A committed credential is not a risk you accept.
 *
 * `dependency` — a published advisory is a fact about a version, and its
 * lifecycle is upgrade, not acceptance. It also feeds the SBOM and the
 * component-health control, so an accepted CVE would make a procurement
 * document lie about a third party rather than about us.
 *
 * Everything else can be accepted, including `injection` — which is the
 * motivating case. A blanket ban on high severity would just push people back
 * to deleting the scanner from the workflow.
 */
export const NEVER_ACCEPTABLE = Object.freeze(["secrets", "dependency"]);

/** Longest an acceptance may run. `expires_at NOT NULL` alone is not enough —
 *  someone will type 2099, and a decade-long acceptance is a perpetual one
 *  wearing a date. A year is long enough to be practical and short enough
 *  that every acceptance is re-read by someone who still works here. */
export const MAX_ACCEPTANCE_SECONDS = 365 * 86400;

const SEVERITY_RANK = { critical: 5, high: 4, medium: 3, low: 2, info: 1 };

export function isAcceptableCategory(category) {
  return !NEVER_ACCEPTABLE.includes(String(category || ""));
}

/** YYYY-MM-DD in UTC, for anything a human reads. */
export function isoDay(unixSeconds) {
  if (typeof unixSeconds !== "number" || !Number.isFinite(unixSeconds)) return null;
  return new Date(unixSeconds * 1000).toISOString().slice(0, 10);
}

/**
 * Decorate findings with their acceptance state.
 *
 * Returns a NEW array of the SAME LENGTH in the SAME ORDER. A dropped finding
 * is a bug, not an optimisation, and the suite asserts the length equality
 * over the whole fixture corpus.
 *
 * Three states, and only the first grants anything:
 *
 *   accepted  exact match on (rule, path, fingerprint), live, in-date, and the
 *             category is acceptable. Excluded from the OPEN count.
 *   drifted   the rule and path match a signed acceptance but the fingerprint
 *             does not — the code changed under the signature. OPEN, and the
 *             reader is told who signed what and when.
 *   expired   matched, but the date has passed. OPEN, at full severity, and
 *             carrying the record of who let it lapse. Stronger than silence.
 *
 * @param {object[]} findings   normalized findings (post-dedupe, with fingerprints)
 * @param {object[]} acceptances rows from risk/store.js — revoked already excluded
 * @param {object}   opts        { repoKey, now } — now in unix SECONDS
 */
export function applyAcceptedRisks(findings, acceptances, { repoKey = null, now = 0 } = {}) {
  const list = Array.isArray(findings) ? findings : [];
  // No repository, no acceptance. A scan of pasted content belongs to nothing
  // an acceptance could have been signed against.
  if (!repoKey || !Array.isArray(acceptances) || acceptances.length === 0) {
    return list.map((f) => ({ ...f }));
  }

  // Index by the loose half of the key. The exact half is checked per finding,
  // because the difference between the two is the whole design.
  const byRulePath = new Map();
  for (const a of acceptances) {
    if (!a || a.repoKey !== repoKey) continue;
    const k = `${a.ruleId}|${a.path}`;
    const bucket = byRulePath.get(k);
    if (bucket) bucket.push(a); else byRulePath.set(k, [a]);
  }

  return list.map((f) => {
    const bucket = byRulePath.get(`${f.ruleId}|${f.path}`);
    if (!bucket) return { ...f };

    const exact = bucket.find((a) => a.fingerprint === f.fingerprint);
    const a = exact || bucket[0];

    // Re-checked here and not only at the API. A row written by a future code
    // path, an import, or a hand-edited database still cannot take effect.
    // Deleting this line is the test in group 1 of test-accepted-risks.mjs.
    if (!isAcceptableCategory(a.category)) return { ...f };

    const record = {
      id: a.id,
      ownerEmail: a.ownerEmail,
      rationale: a.rationale,
      documentUrl: a.documentUrl || null,
      acceptedAt: a.acceptedAt,
      acceptedBy: a.acceptedBy || null,
      expiresAt: a.expiresAt,
      expiresOn: isoDay(a.expiresAt),
      acceptedSeverity: a.severity,
    };

    if (!exact) {
      return { ...f, accepted: false, acceptance: { ...record, state: "drifted" } };
    }
    if (typeof a.expiresAt === "number" && a.expiresAt <= now) {
      return { ...f, accepted: false, acceptance: { ...record, state: "expired" } };
    }
    // One-way, like the compliance resolver's `weakenTo`: an acceptance covers
    // a finding that got quieter, never one that got louder. A `medium` signed
    // in a test file must not silently cover the `high` it becomes when the
    // file moves out of test/.
    if ((SEVERITY_RANK[f.severity] || 0) > (SEVERITY_RANK[a.severity] || 0)) {
      return { ...f, accepted: false, acceptance: { ...record, state: "drifted" } };
    }
    return { ...f, accepted: true, acceptance: { ...record, state: "accepted" } };
  });
}

/** Counts by acceptance state. `open` is the only one a gate may read. */
export function acceptanceSummary(findings) {
  const zero = () => ({ critical: 0, high: 0, medium: 0, low: 0, info: 0 });
  const open = zero(), accepted = zero();
  let openTotal = 0, acceptedTotal = 0, drifted = 0, expired = 0;
  for (const f of Array.isArray(findings) ? findings : []) {
    const state = f.acceptance && f.acceptance.state;
    if (state === "drifted") drifted++;
    if (state === "expired") expired++;
    if (f.accepted) {
      acceptedTotal++;
      if (accepted[f.severity] !== undefined) accepted[f.severity]++;
    } else {
      openTotal++;
      if (open[f.severity] !== undefined) open[f.severity]++;
    }
  }
  return {
    open: { total: openTotal, bySeverity: open },
    accepted: { total: acceptedTotal, bySeverity: accepted },
    drifted,
    expiredAcceptances: expired,
  };
}
