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

import { stageOptions, estimatePipelineCost, validateStageConfig, STAGE_IDS } from "../ai/stages.js";
import { graphData, GRAPH_KINDS } from "../ai/models.js";

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** GET /api/ai/models — the dropdown data, plus an optional model graph. */
export async function stageModelsHandler(request, env) {
  const url = new URL(request.url);
  const graphKind = url.searchParams.get("graph");
  const out = { schema: "algosize.stage-models/1", stages: stageOptions() };
  if (graphKind) {
    if (!GRAPH_KINDS.includes(graphKind)) {
      return json({ error: "invalid_graph", message: `graph must be one of ${GRAPH_KINDS.join(", ")}` }, 400);
    }
    out.graph = graphData(graphKind);
  }
  return json(out, 200);
}

/** POST /api/ai/estimate — { config:{triage,validate,fix,verify}, routeToMcp:[] } → cost. */
export async function estimateStageCostHandler(request, env) {
  let body;
  try { body = await request.json(); }
  catch { return json({ error: "invalid_json", message: "request body must be valid JSON" }, 400); }
  const config = pickConfig(body && body.config);
  const routeToMcp = Array.isArray(body && body.routeToMcp)
    ? body.routeToMcp.filter((s) => STAGE_IDS.includes(s)) : [];
  const estimate = estimatePipelineCost(config, { routeToMcp });
  return json({ schema: "algosize.stage-estimate/1", ...estimate, routeToMcp }, 200);
}

/** POST /api/ai/stage-config/validate — server-side Stage 5 ≠ Stage 4 + role check. */
export async function validateStageConfigHandler(request, env) {
  let body;
  try { body = await request.json(); }
  catch { return json({ error: "invalid_json", message: "request body must be valid JSON" }, 400); }
  const config = pickConfig(body && body.config);
  const result = validateStageConfig(config);
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
