// Fix orchestrator — the finding-to-fix lifecycle, end to end.
//
//   finding ──▶ eligibility ──▶ FixTask (context packet)
//        ──▶ provider adapter ──▶ FixProposal
//        ──▶ static validation ──▶ verdict + patch + blast radius
//        ──▶ AgentExecutionRecord (hashes only) for the audit log
//
// This module owns the business decisions the provider layer must not:
// which findings are worth a fix task, what context a task carries, when a
// bad reply earns a constrained retry, and what the caller gets back. It
// performs no IO of its own beyond the provider call it is handed — file
// content arrives from the caller (the HTTP handler refetches it, an MCP
// client supplies its local copy), so the pipeline itself stays testable
// with literal strings.

import { languageOfPath } from "../analyzers/sast/languages.js";
import { ruleById } from "../analyzers/sast/registry.js";
import {
  SCHEMAS, MAX_FIX_FILE_BYTES, newFixTaskId,
  validateFixTask, toFixProposal, makeAgentExecutionRecord,
} from "./schemas.js";
import { resolveProvider } from "./providers.js";
import { validateProposal } from "./validate.js";

// ---------------------------------------------------------------------------
// Eligibility
// ---------------------------------------------------------------------------

/**
 * Can this finding become a fix task at all? Returns { ok } or
 * { ok:false, reason, message } — a reason, not an error, because "this
 * finding is not automatable" is an answer the UI shows, not a failure.
 */
export function fixEligibility(finding, files) {
  if (!finding || typeof finding.ruleId !== "string" || typeof finding.fingerprint !== "string") {
    return { ok: false, reason: "not_a_finding", message: "A normalized finding with ruleId and fingerprint is required." };
  }
  if (finding.category === "dependency") {
    // A dependency advisory's fix is a version bump, and the advisory panel's
    // existing generator (analyzers/fixgen.js, kind "vuln") already produces
    // exactly that. Routing it through source rewriting would have a model
    // hand-edit a lockfile — the one file class this platform refuses to
    // fetch into fix context at all.
    return { ok: false, reason: "dependency_finding", message: "Dependency advisories are fixed by upgrading — use the advisory panel's fix generator." };
  }
  const file = (files || []).find((f) => f && f.path === finding.path);
  if (!file) {
    return { ok: false, reason: "file_not_supplied", message: `The finding is in ${finding.path}, which was not provided.` };
  }
  if (typeof file.content !== "string" || !file.content) {
    return { ok: false, reason: "file_empty", message: `${finding.path} has no content to fix.` };
  }
  if (file.content.length > MAX_FIX_FILE_BYTES) {
    // Not "fixed with less context": a model rewriting a file it cannot fully
    // see is how fixes delete code they never read.
    return { ok: false, reason: "file_too_large_for_fix",
      message: `${finding.path} is ${Math.round(file.content.length / 1024)}KB; the fix context cap is ${Math.round(MAX_FIX_FILE_BYTES / 1024)}KB.` };
  }
  return { ok: true, file };
}

// ---------------------------------------------------------------------------
// FixTask construction — the context packet
// ---------------------------------------------------------------------------

/**
 * Build a FixTask from a normalized finding plus the file it lives in.
 *
 * The packet carries everything the model needs and nothing it should not:
 * the finding's own metadata (CWE/OWASP/severity/evidence), the registry's
 * remediation text for the rule, language and framework context, the full
 * affected file, and measurable acceptance criteria. Secrets in the snippet
 * were already masked by the scanner before the finding existed.
 */
export function findingToFixTask(finding, files, { frameworks = [], provider = null } = {}) {
  const eligible = fixEligibility(finding, files);
  if (!eligible.ok) return eligible;

  const rule = ruleById(finding.ruleId);
  return {
    ok: true,
    value: {
      schema: SCHEMAS.FIX_TASK,
      id: newFixTaskId(),
      finding: {
        ruleId: finding.ruleId,
        fingerprint: finding.fingerprint,
        title: finding.title || (rule && rule.title) || finding.ruleId,
        severity: finding.severity,
        confidence: finding.confidence,
        category: finding.category,
        cwe: finding.cwe || (rule && rule.cwe) || [],
        owasp: finding.owasp || (rule && rule.owasp) || [],
        path: finding.path,
        line: finding.line,
        snippet: finding.snippet || null,
        evidence: finding.evidence || null,
      },
      files: [{ path: eligible.file.path, content: eligible.file.content }],
      context: {
        language: languageOfPath(finding.path),
        frameworks: frameworks.map((f) => (typeof f === "string" ? f : f.name)).filter(Boolean),
        remediation: finding.recommendation || (rule && rule.remediation) || null,
      },
      acceptance: {
        targetFingerprint: finding.fingerprint,
        maxNewSeverity: "medium",
        mustParse: true,
      },
      requestedProvider: provider,
      createdAt: Math.floor(Date.now() / 1000),
    },
  };
}

// ---------------------------------------------------------------------------
// The pipeline
// ---------------------------------------------------------------------------

/**
 * finding → task → proposal → validation, with one constrained retry.
 *
 * The retry rule is narrow and mechanical: an unparseable reply or a
 * proposal that failed validation earns exactly ONE more attempt, with the
 * failure folded in as constraints the model can act on. One, not more —
 * each attempt costs the caller money, and a model that misses twice with
 * the failure spelled out is telling us this finding needs a human.
 *
 * Returns every artifact it produced, success or not, because the failure
 * path is a product surface here: "the model proposed X and validation
 * rejected it for Y" is exactly what a reviewer wants to see.
 */
export async function runFixPipeline({ finding, files, frameworks = [], provider = null, env }) {
  const started = Date.now();

  const taskResult = findingToFixTask(finding, files, { frameworks, provider });
  if (!taskResult.ok) return { ok: false, stage: "task", ...taskResult };
  const task = taskResult.value;

  const checked = validateFixTask(task);
  if (!checked.ok) return { ok: false, stage: "task", ...checked };

  const resolved = resolveProvider(provider, env);
  if (!resolved.ok) return { ok: false, stage: "provider", ...resolved, task };
  const agent = resolved.provider;

  // ---- attempt 1 ----------------------------------------------------------
  let attempt = await agent.createFixProposal(task, env);
  let proposal = null, validation = null, patch = null, retried = false;

  const settle = (raw) => {
    const normalized = toFixProposal(raw, task, { provider: agent.id, model: attempt.model });
    if (!normalized.ok) return normalized;
    const v = validateProposal(task, normalized.value);
    return { ok: true, proposal: normalized.value, validation: v.result, patch: v.patch };
  };

  if (attempt.ok) {
    const settled = settle(attempt.raw);
    if (settled.ok) ({ proposal, validation, patch } = settled);
    else attempt = { ok: false, error: settled.error, message: settled.message };
  }

  // ---- one constrained retry ---------------------------------------------
  const needsRetry =
    (!attempt.ok && attempt.error !== "provider_not_configured" && attempt.error !== "provider_failed") ||
    (validation && validation.verdict === "failed");
  if (needsRetry) {
    retried = true;
    const constraints = validation
      ? validation.reasons
      : [`Your previous reply was rejected: ${attempt.message}. Reply with ONLY the JSON object described in the instructions.`];
    const second = await agent.retryFixWithConstraints(task, env, constraints);
    if (second.ok) {
      const settled = settle(second.raw);
      if (settled.ok) {
        // The retry replaces the first attempt only when it is an
        // improvement; a failed retry leaves the first (annotated) result in
        // place so the caller sees the best attempt, not the last one.
        const better = !validation || settled.validation.verdict === "passed_static";
        if (better) ({ proposal, validation, patch } = settled);
      }
    }
  }

  const record = makeAgentExecutionRecord({
    task, proposal, validation,
    provider: agent.id,
    model: (proposal && proposal.model) || null,
    ok: Boolean(proposal),
    errorCode: proposal ? null : (attempt.error || "provider_failed"),
    durationMs: Date.now() - started,
  });

  if (!proposal) {
    return {
      ok: false, stage: "proposal", task, record, retried,
      error: attempt.error || "provider_failed",
      message: attempt.message || "The provider did not return a usable proposal.",
    };
  }

  return {
    ok: true,
    task,
    proposal,
    validation,
    patch,
    retried,
    record,
    // The one-line truth for a UI badge: a fix is APPLYABLE when it passed
    // every static check; anything else is a draft that needs a human.
    applyable: validation.verdict === "passed_static",
  };
}
