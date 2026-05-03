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
export async function osvBatchQuery(packages, fetchImpl = fetch) {
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
export async function osvHydrateVulns(matches, fetchImpl = fetch) {
  if (!Array.isArray(matches) || matches.length === 0) return [];

  // Unique IDs to fetch — cap to bound fan-out.
  const idOrder = [];
  const idSet = new Set();
  for (const m of matches) {
    if (idSet.has(m.id)) continue;
    idSet.add(m.id);
    idOrder.push(m.id);
    if (idOrder.length >= MAX_VULNS_TO_HYDRATE) break;
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
    advisories.push({
      id: m.id,
      ecosystem: m.package.ecosystem,
      package: m.package.name,
      installedVersion: m.package.version,
      fixedIn: extractFixedIn(detail, m.package),
      severity: extractSeverity(detail),
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
 * OSV stores fix info in `affected[].ranges[].events[]`. Each "range" is a
 * sequence of `{introduced: "X"} ... {fixed: "Y"}` events. We pick the LAST
 * `fixed` event in the range that matches our package — that's the version
 * the user should upgrade to.
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
  let lastFixed = null;
  for (const r of ranges) {
    const events = Array.isArray(r.events) ? r.events : [];
    for (const ev of events) {
      if (ev && typeof ev.fixed === "string") lastFixed = ev.fixed;
    }
  }
  return lastFixed;
}

/**
 * Two sources, in order of preference:
 *   1. database_specific.severity     — GHSA's text rating (LOW/MODERATE/HIGH/CRITICAL)
 *   2. severity[] CVSS vector         — parse base score, bucket per FIRST CVSS rubric
 *   3. fall back to "unknown"         — explicit, never silently downgrade
 */
function extractSeverity(detail) {
  const dbs = detail.database_specific;
  if (dbs && typeof dbs.severity === "string") {
    const s = dbs.severity.toLowerCase();
    if (s === "critical" || s === "high" || s === "medium" || s === "low") return s;
    if (s === "moderate") return "medium";
  }
  const sev = Array.isArray(detail.severity) ? detail.severity : [];
  for (const item of sev) {
    if (!item || typeof item.score !== "string") continue;
    // OSV's `score` is usually a CVSS vector string; some sources append the
    // numeric base score to the end. Strip the "CVSS:X.Y/" version prefix so
    // that "3.1" doesn't get mistaken for the base score, then look for a
    // standalone 0.0–10.0 number anywhere in the remainder.
    const stripped = item.score.replace(/^\s*CVSS:[\d.]+\/?/, "");
    const m = /(?:^|[\s/])(\d+(?:\.\d+)?)(?=$|[\s/])/.exec(stripped);
    if (m) {
      const score = parseFloat(m[1]);
      if (score >= 0 && score <= 10) return cvssNumberToSeverity(score);
    }
  }
  return "unknown";
}

function cvssNumberToSeverity(score) {
  // FIRST CVSS v3 qualitative rating scale.
  if (score >= 9.0) return "critical";
  if (score >= 7.0) return "high";
  if (score >= 4.0) return "medium";
  if (score >  0.0) return "low";
  return "unknown";
}

function shortSummary(detail) {
  const s = (detail && typeof detail.summary === "string") ? detail.summary : "";
  return s.length > 240 ? s.slice(0, 239) + "…" : s;
}
