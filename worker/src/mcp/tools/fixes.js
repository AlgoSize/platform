// Fix tools — the MCP surface of the fix-orchestration pipeline.
//
// This is where an external agent and the platform meet in the middle. The
// division of labour is deliberate and worth stating:
//
//   the AGENT owns the checkout. It has the files, the git history, the
//   branch, and (through its own credentials) the ability to commit and open
//   a PR. A Worker has none of those, by design — it holds no repository
//   write credential at all.
//
//   the PLATFORM owns judgement. It scans, fingerprints, generates candidate
//   fixes, and — the part an agent cannot do for itself — validates ANY fix
//   with the same engine that found the problem: target finding gone, no new
//   high/critical introduced, still parses, blast radius measured.
//
// So `generate_fix` hands back a validated proposal + patch for the agent to
// apply locally, and `validate_fix` grades a fix the agent wrote itself.
// Apply/branch/PR "tools" are deliberately absent: a tool that cannot do the
// thing should not exist, and here the applying side of the contract belongs
// to the client holding the checkout.

import { callHandler } from "../dispatch.js";
import { CHAINS } from "../chains.js";
import { SCOPES, failureOf, READ_ONLY, clip } from "./_shared.js";

const FILE_SCHEMA = {
  type: "object",
  properties: { path: { type: "string" }, content: { type: "string" } },
  required: ["path", "content"],
  additionalProperties: false,
};

const FINDING_SCHEMA = {
  type: "object",
  description: "A normalized finding from an Algosize scan (source.findings[] of a vuln run).",
  properties: {
    ruleId:      { type: "string" },
    fingerprint: { type: "string" },
    path:        { type: "string" },
    line:        { type: "number" },
    severity:    { type: "string" },
    confidence:  { type: "string" },
    category:    { type: "string" },
    title:       { type: "string" },
    snippet:     { type: "string" },
    recommendation: { type: "string" },
  },
  required: ["ruleId", "fingerprint", "path"],
};

function validationText(validation, applyable) {
  const lines = [
    applyable
      ? "VERDICT: passed_static — every check a static engine can run passed."
      : `VERDICT: ${validation.verdict}`,
    ...validation.checks.map((c) => `  ${c.ok ? "✓" : "✗"} ${c.check}: ${c.detail}`),
    "",
    "Not checked here (run these where the code runs, before merging): " +
      validation.checksNotRun.map((c) => c.check).join(", ") + ".",
  ];
  if (validation.reasons.length) lines.push("", "Reasons: " + validation.reasons.join(" "));
  return lines.join("\n");
}

export const FIX_TOOLS = [
  {
    // NOT `algosize_generate_fix` — that name is taken by the advisory-prose
    // generator in analysis.js (dependency and architecture findings, free
    // text). This is the structured pipeline for SOURCE findings: it returns
    // corrected file content and a validation verdict, not prose. Two tools,
    // two products, two names; renaming the older one would break clients
    // already calling it.
    name: "algosize_propose_code_fix",
    title: "Propose and validate a code fix for a source finding",
    description:
      "Turn one normalized SOURCE finding into a minimal, statically-validated code fix — corrected " +
      "file content plus a patch, not prose. (For a dependency advisory or an architecture finding, " +
      "use algosize_generate_fix instead: those are fixed by upgrading or reconfiguring, and it " +
      "returns guidance rather than a rewrite.) Pass the finding " +
      "(from a scan's source.findings) plus EITHER the affected file's current content (`file`) — " +
      "preferred when you have a local checkout, so the fix matches what is on disk — OR `repoUrl` " +
      "for Algosize to fetch the committed version. Returns the corrected file content, a unified " +
      "patch to apply, an explanation, and the validation verdict. `applyable: true` means the fix " +
      "passed every static check (target finding gone, no new high/critical findings, parses, bounded " +
      "blast radius); tests and builds are YOURS to run — a Worker cannot execute code, and the " +
      "response says exactly which checks were not run. Apply the patch to your own checkout and " +
      "commit through your own tooling; Algosize never pushes code.",
    scope: SCOPES.ANALYZE,
    paidOnly: false,
    metered: false,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    inputSchema: {
      type: "object",
      properties: {
        finding: FINDING_SCHEMA,
        file:    { ...FILE_SCHEMA, description: "Current content of the file the finding names." },
        repoUrl: { type: "string", description: "Public GitHub URL, used only when `file` is not given." },
        provider: { type: "string", enum: ["kimi", "claude", "openai"], description: "Optional model provider; defaults to the first configured one." },
      },
      required: ["finding"],
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: {
        proposal: { type: "object" }, validation: { type: "object" },
        patch: { type: "string" }, applyable: { type: "boolean" },
      },
    },
    async run({ args, request, env, ctx }) {
      const body = {
        finding: args.finding,
        ...(args.file ? { files: [args.file] } : {}),
        ...(args.repoUrl ? { repoUrl: args.repoUrl } : {}),
        ...(args.provider ? { provider: args.provider } : {}),
      };
      const res = await callHandler(CHAINS.fixPropose.chain, {
        method: CHAINS.fixPropose.method, path: CHAINS.fixPropose.path, request, env, ctx, body,
      });
      const fail = failureOf(res, "Generating the fix");
      if (fail) return fail;

      const d = res.json || {};
      return {
        text: [
          d.proposal ? `Fix proposed by ${d.proposal.provider}${d.proposal.model ? ` (${d.proposal.model})` : ""}.` : "No proposal.",
          "",
          clip(d.proposal ? d.proposal.explanation : "", 1200),
          "",
          validationText(d.validation, d.applyable),
          "",
          d.applyable
            ? "Apply the `patch` field with `git apply`, or write `proposal.files[*].content` over the originals — then run the project's tests."
            : "Do not apply this as-is; the validation reasons above say what is wrong.",
        ].join("\n"),
        structured: {
          taskId: d.taskId, proposal: d.proposal, validation: d.validation,
          patch: d.patch, applyable: d.applyable, retried: d.retried,
        },
      };
    },
  },

  {
    name: "algosize_validate_fix",
    title: "Validate a fix you wrote",
    description:
      "Grade YOUR fix with the same engine that found the problem. Pass the finding you are fixing, " +
      "the original file, and your fixed version; Algosize re-scans and reports whether the target " +
      "finding is gone, whether anything new appeared at high/critical, whether the file still " +
      "parses, and how large the change is. Use this after editing and BEFORE committing — it is the " +
      "closed loop that turns 'I changed the code' into 'the scanner can no longer find the bug'. " +
      "Free: validation runs no AI.",
    scope: SCOPES.ANALYZE,
    paidOnly: false,
    metered: false,
    annotations: READ_ONLY,
    inputSchema: {
      type: "object",
      properties: {
        finding:  FINDING_SCHEMA,
        original: { ...FILE_SCHEMA, description: "The file as the scan saw it." },
        fixed:    { ...FILE_SCHEMA, description: "The file after your edit — same path." },
      },
      required: ["finding", "original", "fixed"],
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: { validation: { type: "object" }, applyable: { type: "boolean" }, patch: { type: "string" } },
    },
    async run({ args, request, env, ctx }) {
      const res = await callHandler(CHAINS.fixValidate.chain, {
        method: CHAINS.fixValidate.method, path: CHAINS.fixValidate.path, request, env, ctx,
        body: { finding: args.finding, original: args.original, fixed: args.fixed },
      });
      const fail = failureOf(res, "Validating the fix");
      if (fail) return fail;
      const d = res.json || {};
      return {
        text: validationText(d.validation, d.applyable),
        structured: { validation: d.validation, applyable: d.applyable, patch: d.patch },
      };
    },
  },

  {
    name: "algosize_explain_finding",
    title: "Explain a finding's rule",
    description:
      "The registry's full metadata for one rule id: what the rule detects, why it matters, its CWE " +
      "and OWASP mappings, severity and confidence defaults, the languages it covers and the " +
      "remediation guidance. Free, instant and offline — this reads the rule registry, not a model — " +
      "so call it before generate_fix to understand what you are fixing.",
    scope: SCOPES.READ,
    paidOnly: false,
    metered: false,
    annotations: READ_ONLY,
    inputSchema: {
      type: "object",
      properties: {
        ruleId: { type: "string", description: "e.g. sast.sql-injection.tainted-query" },
        path:   { type: "string", description: "Optional file path, to include its detected language and scan tier." },
      },
      required: ["ruleId"],
      additionalProperties: false,
    },
    outputSchema: { type: "object", properties: { rule: { type: "object" } } },
    async run({ args, request, env, ctx }) {
      const qs = new URLSearchParams({ id: args.ruleId, ...(args.path ? { path: args.path } : {}) });
      const res = await callHandler(CHAINS.fixRule.chain, {
        method: CHAINS.fixRule.method, path: `${CHAINS.fixRule.path}?${qs}`, request, env, ctx,
      });
      const fail = failureOf(res, "Explaining the rule");
      if (fail) return fail;
      const d = res.json || {};
      const rule = d.rule;
      const langLine = d.pathInfo
        ? `\n${args.path} is ${d.pathInfo.language}, scanned at tier ${d.pathInfo.tier} (${d.pathInfo.tierLabel}).`
        : "";
      return {
        text: [
          `${rule.title} [${rule.severity}/${rule.confidence}]`,
          rule.description,
          rule.cwe && rule.cwe.length ? `CWE: ${rule.cwe.join(", ")}` : null,
          rule.owasp && rule.owasp.length ? `OWASP: ${rule.owasp.join(", ")}` : null,
          `Remediation: ${rule.remediation}`,
        ].filter(Boolean).join("\n") + langLine,
        structured: { rule, pathInfo: d.pathInfo || null },
      };
    },
  },
];
