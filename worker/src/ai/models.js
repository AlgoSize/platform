// AI model recommendation registry — one place, registry-driven.
//
// The brief's rule: "Do not hardcode model selection in scattered files. Build
// a reusable internal registry-driven system." Model selection anywhere in the
// platform should consult `recommend()`, never a literal slug chosen inline.
//
// This is a CURATED shortlist for Algosize's jobs, not a catalog dump. The
// model set and its cost ladder track the pricing registry in ./pricing.js
// (prices relayed from the Cloudflare Workers AI models page, 2026-08).
//
// SCORES: 0–100, oriented so higher is always better on every axis:
//   capability   — general answer quality on this platform's jobs
//   coding       — reading/writing code (the autofix axis)
//   costScore    — 100 = cheapest, 0 = dearest (derived from the real output
//                  price ladder — the one score anchored to verified data)
//   latencyScore — 100 = fastest (engineering estimate)
// costScore is anchored to the sourced prices; capability/coding/latency are
// seeded engineering estimates. `scored: false` marks that the quality scores
// are estimates, not benchmark output — good enough to rank and to place on a
// graph, not a published benchmark.

export const TASK_FAMILIES = Object.freeze([
  "embeddings", "reranking", "summarization", "finding_explanation",
  "repo_summarization", "vuln_classification", "triage", "fix_suggestion",
  "multifile_fix", "support_chat", "report_writing", "visual_reasoning",
  "moderation",
]);

export const TIERS = Object.freeze(["primary", "secondary", "budget", "avoid"]);

// costScore anchored to the real output $/1M ladder from ./pricing.js:
//   0.00→100  0.11→95  0.18→90  0.30→82  0.34→78  0.40→74  0.50→70
//   1.32→45   4.00→15  4.40→12
export const MODELS = Object.freeze([
  // ---- retrieval ----
  m("workers-ai", "@cf/baai/bge-m3", "BGE-M3 embeddings", {
    capability: 62, coding: 0, costScore: 99, latencyScore: 96,
    p50Ms: 110, contextWindow: 8192, tools: false, reasoning: false, vision: false,
    tasks: { embeddings: "primary" },
    notes: "Cheap multilingual embeddings. Default retrieval encoder.",
  }),
  m("workers-ai", "@cf/qwen/qwen3-embedding-0.6b", "Qwen3 embeddings 0.6b", {
    capability: 60, coding: 0, costScore: 99, latencyScore: 96,
    p50Ms: 110, contextWindow: 8192, tools: false, reasoning: false, vision: false,
    tasks: { embeddings: "secondary" },
    notes: "Same listed price as BGE-M3; Qwen-family alternative.",
  }),
  m("workers-ai", "@cf/baai/bge-reranker-base", "BGE reranker base", {
    capability: 55, coding: 0, costScore: 100, latencyScore: 94,
    p50Ms: 130, contextWindow: 512, tools: false, reasoning: false, vision: false,
    tasks: { reranking: "primary" },
    notes: "Cheapest second-stage relevance ranking for findings/files/context.",
  }),
  // ---- cheap helper / general text ----
  m("workers-ai", "@cf/ibm-granite/granite-4.0-h-micro", "Granite 4.0 H Micro", {
    capability: 58, coding: 40, costScore: 95, latencyScore: 92,
    p50Ms: 400, contextWindow: 128000, tools: true, reasoning: false, vision: false,
    tasks: { summarization: "primary", finding_explanation: "primary", triage: "primary", moderation: "budget", support_chat: "budget" },
    notes: "Best ultra-cheap text helper: summaries, labels, routing, short explanations.",
  }),
  m("workers-ai", "@cf/zai-org/glm-4.7-flash", "GLM-4.7 Flash", {
    capability: 68, coding: 52, costScore: 74, latencyScore: 84,
    p50Ms: 700, contextWindow: 128000, tools: true, reasoning: false, vision: false,
    tasks: { support_chat: "primary", report_writing: "secondary", finding_explanation: "secondary", summarization: "secondary" },
    notes: "Low-cost step up for chatty UX and structured light reasoning.",
  }),
  // ---- reasoning ----
  m("workers-ai", "@cf/qwen/qwen3-30b-a3b-fp8", "Qwen3 30B A3B fp8", {
    capability: 78, coding: 66, costScore: 78, latencyScore: 66,
    p50Ms: 1400, contextWindow: 128000, tools: true, reasoning: true, vision: false,
    tasks: { vuln_classification: "primary", triage: "secondary", fix_suggestion: "secondary", report_writing: "secondary" },
    notes: "Strong value for reasoning-heavy but cost-sensitive tasks.",
  }),
  m("workers-ai", "@cf/openai/gpt-oss-20b", "GPT-OSS 20B", {
    capability: 76, coding: 62, costScore: 82, latencyScore: 70,
    p50Ms: 1200, contextWindow: 128000, tools: true, reasoning: true, vision: false,
    tasks: { triage: "primary", finding_explanation: "secondary", vuln_classification: "secondary" },
    notes: "Good reasoning/cost balance for triage and explanations.",
  }),
  m("workers-ai", "@cf/deepseek-ai/deepseek-v4-flash-0731", "DeepSeek V4 Flash", {
    capability: 85, coding: 80, costScore: 45, latencyScore: 55,
    p50Ms: 2000, contextWindow: 128000, tools: true, reasoning: true, vision: false,
    tasks: { fix_suggestion: "primary", multifile_fix: "secondary", repo_summarization: "secondary", report_writing: "secondary", vuln_classification: "secondary" },
    notes: "Capable agentic/reasoning model with cached-input pricing. Third voter in the critical-finding exploitability ensemble.",
  }),
  // ---- premium coding / remediation ----
  m("workers-ai", "@cf/zai-org/glm-5.3-flash", "GLM-5.3 Flash", {
    capability: 82, coding: 82, costScore: 70, latencyScore: 68,
    p50Ms: 1600, contextWindow: 200000, tools: true, reasoning: true, vision: false,
    tasks: { fix_suggestion: "primary", multifile_fix: "secondary", report_writing: "secondary" },
    notes: "Much cheaper than full GLM-5.3; good for draft fixes and coding assist.",
  }),
  m("workers-ai", "@cf/zai-org/glm-5.3", "GLM-5.3", {
    capability: 92, coding: 92, costScore: 12, latencyScore: 45,
    p50Ms: 2600, contextWindow: 200000, tools: true, reasoning: true, vision: false,
    tasks: { multifile_fix: "primary", fix_suggestion: "secondary", repo_summarization: "secondary" },
    notes: "Flagship coding/agentic model. Deep fix generation; meter closely.",
  }),
  m("workers-ai", "@cf/moonshotai/kimi-k2.7-code", "Kimi K2.7 Code", {
    capability: 88, coding: 93, costScore: 15, latencyScore: 50,
    p50Ms: 2400, contextWindow: 256000, tools: true, reasoning: true, vision: false,
    tasks: { multifile_fix: "primary", fix_suggestion: "primary" },
    notes: "Code specialist for high-value remediation.",
  }),
  // ---- vision ----
  m("workers-ai", "@cf/google/gemma-4-26b-a4b-it", "Gemma 4 26B", {
    capability: 74, coding: 40, costScore: 82, latencyScore: 62,
    p50Ms: 1500, contextWindow: 128000, tools: false, reasoning: false, vision: true,
    tasks: { visual_reasoning: "primary" },
    notes: "Good-priced multimodal option for UI/screenshot analysis.",
  }),
  // ---- currently wired default (the only live provider today) ----
  m("workers-ai", "@cf/moonshotai/kimi-k2.6", "Kimi K2.6 (wired default)", {
    capability: 70, coding: 58, costScore: 90, latencyScore: 85,
    p50Ms: 900, contextWindow: 128000, tools: true, reasoning: false, vision: false,
    tasks: { summarization: "secondary", finding_explanation: "secondary", triage: "secondary", fix_suggestion: "budget" },
    notes: "The keyless binding in production today. Cheap and fast; the fallback default.",
  }),
  // ---- deprecated: never a default recommendation ----
  m("workers-ai", "@cf/moonshotai/kimi-k2.5", "Kimi K2.5 (deprecated)", {
    capability: 66, coding: 54, costScore: 90, latencyScore: 84,
    p50Ms: 950, contextWindow: 128000, tools: true, reasoning: false, vision: false,
    deprecated: true, tasks: { summarization: "avoid", fix_suggestion: "avoid" },
    notes: "Superseded by K2.6/K2.7. Do not use as a default.",
  }),
  m("workers-ai", "@cf/facebook/bart-large-cnn", "BART-large-CNN (deprecated)", {
    capability: 45, coding: 0, costScore: 96, latencyScore: 88,
    p50Ms: 500, contextWindow: 1024, tools: false, reasoning: false, vision: false,
    deprecated: true, tasks: { summarization: "avoid" },
    notes: "Legacy summarizer. Superseded by Granite/GLM. Avoid.",
  }),
]);

function m(provider, model, label, rest) {
  return {
    provider, model, label,
    capability: 0, coding: 0, costScore: 0, latencyScore: 0,
    p50Ms: null, contextWindow: null, tools: false, reasoning: false, vision: false,
    deprecated: false, scored: false, tasks: {}, notes: "",
    ...rest,
  };
}

const rank = { primary: 0, secondary: 1, budget: 2, avoid: 3 };

/**
 * Ranked recommendations for a task family, best-first.
 *
 * opts: { budget, includeDeprecated=false, allow, block }
 *   budget — weight cost up so a cheap secondary can beat a dear primary.
 *   allow/block — plan allowlist/blocklist of model slugs.
 *
 * Deprecated models and models that hold tier "avoid" for the family are never
 * returned unless includeDeprecated is set (and "avoid" never is).
 */
export function recommend(taskFamily, opts = {}) {
  const { budget = false, includeDeprecated = false, allow = null, block = null } = opts;
  const pool = MODELS.filter((x) => {
    const tier = x.tasks[taskFamily];
    if (!tier || tier === "avoid") return false;
    if (x.deprecated && !includeDeprecated) return false;
    if (allow && !allow.includes(x.model)) return false;
    if (block && block.includes(x.model)) return false;
    return true;
  });

  const isCoding = taskFamily === "multifile_fix" || taskFamily === "fix_suggestion";
  const scoreOf = (x) => {
    const tierScore = (3 - rank[x.tasks[taskFamily]]) * 100;
    const quality = isCoding ? x.coding : x.capability;
    const w = budget
      ? { tier: 1.0, quality: 0.6, cost: 1.4, latency: 0.3 }
      : { tier: 1.0, quality: 1.2, cost: 0.4, latency: 0.3 };
    return tierScore * w.tier + quality * w.quality + x.costScore * w.cost + x.latencyScore * w.latency;
  };

  return pool
    .map((x) => ({
      provider: x.provider, model: x.model, label: x.label,
      tier: x.tasks[taskFamily], score: Math.round(scoreOf(x)),
      capability: x.capability, coding: x.coding, costScore: x.costScore, latencyScore: x.latencyScore,
      contextWindow: x.contextWindow, tools: x.tools, reasoning: x.reasoning, vision: x.vision,
      scored: x.scored, notes: x.notes,
    }))
    .sort((a, b) => b.score - a.score);
}

// ---------------------------------------------------------------------------
// Graph-ready datasets. Higher-is-better on both axes, so every scatter reads
// the same way (top-right = best). Points carry raw units + flags for tooltips.
// ---------------------------------------------------------------------------

const GRAPHS = {
  cost_vs_capability: { x: { key: "costScore", label: "Cheaper →" }, y: { key: "capability", label: "More capable →" } },
  latency_vs_quality: { x: { key: "latencyScore", label: "Faster →" }, y: { key: "capability", label: "Higher quality →" } },
  cost_vs_autofix:    { x: { key: "costScore", label: "Cheaper →" }, y: { key: "coding", label: "Better at code →" } },
};

export const GRAPH_KINDS = Object.freeze(Object.keys(GRAPHS).concat(["model_fit_by_task"]));

/**
 * Graph-ready data. `kind` ∈ GRAPH_KINDS. `filter`:
 *   { taskFamily, provider, includeDeprecated }
 * Scatter kinds return { kind, x, y, points }; model_fit_by_task returns a
 * tier-per-family matrix for a heatmap.
 */
export function graphData(kind, filter = {}) {
  const { taskFamily = null, provider = null, includeDeprecated = false } = filter;
  const models = MODELS.filter((x) => {
    if (x.deprecated && !includeDeprecated) return false;
    if (provider && x.provider !== provider) return false;
    if (taskFamily && !x.tasks[taskFamily]) return false;
    return true;
  });

  if (kind === "model_fit_by_task") {
    return {
      kind, families: TASK_FAMILIES,
      rows: models.map((x) => ({
        model: x.model, label: x.label, deprecated: x.deprecated,
        fit: Object.fromEntries(TASK_FAMILIES.map((f) => [f, x.tasks[f] || null])),
      })),
    };
  }

  const g = GRAPHS[kind];
  if (!g) throw new Error(`unknown graph kind: ${kind}`);
  return {
    kind, x: g.x, y: g.y,
    points: models.map((x) => ({
      model: x.model, label: x.label, provider: x.provider,
      x: x[g.x.key], y: x[g.y.key],
      deprecated: x.deprecated, scored: x.scored,
      p50Ms: x.p50Ms, contextWindow: x.contextWindow,
    })),
  };
}
