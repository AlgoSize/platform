// Scheduled monitors. Everything here needs algosize:manage, and every one
// of these tools changes standing configuration rather than reading it — a
// deleted monitor stops watching a repository, which is a decision a person
// should have asked for.

import { callHandler } from "../dispatch.js";
import { CHAINS } from "../chains.js";
import { SCOPES, failureOf, READ_ONLY, MUTATING } from "./_shared.js";

// Literals rather than imports from handlers/monitors.js — tools/ may not
// import a handler module. test-mcp-tools.mjs asserts these still match.
const MONITOR_ANALYZERS = ["vuln", "arch", "estimate", "algo"];
const SCHEDULES = ["daily", "weekly"];

/** Every monitor tool takes an id; this keeps the path building in one place. */
function monitorPath(chainKey, id, suffix = "") {
  return { path: `/api/monitors/${encodeURIComponent(id)}${suffix}`, params: { id } };
}

export const MONITOR_TOOLS = [
  {
    name: "algosize_list_monitors",
    title: "List scheduled monitors",
    description:
      "List the repositories under scheduled watch, with each one's schedule, enabled analyzers, " +
      "last result and health. Free and read-only.",
    scope: SCOPES.READ,
    paidOnly: false,
    metered: false,
    annotations: READ_ONLY,
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    outputSchema: { type: "object", properties: { monitors: { type: "array" }, monitorsUsed: { type: "number" } } },
    async run({ request, env, ctx }) {
      const res = await callHandler(CHAINS.listMonitors.chain, {
        method: CHAINS.listMonitors.method, path: CHAINS.listMonitors.path, request, env, ctx,
      });
      const fail = failureOf(res, "Listing monitors");
      if (fail) return fail;

      const d = res.json || {};
      const monitors = d.monitors || [];
      return {
        text: monitors.length
          ? `${monitors.length} monitor(s), ${d.monitorsUsed ?? monitors.length} of ${d.monitorLimit ?? "?"} used:\n` +
            monitors.map((m) =>
              `• ${m.monitorId} — ${m.repoUrl}${m.branch ? `#${m.branch}` : ""} — ${m.schedule}` +
              `${m.paused ? " [paused]" : ""} — analyzers: ${(m.analyzers || []).join(", ") || "none"}` +
              `${m.lastStatus ? ` — last: ${m.lastStatus}` : ""}`).join("\n")
          : "No monitors configured.",
        structured: { monitors, monitorsUsed: d.monitorsUsed ?? null, monitorLimit: d.monitorLimit ?? null },
      };
    },
  },

  {
    name: "algosize_create_monitor",
    title: "Watch a repository on a schedule",
    description:
      "Put a GitHub repository under scheduled watch so the chosen analyzers run automatically and " +
      "alert on new findings. Creating a monitor does not itself consume a run; each scheduled sweep " +
      "it later performs does. Requires a paid plan once the free monitor limit is reached.",
    scope: SCOPES.MANAGE,
    paidOnly: false,
    metered: false,
    annotations: MUTATING,
    inputSchema: {
      type: "object",
      properties: {
        repoUrl:   { type: "string", description: "https://github.com/owner/name" },
        branch:    { type: "string" },
        schedule:  { type: "string", enum: SCHEDULES, description: "Default daily." },
        runAtHour: { type: "integer", minimum: 0, maximum: 23, description: "UTC hour to run at. Omit for any sweep." },
        analyzers: {
          type: "array", items: { type: "string", enum: MONITOR_ANALYZERS },
          description: "Which analyzers this monitor runs.",
        },
      },
      required: ["repoUrl"],
      additionalProperties: false,
    },
    outputSchema: { type: "object", properties: { monitor: { type: "object" } } },
    async run({ args, request, env, ctx }) {
      const res = await callHandler(CHAINS.createMonitor.chain, {
        method: CHAINS.createMonitor.method, path: CHAINS.createMonitor.path,
        body: args, request, env, ctx,
      });
      const fail = failureOf(res, "Creating the monitor");
      if (fail) return fail;
      const m = (res.json || {}).monitor || {};
      return {
        text: `Now watching ${m.repoUrl}${m.branch ? `#${m.branch}` : ""} (${m.schedule}), ` +
              `analyzers: ${(m.analyzers || []).join(", ") || "none"}. Monitor id ${m.monitorId}.`,
        structured: { monitor: m },
      };
    },
  },

  {
    name: "algosize_update_monitor",
    title: "Change a monitor's analyzers, schedule or paused state",
    description:
      "Change one existing monitor: which analyzers it runs, when it runs, or whether it is paused. " +
      "Supply only the fields you are changing. Pausing stops future sweeps without losing history.",
    scope: SCOPES.MANAGE,
    paidOnly: false,
    metered: false,
    annotations: MUTATING,
    inputSchema: {
      type: "object",
      properties: {
        monitorId: { type: "string" },
        analyzers: { type: "array", items: { type: "string", enum: MONITOR_ANALYZERS } },
        schedule:  { type: "string", enum: SCHEDULES },
        runAtHour: { type: "integer", minimum: 0, maximum: 23 },
        paused:    { type: "boolean" },
      },
      required: ["monitorId"],
      additionalProperties: false,
    },
    outputSchema: { type: "object", properties: { monitor: { type: "object" }, applied: { type: "array" } } },
    async run({ args, request, env, ctx }) {
      // Three separate endpoints back this one tool, because a model should
      // not have to know that "change the analyzers" and "change the schedule"
      // are different routes. Applied in order, and the first failure stops
      // the rest — a partial change reported as success would leave the
      // monitor in a state nobody asked for.
      const applied = [];
      let latest = null;

      if (args.analyzers) {
        const c = CHAINS.monitorAnalyzers;
        const { path, params } = monitorPath("monitorAnalyzers", args.monitorId, "/analyzers");
        const res = await callHandler(c.chain, {
          method: c.method, path, params, body: { analyzers: args.analyzers }, request, env, ctx,
        });
        const fail = failureOf(res, "Updating the monitor's analyzers");
        if (fail) return fail;
        applied.push("analyzers"); latest = (res.json || {}).monitor || latest;
      }

      if (args.schedule !== undefined || args.runAtHour !== undefined) {
        const c = CHAINS.monitorSchedule;
        const { path, params } = monitorPath("monitorSchedule", args.monitorId, "/schedule");
        const body = {};
        if (args.schedule !== undefined)  body.schedule  = args.schedule;
        if (args.runAtHour !== undefined) body.runAtHour = args.runAtHour;
        const res = await callHandler(c.chain, { method: c.method, path, params, body, request, env, ctx });
        const fail = failureOf(res, "Updating the monitor's schedule");
        if (fail) return fail;
        applied.push("schedule"); latest = (res.json || {}).monitor || latest;
      }

      if (args.paused !== undefined) {
        const c = CHAINS.pauseMonitor;
        const { path, params } = monitorPath("pauseMonitor", args.monitorId, "/pause");
        const res = await callHandler(c.chain, {
          method: c.method, path, params, body: { paused: args.paused }, request, env, ctx,
        });
        const fail = failureOf(res, args.paused ? "Pausing the monitor" : "Resuming the monitor");
        if (fail) return fail;
        applied.push("paused"); latest = (res.json || {}).monitor || latest;
      }

      if (!applied.length) {
        return {
          text: "Nothing to change — supply at least one of analyzers, schedule, runAtHour or paused.",
          isError: true, errorCode: "invalid_params",
        };
      }
      return {
        text: `Updated ${applied.join(", ")} on monitor ${args.monitorId}.` +
              (latest ? ` Now: ${latest.schedule}${latest.paused ? " [paused]" : ""}, analyzers ${(latest.analyzers || []).join(", ") || "none"}.` : ""),
        structured: { monitor: latest, applied },
      };
    },
  },

  {
    name: "algosize_delete_monitor",
    title: "Stop watching a repository",
    description:
      "Permanently remove a monitor. The repository stops being analysed on a schedule and stops " +
      "alerting. Past run history is kept. If the intent is a temporary stop, use " +
      "algosize_update_monitor with paused=true instead — that is reversible and this is not.",
    scope: SCOPES.MANAGE,
    paidOnly: false,
    metered: false,
    annotations: {
      readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false,
    },
    inputSchema: {
      type: "object",
      properties: { monitorId: { type: "string" } },
      required: ["monitorId"],
      additionalProperties: false,
    },
    outputSchema: { type: "object", properties: { removed: { type: "boolean" } } },
    async run({ args, request, env, ctx }) {
      const c = CHAINS.deleteMonitor;
      const { path, params } = monitorPath("deleteMonitor", args.monitorId);
      const res = await callHandler(c.chain, { method: c.method, path, params, request, env, ctx });
      const fail = failureOf(res, "Deleting the monitor");
      if (fail) return fail;
      return {
        text: `Monitor ${args.monitorId} deleted. That repository is no longer watched. Past runs are kept.`,
        structured: { removed: true, monitorId: args.monitorId },
      };
    },
  },

  {
    name: "algosize_run_monitor_now",
    title: "Run a monitor immediately",
    description:
      "Queue an out-of-schedule sweep for one monitor. Returns as soon as the work is queued, not " +
      "when it finishes — read the result afterwards with algosize_get_monitor_result. The sweep " +
      "itself consumes runs from the monthly allowance, one per enabled analyzer, even though this " +
      "call does not. Refused if the monitor is paused.",
    scope: SCOPES.MANAGE,
    paidOnly: false,
    metered: false,
    annotations: MUTATING,
    inputSchema: {
      type: "object",
      properties: { monitorId: { type: "string" } },
      required: ["monitorId"],
      additionalProperties: false,
    },
    outputSchema: { type: "object", properties: { queued: { type: "boolean" } } },
    async run({ args, request, env, ctx }) {
      const c = CHAINS.runMonitorNow;
      const { path, params } = monitorPath("runMonitorNow", args.monitorId, "/run");
      const res = await callHandler(c.chain, { method: c.method, path, params, request, env, ctx });
      const fail = failureOf(res, "Queueing the monitor run");
      if (fail) return fail;
      const d = res.json || {};
      return {
        text: d.message || `Queued a run for monitor ${args.monitorId}.`,
        structured: { queued: d.queued === true, monitorId: args.monitorId },
      };
    },
  },

  {
    name: "algosize_get_monitor_result",
    title: "Read a monitor's latest analyzer result",
    description:
      "Read the most recent result one analyzer produced for one monitored repository, with its " +
      "baseline and the delta since. Free and read-only. The reply's `status` distinguishes a real " +
      "result from an analyzer that is not enabled and from one whose first run has not landed — " +
      "do not read the last two as 'nothing found'.",
    scope: SCOPES.READ,
    paidOnly: false,
    metered: false,
    annotations: READ_ONLY,
    inputSchema: {
      type: "object",
      properties: {
        monitorId: { type: "string" },
        analyzer:  { type: "string", enum: MONITOR_ANALYZERS },
      },
      required: ["monitorId", "analyzer"],
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      properties: { status: { type: "string" }, result: {}, delta: {} },
    },
    async run({ args, request, env, ctx }) {
      const c = CHAINS.monitorResult;
      const res = await callHandler(c.chain, {
        method: c.method,
        path: `/api/monitors/${encodeURIComponent(args.monitorId)}/result/${encodeURIComponent(args.analyzer)}`,
        params: { id: args.monitorId, analyzer: args.analyzer },
        request, env, ctx,
      });
      const fail = failureOf(res, "Reading the monitor result");
      if (fail) return fail;

      const d = res.json || {};
      if (d.status === "not_enabled" || d.status === "unavailable") {
        return {
          text: `${d.message || d.status} (${args.analyzer} on ${d.repoUrl || args.monitorId}).`,
          structured: { status: d.status, result: null, delta: null },
        };
      }
      return {
        text:
          `${args.analyzer} on ${d.repoUrl || args.monitorId}` +
          `${d.computedAt ? `, computed ${new Date(d.computedAt * 1000).toISOString()}` : ""}.\n` +
          `${d.delta ? `Change since baseline: ${JSON.stringify(d.delta)}` : "No baseline delta recorded."}`,
        structured: { status: d.status, result: d.result ?? null, delta: d.delta ?? null },
      };
    },
  },
];
