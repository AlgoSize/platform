// Runs, reports and the share link.
//
// These are how an assistant answers "what did we already find" without
// spending a run, which is why the analyzer tools' descriptions point at
// algosize_list_runs before starting anything new.

import { callHandler } from "../dispatch.js";
import { CHAINS } from "../chains.js";
import { SCOPES, failureOf, READ_ONLY, MUTATING, clip } from "./_shared.js";

// Kept as a literal rather than imported from handlers/runs.js — importing a
// handler module into tools/ is what the purity guard forbids. The tool test
// asserts this matches the handler's own ANALYZERS list.
const ANALYZERS = ["cost", "vuln", "algo", "arch", "estimate"];

export const RUN_TOOLS = [
  {
    name: "algosize_list_runs",
    title: "List recent analysis runs",
    description:
      "List this organisation's recent analysis runs, newest first. Free and read-only. Call this " +
      "BEFORE any metered analysis tool: if a recent run already covers the same repository and " +
      "analyzer, read it with algosize_get_run instead of paying for a new one.",
    scope: SCOPES.READ,
    paidOnly: false,
    metered: false,
    annotations: READ_ONLY,
    inputSchema: {
      type: "object",
      properties: {
        limit:    { type: "integer", minimum: 1, maximum: 50, description: "How many to return. Default 20." },
        cursor:   { type: "string", description: "Pagination cursor from a previous call's nextCursor." },
        analyzer: { type: "string", enum: ANALYZERS, description: "Only runs from this analyzer." },
        source:   { type: "string", enum: ["ci", "manual"], description: "Only runs from this origin." },
      },
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: { items: { type: "array" }, nextCursor: { type: "string" } },
    },
    async run({ args, request, env, ctx }) {
      const res = await callHandler(CHAINS.listRuns.chain, {
        method: CHAINS.listRuns.method, path: CHAINS.listRuns.path,
        query: { limit: args.limit, cursor: args.cursor, analyzer: args.analyzer, source: args.source },
        request, env, ctx,
      });
      const fail = failureOf(res, "Listing runs");
      if (fail) return fail;

      const d = res.json || {};
      const items = d.items || [];
      return {
        text: items.length
          ? `${items.length} run(s):\n` + items.map((r) =>
              `• ${r.id} — ${r.analyzer}${r.repo ? ` on ${r.repo}` : ""} — ` +
              `${r.headline || "no summary"} (${new Date(r.createdAt).toISOString()})`).join("\n")
          : "No runs recorded for this organisation yet.",
        structured: { items, nextCursor: d.nextCursor || null },
      };
    },
  },

  {
    name: "algosize_get_run",
    title: "Read one analysis run",
    description:
      "Fetch the full stored result of a single run by id, including every finding. Free and " +
      "read-only. Use it to read an existing result rather than re-running the analysis.",
    scope: SCOPES.READ,
    paidOnly: false,
    metered: false,
    annotations: READ_ONLY,
    inputSchema: {
      type: "object",
      properties: { runId: { type: "string", description: "The run id, from algosize_list_runs." } },
      required: ["runId"],
      additionalProperties: false,
    },
    outputSchema: { type: "object", properties: { id: { type: "string" }, analyzer: { type: "string" }, result: {} } },
    async run({ args, request, env, ctx }) {
      const res = await callHandler(CHAINS.getRun.chain, {
        method: CHAINS.getRun.method, path: `/api/runs/${encodeURIComponent(args.runId)}`,
        params: { id: args.runId }, request, env, ctx,
      });
      const fail = failureOf(res, "Reading the run");
      if (fail) return fail;

      const d = res.json || {};
      return {
        text:
          `Run ${d.id} — ${d.analyzer}, ${new Date(d.createdAt).toISOString()}\n` +
          `${d.headline || ""}\n\n${clip(JSON.stringify(d.result ?? {}, null, 2), 6000)}`,
        structured: {
          id: d.id, analyzer: d.analyzer, createdAt: d.createdAt,
          headline: d.headline || null, result: d.result ?? null,
        },
      };
    },
  },

  {
    name: "algosize_get_run_report",
    title: "Read a run's rendered report",
    description:
      "Fetch a run's report. `json` returns the structured result; `sarif`, `cyclonedx` and `csv` are " +
      "produced for dependency-audit runs only and will be refused for other analyzers. Free and " +
      "read-only. HTML is deliberately not offered here — ask for json and describe it instead.",
    scope: SCOPES.READ,
    paidOnly: false,
    metered: false,
    annotations: READ_ONLY,
    inputSchema: {
      type: "object",
      properties: {
        runId:  { type: "string" },
        format: {
          type: "string",
          // `html` is excluded on purpose: it returns a full styled document
          // that would flood a model's context with markup carrying no
          // information the json form lacks.
          enum: ["json", "sarif", "cyclonedx", "csv"],
          description: "Default json. The last three are dependency-audit runs only.",
        },
      },
      required: ["runId"],
      additionalProperties: false,
    },
    outputSchema: { type: "object", properties: { format: { type: "string" }, report: {} } },
    async run({ args, request, env, ctx }) {
      const format = args.format || "json";
      const res = await callHandler(CHAINS.getReport.chain, {
        method: CHAINS.getReport.method, path: `/api/runs/${encodeURIComponent(args.runId)}/report`,
        params: { id: args.runId }, query: { format }, request, env, ctx,
      });
      const fail = failureOf(res, "Reading the report");
      if (fail) return fail;

      // Only the json format comes back as JSON; sarif/cyclonedx/csv are text
      // bodies. Reading `res.json` blindly would yield null for three of the
      // four and silently return an empty report.
      const isJson = format === "json";
      return {
        text: clip(isJson ? JSON.stringify(res.json ?? {}, null, 2) : res.text, 8000),
        structured: { format, report: isJson ? (res.json ?? null) : res.text },
      };
    },
  },

  {
    name: "algosize_share_run",
    title: "Create a public link to a report",
    description:
      "CREATES A PUBLICLY REACHABLE LINK to this run's report — anyone who has the URL can open it " +
      "without signing in. Only call this when the user has explicitly asked for something to share " +
      "externally; never call it to read a report yourself, which algosize_get_run_report does " +
      "privately. The link expires, and can be revoked from the dashboard.",
    scope: SCOPES.MANAGE,
    paidOnly: false,
    metered: false,
    annotations: {
      readOnlyHint: false, destructiveHint: false, idempotentHint: false,
      // The one tool in the catalog that reaches outside the tenant boundary.
      // openWorldHint is what tells a host this is not a purely internal
      // action, and it is why this tool must never be auto-approved.
      openWorldHint: true,
    },
    inputSchema: {
      type: "object",
      properties: {
        runId: { type: "string" },
        expiresInDays: { type: "integer", minimum: 1, maximum: 90, description: "Link lifetime. The server applies its own default and maximum." },
      },
      required: ["runId"],
      additionalProperties: false,
    },
    outputSchema: { type: "object", properties: { url: { type: "string" }, expiresAt: { type: "number" } } },
    async run({ args, request, env, ctx }) {
      const body = {};
      if (args.expiresInDays !== undefined) body.expiresInDays = args.expiresInDays;
      const res = await callHandler(CHAINS.shareRun.chain, {
        method: CHAINS.shareRun.method, path: `/api/runs/${encodeURIComponent(args.runId)}/share`,
        params: { id: args.runId }, body, request, env, ctx,
      });
      const fail = failureOf(res, "Creating the share link");
      if (fail) return fail;

      const d = res.json || {};
      return {
        text:
          `Public link created: ${d.url}\n` +
          `Anyone with this URL can read the report without signing in. ` +
          `It expires ${d.expiresAt ? `on ${new Date(d.expiresAt * 1000).toISOString()}` : "per the account default"}.`,
        structured: { url: d.url || null, token: d.token || null, expiresAt: d.expiresAt ?? null },
      };
    },
  },
];
