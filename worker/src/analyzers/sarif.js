// SARIF 2.1.0 output for dependency audits.
//
// The point of SARIF is not the file — it is that GitHub renders it in the
// repository's Security tab, which is where a security engineer already looks.
// A finding that only exists in our dashboard competes for attention; the same
// finding in their Security tab arrives where they work.
//
// Spec: SARIF 2.1.0 (OASIS). We emit the subset GitHub's code-scanning
// ingester actually reads, because emitting more of the schema than we can
// populate honestly produces a file that validates and says nothing.

const SARIF_VERSION = "2.1.0";
const SARIF_SCHEMA  = "https://raw.githubusercontent.com/oasis-tcs/sarif-spec/main/sarif-2.1/schema/sarif-schema-2.1.0.json";

// SARIF has three levels; our four severities have to map onto them. `error`
// for the two that should block a merge, `warning` for medium, `note` for low.
// The precise CVSS score travels in `properties` so nothing is lost in the
// flattening — a reader who cares can still sort by it.
const LEVEL_BY_SEVERITY = {
  critical: "error",
  high:     "error",
  medium:   "warning",
  low:      "note",
  unknown:  "warning",
};

// GitHub sorts and filters on this, and it is the field that decides whether a
// finding is loud. Kept separate from `level` because SARIF's three levels
// cannot express the difference between critical and high, and that difference
// is the one people act on.
const SECURITY_SEVERITY = {
  critical: "9.5",
  high:     "7.5",
  medium:   "5.0",
  low:      "2.0",
  unknown:  "5.0",
};

/**
 * A SARIF rule descriptor for a source finding.
 *
 * `tags` is the field GitHub renders as filter chips, so the CWE and OWASP
 * mappings go there rather than into prose nobody can filter on.
 */
function sourceRuleFor(f) {
  return {
    id: f.ruleId,
    name: String(f.ruleId || "").replace(/[^A-Za-z0-9]+/g, ""),
    shortDescription: { text: f.title || f.type },
    fullDescription: { text: f.recommendation || f.title || f.type },
    help: {
      text: f.recommendation || "",
      markdown: `**${f.title || f.type}**\n\n${f.recommendation || ""}` +
        (f.cwe && f.cwe.length
          ? `\n\n` + f.cwe.map((c) =>
              `[${c}](https://cwe.mitre.org/data/definitions/${String(c).replace("CWE-", "")}.html)`).join(" · ")
          : ""),
    },
    properties: {
      tags: ["security", f.category].concat(f.cwe || []).concat(f.owasp || []),
      "security-severity": SECURITY_SEVERITY[f.severity] || "5.0",
      precision: f.confidence === "high" ? "high" : f.confidence === "medium" ? "medium" : "low",
    },
  };
}

/** A stable rule id per advisory: one GitHub rule per CVE/GHSA. */
function ruleIdFor(advisory) {
  return `algosize/${advisory.id}`;
}

function ruleFor(advisory) {
  const severity = advisory.severity || "unknown";
  return {
    id: ruleIdFor(advisory),
    name: advisory.id,
    shortDescription: { text: `${advisory.id} in ${advisory.package}` },
    fullDescription:  { text: advisory.summary || `${advisory.id} affects ${advisory.package}.` },
    help: {
      text: helpText(advisory),
      markdown: helpMarkdown(advisory),
    },
    helpUri: advisory.advisoryUrl || `https://osv.dev/vulnerability/${encodeURIComponent(advisory.id)}`,
    properties: {
      tags: ["security", "dependency", severity],
      "security-severity": SECURITY_SEVERITY[severity] || SECURITY_SEVERITY.unknown,
      ...(advisory.cvssScore  != null ? { cvssScore:  advisory.cvssScore }  : {}),
      ...(advisory.cvssVector       ? { cvssVector: advisory.cvssVector } : {}),
      ...(advisory.aliases && advisory.aliases.length ? { aliases: advisory.aliases } : {}),
    },
  };
}

function helpText(a) {
  const lines = [
    `${a.package}@${a.installedVersion} is affected by ${a.id}.`,
  ];
  if (a.summary) lines.push("", a.summary);
  lines.push("", a.fixedIn
    ? `Fixed in ${a.fixedIn}. Upgrade to ${a.fixedIn} or later.`
    : "No fixed version is published yet. Check the advisory for mitigations.");
  if (a.cvssVector) lines.push("", `CVSS: ${a.cvssScore ?? "—"} (${a.cvssVector})`);
  return lines.join("\n");
}

function helpMarkdown(a) {
  const rows = [
    `**${a.package}@${a.installedVersion}** — [${a.id}](${a.advisoryUrl || "https://osv.dev"})`,
    "",
    a.summary || "",
    "",
    a.fixedIn
      ? `**Fix:** upgrade to \`${a.fixedIn}\` or later.`
      : "**Fix:** no patched version published yet — check the advisory for mitigations.",
  ];
  if (a.cvssVector) rows.push("", `**CVSS:** ${a.cvssScore ?? "—"} \`${a.cvssVector}\``);
  return rows.filter((r) => r !== undefined).join("\n");
}

/**
 * Which file to attach a finding to.
 *
 * SARIF requires a location, and GitHub will not display a result without one.
 * We attach to the manifest the package came from, at line 1 — we know the
 * lockfile, not the line within it, and inventing a line number would put a
 * red squiggle on an unrelated dependency. Line 1 of the right file is honest
 * and still lands the annotation where the fix happens.
 */
function locationFor(advisory, manifestPath) {
  return {
    physicalLocation: {
      artifactLocation: { uri: manifestPath, uriBaseId: "%SRCROOT%" },
      region: { startLine: 1 },
    },
  };
}

/**
 * Convert a stored vuln-audit result into a SARIF 2.1.0 log.
 *
 * `result` is the object the audit produced — `advisories`, `scanned`,
 * `summary`. Anything missing degrades to an empty-but-valid run rather than
 * throwing: a CI step that fails because the report generator crashed teaches
 * people to remove the CI step.
 */
export function toSarif(result, { runId = null, siteOrigin = "" } = {}) {
  const advisories = Array.isArray(result && result.advisories) ? result.advisories : [];
  const manifests  = (result && result.scanned && result.scanned.manifests) || [];

  // One manifest to hang findings on. When several were scanned we cannot tell
  // which one a given package came from (the parser merges them before the OSV
  // lookup), so we use the first — and say so, rather than guessing per-package.
  const primaryManifest = manifests.length ? manifests[0].filename : "package-lock.json";

  const rulesById = new Map();
  const results = [];

  // Source findings first. GitHub's code-scanning UI is where a reviewer
  // already works, and a SAST finding has something a dependency advisory
  // does not: a real file and a real line. Emitting them alongside the
  // advisories is the difference between "the scanner found something, go
  // open our dashboard" and the finding appearing inline on the pull request
  // that introduced it.
  const sourceFindings = (result && result.source && Array.isArray(result.source.findings))
    ? result.source.findings : [];
  for (const f of sourceFindings) {
    if (!f || !f.ruleId) continue;
    if (!rulesById.has(f.ruleId)) rulesById.set(f.ruleId, sourceRuleFor(f));
    results.push({
      ruleId: f.ruleId,
      level: LEVEL_BY_SEVERITY[f.severity] || "warning",
      message: {
        text: `${f.title || f.type}: ${f.recommendation}` +
          (f.evidence && f.evidence.source && f.evidence.sink
            ? ` (data flows from ${f.evidence.source} to ${f.evidence.sink})`
            : ""),
      },
      locations: [{
        physicalLocation: {
          artifactLocation: { uri: f.path, uriBaseId: "%SRCROOT%" },
          region: f.column
            ? { startLine: f.line, startColumn: f.column }
            : { startLine: f.line },
        },
      }],
      // Our own fingerprint, which is deliberately not keyed on the line
      // number — so GitHub keeps tracking a finding as one issue when
      // unrelated edits move it down the file, instead of closing it and
      // opening a new one on every commit.
      partialFingerprints: { algosizeFinding: f.fingerprint },
      properties: {
        confidence: f.confidence,
        category: f.category,
        module: f.module,
        ...(f.cwe && f.cwe.length ? { cwe: f.cwe } : {}),
      },
    });
  }

  for (const a of advisories) {
    if (!a || !a.id) continue;
    const id = ruleIdFor(a);
    if (!rulesById.has(id)) rulesById.set(id, ruleFor(a));
    results.push({
      ruleId: id,
      level: LEVEL_BY_SEVERITY[a.severity] || "warning",
      message: {
        text: a.fixedIn
          ? `${a.package}@${a.installedVersion} is affected by ${a.id}. Fixed in ${a.fixedIn}.`
          : `${a.package}@${a.installedVersion} is affected by ${a.id}. No fixed version published yet.`,
      },
      locations: [locationFor(a, primaryManifest)],
      // Stable across runs for the same advisory+package, so GitHub can track
      // a finding as it persists rather than re-reporting it as new each time.
      partialFingerprints: {
        algosizeAdvisory: `${a.id}/${a.ecosystem || "unknown"}/${a.package}`,
      },
    });
  }

  return {
    $schema: SARIF_SCHEMA,
    version: SARIF_VERSION,
    runs: [{
      tool: {
        driver: {
          name: "Algosize",
          informationUri: siteOrigin || "https://algosize.com",
          rules: [...rulesById.values()],
        },
      },
      results,
      // Coverage caveats travel with the report. If the audit was truncated,
      // a clean Security tab would otherwise read as "nothing found" when it
      // actually means "we stopped looking".
      properties: {
        ...(runId ? { algosizeRunId: runId } : {}),
        manifestsScanned: manifests.map((m) => m.filename),
        complete: !!(result && result.summary && result.summary.complete),
        // Which passes actually ran. A SARIF log with no source results
        // because the source could not be READ must not be indistinguishable
        // from one with no source results because the code was clean.
        sourceScanStatus: (result && result.source && result.source.status) || "not_run",
        ...(result && result.source && result.source.coverage
          ? { sourceFilesScanned: result.source.coverage.filesScanned }
          : {}),
        ...(manifests.length > 1
          ? { locationCaveat: "Findings are attached to the first scanned manifest; packages from several manifests are merged before the advisory lookup." }
          : {}),
      },
    }],
  };
}
