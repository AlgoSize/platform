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
        ...(manifests.length > 1
          ? { locationCaveat: "Findings are attached to the first scanned manifest; packages from several manifests are merged before the advisory lookup." }
          : {}),
      },
    }],
  };
}
