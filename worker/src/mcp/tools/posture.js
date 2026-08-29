// Posture: the scorecard, architecture history, the CI snippets, and whoami.
// All read-only, all free.

import { callHandler } from "../dispatch.js";
import { CHAINS } from "../chains.js";
import { SCOPES, failureOf, READ_ONLY, clip } from "./_shared.js";

const SNIPPET_CHAINS = {
  audit:        "ciSnippet",
  optimizer:    "ciOptimizerSnippet",
  estimate:     "ciEstimateSnippet",
  architecture: "ciArchitectureSnippet",
};

export const POSTURE_TOOLS = [
  {
    name: "algosize_get_scorecard",
    title: "Read the engineering scorecard",
    description:
      "One graded row per monitored repository across security, cost, complexity and architecture. " +
      "Free and read-only, and the fastest way to see overall posture without running anything. " +
      "Each cell reports its own kind: `grade` is a real result, `stale` is an old one, `pending` " +
      "means the first run has not finished, and `off` means that analyzer is not enabled — treat " +
      "those four as genuinely different, never as a missing score.",
    scope: SCOPES.READ,
    paidOnly: false,
    metered: false,
    annotations: READ_ONLY,
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    outputSchema: { type: "object", properties: { rows: { type: "array" }, columns: { type: "array" } } },
    async run({ request, env, ctx }) {
      const res = await callHandler(CHAINS.scorecard.chain, {
        method: CHAINS.scorecard.method, path: CHAINS.scorecard.path, request, env, ctx,
      });
      const fail = failureOf(res, "Reading the scorecard");
      if (fail) return fail;

      const d = res.json || {};
      const rows = d.rows || [];
      return {
        text: rows.length
          ? `Scorecard (${rows.length} repositor${rows.length === 1 ? "y" : "ies"}):\n` +
            rows.map((r) => {
              const cells = Object.entries(r.cells || {})
                .map(([k, c]) => `${k}=${c.kind === "grade" ? c.value : c.kind}`)
                .join(" ");
              return `• ${r.repo}${r.branch ? `#${r.branch}` : ""} — ${cells}`;
            }).join("\n") + `\n\n${d.basis || ""}`
          : `No repositories are graded. ${d.basis || "A repository has to be under watch to be graded."}`,
        structured: { rows, columns: d.columns || [], basis: d.basis || null },
      };
    },
  },

  {
    name: "algosize_list_arch_snapshots",
    title: "List architecture snapshots",
    description:
      "List stored architecture snapshots for this organisation, newest first. Each snapshot is one " +
      "captured graph; pairs of them are what algosize_diff_architecture compares. Free and read-only.",
    scope: SCOPES.READ,
    paidOnly: false,
    metered: false,
    annotations: READ_ONLY,
    inputSchema: {
      type: "object",
      properties: {
        repoUrl: { type: "string", description: "Filter to one repository. Pass an empty string for manual uploads, which have no repository." },
        branch:  { type: "string" },
        limit:   { type: "integer", minimum: 1, maximum: 200 },
      },
      additionalProperties: false,
    },
    outputSchema: { type: "object", properties: { snapshots: { type: "array" } } },
    async run({ args, request, env, ctx }) {
      const res = await callHandler(CHAINS.archSnapshots.chain, {
        method: CHAINS.archSnapshots.method, path: CHAINS.archSnapshots.path,
        // The handler distinguishes an absent parameter (no filter) from a
        // present-but-empty one (match rows whose column IS NULL — the manual
        // uploads). callHandler drops undefined, so passing it through
        // untouched preserves that three-way meaning.
        query: { repoUrl: args.repoUrl, branch: args.branch, limit: args.limit },
        request, env, ctx,
      });
      const fail = failureOf(res, "Listing architecture snapshots");
      if (fail) return fail;

      const d = res.json || {};
      const snaps = d.snapshots || [];
      return {
        text: snaps.length
          ? `${snaps.length} snapshot(s):\n` + snaps.map((s) =>
              `• ${s.snapshotId} — ${s.repoUrl || "manual upload"}${s.branch ? `#${s.branch}` : ""} — ` +
              `${s.nodeCount} nodes, ${s.edgeCount} edges, ${s.findingCount} findings ` +
              `(${s.source}, ${new Date(s.capturedAt * 1000).toISOString()})` +
              (s.reduced ? " [evidence dropped to fit]" : "")).join("\n")
          : `No architecture snapshots yet. ${d.basis || ""}`,
        structured: { snapshots: snaps },
      };
    },
  },

  {
    name: "algosize_diff_architecture",
    title: "Diff two architecture snapshots",
    description:
      "Compare an architecture snapshot against an earlier one and report which components and " +
      "dependencies were added or removed — the 'did this change add a dependency on the payments " +
      "database' question. Pass only `to` to compare it against whatever preceded it. Free and " +
      "read-only. A result with comparable=false means there was nothing to compare against, which " +
      "is NOT the same as no changes.",
    scope: SCOPES.READ,
    paidOnly: false,
    metered: false,
    annotations: READ_ONLY,
    inputSchema: {
      type: "object",
      properties: {
        to:   { type: "string", description: "The snapshot to diff." },
        from: { type: "string", description: "Optional baseline. Defaults to the snapshot recorded before `to`." },
      },
      required: ["to"],
      additionalProperties: false,
    },
    outputSchema: { type: "object", properties: { diff: { type: "object" }, note: { type: "string" } } },
    async run({ args, request, env, ctx }) {
      const res = await callHandler(CHAINS.archDiff.chain, {
        method: CHAINS.archDiff.method, path: CHAINS.archDiff.path,
        query: { to: args.to, from: args.from }, request, env, ctx,
      });
      const fail = failureOf(res, "Diffing architecture snapshots");
      if (fail) return fail;

      const d = res.json || {};
      const diff = d.diff || {};
      if (!diff.comparable) {
        return {
          text: `No comparison was possible. ${d.note || ""}`.trim(),
          structured: { diff, note: d.note || null },
        };
      }
      return {
        text:
          `${diff.changed} change(s) between the two snapshots.\n` +
          `Components added: ${(diff.nodesAdded || []).join(", ") || "none"}\n` +
          `Components removed: ${(diff.nodesRemoved || []).join(", ") || "none"}\n` +
          `Dependencies added: ${(diff.edgesAdded || []).length}\n` +
          `Dependencies removed: ${(diff.edgesRemoved || []).length}` +
          (d.reducedInputs && d.reducedInputs.length
            ? `\n\nNote: ${d.reducedInputs.length} of these snapshots dropped their evidence to fit, so this diff cannot cite files.`
            : ""),
        structured: { diff, note: d.note || null, reducedInputs: d.reducedInputs || [] },
      };
    },
  },

  {
    name: "algosize_get_ci_snippet",
    title: "Get a CI workflow snippet",
    description:
      "Return a ready-to-commit GitHub Actions workflow that runs one Algosize check on every pull " +
      "request. Free and read-only. The snippet references a repository secret by name and never " +
      "contains a key — the user creates the key themselves in the dashboard.",
    scope: SCOPES.READ,
    paidOnly: false,
    metered: false,
    annotations: READ_ONLY,
    inputSchema: {
      type: "object",
      properties: {
        kind: {
          type: "string",
          enum: Object.keys(SNIPPET_CHAINS),
          description: "Which gate: audit (dependencies), optimizer, estimate (cost), or architecture.",
        },
        failOn: {
          type: "string", enum: ["critical", "high", "medium", "low", "none"],
          description: "audit only — severity at which the build fails. Default high.",
        },
      },
      required: ["kind"],
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: { filename: { type: "string" }, workflow: { type: "string" }, secretName: { type: "string" } },
    },
    async run({ args, request, env, ctx }) {
      const key = SNIPPET_CHAINS[args.kind];
      if (!key) {
        return { text: `Unknown snippet kind "${args.kind}".`, isError: true, errorCode: "invalid_params" };
      }
      const c = CHAINS[key];
      const res = await callHandler(c.chain, {
        method: c.method, path: c.path,
        query: args.kind === "audit" && args.failOn ? { fail_on: args.failOn } : {},
        request, env, ctx,
      });
      const fail = failureOf(res, "Fetching the CI snippet");
      if (fail) return fail;

      const d = res.json || {};
      return {
        text:
          `Commit this as ${d.filename}. It reads the API key from a repository secret named ` +
          `${d.secretName}, which you create in the Algosize dashboard.\n\n` +
          `${(d.setupSteps || []).map((s, i) => `${i + 1}. ${s}`).join("\n")}\n\n` +
          `\`\`\`yaml\n${clip(d.workflow, 6000)}\n\`\`\`` +
          (d.configExample ? `\n\nAlso commit ${d.configFilename}:\n\`\`\`json\n${clip(d.configExample, 2000)}\n\`\`\`` : ""),
        structured: {
          filename: d.filename, workflow: d.workflow, secretName: d.secretName,
          configFilename: d.configFilename || null, configExample: d.configExample || null,
        },
      };
    },
  },

  {
    name: "algosize_whoami",
    title: "Show the connected account",
    description:
      "Report which Algosize account this connection is acting as, its plan, and how much of the " +
      "monthly run allowance is left. Free and read-only. Call it first when a metered tool is " +
      "refused, to see whether the allowance is the reason.",
    scope: SCOPES.READ,
    paidOnly: false,
    metered: false,
    annotations: READ_ONLY,
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    outputSchema: {
      type: "object",
      properties: {
        plan: { type: "string" }, active: { type: "boolean" },
        monthlyRunsUsed: { type: "number" }, monthlyRunsLimit: { type: "number" },
        authMethod: { type: "string" },
      },
    },
    async run({ request, env, ctx }) {
      const res = await callHandler(CHAINS.me.chain, {
        method: CHAINS.me.method, path: CHAINS.me.path, request, env, ctx,
      });
      const fail = failureOf(res, "Reading the account");
      if (fail) return fail;

      const d = res.json || {};
      // /api/me is built around a session user. An API-key or OAuth caller has
      // no user row behind it, so email and the run counters come back null —
      // that is the endpoint working correctly, not a failure, and the text
      // says which fields are unavailable rather than printing "null".
      const method = request.authMethod || "unknown";
      const orgOnly = method === "api_key" || method === "mcp_oauth";
      return {
        text:
          `Connected to Algosize as ${orgOnly ? "an organisation credential" : d.email || "a signed-in user"} ` +
          `(${method}).\n` +
          `Plan: ${d.plan || "unknown"}${d.active === false ? " — not active" : ""}` +
          (d.reason ? ` (${d.reason})` : "") + "\n" +
          (typeof d.monthlyRunsUsed === "number"
            ? `Runs used this month: ${d.monthlyRunsUsed} of ${d.monthlyRunsLimit}.`
            : orgOnly
              ? "Run allowance is metered per organisation and is not reported on this endpoint for key-based connections."
              : "This plan does not meter runs."),
        structured: {
          plan: d.plan || null, active: d.active ?? null,
          monthlyRunsUsed: d.monthlyRunsUsed ?? null,
          monthlyRunsLimit: d.monthlyRunsLimit ?? null,
          authMethod: method,
        },
      };
    },
  },
];
