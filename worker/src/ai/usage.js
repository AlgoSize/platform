// AI usage recording — turns an llmChat result into a priced ai_usage row.
//
// `buildUsageRecord` is PURE (no IO): a call result + context in, a fully
// priced row out. It is the single place that joins the raw usage llmChat now
// returns (see extractUsage in analyzers/llm.js) to the pricing engine, so the
// number the meter stores and the number a test asserts come from one function.
//
// `recordAiUsage` is the thin, BEST-EFFORT persistence wrapper: it never throws
// into the caller's hot path. A metering write failing must not fail the fix or
// scan it was measuring — the same posture the audit log takes.

import { costOf } from "./pricing.js";

// The ai_usage columns, in bind order. The single source of truth for the
// INSERT below AND for the order buildUsageRecord emits — a test asserts all
// three agree, so a column added in one place without the others fails loudly.
export const AI_USAGE_COLUMNS = Object.freeze([
  "org_id", "user_id", "repository_id", "feature_name", "provider", "model", "request_type",
  "input_tokens", "output_tokens", "cached_input_tokens", "units",
  "neurons_consumed", "neurons_source", "unit_cost", "total_cost", "currency", "price_verified",
  "latency_ms", "status", "error_code", "fallback_provider", "fallback_model",
  "scan_id", "fix_task_id", "request_metadata", "created_at",
]);

// A fully literal prepared statement — no interpolation, no concatenation with
// a variable. Values are bound in AI_USAGE_COLUMNS order.
const AI_USAGE_INSERT_SQL =
  "INSERT INTO ai_usage " +
  "(org_id, user_id, repository_id, feature_name, provider, model, request_type, " +
  "input_tokens, output_tokens, cached_input_tokens, units, " +
  "neurons_consumed, neurons_source, unit_cost, total_cost, currency, price_verified, " +
  "latency_ms, status, error_code, fallback_provider, fallback_model, " +
  "scan_id, fix_task_id, request_metadata, created_at) " +
  "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)";

/**
 * Build a priced ai_usage row from a call.
 *
 * `result` is an llmChat result: { ok, provider, model, usage, ... }.
 * `ctx` supplies attribution: { orgId, userId, repositoryId, feature,
 *   requestType, scanId, fixTaskId, latencyMs, fallbackProvider, fallbackModel,
 *   status, errorCode, metadata }.
 *
 * Cost is computed from the model + usage via the pricing engine. An unpriced
 * model yields null cost/neurons — never zero (see costOf).
 */
export function buildUsageRecord(result, ctx = {}, now = Date.now()) {
  const usage = (result && result.usage) || {};
  const model = (result && result.model) || ctx.model || null;
  const priced = model ? costOf(model, usage, now) : null;

  const status = ctx.status || (result && result.ok === false ? "error" : "ok");

  return {
    org_id: ctx.orgId || null,
    user_id: ctx.userId ?? null,
    repository_id: ctx.repositoryId ?? null,
    feature_name: ctx.feature || "unknown",
    provider: (result && result.provider) || ctx.provider || null,
    model,
    request_type: ctx.requestType || "chat",

    input_tokens: numOrNull(usage.inputTokens),
    output_tokens: numOrNull(usage.outputTokens),
    cached_input_tokens: numOrNull(usage.cachedInputTokens),
    units: numOrNull(usage.units),

    neurons_consumed: priced ? priced.neurons : (numOrNull(usage.reportedNeurons)),
    neurons_source: priced ? priced.neuronsSource : (usage.reportedNeurons != null ? "reported" : "none"),
    unit_cost: priced ? priced.unitCostPer1000Neurons : null,
    total_cost: priced ? priced.totalCostUsd : null,   // null (not 0) when unpriced
    currency: priced ? priced.currency : "USD",
    price_verified: priced && priced.verified ? 1 : 0,

    latency_ms: numOrNull(ctx.latencyMs),
    status,
    error_code: ctx.errorCode ?? null,
    fallback_provider: ctx.fallbackProvider ?? null,
    fallback_model: ctx.fallbackModel ?? null,

    scan_id: ctx.scanId ?? null,
    fix_task_id: ctx.fixTaskId ?? null,
    // Correlation keys ONLY — never prompt/response content.
    request_metadata: ctx.metadata ? JSON.stringify(stripContent(ctx.metadata)) : null,

    created_at: now,
  };
}

/**
 * Persist a usage record, best-effort. Never throws into the caller.
 *
 * No DB, no org → silently skipped (Node/CI callers, or a call with no tenant).
 * A write error is swallowed: metering must not break the thing it measures.
 */
export async function recordAiUsage(env, result, ctx = {}) {
  try {
    if (!env || !env.DB || !ctx.orgId) return { recorded: false, reason: "no_db_or_org" };
    const r = buildUsageRecord(result, ctx);
    // Static INSERT, not built by interpolation. The values are bound; the
    // column list is a fixed literal. AI_USAGE_COLUMNS is the single source of
    // bind order, and a test asserts it matches both this statement and the
    // keys buildUsageRecord emits, so the two can never drift.
    await env.DB.prepare(AI_USAGE_INSERT_SQL)
      .bind(...AI_USAGE_COLUMNS.map((c) => r[c]))
      .run();
    return { recorded: true };
  } catch (err) {
    // Deliberately swallowed. A metering failure is not the caller's problem.
    return { recorded: false, reason: String(err && err.message || err).slice(0, 120) };
  }
}

function numOrNull(v) { return typeof v === "number" && Number.isFinite(v) ? v : null; }

// Guard against a caller accidentally passing prompt/response text in metadata.
// Only a small allowlist of correlation keys is ever persisted.
const META_ALLOW = new Set(["environment", "route", "attempt", "gateway", "reasoningEffort"]);
function stripContent(meta) {
  const out = {};
  for (const [k, v] of Object.entries(meta || {})) {
    if (META_ALLOW.has(k) && (typeof v === "string" || typeof v === "number" || typeof v === "boolean")) {
      out[k] = v;
    }
  }
  return out;
}
