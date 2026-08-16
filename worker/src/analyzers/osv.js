// OSV.dev client — Cloudflare Worker-side, pure-fetch, no SDK.
//
// Two-step flow because that's what the OSV API requires:
//   1. POST /v1/querybatch  → returns vulnerability IDs per package
//   2. GET  /v1/vulns/{id}  → returns severity, fix versions, summary
//
// The batch endpoint is cheap (1 request for up to 1000 packages) but only
// returns IDs. Severity + fixed_in only come from the per-vuln endpoint, so
// we fan out — capped at MAX_VULNS_TO_HYDRATE — and run the per-vuln
// requests in parallel. CF Workers allow up to 1000 subrequests per
// invocation, so a hard cap of 100 unique vulns leaves plenty of room.
//
// All network calls accept an injectable `fetchImpl` so tests can mock
// without touching globalThis.fetch.

import { scoreCvssVector } from "./cvss.js";

const OSV_API = "https://api.osv.dev";
const OSV_TIMEOUT_MS = 15_000;

// Hard caps — see file header for rationale.
const MAX_QUERIES_PER_BATCH = 1000;
export const MAX_VULNS_TO_HYDRATE = 100;

const SEVERITY_RANK = { critical: 4, high: 3, medium: 2, low: 1, unknown: 0 };

export class OsvError extends Error {
  constructor(message) { super(message); this.osvError = true; }
}

/**
 * Step 1: batch-query OSV for which packages have vulnerabilities.
 *
 * Input: `[{ name, version, ecosystem }, ...]`  (already deduped is fine,
 *        we dedupe defensively here too)
 * Output: `[{ id: "GHSA-…", package: {...} }, ...]` — one entry per
 *         (package × matched vuln). Same vuln ID can appear under multiple
 *         packages; same package can have multiple vuln IDs.
 */
export async function osvBatchQuery(packages, fetchImpl = fetch, stats = null) {
  if (!Array.isArray(packages) || packages.length === 0) return [];

  // Dedupe by ecosystem + name + version. Same dep can appear in both a
  // package-lock.json and a yarn.lock (yes, some repos ship both).
  const seen = new Set();
  const queries = [];
  const queryToPackage = [];
  for (const p of packages) {
    if (!p || !p.name || !p.version || !p.ecosystem) continue;
    const key = p.ecosystem + "/" + p.name + "@" + p.version;
    if (seen.has(key)) continue;
    seen.add(key);
    queries.push({ package: { name: p.name, ecosystem: p.ecosystem }, version: p.version });
    queryToPackage.push(p);
    if (queries.length >= MAX_QUERIES_PER_BATCH) break;
  }
  if (queries.length === 0) return [];

  // Report truncation to the caller. Silently querying the first 1000 of
  // 4000 packages and presenting the result as "your dependencies are
  // clean" is the worst failure an auditor can have — the user needs to
  // know the audit was partial.
  if (stats) {
    stats.packagesQueried = queries.length;
    stats.packagesTruncated = queries.length >= MAX_QUERIES_PER_BATCH && packages.length > queries.length;
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), OSV_TIMEOUT_MS);
  let json;
  try {
    const res = await fetchImpl(OSV_API + "/v1/querybatch", {
      method: "POST",
      headers: { "content-type": "application/json", "user-agent": "algosize-vuln-scanner/1.0" },
      body: JSON.stringify({ queries }),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      throw new OsvError(`OSV /v1/querybatch failed: HTTP ${res.status}`);
    }
    json = await res.json();
  } catch (err) {
    if (err && err.osvError) throw err;
    throw new OsvError(`OSV /v1/querybatch error: ${err && err.message ? err.message : String(err)}`);
  } finally {
    clearTimeout(timer);
  }

  const results = Array.isArray(json && json.results) ? json.results : [];
  const matches = [];
  for (let i = 0; i < results.length; i++) {
    const vulns = (results[i] && Array.isArray(results[i].vulns)) ? results[i].vulns : [];
    if (vulns.length === 0) continue;
    const pkg = queryToPackage[i];
    for (const v of vulns) {
      if (v && typeof v.id === "string") {
        matches.push({ id: v.id, package: pkg });
      }
    }
  }
  return matches;
}

/**
 * Step 2: hydrate each unique vuln ID with severity + fix info.
 *
 * Returns advisories sorted by severity descending, dedup-keyed by
 * (vuln-id × package). A given CVE that hits 5 transitive copies of the
 * same package is therefore reported once per affected install (so the
 * UI can show fix-versions per copy), not once globally.
 */
export async function osvHydrateVulns(matches, fetchImpl = fetch, stats = null) {
  if (!Array.isArray(matches) || matches.length === 0) return [];

  // Unique IDs to fetch — cap to bound fan-out.
  const idOrder = [];
  const idSet = new Set();
  const allIds = new Set();
  for (const m of matches) {
    allIds.add(m.id);
    if (idSet.has(m.id) || idOrder.length >= MAX_VULNS_TO_HYDRATE) continue;
    idSet.add(m.id);
    idOrder.push(m.id);
  }
  if (stats) {
    stats.vulnsMatched  = allIds.size;
    stats.vulnsHydrated = idOrder.length;
    // Same reasoning as the package cap above: a 100-vuln ceiling on a repo
    // with 300 distinct advisories must be visible, not implied.
    stats.vulnsTruncated = allIds.size > idOrder.length;
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), OSV_TIMEOUT_MS);

  let detailsById;
  try {
    const fetches = idOrder.map((id) =>
      fetchImpl(OSV_API + "/v1/vulns/" + encodeURIComponent(id), {
        headers: { "user-agent": "algosize-vuln-scanner/1.0" },
        signal: ctrl.signal,
      })
        .then((r) => (r && r.ok ? r.json() : null))
        .catch(() => null),
    );
    const arr = await Promise.all(fetches);
    detailsById = new Map();
    for (let i = 0; i < idOrder.length; i++) {
      if (arr[i]) detailsById.set(idOrder[i], arr[i]);
    }
  } finally {
    clearTimeout(timer);
  }

  const advisories = [];
  const dedupe = new Set();
  for (const m of matches) {
    const detail = detailsById.get(m.id);
    if (!detail) continue;
    const key = m.id + "/" + m.package.ecosystem + "/" + m.package.name + "@" + m.package.version;
    if (dedupe.has(key)) continue;
    dedupe.add(key);
    const sev = extractSeverity(detail);
    advisories.push({
      id: m.id,
      ecosystem: m.package.ecosystem,
      package: m.package.name,
      installedVersion: m.package.version,
      fixedIn: extractFixedIn(detail, m.package),
      severity: sev.severity,
      // The numeric score and its vector travel with the advisory so the
      // dashboard can show *why* something is rated critical, and so a
      // reviewer can check our arithmetic against the published vector.
      cvssScore:   sev.cvssScore,
      cvssVector:  sev.cvssVector,
      cvssVersion: sev.cvssVersion,
      severityApproximate: sev.approximate,
      aliases: Array.isArray(detail.aliases)
        ? detail.aliases.filter((a) => typeof a === "string").slice(0, 8)
        : [],
      summary: shortSummary(detail),
      advisoryUrl: "https://osv.dev/vulnerability/" + encodeURIComponent(m.id),
    });
  }

  advisories.sort((a, b) =>
    (SEVERITY_RANK[b.severity] ?? 0) - (SEVERITY_RANK[a.severity] ?? 0) ||
    a.package.localeCompare(b.package) ||
    a.id.localeCompare(b.id),
  );
  return advisories;
}

// ---------------------------------------------------------------------------
// Detail extraction
// ---------------------------------------------------------------------------

/**
 * Compare two version strings well enough to order release versions.
 *
 * Not a full semver implementation — it has to serve npm, PyPI, RubyGems and
 * Go simultaneously, and those disagree about pre-release syntax. It splits
 * on non-alphanumerics and compares chunk by chunk, numerically when both
 * chunks are numeric. That gets the common cases right (1.9.0 < 1.10.0,
 * 4.17.20 < 4.17.21) and degrades to a string compare on exotic ones.
 *
 * Returns a negative number, 0, or a positive number, like a sort comparator.
 */
export function compareVersions(a, b) {
  const split = (v) => String(v).split(/[.\-+_~]/).filter(Boolean);
  const av = split(a);
  const bv = split(b);
  for (let i = 0; i < Math.max(av.length, bv.length); i++) {
    const x = av[i];
    const y = bv[i];
    // A missing chunk sorts before a present one: 1.2 < 1.2.1. A present
    // pre-release chunk is the exception (1.2.0-rc1 < 1.2.0) but OSV fix
    // versions are releases, so we don't model that.
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const nx = /^\d+$/.test(x) ? parseInt(x, 10) : null;
    const ny = /^\d+$/.test(y) ? parseInt(y, 10) : null;
    if (nx !== null && ny !== null) {
      if (nx !== ny) return nx - ny;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

/**
 * OSV stores fix info in `affected[].ranges[].events[]`. Each "range" is a
 * sequence of `{introduced: "X"} … {fixed: "Y"}` events.
 *
 * Two things this must get right, because `fixedIn` is the one piece of the
 * advisory the user acts on:
 *
 *   1. Skip GIT ranges. Their `fixed` values are commit SHAs, not versions.
 *      Taking the last `fixed` event across all ranges — as this did before
 *      — routinely produced advice like "upgrade to
 *      a1b2c3d4e5f60718293a4b5c6d7e8f9012345678", which is not a version
 *      anyone can install. Only SEMVER and ECOSYSTEM ranges carry versions.
 *
 *   2. Pick the LOWEST fix at or above the installed version, not the last
 *      one seen. An advisory that spans several release lines (fixed in
 *      1.2.9, 2.0.4 and 3.1.1) should tell a 1.2.x user to go to 1.2.9 —
 *      the smallest upgrade that clears the vulnerability — not to jump two
 *      majors.
 */
function extractFixedIn(detail, pkg) {
  const affected = Array.isArray(detail.affected) ? detail.affected : [];
  const aff = affected.find(
    (a) => a && a.package &&
           a.package.name === pkg.name &&
           a.package.ecosystem === pkg.ecosystem,
  );
  if (!aff) return null;

  const ranges = Array.isArray(aff.ranges) ? aff.ranges : [];
  const candidates = [];
  for (const r of ranges) {
    if (!r) continue;
    // `type` is optional in the schema; absent means a version range, and
    // GIT is the only type whose events hold commit hashes.
    if (typeof r.type === "string" && r.type.toUpperCase() === "GIT") continue;
    const events = Array.isArray(r.events) ? r.events : [];
    for (const ev of events) {
      if (ev && typeof ev.fixed === "string" && ev.fixed) candidates.push(ev.fixed);
    }
  }
  if (candidates.length === 0) return null;

  const ahead = candidates
    .filter((v) => compareVersions(v, pkg.version) > 0)
    .sort(compareVersions);
  if (ahead.length > 0) return ahead[0];

  // Nothing strictly newer than what's installed — return the highest fix on
  // record so the advisory still names a version, rather than going silent.
  return candidates.slice().sort(compareVersions).pop();
}

/**
 * Resolve an advisory's severity.
 *
 * Two sources, in order of preference:
 *   1. `severity[]` CVSS vector — scored properly via analyzers/cvss.js.
 *   2. `database_specific.severity` — GHSA's text rating
 *      (LOW/MODERATE/HIGH/CRITICAL), used when no vector is present or the
 *      vector can't be scored.
 *   3. "unknown" — explicit, never a silent downgrade.
 *
 * The CVSS vector is preferred over the text rating because it is the
 * primary, machine-checkable source: the text rating is a human summary that
 * some databases omit and others round.
 *
 * This used to be the other way round, with the vector "parsed" by scanning
 * it for a bare number. CVSS vectors don't contain their base score, so that
 * search never matched and every advisory without a GHSA text rating — most
 * PyPI, Go and distro advisories — came back `unknown`. An auditor that
 * can't separate critical from low can't prioritize, which made the whole
 * dependency audit close to useless for those ecosystems.
 *
 * Returns `{ severity, cvssScore, cvssVector, cvssVersion, approximate }`.
 */
function extractSeverity(detail) {
  const sev = Array.isArray(detail.severity) ? detail.severity : [];
  // Prefer an exact vector over an approximated one (CVSS v4 is
  // approximated — see analyzers/cvss.js).
  let best = null;
  for (const item of sev) {
    if (!item || typeof item.score !== "string") continue;
    const scored = scoreCvssVector(item.score);
    if (!scored) continue;
    if (!best || (best.approximate && !scored.approximate)) {
      best = { ...scored, vector: item.score };
    }
  }
  if (best && best.severity !== "none") {
    return {
      severity:    best.severity,
      cvssScore:   best.score,
      cvssVector:  best.vector,
      cvssVersion: best.version,
      approximate: best.approximate,
    };
  }

  const dbs = detail.database_specific;
  if (dbs && typeof dbs.severity === "string") {
    const s = dbs.severity.toLowerCase();
    if (s === "critical" || s === "high" || s === "medium" || s === "low") {
      return { severity: s, cvssScore: null, cvssVector: null, cvssVersion: null, approximate: false };
    }
    if (s === "moderate") {
      return { severity: "medium", cvssScore: null, cvssVector: null, cvssVersion: null, approximate: false };
    }
  }

  // A vector that scored 0.0 ("none") is a real answer, just not a risky one.
  if (best && best.severity === "none") {
    return {
      severity: "low", cvssScore: best.score, cvssVector: best.vector,
      cvssVersion: best.version, approximate: best.approximate,
    };
  }
  return { severity: "unknown", cvssScore: null, cvssVector: null, cvssVersion: null, approximate: false };
}

function shortSummary(detail) {
  const s = (detail && typeof detail.summary === "string") ? detail.summary : "";
  return s.length > 240 ? s.slice(0, 239) + "…" : s;
}
