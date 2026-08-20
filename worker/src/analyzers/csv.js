// CSV export of a dependency-audit run — the spreadsheet the customer keeps.
//
// Sits beside sarif.js and cyclonedx.js as the third interchange format on
// GET /api/runs/:id/report. Those two feed machines (code scanning, SBOM
// tooling); this one feeds a person with a spreadsheet — the security lead
// tracking remediation in Sheets, the consultant pasting findings into a
// client workbook. So the column set mirrors what the HTML report SHOWS,
// not the raw result object: one row per advisory, in the same
// severity-then-fixability order the report prints, with the upgrade
// command spelled out per row.
//
// Two structural rules, both learned elsewhere in this codebase:
//
//   * RFC-4180 quoting and CRLF line endings, because Excel is the reader
//     that matters and it is the least forgiving one.
//   * The scope and score ride IN the file as comment rows. A spreadsheet
//     gets detached from the page it came from immediately — a table of
//     findings with no repo name, timestamp or coverage caveat becomes "the
//     audit" in a meeting six weeks later, wrong and unattributable. Same
//     reasoning as the estimator's CSV (dash-estimate.js).

/** RFC-4180: quote when the value contains a comma, quote, or newline. */
export function csvCell(v) {
  const s = v === undefined || v === null ? "" : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const row = (cells) => cells.map(csvCell).join(",");

/**
 * Render one vuln run as CSV.
 *
 * @param {object} run  the stored run — { id, input, result, createdAt }
 * @returns {string}    CRLF-joined CSV text
 */
export function toAuditCsv(run) {
  const result = (run && run.result) || {};
  const summary = result.summary || {};
  const counts = summary.counts || {};
  const scanned = result.scanned || {};
  const input = (run && run.input) || {};
  const ci = input.ci || {};
  const advisories = Array.isArray(result.advisories) ? result.advisories : [];

  const lines = [];

  // ---- provenance header, as comment rows -------------------------------
  const repo = ci.repo || input.repo || input.repoUrl || null;
  lines.push(row(["# Algosize dependency audit" + (repo ? ` — ${repo}` : "")]));
  lines.push(row([
    `# Score ${summary.securityScore ?? "—"}/100 · grade ${summary.grade ?? "—"} · ` +
    `${summary.totalIssues ?? advisories.length} finding(s) · worst severity: ${summary.worstSeverity || "none"}`,
  ]));
  if (Array.isArray(scanned.manifests) && scanned.manifests.length) {
    lines.push(row([`# Manifests: ${scanned.manifests.join(", ")}` +
      (typeof scanned.totalPackages === "number" ? ` · ${scanned.totalPackages} packages` : "")]));
  }
  // The coverage caveat is the one line that must not be lost in transit:
  // a truncated audit pasted into a tracker without it reads as a complete one.
  if (summary.complete === false) {
    lines.push(row([`# COVERAGE INCOMPLETE — counts are a lower bound. ${summary.partialReason || ""}`.trim()]));
  }
  if (run && run.id) lines.push(row([`# Run ${run.id}`]));
  lines.push("");

  // ---- findings ---------------------------------------------------------
  lines.push(row([
    "severity", "package", "ecosystem", "installed_version", "fixed_in",
    "advisory_id", "cvss_score", "cvss_version", "cvss_vector", "score_source",
    "upgrade_command", "advisory_url",
  ]));
  for (const a of advisories) {
    lines.push(row([
      a.severity || "unknown",
      a.package,
      a.ecosystem || "",
      a.installedVersion,
      a.fixedIn || "",
      a.id,
      a.cvssScore == null ? "" : a.cvssScore,
      a.cvssVersion || "",
      a.cvssVector || "",
      // Three-way, matching the HTML report's wording: a score OSV published,
      // one we approximated from the vector, or none at all.
      a.cvssScore == null ? "none" : (a.approximate ? "approximate" : "published"),
      a.fixedIn ? `npm install ${a.package}@${a.fixedIn}` : "",
      a.advisoryUrl || (a.id ? `https://osv.dev/vulnerability/${a.id}` : ""),
    ]));
  }

  // ---- severity tally ---------------------------------------------------
  lines.push("");
  lines.push(row(["severity", "count"]));
  for (const sev of ["critical", "high", "medium", "low", "unknown"]) {
    lines.push(row([sev, counts[sev] ?? 0]));
  }

  // ---- remediation, in the report's order -------------------------------
  const remediation = Array.isArray(summary.remediation) ? summary.remediation : [];
  if (remediation.length) {
    lines.push("");
    lines.push(row(["order", "priority", "action", "why", "command"]));
    remediation.forEach((r, i) => {
      lines.push(row([i + 1, r.priority || "", r.action || "", r.why || "", r.command || ""]));
    });
  }

  return lines.join("\r\n") + "\r\n";
}
