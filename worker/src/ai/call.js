// Per-stage model caller — call ONE named model, meter the call.
//
// The multi-model pipeline needs to call a SPECIFIC model at each stage
// (triage on a cheap model, validation on a reasoner, verification on a model
// that differs from the fixer), whereas the shared llmChat resolves a single
// env-configured model. Rather than fork the provider chain — the codebase's
// standing "one provider chain" rule — this rides the existing, tested
// WORKERS_AI_MODEL override: resolveModel() already honours an explicit slug,
// so cloning env with the routed model reaches exactly that model with no
// change to llmChat or the provider adapters.
//
// Every call is metered through recordAiUsage (best-effort, never throws), so
// each pipeline stage lands in ai_usage with its own feature_name and carries
// the platform margin — the pipeline's cost funnel is measured the same way
// everything else is.

import { llmChat } from "../analyzers/llm.js";
import { recordAiUsage } from "./usage.js";

/**
 * Call a specific Workers AI model and meter the call.
 *
 * `spec`: { model, system, user, maxTokens, temperature }
 * `ctx`:  metering attribution — { orgId, userId, repositoryId, feature,
 *          scanId, fixTaskId, marginRate, marginVersion, isInternal,
 *          metadata } (same shape recordAiUsage takes).
 *
 * Returns { ok, reply, model, provider, usage, reason } — ok:false carries a
 * reason a UI can show, never a thrown error into the pipeline.
 */
export async function callModel(env, spec, ctx = {}) {
  const { model, system, user, maxTokens = 700, temperature = 0.1 } = spec || {};
  if (!model) return { ok: false, reason: "no_model_routed", model: null };

  // Clone env with the routed model as the explicit override. First-party
  // @cf/ models need no gateway, so the binding leg calls env.AI.run(model,…)
  // directly; a third-party slug would still be routed through the gateway by
  // resolveModel, exactly as a normal call is.
  const scoped = { ...env, WORKERS_AI_MODEL: model };

  const started = Date.now();
  let r;
  try {
    r = await llmChat({ system, user, maxTokens, temperature }, scoped);
  } catch (err) {
    return { ok: false, reason: `call_failed: ${err && err.message || err}`, model };
  }
  const latencyMs = Date.now() - started;

  // Meter every call that actually reached a provider — success or a
  // provider-level failure that still consumed tokens. `configured:false`
  // (no provider at all) is not a billable event.
  if (r && (r.ok || r.configured)) {
    await recordAiUsage(env, {
      ok: Boolean(r.ok),
      provider: r.provider || "workers-ai",
      // The model we ASKED for; llmChat echoes the served model back on ok.
      model: (r.ok && r.model) || model,
      usage: (r.ok && r.usage) || {},
    }, {
      ...ctx,
      model: (r.ok && r.model) || model,
      latencyMs,
      status: r.ok ? "ok" : "error",
      errorCode: r.ok ? null : "provider_failed",
    });
  }

  if (!r || !r.ok) {
    return { ok: false, reason: (r && r.reason) || "no_reply", model, configured: r && r.configured };
  }
  return { ok: true, reply: r.reply, model: r.model || model, provider: r.provider, usage: r.usage || {} };
}
