// The single lookup for tools, resources and prompts.
//
// `handlers/mcp.js` asks this module what exists and what the caller may see;
// it never reaches into tools/index.js directly. That keeps the filtering
// rules — scope, plan, feature flag — in one place instead of being repeated
// at each of the three list methods, where one of them would eventually be
// forgotten.

import { TOOLS, TOOL_GROUPS } from "./tools/index.js";
import { hasScope, SCOPES } from "./tokens.js";

export { TOOLS, TOOL_GROUPS };

/** One tool by name, or null. */
export function getTool(name) {
  return TOOLS.find((t) => t.name === name) || null;
}

/**
 * The tools this caller may see.
 *
 * Filtered by scope AND by plan. A tool the caller cannot use is omitted from
 * the list rather than shown and refused: a model handed a tool it will always
 * be told "no" by wastes turns discovering that, and on a metered surface some
 * of those attempts would cost real runs before the refusal.
 *
 * `paidOnly` tools are the exception worth stating: they are omitted for a
 * free org, but if one is somehow called anyway, `handlers/mcp.js` answers
 * with an isError result naming the plan and linking pricing — an honest
 * upgrade path rather than a bare "unknown tool".
 */
export function listTools({ scopes = [], entitled = true } = {}) {
  return TOOLS.filter((t) => {
    if (!hasScope(scopes, t.scope)) return false;
    if (t.paidOnly && !entitled) return false;
    return true;
  }).map(publicTool);
}

/** The wire shape of a tool. `run` and the internal flags never cross the wire. */
export function publicTool(t) {
  return {
    name:        t.name,
    title:       t.title,
    description: t.description,
    inputSchema: t.inputSchema,
    ...(t.outputSchema ? { outputSchema: t.outputSchema } : {}),
    annotations: t.annotations,
    // Not part of the MCP spec, and namespaced so a strict client ignores it.
    // The dashboard's catalog renders the metered and plan badges from these,
    // and reading them off the same objects the server dispatches on is what
    // keeps the badges from drifting away from the truth.
    _meta: { "algosize/metered": t.metered === true, "algosize/scope": t.scope, "algosize/paidOnly": t.paidOnly === true },
  };
}

// ---------------------------------------------------------------------------
// Resources
// ---------------------------------------------------------------------------
//
// Read-only context a host can attach without spending a tool call. Every one
// maps onto a tool that already exists, and reads go through the same
// callHandler path and the same scope check — a resource is a different
// affordance over the same data, never a second way in.

const RESOURCES = Object.freeze([
  {
    uri: "algosize://scorecard",
    name: "Engineering scorecard",
    description: "Current grades across security, cost, complexity and architecture for every monitored repository.",
    mimeType: "application/json",
    scope: SCOPES.READ,
    tool: "algosize_get_scorecard",
    args: () => ({}),
  },
  {
    uri: "algosize://runs/recent",
    name: "Recent analysis runs",
    description: "The organisation's twenty most recent analysis runs.",
    mimeType: "application/json",
    scope: SCOPES.READ,
    tool: "algosize_list_runs",
    args: () => ({ limit: 20 }),
  },
  {
    uri: "algosize://monitors",
    name: "Scheduled monitors",
    description: "Every repository under scheduled watch, with schedule and health.",
    mimeType: "application/json",
    scope: SCOPES.READ,
    tool: "algosize_list_monitors",
    args: () => ({}),
  },
]);

// RFC 6570 templates, so a host can offer completion on the variable part.
const RESOURCE_TEMPLATES = Object.freeze([
  {
    uriTemplate: "algosize://runs/{runId}",
    name: "One analysis run",
    description: "The full stored result of a single run.",
    mimeType: "application/json",
    scope: SCOPES.READ,
    tool: "algosize_get_run",
    pattern: /^algosize:\/\/runs\/([^/]+)$/,
    args: (m) => ({ runId: decodeURIComponent(m[1]) }),
  },
  {
    uriTemplate: "algosize://runs/{runId}/report",
    name: "A run's report",
    description: "The rendered report for one run, as structured JSON.",
    mimeType: "application/json",
    scope: SCOPES.READ,
    tool: "algosize_get_run_report",
    pattern: /^algosize:\/\/runs\/([^/]+)\/report$/,
    args: (m) => ({ runId: decodeURIComponent(m[1]), format: "json" }),
  },
  {
    uriTemplate: "algosize://arch/snapshots/{snapshotId}",
    name: "An architecture snapshot",
    description: "One captured architecture graph.",
    mimeType: "application/json",
    scope: SCOPES.READ,
    tool: "algosize_list_arch_snapshots",
    pattern: /^algosize:\/\/arch\/snapshots\/([^/]+)$/,
    args: (m) => ({ snapshotId: decodeURIComponent(m[1]) }),
  },
]);

export function listResources({ scopes = [] } = {}) {
  return RESOURCES.filter((r) => hasScope(scopes, r.scope))
    .map(({ uri, name, description, mimeType }) => ({ uri, name, description, mimeType }));
}

export function listResourceTemplates({ scopes = [] } = {}) {
  return RESOURCE_TEMPLATES.filter((r) => hasScope(scopes, r.scope))
    .map(({ uriTemplate, name, description, mimeType }) => ({ uriTemplate, name, description, mimeType }));
}

/**
 * Resolve a resource URI to the tool that serves it.
 *
 * Fixed URIs are matched first, then templates. Returns null for anything
 * unrecognised — including a URI that merely looks like ours. A resource
 * reader that guessed would be a path traversal waiting to happen.
 */
export function matchResource(uri) {
  const fixed = RESOURCES.find((r) => r.uri === uri);
  if (fixed) return { descriptor: fixed, args: fixed.args() };
  for (const t of RESOURCE_TEMPLATES) {
    const m = t.pattern.exec(uri);
    if (m) return { descriptor: t, args: t.args(m) };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------
//
// Templates that chain the tools above into a workflow. No server-side model
// call happens here: a prompt returns MESSAGES, and the host's own model does
// the work. That matters for the product's privacy claim — Algosize never
// sends customer code to a model the customer did not choose.

const PROMPTS = Object.freeze([
  {
    name: "audit_repository",
    title: "Audit a repository end to end",
    description: "Dependency scan, architecture x-ray, then a prioritised list of what to fix first.",
    arguments: [
      { name: "repoUrl", description: "https://github.com/owner/name", required: true },
      { name: "branch",  description: "Branch to audit. Defaults to the repository's default branch.", required: false },
    ],
    build: (a) => [{
      role: "user",
      content: { type: "text", text:
        `Audit ${a.repoUrl}${a.branch ? ` on branch ${a.branch}` : ""} using Algosize.\n\n` +
        `1. Call algosize_list_runs first to see whether a recent audit already covers this ` +
        `repository — each analysis costs a run from a monthly allowance, so reuse a fresh result ` +
        `rather than repeating it.\n` +
        `2. If nothing recent exists, call algosize_analyze_vulnerabilities with repoUrl.\n` +
        `3. Call algosize_get_scorecard for the wider posture.\n` +
        `4. Summarise: the highest-severity issues first, each with why it matters here and what ` +
        `fixing it involves. Say plainly if the data is stale or an analyzer has not run — do not ` +
        `present an absent result as a clean one.`,
      },
    }],
  },
  {
    name: "explain_findings",
    title: "Explain a run's findings",
    description: "Turn one analysis run into an explanation pitched at a chosen audience.",
    arguments: [
      { name: "runId",    description: "The run to explain.", required: true },
      { name: "audience", description: "engineer or exec. Defaults to engineer.", required: false },
    ],
    build: (a) => [{
      role: "user",
      content: { type: "text", text:
        `Read Algosize run ${a.runId} with algosize_get_run, then explain it for ` +
        `${a.audience === "exec" ? "an executive: lead with business risk and cost, no code, no jargon, " +
          "and be explicit about what is not yet known" : "an engineer: specifics, file and package names, " +
          "and the concrete change each fix needs"}. ` +
        `Where a finding has a suggested remediation, call algosize_generate_fix — it is free and does ` +
        `not consume a run.`,
      },
    }],
  },
  {
    name: "pre_release_check",
    title: "Pre-release gate",
    description: "A pass/fail summary suitable for pasting into a pull request.",
    arguments: [
      { name: "repoUrl", description: "https://github.com/owner/name", required: true },
    ],
    build: (a) => [{
      role: "user",
      content: { type: "text", text:
        `Run a pre-release check on ${a.repoUrl} using Algosize.\n\n` +
        `Call algosize_get_scorecard and algosize_list_monitors, and if the repository has ` +
        `architecture snapshots, call algosize_diff_architecture on the two most recent to see what ` +
        `this release changes structurally.\n\n` +
        `Produce a short PASS / FAIL verdict with the reasons. A FAIL needs a named blocking finding. ` +
        `If the evidence is incomplete — an analyzer that has not run, a stale grade, a diff with no ` +
        `baseline — say so and do not issue a PASS on missing data.`,
      },
    }],
  },
]);

export function listPrompts() {
  return PROMPTS.map(({ name, title, description, arguments: args }) => ({
    name, title, description, arguments: args,
  }));
}

/** Build one prompt's messages, or null when the name is unknown. */
export function getPrompt(name, args = {}) {
  const p = PROMPTS.find((x) => x.name === name);
  if (!p) return null;
  const missing = (p.arguments || []).filter((a) => a.required && !args[a.name]).map((a) => a.name);
  if (missing.length) return { error: `Missing required argument(s): ${missing.join(", ")}` };
  return { description: p.description, messages: p.build(args) };
}
