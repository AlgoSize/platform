// The tool catalog: one flat array, assembled from the four domain files.
//
// What is deliberately NOT here is as important as what is. There is no tool
// for /api/keys, /api/billing/*, /api/account/*, /api/org*, /api/admin/*,
// /api/checkout or /api/auth/*. Not gated behind a scope — absent entirely,
// so no combination of scopes, no plan, and no bug in scope checking can
// reach them. An MCP client cannot mint a credential, move money, or change
// who has access to the organisation, because the code to do it from here
// does not exist.
//
// That is also why `keys.js` already refuses to let an API key manage API
// keys: the same reasoning, applied one layer down. An MCP session has no
// person behind it in the API-key case, and a credential that can mint
// credentials is a credential that cannot be revoked.

import { ANALYSIS_TOOLS } from "./analysis.js";
import { RUN_TOOLS }      from "./runs.js";
import { POSTURE_TOOLS }  from "./posture.js";
import { MONITOR_TOOLS }  from "./monitors.js";
import { FIX_TOOLS }      from "./fixes.js";

export const TOOLS = Object.freeze([
  ...ANALYSIS_TOOLS,
  ...RUN_TOOLS,
  ...POSTURE_TOOLS,
  ...MONITOR_TOOLS,
  ...FIX_TOOLS,
]);

// The four groups the dashboard's tool catalog renders under. Derived from the
// files rather than hand-listed, so a tool added to a domain file appears in
// the UI without a second edit somewhere else.
export const TOOL_GROUPS = Object.freeze([
  { id: "analysis", label: "Analysis",        tools: ANALYSIS_TOOLS.map((t) => t.name) },
  { id: "runs",     label: "Runs & Reports",  tools: RUN_TOOLS.map((t) => t.name) },
  { id: "posture",  label: "Posture",         tools: POSTURE_TOOLS.map((t) => t.name) },
  { id: "monitors", label: "Monitors",        tools: MONITOR_TOOLS.map((t) => t.name) },
  { id: "fixes",    label: "Fixes",           tools: FIX_TOOLS.map((t) => t.name) },
]);
