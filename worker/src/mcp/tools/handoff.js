// Handoff tools — the MCP surface of the "route the fix to your own agent"
// story.
//
// The multi-model pipeline runs the cheap deterministic + triage + validation
// stages on Algosize's infrastructure, then — instead of spending flagship
// coding-model budget on the fix — hands the finding to the customer's OWN
// agent session (Claude Code, Kimi, any MCP host), which edits its own checkout
// at zero Workers AI token cost. Two tools bracket that handoff:
//
//   algosize_get_scan_findings — pull the findings from a scan run plus a
//       ready-to-paste prompt document the agent can act on directly.
//   algosize_record_patch — report the patch the agent applied back, so the
//       platform has provenance (who fixed what, when, content hash) without
//       ever storing the customer's source.
//
// Both go through callHandler like every tool — no env.DB, no analyzer import
// (the purity guard enforces it). org scoping and the no-source rule live in
// the handlers behind the chains.

import { callHandler } from "../dispatch.js";
import { CHAINS } from "../chains.js";
import { SCOPES, failureOf, READ_ONLY, MUTATING, clip } from "./_shared.js";

export const HANDOFF_TOOLS = [
  {
    name: "algosize_get_scan_findings",
    title: "Get scan findings + a ready-to-paste fix prompt for this agent",
    description:
      "Return the security findings from an Algosize scan run, plus a ready-to-paste " +
      "prompt document you can act on to fix them in your own checkout. Optionally " +
      "narrow to one finding by fingerprint, and optionally attach similar prior fixes " +
      "from this codebase. After you fix and validate a finding, report it back with " +
      "algosize_record_patch. This is the zero-Workers-AI-token path: you do the edit.",
    scope: SCOPES.READ,
    paidOnly: false,
    metered: false,
    annotations: READ_ONLY,
    inputSchema: {
      type: "object",
      properties: {
        runId:       { type: "string", description: "The scan run id whose findings to hand off." },
        fingerprint: { type: "string", description: "Optional: narrow to a single finding." },
        agent:       { type: "string", enum: ["claude_code", "kimi", "mcp"], description: "Which agent the prompt is framed for. Default mcp." },
        retrieval:   { type: "boolean", description: "Attach similar prior fixes from this codebase (best-effort; needs the retrieval index)." },
      },
      required: ["runId"],
      additionalProperties: false,
    },
    outputSchema: null,
    async run({ args, request, env, ctx }) {
      const query = {
        runId: args.runId,
        ...(args.fingerprint ? { fingerprint: args.fingerprint } : {}),
        ...(args.agent ? { agent: args.agent } : {}),
        ...(args.retrieval ? { retrieval: "1" } : {}),
      };
      const res = await callHandler(CHAINS.fixHandoff.chain, {
        method: CHAINS.fixHandoff.method, path: CHAINS.fixHandoff.path, request, env, ctx, query,
      });
      const fail = failureOf(res, "Getting the scan findings");
      if (fail) return fail;

      const d = res.json || {};
      const n = (d.findings || []).length;
      return {
        text: [
          `${n} finding${n === 1 ? "" : "s"} from run ${d.runId}, framed for ${d.agent}.`,
          d.retrieval && d.retrieval.available ? `${d.retrieval.chunks.length} similar prior fix(es) attached.` : "",
          "",
          "Paste the prompt below into your session, fix each finding, validate with algosize_validate_fix, then report back with algosize_record_patch:",
          "",
          clip(d.prompt, 6000),
        ].filter(Boolean).join("\n"),
        structured: {
          runId: d.runId, agent: d.agent, findings: d.findings,
          retrieval: d.retrieval, writeBack: d.writeBack,
        },
      };
    },
  },

  {
    name: "algosize_record_patch",
    title: "Report a patch you applied for a finding",
    description:
      "Record that you (an external agent) applied a fix for an Algosize finding. Pass the " +
      "run id, the finding's fingerprint, and a one-line summary; optionally the patch text " +
      "(it is HASHED, never stored) or a precomputed patchHash. This records provenance — who " +
      "fixed what, when — with source: mcp_agent, and does NOT bill Workers AI tokens, because " +
      "you did the edit. It stores no source code: only a content hash and your summary.",
    scope: SCOPES.MANAGE,
    paidOnly: false,
    metered: false,
    annotations: MUTATING,
    inputSchema: {
      type: "object",
      properties: {
        runId:       { type: "string", description: "The scan run the finding came from." },
        fingerprint: { type: "string", description: "The finding's stable fingerprint." },
        ruleId:      { type: "string" },
        filePath:    { type: "string" },
        patch:       { type: "string", description: "Optional unified diff. HASHED then discarded — never stored." },
        patchHash:   { type: "string", description: "Optional precomputed hash, if you do not want to send the diff at all." },
        summary:     { type: "string", description: "One-line, non-source description of the fix." },
        status:      { type: "string", enum: ["applied", "proposed"], description: "Default applied." },
      },
      required: ["fingerprint"],
      additionalProperties: false,
    },
    outputSchema: null,
    async run({ args, request, env, ctx }) {
      const body = {
        ...(args.runId ? { runId: args.runId } : {}),
        fingerprint: args.fingerprint,
        ...(args.ruleId ? { ruleId: args.ruleId } : {}),
        ...(args.filePath ? { filePath: args.filePath } : {}),
        ...(args.patch ? { patch: args.patch } : {}),
        ...(args.patchHash ? { patchHash: args.patchHash } : {}),
        ...(args.summary ? { summary: args.summary } : {}),
        ...(args.status ? { status: args.status } : {}),
        source: "mcp_agent",
      };
      const res = await callHandler(CHAINS.fixApplyPatch.chain, {
        method: CHAINS.fixApplyPatch.method, path: CHAINS.fixApplyPatch.path, request, env, ctx, body,
      });
      const fail = failureOf(res, "Recording the patch");
      if (fail) return fail;

      const d = res.json || {};
      return {
        text: `Recorded patch ${d.patchId} for ${args.fingerprint} (source: ${d.source}, status: ${d.status}). No source was stored — only a content hash and your summary.`,
        structured: { patchId: d.patchId, source: d.source, status: d.status },
      };
    },
  },
];
