// CVSS vector → base score → qualitative severity.
//
// Why this exists: OSV advisories carry severity as a CVSS *vector string*
// (`CVSS:3.1/AV:N/AC:L/…`), not a number. Before this module, the scanner
// looked for a bare numeric substring in that vector, found none, and
// reported `severity: "unknown"` for every advisory whose source didn't also
// ship a GitHub-style text rating — which is most PyPI (PYSEC), Go, and
// Linux-distro advisories. An auditor that can't tell critical from low
// can't prioritize, so the score is computed here from the vector itself.
//
// Implemented exactly, per the FIRST specifications:
//   CVSS v3.0 / v3.1  — https://www.first.org/cvss/v3.1/specification-document
//   CVSS v2.0         — https://www.first.org/cvss/v2/guide
//
// CVSS v4.0 is approximated rather than computed: its base score requires the
// official 270-entry MacroVector lookup table, which is too much data to
// carry for the handful of advisories that publish v4 and nothing else. The
// approximation maps v4 metrics onto the v3.1 formula and is flagged as
// `approximate: true` so callers never present it as an exact score. Where
// an advisory publishes both, callers should prefer the exact v3 vector.

// ---------------------------------------------------------------------------
// v3.0 / v3.1
// ---------------------------------------------------------------------------

const V3_AV = { N: 0.85, A: 0.62, L: 0.55, P: 0.2 };
const V3_AC = { L: 0.77, H: 0.44 };
// Privileges Required is scope-dependent: a changed scope makes the same
// privilege level count for more.
const V3_PR_UNCHANGED = { N: 0.85, L: 0.62, H: 0.27 };
const V3_PR_CHANGED   = { N: 0.85, L: 0.68, H: 0.50 };
const V3_UI = { N: 0.85, R: 0.62 };
const V3_CIA = { H: 0.56, L: 0.22, N: 0.0 };

/**
 * CVSS v3.1 "Roundup": round up to one decimal place, working in integer
 * hundred-thousandths to dodge binary floating-point error. Straight
 * `Math.ceil(x * 10) / 10` gets 8.6 wrong for inputs that land a hair below
 * the boundary (the spec calls this out explicitly).
 */
function roundUp1(input) {
  const i = Math.round(input * 100000);
  if (i % 10000 === 0) return i / 100000;
  return (Math.floor(i / 10000) + 1) / 10;
}

function scoreV3(metrics) {
  const scopeChanged = metrics.S === "C";
  const av  = V3_AV[metrics.AV];
  const ac  = V3_AC[metrics.AC];
  const pr  = (scopeChanged ? V3_PR_CHANGED : V3_PR_UNCHANGED)[metrics.PR];
  const ui  = V3_UI[metrics.UI];
  const c   = V3_CIA[metrics.C];
  const i   = V3_CIA[metrics.I];
  const a   = V3_CIA[metrics.A];
  // Every base metric is mandatory — a vector missing one is malformed, and
  // guessing a default would silently invent a score.
  if ([av, ac, pr, ui, c, i, a].some((v) => v === undefined)) return null;

  const iscBase = 1 - (1 - c) * (1 - i) * (1 - a);
  const impact = scopeChanged
    ? 7.52 * (iscBase - 0.029) - 3.25 * Math.pow(iscBase - 0.02, 15)
    : 6.42 * iscBase;
  if (impact <= 0) return 0;

  const exploitability = 8.22 * av * ac * pr * ui;
  const base = scopeChanged
    ? Math.min(1.08 * (impact + exploitability), 10)
    : Math.min(impact + exploitability, 10);
  return roundUp1(base);
}

// ---------------------------------------------------------------------------
// v2.0
// ---------------------------------------------------------------------------

const V2_AV  = { L: 0.395, A: 0.646, N: 1.0 };
const V2_AC  = { H: 0.35, M: 0.61, L: 0.71 };
const V2_AU  = { M: 0.45, S: 0.56, N: 0.704 };
const V2_CIA = { N: 0.0, P: 0.275, C: 0.660 };

function scoreV2(metrics) {
  const av = V2_AV[metrics.AV];
  const ac = V2_AC[metrics.AC];
  const au = V2_AU[metrics.Au];
  const c  = V2_CIA[metrics.C];
  const i  = V2_CIA[metrics.I];
  const a  = V2_CIA[metrics.A];
  if ([av, ac, au, c, i, a].some((v) => v === undefined)) return null;

  const impact = 10.41 * (1 - (1 - c) * (1 - i) * (1 - a));
  const exploitability = 20 * av * ac * au;
  const fImpact = impact === 0 ? 0 : 1.176;
  const base = ((0.6 * impact) + (0.4 * exploitability) - 1.5) * fImpact;
  return Math.round(base * 10) / 10;
}

// ---------------------------------------------------------------------------
// v4.0 (approximate — see file header)
// ---------------------------------------------------------------------------

// v4 splits v3's Attack Complexity into AC + AT (Attack Requirements) and
// renames the impact metrics to VC/VI/VA (vulnerable system) — SC/SI/SA
// (subsequent system) map onto v3's "scope changed".
function approximateV4(metrics) {
  const subsequentImpact = ["SC", "SI", "SA"].some((k) => metrics[k] && metrics[k] !== "N");
  return scoreV3({
    AV: metrics.AV,
    // Attack Requirements present ≈ higher complexity.
    AC: metrics.AT && metrics.AT !== "N" ? "H" : metrics.AC,
    PR: metrics.PR,
    UI: metrics.UI === "N" ? "N" : "R",
    S:  subsequentImpact ? "C" : "U",
    C:  metrics.VC,
    I:  metrics.VI,
    A:  metrics.VA,
  });
}

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

/** FIRST's qualitative rating scale (v3.1 §5). */
export function severityForScore(score) {
  if (typeof score !== "number" || Number.isNaN(score)) return "unknown";
  if (score >= 9.0) return "critical";
  if (score >= 7.0) return "high";
  if (score >= 4.0) return "medium";
  if (score >  0.0) return "low";
  return "none";
}

/**
 * Split `AV:N/AC:L/…` into `{ AV: "N", AC: "L", … }`.
 *
 * Values are cut at the first whitespace: a few OSV sources publish the
 * vector with its base score appended (`…/A:H 9.8`), which would otherwise
 * make the final metric parse as `"H 9.8"` and fail the whole vector.
 */
function parseMetrics(body) {
  const metrics = {};
  for (const part of body.split("/")) {
    const idx = part.indexOf(":");
    if (idx <= 0) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim().split(/\s+/)[0].toUpperCase();
    if (key) metrics[key] = value;
  }
  return metrics;
}

/**
 * Some feeds append the numeric base score to the vector. If the vector
 * itself won't score, that trailing number is still better than `unknown`.
 */
function trailingScore(raw) {
  const m = /(?:^|\s)(\d{1,2}(?:\.\d)?)\s*$/.exec(raw);
  if (!m) return null;
  const n = parseFloat(m[1]);
  return n >= 0 && n <= 10 ? n : null;
}

/**
 * Score a CVSS vector string.
 *
 * Accepts v3.x (`CVSS:3.1/…`), v4.0 (`CVSS:4.0/…`), and v2 (bare
 * `AV:N/AC:L/Au:N/…`, which has no version prefix). Also accepts a plain
 * numeric string, since a few OSV sources publish `"7.5"` as the score.
 *
 * Returns `{ score, severity, version, approximate }` or null when the input
 * isn't a vector we can score. Never throws.
 */
export function scoreCvssVector(vector) {
  if (typeof vector !== "string") return null;
  const raw = vector.trim();
  if (raw === "") return null;

  // Plain number (e.g. "9.8").
  if (/^\d+(\.\d+)?$/.test(raw)) {
    const n = parseFloat(raw);
    if (n < 0 || n > 10) return null;
    return { score: n, severity: severityForScore(n), version: "numeric", approximate: false };
  }

  const versionMatch = /^CVSS:(\d+)\.(\d+)\//i.exec(raw);
  const body = versionMatch ? raw.slice(versionMatch[0].length) : raw;
  const metrics = parseMetrics(body);

  let score = null;
  let version;
  let approximate = false;

  if (versionMatch && versionMatch[1] === "3") {
    version = `3.${versionMatch[2]}`;
    score = scoreV3(metrics);
  } else if (versionMatch && versionMatch[1] === "4") {
    version = `4.${versionMatch[2]}`;
    score = approximateV4(metrics);
    approximate = true;
  } else if (!versionMatch && metrics.Au !== undefined) {
    // v2 is the only version with an Authentication metric.
    version = "2.0";
    score = scoreV2(metrics);
  } else if (!versionMatch && metrics.AV !== undefined) {
    // Unversioned v3-shaped vector — rare, but some feeds drop the prefix.
    version = "3.1";
    score = scoreV3(metrics);
  } else {
    return null;
  }

  if (score === null || Number.isNaN(score)) {
    const appended = trailingScore(raw);
    if (appended === null) return null;
    return { score: appended, severity: severityForScore(appended), version, approximate: false };
  }
  return { score, severity: severityForScore(score), version, approximate };
}
