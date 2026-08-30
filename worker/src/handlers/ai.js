// AI model selector API — the data behind the per-stage model dropdowns, the
// live cost estimate, and the server-side stage-config validation.
//
//   GET  /api/ai/models              → per-stage valid models + price hints
//   POST /api/ai/estimate            → live per-finding cost for a selection
//   POST /api/ai/stage-config/validate → enforce Stage 5 ≠ Stage 4 (+ roles)
//
// The registry (ai/models.js + ai/pricing.js) is the single source of truth;
// this handler never names a model. All three are read-only and carry no
// secret; auth is the router's job (requireAuth).

import { stageOptions, estimatePipelineCost, validateStageConfig, expandRouting, STAGE_IDS, FUNNEL_SHARE } from "../ai/stages.js";
import { graphData, GRAPH_KINDS, recommend, TASK_FAMILIES, TASK_FAMILY_META } from "../ai/models.js";

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/**
 * GET /api/ai/models — the dropdown data, plus the Model explorer's datasets.
 *
 *   ?graph=<kind>          a scatter (cost_vs_capability | latency_vs_quality |
 *                          cost_vs_autofix) or the model_fit_by_task matrix
 *   ?includeDeprecated=1   keep superseded models in the answer
 *   ?taskFamily=<id>       narrow a graph to models rated for one family
 *   ?task=<id>             the ranked recommendation list for one family
 *   ?budget=1              with ?task, weight cost up so a cheap secondary
 *                          can outrank a dear primary
 *
 * All read-only registry data; no secret, no tenant state. The filters exist
 * because graphData has always supported them and nothing could reach them —
 * the explorer's Deprecated toggle had no server side at all.
 */
export async function stageModelsHandler(request, env) {
  const url = new URL(request.url);
  const graphKind = url.searchParams.get("graph");
  const task = url.searchParams.get("task");
  const taskFamily = url.searchParams.get("taskFamily");
  const includeDeprecated = url.searchParams.get("includeDeprecated") === "1";
  const budget = url.searchParams.get("budget") === "1";

  if (taskFamily && !TASK_FAMILIES.includes(taskFamily)) {
    return json({ error: "invalid_task_family", message: `taskFamily must be one of ${TASK_FAMILIES.join(", ")}` }, 400);
  }
  if (task && !TASK_FAMILIES.includes(task)) {
    return json({ error: "invalid_task", message: `task must be one of ${TASK_FAMILIES.join(", ")}` }, 400);
  }

  const out = { schema: "algosize.stage-models/2", stages: stageOptions(), funnel: FUNNEL_SHARE };

  // The task catalogue always rides along: an explorer that lists ids with no
  // descriptions asks the reader to already know the routing table.
  out.taskFamilies = TASK_FAMILIES.map((id) => ({ id, description: TASK_FAMILY_META[id] || "" }));

  if (graphKind) {
    if (!GRAPH_KINDS.includes(graphKind)) {
      return json({ error: "invalid_graph", message: `graph must be one of ${GRAPH_KINDS.join(", ")}` }, 400);
    }
    out.graph = graphData(graphKind, { includeDeprecated, taskFamily });
  }

  if (task) {
    const ranked = recommend(task, { budget, includeDeprecated });
    out.recommendation = {
      task,
      description: TASK_FAMILY_META[task] || "",
      budget,
      models: ranked,
      // An empty list is a deliberate blank, not a hole in the data: nothing on
      // the shortlist scored well enough for this job, so it runs
      // deterministically or not at all. Said here so a client does not have to
      // guess whether the registry simply forgot this family.
      empty: ranked.length === 0,
    };
  }

  return json(out, 200);
}

/** POST /api/ai/estimate — { config:{triage,validate,fix,verify}, routeToMcp:[] } → cost. */
export async function estimateStageCostHandler(request, env) {
  let body;
  try { body = await request.json(); }
  catch { return json({ error: "invalid_json", message: "request body must be valid JSON" }, 400); }
  const config = pickConfig(body && body.config);
  // expandRouting applies the S4→S5 coupling once, here, rather than trusting
  // the client to have sent both.
  const routeToMcp = expandRouting(
    Array.isArray(body && body.routeToMcp)
      ? body.routeToMcp.filter((s) => STAGE_IDS.includes(s)) : []);
  const estimate = estimatePipelineCost(config, { routeToMcp });
  return json({ schema: "algosize.stage-estimate/2", ...estimate }, 200);
}

/** POST /api/ai/stage-config/validate — server-side Stage 5 ≠ Stage 4 + role check. */
export async function validateStageConfigHandler(request, env) {
  let body;
  try { body = await request.json(); }
  catch { return json({ error: "invalid_json", message: "request body must be valid JSON" }, 400); }
  const config = pickConfig(body && body.config);
  // The verdict depends on which stages the platform will actually run, so the
  // routing selection is part of the question, not a client-side detail.
  const routeToMcp = Array.isArray(body && body.routeToMcp)
    ? body.routeToMcp.filter((s) => STAGE_IDS.includes(s)) : [];
  const result = validateStageConfig(config, { routeToMcp });
  // A rejected config is a 422 so the client cannot mistake it for a network
  // success — the enforcement is the point of the endpoint.
  return json({ schema: "algosize.stage-config-validation/1", ...result }, result.ok ? 200 : 422);
}

function pickConfig(c) {
  const out = {};
  for (const id of STAGE_IDS) {
    if (c && typeof c[id] === "string" && c[id]) out[id] = c[id];
  }
  return out;
}
