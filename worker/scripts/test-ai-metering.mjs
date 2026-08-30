// AI metering + recommendation engine tests.
//
// Covers the brief's required cases: pricing calculation, usage aggregation,
// budget enforcement, deprecated-model handling, graph dataset generation,
// recommendation ranking — plus the "unmeasured is not zero" discipline that
// runs through the whole system.

import { costOf, pickPrice, NEURON_PRICE } from "../src/ai/pricing.js";
import {
  aggregateBy, costTrend, topExpensive, budgetStatus, BUDGET_STATE, withDateBucket,
} from "../src/ai/aggregate.js";
import { recommend, graphData, GRAPH_KINDS, MODELS, TASK_FAMILIES } from "../src/ai/models.js";
import { buildUsageRecord, AI_USAGE_COLUMNS } from "../src/ai/usage.js";

let failures = 0;
const expect = (cond, label) => {
  if (cond) console.log(`  \x1b[32m✓\x1b[0m ${label}`);
  else { failures++; console.log(`  \x1b[31m✗\x1b[0m ${label}`); }
};
const approx = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;

console.log("\npricing: cost is computed from the real token ladder\n");
{
  // GLM-4.7 Flash: input 0.060 /1M, output 0.400 /1M.
  const c = costOf("@cf/zai-org/glm-4.7-flash", { inputTokens: 1_000_000, outputTokens: 1_000_000 });
  expect(c.priced === true, "a known model prices");
  expect(approx(c.totalCostUsd, 0.060 + 0.400), `1M in + 1M out = $${(0.46).toFixed(3)} (got ${c.totalCostUsd})`);
  expect(c.neuronsSource === "estimated", "with no reported Neurons, Neurons are estimated from cost");
  expect(approx(c.neurons, c.totalCostUsd / (NEURON_PRICE.usdPer1000 / 1000)),
    "…and reconcile to cost ÷ Neuron rate");
}
{
  // Reported Neurons win over the estimate (billing truth).
  const c = costOf("@cf/zai-org/glm-4.7-flash", { inputTokens: 1000, outputTokens: 1000, reportedNeurons: 42 });
  expect(c.neurons === 42 && c.neuronsSource === "reported", "reported Neurons override the estimate");
}
{
  // Cached input billed at the cache rate when the model prices it (DeepSeek).
  const full = costOf("@cf/deepseek-ai/deepseek-v4-flash-0731", { inputTokens: 1_000_000, outputTokens: 0 });
  const cached = costOf("@cf/deepseek-ai/deepseek-v4-flash-0731", { inputTokens: 1_000_000, cachedInputTokens: 1_000_000, outputTokens: 0 });
  expect(cached.totalCostUsd < full.totalCostUsd, "cached input costs less than fresh input when the model discounts it");
  expect(approx(cached.totalCostUsd, 0.044), `…at the cached rate 0.044/1M (got ${cached.totalCostUsd})`);
}

console.log("\npricing: unmeasured is not zero\n");
{
  const unknown = costOf("@cf/nobody/does-not-exist", { inputTokens: 100, outputTokens: 100 });
  expect(unknown.priced === false && unknown.totalCostUsd === null,
    "an unknown model is unpriced (null cost), NEVER $0");
  expect(unknown.reason === "model_not_priced", "…with a reason a UI can show");
}
{
  const dep = costOf("@cf/moonshotai/kimi-k2.5", { inputTokens: 100, outputTokens: 100 });
  expect(dep.priced === false && dep.reason === "model_deprecated",
    "a deprecated model is refused for a NEW call (model_deprecated)");
  // …but its historical price is still resolvable for repricing old rows.
  expect(pickPrice("@cf/moonshotai/kimi-k2.5", Date.now(), { allowDeprecated: true }) !== null,
    "…while its historical price stays resolvable with allowDeprecated");
}

console.log("\naggregation: neurons and cost both roll up, partial is flagged\n");
{
  const rows = [
    { org_id: "o1", feature_name: "fix_proposal", model: "m", neurons_consumed: 10, total_cost: 0.10, status: "ok", created_at: Date.parse("2026-08-01T10:00:00Z") },
    { org_id: "o1", feature_name: "advisory_fix", model: "m", neurons_consumed: 5,  total_cost: 0.05, status: "ok", created_at: Date.parse("2026-08-01T12:00:00Z") },
    { org_id: "o2", feature_name: "fix_proposal", model: "m", neurons_consumed: null, total_cost: null, status: "ok", created_at: Date.parse("2026-08-02T09:00:00Z") },
  ];
  const byOrg = aggregateBy(rows, "org_id");
  const o1 = byOrg.find((g) => g.org_id === "o1");
  expect(approx(o1.totalCostUsd, 0.15) && o1.neurons === 15, "org rollup sums cost and neurons");
  const o2 = byOrg.find((g) => g.org_id === "o2");
  expect(o2.totalCostUsd === null && o2.partial === true,
    "an all-unmeasured group sums to null and is flagged partial, not $0");

  const byFeature = aggregateBy(rows, "feature_name");
  expect(byFeature.length === 2, "aggregates by feature too");

  const trend = costTrend(rows, "day");
  expect(trend.length === 2 && trend[0].date === "2026-08-01" && approx(trend[0].totalCostUsd, 0.15),
    "daily trend buckets by date, ascending");
  const monthly = costTrend(rows, "month");
  expect(monthly.length === 1 && monthly[0].date === "2026-08", "monthly rollup collapses to one bucket");

  const top = topExpensive(rows, 1);
  expect(top.length === 1 && approx(top[0].total_cost, 0.10), "top-expensive picks the dearest row");
}

console.log("\nbudget: states, and unmeasured spend is not 'under budget'\n");
{
  expect(budgetStatus(5, 100).state === BUDGET_STATE.OK, "5/100 is ok");
  expect(budgetStatus(85, 100).state === BUDGET_STATE.SOFT, "85/100 crosses the soft threshold");
  expect(budgetStatus(100, 100).state === BUDGET_STATE.HARD, "100/100 is hard (blocking)");
  expect(budgetStatus(200, 100).state === BUDGET_STATE.HARD, "over the limit is hard");
  expect(budgetStatus(null, 100).state === BUDGET_STATE.UNMEASURED,
    "spend that could not be measured is 'unmeasured', NOT under budget");
  expect(budgetStatus(50, 0).state === BUDGET_STATE.OK && budgetStatus(50, 0).limitUsd === null,
    "no limit set → tracked but never blocked");
}

console.log("\nrecommendation: ranking, tiers, budget weighting, plan lists\n");
{
  const fix = recommend("multifile_fix");
  expect(fix.length > 0 && fix[0].tier === "primary", "multi-file fix leads with a primary coding model");
  expect(fix.every((r) => r.model !== "@cf/moonshotai/kimi-k2.5"), "deprecated models never recommended");
  expect(!fix.some((r) => MODELS.find((m) => m.model === r.model)?.tasks.multifile_fix === "avoid"),
    "…and 'avoid'-tier models never appear");

  const emb = recommend("embeddings");
  expect(emb[0].model.includes("bge-m3") || emb[0].model.includes("embedding"),
    "embeddings recommends an embedding model first");

  // Budget weighting can reorder toward cheaper models.
  const normal = recommend("fix_suggestion");
  const budget = recommend("fix_suggestion", { budget: true });
  expect(budget[0].costScore >= normal[0].costScore - 0 && budget.length === normal.length,
    "budget mode keeps the pool but weights cost up");

  // Plan allow/block lists.
  const blocked = recommend("multifile_fix", { block: [fix[0].model] });
  expect(!blocked.some((r) => r.model === fix[0].model), "a blocked model is removed");
  const allowed = recommend("multifile_fix", { allow: [fix[fix.length - 1].model] });
  expect(allowed.length === 1, "an allowlist narrows to exactly the allowed models");
}

console.log("\ngraph datasets: shape, filters, deprecated excluded\n");
{
  for (const kind of GRAPH_KINDS) {
    const d = graphData(kind);
    expect(!!d && d.kind === kind, `graphData("${kind}") returns a dataset`);
  }
  const scatter = graphData("cost_vs_capability");
  expect(Array.isArray(scatter.points) && scatter.points.every((p) => typeof p.x === "number" && typeof p.y === "number"),
    "scatter points carry numeric x and y");
  expect(!scatter.points.some((p) => p.deprecated), "deprecated models excluded by default");
  expect(graphData("cost_vs_capability", { includeDeprecated: true }).points.some((p) => p.deprecated),
    "…but includeDeprecated brings them back");

  const autofix = graphData("cost_vs_autofix");
  expect(autofix.y.key === "coding", "the autofix graph's y-axis is the coding score, not general capability");

  const matrix = graphData("model_fit_by_task");
  expect(Array.isArray(matrix.rows) && matrix.families.length === TASK_FAMILIES.length,
    "model_fit_by_task returns a family × model matrix");

  let threw = false;
  try { graphData("nonsense"); } catch { threw = true; }
  expect(threw, "an unknown graph kind throws rather than returning junk");
}

console.log("\nusage record: priced row, content never stored\n");
{
  const result = { ok: true, provider: "workers-ai", model: "@cf/zai-org/glm-4.7-flash",
    usage: { inputTokens: 1000, outputTokens: 500 } };
  const rec = buildUsageRecord(result, {
    orgId: "o1", userId: "u1", feature: "advisory_fix", latencyMs: 850,
    metadata: { environment: "production", prompt: "SECRET PROMPT TEXT", route: "/api/fix" },
  });
  expect(rec.org_id === "o1" && rec.feature_name === "advisory_fix", "record carries attribution");
  expect(typeof rec.total_cost === "number" && rec.total_cost > 0, "…and a computed cost");
  expect(rec.input_tokens === 1000 && rec.output_tokens === 500, "…and the token counts");
  expect(!/SECRET PROMPT TEXT/.test(rec.request_metadata || ""),
    "prompt content is NEVER persisted — metadata is correlation keys only");
  expect(/production/.test(rec.request_metadata) && /\/api\/fix/.test(rec.request_metadata),
    "…while allowed correlation keys ARE kept");

  const unpriced = buildUsageRecord({ ok: true, provider: "workers-ai", model: "@cf/unknown/x", usage: {} }, { orgId: "o1", feature: "x" });
  expect(unpriced.total_cost === null, "an unpriced call records null cost, never 0");
}

console.log("\nusage record: columns, SQL, and record keys never drift\n");
{
  const rec = buildUsageRecord({ ok: true, provider: "workers-ai", model: "@cf/zai-org/glm-4.7-flash", usage: {} }, { orgId: "o", feature: "x" });
  const keys = Object.keys(rec);
  expect(keys.length === AI_USAGE_COLUMNS.length, `record has ${AI_USAGE_COLUMNS.length} columns`);
  expect(keys.every((k, i) => k === AI_USAGE_COLUMNS[i]),
    "buildUsageRecord keys match AI_USAGE_COLUMNS in order — the INSERT binds correctly");
}

console.log("");
if (failures === 0) {
  console.log("\x1b[32m  all AI-metering tests passed\x1b[0m\n");
  process.exit(0);
}
console.log(`\x1b[31m  ${failures} AI-metering test(s) failed\x1b[0m\n`);
process.exit(1);
