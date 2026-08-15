// Audit verdict — turns raw findings into something a human can act on.
//
// `/api/analyze/vuln` has two modes that produce different raw shapes: a
// source scan returns `findings[]` (analyzers/vuln.js) and a dependency
// audit returns `advisories[]` (analyzers/osv.js). Both previously ended at
// "here is a list", which leaves the caller to work out whether the repo is
// in trouble and what to do first.
//
// This module gives both modes the same `summary` block: one score, one
// grade, and an ordered remediation list where the first item is the thing
// to do first. Pure and synchronous — same posture as the analyzers.

const SEVERITY_ORDER = ["critical", "high", "medium", "low", "unknown"];

// Points deducted per issue. Critical is deliberately steep: four exposed
// credentials should not leave a repo with a passing grade. `unknown` sits
// between high and medium — an unrated advisory is a real advisory whose
// severity nobody has published yet, so it can't be treated as harmless.
const SEVERITY_WEIGHT = {
  critical: 25,
  high:     12,
  unknown:   8,
  medium:    4,
  low:       1,
};

/** Tally a list of `{severity}` objects into per-severity counts. */
export function countBySeverity(items) {
  const counts = { critical: 0, high: 0, medium: 0, low: 0, unknown: 0 };
  for (const item of items || []) {
    const s = item && typeof item.severity === "string" ? item.severity : "unknown";
    if (counts[s] === undefined) counts.unknown++;
    else counts[s]++;
  }
  return counts;
}

export function gradeForScore(score) {
  if (score >= 90) return "A";
  if (score >= 75) return "B";
  if (score >= 60) return "C";
  if (score >= 40) return "D";
  return "F";
}

/** Highest severity present, or null when there's nothing at all. */
export function worstSeverity(counts) {
  for (const s of SEVERITY_ORDER) {
    if (counts[s] > 0) return s;
  }
  return null;
}

/**
 * Prioritized, deduplicated remediation steps.
 *
 * Ordered by what a responder should do first: rotate leaked credentials
 * (the only finding class where the damage continues after the code is
 * fixed), then patch known-exploitable dependencies, then fix injection
 * sinks, then the rest.
 */
function buildRemediation({ findings, advisories, fixCommand }) {
  const steps = [];
  const byType = new Map();
  for (const f of findings || []) {
    if (!byType.has(f.type)) byType.set(f.type, []);
    byType.get(f.type).push(f);
  }

  // 1. Leaked credentials — rotation is time-critical and can't wait for a
  //    code review, because the secret is already in git history.
  const secretTypes = [...byType.keys()].filter((t) => t.startsWith("hardcoded_") || t === "private_key_material");
  const secretCount = secretTypes.reduce((n, t) => n + byType.get(t).length, 0);
  if (secretCount > 0) {
    const where = secretTypes
      .flatMap((t) => byType.get(t))
      .slice(0, 3)
      .map((f) => `${f.path}:${f.line}`)
      .join(", ");
    steps.push({
      priority: "now",
      action: `Rotate ${secretCount} exposed credential${secretCount === 1 ? "" : "s"} (${where}${secretCount > 3 ? ", …" : ""}), then purge them from git history.`,
      why: "A committed secret stays valid until it is rotated — removing the line does not undo the exposure.",
    });
  }

  // 2. Known-vulnerable dependencies that have a published fix.
  const fixable = (advisories || []).filter((a) => a.fixedIn);
  if (fixable.length > 0) {
    const worst = fixable
      .slice()
      .sort((a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity))
      .slice(0, 3)
      .map((a) => `${a.package} ${a.installedVersion} → ${a.fixedIn}`)
      .join(", ");
    steps.push({
      priority: "high",
      action: `Upgrade ${fixable.length} vulnerable dependenc${fixable.length === 1 ? "y" : "ies"} with published fixes: ${worst}${fixable.length > 3 ? ", …" : ""}.`,
      why: "Each of these has a fixed version available, so the upgrade is the whole remediation.",
      command: fixCommand || null,
    });
  }

  // 3. Advisories with no fix yet — different action, so a different step.
  const unfixable = (advisories || []).filter((a) => !a.fixedIn && (a.severity === "critical" || a.severity === "high"));
  if (unfixable.length > 0) {
    steps.push({
      priority: "high",
      action: `Assess ${unfixable.length} high-severity advisor${unfixable.length === 1 ? "y" : "ies"} with no fixed version published (${unfixable.slice(0, 3).map((a) => a.package).join(", ")}).`,
      why: "No upgrade exists yet — mitigate by removing the dependency, pinning to an unaffected major, or applying the advisory's documented workaround.",
    });
  }

  // 4. Injection sinks — the exploitable-code findings.
  const injection = ["sql_string_concatenation", "sql_template_literal_injection", "command_injection", "use_of_eval", "use_of_exec", "xss_sink", "insecure_deserialization"]
    .filter((t) => byType.has(t));
  const injectionCount = injection.reduce((n, t) => n + byType.get(t).length, 0);
  if (injectionCount > 0) {
    steps.push({
      priority: "high",
      action: `Fix ${injectionCount} injection-prone call site${injectionCount === 1 ? "" : "s"} (${injection.join(", ")}).`,
      why: "These execute attacker-controlled input if any of the interpolated values crosses a trust boundary.",
    });
  }

  // 5. Transport and crypto hygiene.
  const hygiene = ["disabled_tls_verification", "weak_hash_algorithm", "insecure_randomness", "insecure_http_url"]
    .filter((t) => byType.has(t));
  const hygieneCount = hygiene.reduce((n, t) => n + byType.get(t).length, 0);
  if (hygieneCount > 0) {
    steps.push({
      priority: "medium",
      action: `Address ${hygieneCount} transport/crypto hygiene issue${hygieneCount === 1 ? "" : "s"} (${hygiene.join(", ")}).`,
      why: "Individually low-drama, but they are what turns a small bug into a full compromise.",
    });
  }

  return steps;
}

/**
 * Build the audit summary.
 *
 * `findings`   source-scan findings (analyzers/vuln.js), optional
 * `advisories` dependency advisories (analyzers/osv.js), optional
 * `fixCommand` ecosystem upgrade command, optional
 * `partial`    truncation flags — a partial audit must never present itself
 *              as a complete one.
 */
export function buildAuditSummary({ findings = [], advisories = [], fixCommand = null, partial = null } = {}) {
  const all = [...findings, ...advisories];
  const counts = countBySeverity(all);

  let deductions = 0;
  for (const [severity, n] of Object.entries(counts)) {
    deductions += (SEVERITY_WEIGHT[severity] || 0) * n;
  }
  let score = Math.max(0, 100 - deductions);

  // Severity caps. Pure arithmetic would give a repo with one leaked live
  // AWS key a 75 — a "B" — because a single 25-point deduction leaves
  // plenty of room. That is not how a security audit reads: one exposed
  // credential or one remotely exploitable dependency is a failure
  // regardless of how tidy everything else is. So the worst finding puts a
  // ceiling on the grade, and additional findings can only push it lower.
  if (counts.critical > 0)  score = Math.min(score, 39);   // F
  else if (counts.high > 0) score = Math.min(score, 59);   // D or worse
  else if (counts.unknown > 0) score = Math.min(score, 74); // C or worse

  const summary = {
    securityScore: score,
    grade: gradeForScore(score),
    totalIssues: all.length,
    counts,
    worstSeverity: worstSeverity(counts),
    sourceFindings: findings.length,
    dependencyAdvisories: advisories.length,
    remediation: buildRemediation({ findings, advisories, fixCommand }),
    // `complete: false` means the numbers above are a floor, not a total.
    complete: !(partial && (partial.packagesTruncated || partial.vulnsTruncated || partial.filesTruncated)),
  };

  if (!summary.complete) {
    summary.partial = partial;
    summary.partialReason =
      "This audit hit an internal cap and did not cover everything — the counts above are a lower bound. " +
      "Re-run against a smaller scope for complete coverage.";
  }
  return summary;
}
