// Per-finding fix generation — the "Generate fix" button.
//
// One finding in, one concrete remediation out, GitHub-Copilot-style. Two
// finding kinds, matching the two surfaces that render individual findings:
//
//   vuln  a dependency advisory row (package, installed version, fixedIn,
//         severity, advisory id) from the vuln panel / audit report
//   arch  an Architecture X-ray finding (rule, target, lens, why, evidence
//         carrying file:line, plus the rule's own static `fix` text)
//
// Uses the same provider chain as the refactor suggestions (llm.js llmChat:
// Workers AI binding → Workers AI REST → OpenAI), so on a deployed Worker
// this is keyless via the [ai] binding.
//
// The model's reply is ADVISORY prose + a fenced snippet, rendered inline
// under the finding that asked for it. Deliberately NOT persisted to run
// history: a stored run is the record of what an analyzer measured, and a
// generated suggestion is neither measured nor deterministic — storing it
// would let a stale AI guess masquerade as part of the audit. Regenerate on
// demand instead.

import { llmChat, parseLlmReply } from "./llm.js";

const MAX_FIELD_CHARS = 400;      // clamp every caller-supplied string we embed
const MAX_CONTEXT_CHARS = 4000;   // optional source excerpt

const VULN_SYSTEM =
  "You are a senior security engineer. The user shows you one dependency " +
  "advisory from an automated audit. Reply with: " +
  "(a) a 50-200 word assessment of the practical risk and the remediation, " +
  "(b) the exact remediation as a single fenced code block — the upgrade " +
  "command when a fixed version exists, otherwise a concrete mitigation " +
  "(pin, removal, or workaround from the advisory). " +
  "Do not include any other code blocks.";

const ARCH_SYSTEM =
  "You are a staff platform engineer. The user shows you one finding from a " +
  "static architecture analysis of their system, with the file and line the " +
  "evidence came from. Reply with: " +
  "(a) a 50-250 word explanation of the concrete change to make in THAT file, " +
  "(b) the changed configuration or code as a single fenced code block. " +
  "Stay within what the evidence shows — do not invent services or files. " +
  "Do not include any other code blocks.";

const clamp = (v, n = MAX_FIELD_CHARS) =>
  typeof v === "string" ? v.slice(0, n) : v === undefined || v === null ? "" : String(v).slice(0, n);

export function validateFixInput(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, error: "invalid_payload", message: "request body must be a JSON object" };
  }
  if (body.kind !== "vuln" && body.kind !== "arch") {
    return { ok: false, error: "invalid_kind", message: "`kind` must be \"vuln\" or \"arch\"" };
  }
  if (!body.finding || typeof body.finding !== "object" || Array.isArray(body.finding)) {
    return { ok: false, error: "invalid_payload", message: "`finding` (object) is required" };
  }
  const context = typeof body.context === "string" ? body.context.slice(0, MAX_CONTEXT_CHARS) : null;
  return { ok: true, value: { kind: body.kind, finding: body.finding, context } };
}

export function buildFixPrompt({ kind, finding, context }) {
  if (kind === "vuln") {
    const lines = [
      `Advisory: ${clamp(finding.id)}`,
      `Package: ${clamp(finding.package)} (${clamp(finding.ecosystem) || "npm"})`,
      `Installed version: ${clamp(finding.installedVersion)}`,
      `Fixed in: ${finding.fixedIn ? clamp(finding.fixedIn) : "no fixed version published"}`,
      `Severity: ${clamp(finding.severity)}${finding.cvssScore ? ` (CVSS ${clamp(finding.cvssScore)})` : ""}`,
    ];
    if (finding.summary) lines.push(`Summary: ${clamp(finding.summary)}`);
    return { system: VULN_SYSTEM, user: lines.join("\n") };
  }
  // arch
  const lines = [
    `Rule: ${clamp(finding.rule)}`,
    `Lens: ${clamp(finding.lens)}`,
    `Severity: ${clamp(finding.severity)}`,
    `Target: ${clamp(finding.target)}`,
    `Why it was flagged: ${clamp(finding.why, 800)}`,
  ];
  if (Array.isArray(finding.evidence)) {
    for (const e of finding.evidence.slice(0, 5)) {
      lines.push(`Evidence: ${clamp(e && e.file)}:${clamp(e && e.line)} ${clamp(e && e.detail, 200)}`);
    }
  }
  if (finding.fix) lines.push(`The analyzer's generic advice was: ${clamp(finding.fix, 600)}`);
  if (context) lines.push(`\nRelevant file excerpt:\n\`\`\`\n${context}\n\`\`\``);
  return { system: ARCH_SYSTEM, user: lines.join("\n") };
}

/**
 * @returns {Promise<{ok:true, fix:{provider,text,code,language}}
 *                 | {ok:false, error:string, message:string, status:number}>}
 */
export async function generateFix(value, env) {
  const { system, user } = buildFixPrompt(value);
  const r = await llmChat({ system, user }, env || {});
  if (r.ok) {
    return { ok: true, fix: parseLlmReply(r.reply, r.provider) };
  }
  if (!r.configured) {
    // 503, not 500: the service is healthy, the capability is switched off.
    return {
      ok: false, status: 503, error: "fix_generation_unavailable",
      message: "No AI provider is configured. Deploy the Workers AI binding " +
               "([ai] in wrangler.toml) or set OPENAI_API_KEY.",
    };
  }
  return {
    ok: false, status: 502, error: "fix_generation_failed",
    message: `The AI provider did not return a usable reply (${r.reason}). Try again.`,
  };
}
