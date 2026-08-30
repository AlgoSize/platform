// Stage → model routing for the multi-model fix pipeline.
//
// The pipeline's governing rule (from the brief): never route every finding
// through one model, and never hardcode a model slug inline. Each stage asks
// for the cheapest model that can do THAT stage's job, and the choice comes
// from one of two places, in order:
//
//   1. model_routing_config (D1)  — an operator override for a
//      (stage, cwe_family, language, complexity) key, versioned by an
//      effective window so a routing change is a new row, never a mutation
//      (the same discipline as pricing and margin). Lets routing be retuned
//      without a code deploy.
//   2. the recommendation engine  — recommend(taskFamily) from ai/models.js,
//      the curated, priced shortlist. The code-level default when the DB has
//      no override, and the ONLY source of truth for which models exist.
//
// So this module never names a model slug of its own: it maps a stage to a
// task family and defers to recommend(). The proposal's model names
// (deepseek-r1, qwq-32b, gpt-oss-120b, …) are NOT in our priced registry;
// mapping through recommend() remaps every stage onto models we actually
// price and can bill, rather than inventing an unpriced slug.

import { recommend } from "./models.js";

// Each pipeline stage is a task family the recommendation engine already
// scores. Stage 4 (fix) splits by complexity: a multi-file change wants the
// flagship coder, a single-file change can use a cheaper fix model.
export const STAGE_TASK_FAMILY = Object.freeze({
  triage: "triage",                    // Stage 2 — cheap FP filter
  validate: "vuln_classification",     // Stage 3 — reasoning exploitability
  ensemble: "vuln_classification",     // Stage 3 — critical findings, N-model vote
  fix_multifile: "multifile_fix",      // Stage 4 — flagship coder
  fix_single: "fix_suggestion",        // Stage 4 — cheaper single-file fix
  verify: "vuln_classification",       // Stage 5 — cross-model review
  embed: "embeddings",                 // support — bge-m3
  rerank: "reranking",                 // support — bge-reranker-base
});

/**
 * The task family for a stage. Stage 4 is complexity-sensitive.
 */
export function taskFamilyForStage(stage, { complexity = "single_file" } = {}) {
  if (stage === "fix") {
    return complexity === "multi_file" ? STAGE_TASK_FAMILY.fix_multifile : STAGE_TASK_FAMILY.fix_single;
  }
  return STAGE_TASK_FAMILY[stage] || null;
}

/**
 * The ordered model candidates for a stage, best-first, from recommend().
 * PURE — no DB. `exclude` drops models (Stage 5 verify must differ from the
 * model Stage 4 used); `budget` weights cost up. Returns model slugs.
 */
export function stageModelPlan(stage, { complexity = "single_file", budget = false, exclude = [], block = null } = {}) {
  const family = taskFamilyForStage(stage, { complexity });
  if (!family) return { stage, family: null, models: [], primary: null };
  const recs = recommend(family, { budget, block });
  const models = recs.map((r) => r.model).filter((mdl) => !exclude.includes(mdl));
  return { stage, family, models, primary: models[0] || null };
}

/**
 * Pick N diverse models for an ensemble vote, best-first. Diversity here is
 * "distinct model slugs" — a vote among three copies of one model is not a
 * vote. Falls back to however many distinct models the family has if N is
 * larger than the pool.
 */
export function ensembleModels(n = 3, { budget = false, exclude = [] } = {}) {
  const plan = stageModelPlan("validate", { budget, exclude });
  return plan.models.slice(0, Math.max(1, n));
}

/**
 * Resolve the model for a stage, honouring a model_routing_config override.
 *
 * Best-effort DB read: an override row matching the most specific
 * (stage, cwe_family, language, complexity) key that is currently effective
 * wins; otherwise fall back to the recommend()-derived primary. Never throws
 * — a missing table or a DB error falls straight through to the code default,
 * because a routing table being absent must not break the pipeline.
 *
 * Returns { model, source: "config"|"recommend"|"none", family, candidates }.
 */
export async function resolveStageModel(env, {
  stage, cweFamily = null, language = null, complexity = "single_file",
  budget = false, exclude = [],
} = {}) {
  const plan = stageModelPlan(stage, { complexity, budget, exclude });

  // Try an operator override first.
  try {
    if (env && env.DB) {
      const now = Math.floor(Date.now() / 1000);
      // Most-specific match first: exact (cwe, language) then wildcards.
      const row = await env.DB.prepare(
        `SELECT model_id FROM model_routing_config
          WHERE stage = ?
            AND (cwe_family = ? OR cwe_family = '*' OR cwe_family IS NULL)
            AND (file_language = ? OR file_language = '*' OR file_language IS NULL)
            AND (complexity = ? OR complexity = '*' OR complexity IS NULL)
            AND effective_from <= ?
            AND (effective_to IS NULL OR effective_to > ?)
          ORDER BY
            (cwe_family = ?) DESC,
            (file_language = ?) DESC,
            (complexity = ?) DESC,
            effective_from DESC
          LIMIT 1`
      ).bind(stage, cweFamily, language, complexity, now, now, cweFamily, language, complexity).first();
      if (row && row.model_id && !exclude.includes(row.model_id)) {
        return { model: row.model_id, source: "config", family: plan.family, candidates: plan.models };
      }
    }
  } catch {
    // Fall through to the code default — routing must not break metering.
  }

  return {
    model: plan.primary,
    source: plan.primary ? "recommend" : "none",
    family: plan.family,
    candidates: plan.models,
  };
}
