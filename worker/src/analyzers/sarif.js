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

import { fingerprintOf } from "./sast/schema.js";

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
// GitHub derives an alert's severity from the RULE's `security-severity`, not
// from the individual result — so one rule cannot carry two severities. Our
// severities are per-FINDING: the same injection pattern is high in a request
// handler and capped to medium in a test file, which is the whole point of the
// cap in sast/schema.js.
//
// Emitting both under one rule silently discarded the cap. A capped test
// finding inherited "High" from whichever product-code sibling happened to be
// serialized first, and this repository's own pull request showed ten test-file
// alerts as high-severity security vulnerabilities — the exact noise the cap
// exists to prevent, reintroduced at the reporting boundary.
//
// So a capped finding gets its OWN rule id. Different severity, different rule
// — that is what GitHub's model requires, and the suffix says why in the id
// itself. Alert history is keyed on partialFingerprints, which is unchanged.
export function sarifRuleIdFor(f) {
  return f && f.evidence && f.evidence.severityCapped
    ? `${f.ruleId}.test-code`
    : f.ruleId;
}

function sourceRuleFor(f) {
  const capped = !!(f.evidence && f.evidence.severityCapped);
  return {
    id: sarifRuleIdFor(f),
    name: String(sarifRuleIdFor(f) || "").replace(/[^A-Za-z0-9]+/g, ""),
    shortDescription: { text: (f.title || f.type) + (capped ? " (in test code)" : "") },
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
      tags: ["security", f.category]
        .concat(capped ? ["test-code"] : [])
        .concat(f.cwe || []).concat(f.owasp || []),
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
    const sarifRuleId = sarifRuleIdFor(f);
    if (!rulesById.has(sarifRuleId)) {
      rulesById.set(sarifRuleId, sourceRuleFor(f));
    } else {
      // Belt and braces for any OTHER per-finding severity override (a
      // taint-confirmed sink outranking its registry baseline): a rule keeps
      // the LOUDEST severity among its findings, so a shared rule can
      // over-report but never under-report.
      const existing = rulesById.get(sarifRuleId);
      const seen = parseFloat(existing.properties["security-severity"]);
      const mine = parseFloat(SECURITY_SEVERITY[f.severity] || "5.0");
      if (mine > seen) existing.properties["security-severity"] = String(mine);
    }
    results.push({
      ruleId: sarifRuleId,
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
      // An accepted risk is SUPPRESSED here, not omitted.
      //
      // SARIF has a word for this and GitHub renders it: the alert shows as
      // closed-and-suppressed with the justification attached, rather than
      // silently absent from the Security tab. Dropping the result would make
      // the export disagree with the report, and would make an acceptance
      // indistinguishable from a fix.
      //
      // The `level` and the rule's security-severity are UNTOUCHED: accepting
      // a risk does not make it less severe, only differently owned. And no
      // suffixed rule id is minted (unlike the test-code cap, which changes
      // severity and therefore must fork the rule) — a second id would fork
      // GitHub's alert history for no gain.
      //
      // A drifted or expired acceptance emits nothing here. Both are open.
      ...(f.accepted && f.acceptance ? {
        suppressions: [{
          kind: "external",
          status: "accepted",
          justification: f.acceptance.rationale,
          properties: {
            owner: f.acceptance.ownerEmail,
            ...(f.acceptance.expiresOn ? { expiresOn: f.acceptance.expiresOn } : {}),
          },
        }],
      } : {}),
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


// ---------------------------------------------------------------------------
// SARIF IMPORT — external scanners' results as normalized findings
// ---------------------------------------------------------------------------
//
// The reverse direction: a SARIF log produced by ANY scanner becomes findings
// in the platform's own shape, so external results flow through the same
// grouping, prioritization and fix pipeline as native ones. Mapping rules:
//
//   severity     security-severity when present (the CVSS-ish scale GitHub
//                sorts on), else the three-level `level` — error→high,
//                warning→medium, note→low. Never critical from `level` alone:
//                three levels cannot express critical, and inventing it would
//                overclaim on every imported error.
//   ruleId       namespaced as `sarif.<tool>.<originalRuleId>` so imports can
//                never collide with the native registry, while the original
//                id survives verbatim in `evidence.importedRuleId` — the
//                mapping back that interop requires.
//   fingerprint  the platform's own content-based fingerprint, so an imported
//                finding dedupes and diffs exactly like a native one.
//
// Anything unreadable is skipped and COUNTED, never silently dropped: the
// return says how many results the log claimed and how many survived.

const IMPORT_SEVERITY_BY_LEVEL = { error: "high", warning: "medium", note: "low", none: "info" };
const MAX_IMPORT_RESULTS = 2000;

function importSeverity(result, rule) {
  const props = (rule && rule.properties) || {};
  const ss = parseFloat(props["security-severity"]);
  if (Number.isFinite(ss)) {
    if (ss >= 9) return "critical";
    if (ss >= 7) return "high";
    if (ss >= 4) return "medium";
    if (ss > 0)  return "low";
  }
  return IMPORT_SEVERITY_BY_LEVEL[result.level]
    || IMPORT_SEVERITY_BY_LEVEL[(rule && rule.defaultConfiguration && rule.defaultConfiguration.level)]
    || "medium";
}

function extractCwes(rule) {
  const tags = (rule && rule.properties && rule.properties.tags) || [];
  return tags
    .map((t) => /(?:external\/)?cwe(?:\/|-)?(\d+)/i.exec(String(t)))
    .filter(Boolean)
    .map((m) => `CWE-${m[1]}`);
}

/**
 * Parse a SARIF 2.1 document into normalized findings.
 *
 * @returns {{ ok:true, findings, skipped, total, toolNames }
 *         | { ok:false, error, message }}
 */
export function fromSarif(doc) {
  if (typeof doc === "string") {
    try { doc = JSON.parse(doc); }
    catch { return { ok: false, error: "invalid_sarif", message: "the document is not valid JSON" }; }
  }
  if (!doc || !Array.isArray(doc.runs)) {
    return { ok: false, error: "invalid_sarif", message: "a SARIF document has a top-level `runs` array" };
  }

  const findings = [];
  const toolNames = [];
  let skipped = 0, total = 0;
  const occurrence = new Map();

  for (const run of doc.runs) {
    const driver = (run && run.tool && run.tool.driver) || {};
    const toolName = String(driver.name || "unknown-tool");
    toolNames.push(toolName);
    const toolSlug = toolName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "") || "tool";
    const rulesById = new Map((driver.rules || []).map((r) => [r.id, r]));

    for (const result of (run.results || [])) {
      total++;
      if (findings.length >= MAX_IMPORT_RESULTS) { skipped++; continue; }
      if (!result || typeof result !== "object") { skipped++; continue; }
      const originalRuleId = String(result.ruleId || (result.rule && result.rule.id) || "");
      const loc = Array.isArray(result.locations) && result.locations[0] && result.locations[0].physicalLocation;
      const path = loc && loc.artifactLocation && typeof loc.artifactLocation.uri === "string"
        ? loc.artifactLocation.uri.replace(/^file:\/\/+/, "").replace(/^\.\//, "")
        : null;
      if (!originalRuleId || !path) { skipped++; continue; }

      const rule = rulesById.get(originalRuleId);
      const message = (result.message && (result.message.text || result.message.markdown)) || "";
      const ruleId = `sarif.${toolSlug}.${originalRuleId}`;
      const snippet = String(message).slice(0, 200);

      const occKey = `${ruleId}|${path}|${snippet}`;
      const occ = occurrence.get(occKey) || 0;
      occurrence.set(occKey, occ + 1);

      findings.push({
        severity: importSeverity(result, rule),
        // Imported severities are the FOREIGN tool's claim, relayed — not
        // re-derived by us — so confidence is capped at medium: we can vouch
        // for the mapping, not for the finding.
        confidence: "medium",
        type: "imported_finding",
        ruleId,
        title: (rule && rule.shortDescription && rule.shortDescription.text) || originalRuleId,
        category: "imported",
        cwe: extractCwes(rule),
        owasp: [],
        path,
        line: (loc && loc.region && loc.region.startLine) || 1,
        snippet,
        recommendation: ((rule && rule.help && (rule.help.text || rule.help.markdown)) || "").slice(0, 500)
          || `See ${toolName}'s documentation for ${originalRuleId}.`,
        module: "sarif-import",
        language: null,
        evidence: { importedFrom: toolName, importedRuleId: originalRuleId },
        fingerprint: fingerprintOf({ ruleId, path, snippet }, occ),
      });
    }
  }

  return { ok: true, findings, skipped, total, toolNames };
}
