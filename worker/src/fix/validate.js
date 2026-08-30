// Static validation of fix proposals — everything a Worker can honestly check.
//
// ---------------------------------------------------------------------------
// WHAT "VALIDATED" IS ALLOWED TO MEAN HERE
// ---------------------------------------------------------------------------
//
// A Cloudflare Worker cannot execute the customer's code: no test run, no
// build, no project linters. Pretending otherwise is how a fix platform
// ships regressions with a green badge on them. So this engine runs the
// checks that ARE possible — and they are substantive — and stamps every
// result with the ones that were not:
//
//   structural   the proposal changed something, and only allowed files
//   parse        changed JavaScript still parses (acorn, module then script)
//   re-scan      the FULL scanner over the fixed content: the target finding
//                is gone, and nothing new at high/critical appeared — the
//                "no obvious security downgrade" check, measured rather than
//                asserted
//   secrets      free, because the re-scan includes the secrets engine: a fix
//                that pastes a credential in fails here
//   blast radius how much changed, from fix/diff.js — recorded always,
//                and failed when a bounded task changed implausibly much
//
// The verdict vocabulary is `passed_static` or `failed`. There is no bare
// "passed" in this module on purpose: tests and builds run where code runs —
// CI or the developer's machine — exactly as the optimizer gate measures in
// the customer's runner and labels the result `measuredBy: "ci_runner"`.

import * as acorn from "acorn";
import { analyzeVuln } from "../analyzers/vuln.js";
import { isAstParseable } from "../analyzers/sast/schema.js";
import { makeValidationResult } from "./schemas.js";
import { diffProposal } from "./diff.js";

// A minimal fix that rewrites this much of the file is suspect regardless of
// how it scans: reviewers approve what they can read, and a 400-line rewrite
// of a one-line finding is not reviewable as a security patch.
const MAX_CHANGED_LINES = 400;

/**
 * Validate one proposal against its task.
 *
 * Pure: content in, verdict out. No IO, no model calls — a proposal is
 * validated identically whether it came from Kimi, Claude, a human, or an
 * MCP client asking us to check its own work (which is exactly what the
 * algosize_validate_fix tool does).
 */
export function validateProposal(task, proposal) {
  const checks = [];
  const reasons = [];

  // ---- structural ---------------------------------------------------------
  const { patch, blastRadius } = diffProposal(task, proposal);
  const changedSomething = blastRadius.files > 0;
  checks.push({
    check: "structural", ok: changedSomething,
    detail: changedSomething
      ? `${blastRadius.files} file(s), +${blastRadius.linesAdded}/-${blastRadius.linesRemoved}`
      : "the proposal is byte-identical to the original",
  });
  if (!changedSomething) reasons.push("The proposal changes nothing, so it cannot have fixed anything.");

  const totalChanged = blastRadius.linesAdded + blastRadius.linesRemoved;
  const proportionate = totalChanged <= MAX_CHANGED_LINES;
  checks.push({
    check: "blast_radius", ok: proportionate,
    detail: proportionate
      ? `${totalChanged} changed line(s)`
      : `${totalChanged} changed lines for one finding — beyond what a reviewer can verify as a security patch`,
  });
  if (!proportionate) reasons.push(`The fix rewrites ${totalChanged} lines; a minimal fix was asked for.`);

  // ---- parse --------------------------------------------------------------
  let parseOk = true;
  for (const f of proposal.files) {
    if (!isAstParseable(f.path)) continue;
    const err = parseError(f.content);
    if (err) {
      parseOk = false;
      checks.push({ check: "parse", ok: false, detail: `${f.path}: ${err}` });
      reasons.push(`${f.path} no longer parses: ${err}`);
    }
  }
  if (parseOk) {
    checks.push({ check: "parse", ok: true, detail: "changed JavaScript parses" });
  }

  // ---- re-scan ------------------------------------------------------------
  //
  // The scanner sees the whole file set with the proposal's content swapped
  // in, so a fix that moves a vulnerability between files it was given is
  // still caught. Deltas are keyed on fingerprints — which are content-based
  // and deliberately NOT line-based, so an edit above a pre-existing finding
  // does not make that finding read as "new".
  const fixedFiles = mergeFiles(task.files, proposal.files);
  const before = analyzeVuln({ files: task.files }).findings;
  const after  = analyzeVuln({ files: fixedFiles }).findings;

  const beforePrints = new Set(before.map((f) => f.fingerprint));
  const afterPrints  = new Set(after.map((f) => f.fingerprint));

  const target = task.acceptance.targetFingerprint;
  const targetRule = task.finding.ruleId;
  const targetPath = task.finding.path;
  const countRule = (list) => list.filter((f) => f.ruleId === targetRule && f.path === targetPath).length;
  // Gone AND fewer: the fingerprint vanishing is necessary but not
  // sufficient — a re-spelled version of the same bug has a new fingerprint,
  // and only the same-rule count catches it. A file with two instances of the
  // rule where the task targeted one still passes when exactly one is fixed.
  const targetRemoved = !afterPrints.has(target) && countRule(after) < countRule(before);
  checks.push({
    check: "target_removed", ok: targetRemoved,
    detail: targetRemoved
      ? `${targetRule} no longer fires at ${targetPath}`
      : `${targetRule} still fires at ${targetPath} — the finding this task exists to fix`,
  });
  if (!targetRemoved) reasons.push("The target finding is still present in the fixed code.");

  const newFindings = after.filter((f) => !beforePrints.has(f.fingerprint));
  const newSevere = newFindings.filter((f) => f.severity === "critical" || f.severity === "high");
  checks.push({
    check: "no_new_severe", ok: newSevere.length === 0,
    detail: newSevere.length
      ? newSevere.map((f) => `${f.severity} ${f.ruleId} at ${f.path}:${f.line}`).join("; ")
      : `${newFindings.length} new finding(s), none at high or critical`,
  });
  if (newSevere.length) {
    reasons.push(`The fix introduces ${newSevere.length} new high/critical finding(s) — a security downgrade.`);
  }

  const newBySeverity = {};
  for (const f of newFindings) newBySeverity[f.severity] = (newBySeverity[f.severity] || 0) + 1;

  const verdict = checks.every((c) => c.ok) ? "passed_static" : "failed";
  return {
    result: makeValidationResult({
      proposalId: proposal.id,
      verdict,
      checks,
      findingDelta: {
        targetRemoved,
        // Findings from the original scan whose fingerprint is absent after
        // the fix — the honest count of what this proposal resolved.
        resolvedCount: before.filter((f) => !afterPrints.has(f.fingerprint)).length,
        newFindings: newFindings.map((f) => ({
          ruleId: f.ruleId, severity: f.severity, path: f.path, line: f.line, title: f.title,
        })),
        newBySeverity,
      },
      blastRadius,
      reasons,
    }),
    patch,
  };
}

/** Task files with the proposal's replacements swapped in. */
function mergeFiles(taskFiles, proposalFiles) {
  const replaced = new Map(proposalFiles.map((f) => [f.path, f.content]));
  return taskFiles.map((f) => ({
    path: f.path,
    content: replaced.has(f.path) ? replaced.get(f.path) : f.content,
  }));
}

/** acorn parse error message, or null. Tries module goal, then script. */
function parseError(content) {
  for (const sourceType of ["module", "script"]) {
    try {
      acorn.parse(content, { ecmaVersion: "latest", sourceType });
      return null;
    } catch (err) {
      if (sourceType === "script") return String(err.message || err).slice(0, 200);
    }
  }
  return "unparseable";
}
