// Support layer — semantic retrieval of prior fixes (runs PARALLEL to the
// main pipeline, never in its critical path).
//
// When a fix is being generated for a finding, the single best piece of extra
// context is how a SIMILAR finding was fixed before in the same codebase. This
// module embeds findings/functions with bge-m3, stores them in a Cloudflare
// Vectorize index, and at fix time retrieves the closest prior fixes and
// reranks them with bge-reranker-base, so Stage 4 can be handed real prior art
// instead of guessing from scratch.
//
// BEST-EFFORT, ALWAYS. Vectorize is a binding an operator must provision
// (env.VECTORIZE) — the Worker sandbox cannot create it. Every function here
// degrades to { available: false } when the binding is absent or a call
// fails, and the pipeline treats retrieval as an ENRICHMENT: a fix generated
// without prior art is a normal fix, not a failure. Retrieval never throws
// into the pipeline and never blocks a fix on a missing index.
//
// The embedding model is chosen through the recommendation engine
// (recommend("embeddings") / ("reranking")) like every other stage, so the
// slug is never hardcoded here.

import { resolveStageModel } from "./routing.js";

/** Is a Vectorize index actually available on this deployment? */
export function retrievalAvailable(env) {
  return Boolean(env && env.VECTORIZE && typeof env.VECTORIZE.query === "function");
}

/**
 * Embed a batch of texts with the routed embedding model. Best-effort.
 * Returns { available, model, vectors } — vectors is null when embeddings are
 * not reachable (no binding, or the model call failed).
 */
export async function embedTexts(env, texts, ctx = {}) {
  const items = (texts || []).filter((t) => typeof t === "string" && t.length);
  if (!items.length) return { available: false, model: null, vectors: null, reason: "no_input" };
  const routed = await resolveStageModel(env, { stage: "embed" });
  if (!routed.model) return { available: false, model: null, vectors: null, reason: "no_embedding_model" };
  // Embeddings go through the Workers AI binding directly (not the chat path).
  if (!(env && env.AI && typeof env.AI.run === "function")) {
    return { available: false, model: routed.model, vectors: null, reason: "no_ai_binding" };
  }
  try {
    const out = await env.AI.run(routed.model, { text: items });
    const vectors = extractEmbeddings(out);
    return { available: Boolean(vectors), model: routed.model, vectors, reason: vectors ? null : "no_vectors_in_reply" };
  } catch (err) {
    return { available: false, model: routed.model, vectors: null, reason: `embed_failed: ${err && err.message || err}` };
  }
}

/**
 * Index one prior fix so future findings can retrieve it. Best-effort.
 *
 * Stores ONLY a source-free descriptor as metadata — ruleId, category,
 * fingerprint, and content HASHES — never file content, matching the
 * fix-orchestration rule that the durable record copies no source. The vector
 * is derived from the finding's descriptor text, not from raw source lines.
 */
export async function indexPriorFix(env, { finding, fixSummary, descriptorText }, ctx = {}) {
  if (!retrievalAvailable(env)) return { available: false, reason: "no_vectorize" };
  const text = descriptorText || descriptorFor(finding, fixSummary);
  const emb = await embedTexts(env, [text], ctx);
  if (!emb.available || !emb.vectors || !emb.vectors[0]) return { available: false, reason: emb.reason || "embed_unavailable" };
  try {
    await env.VECTORIZE.insert([{
      id: `fix_${(finding && finding.fingerprint) || crypto.randomUUID()}`,
      values: emb.vectors[0],
      metadata: {
        ruleId: (finding && finding.ruleId) || null,
        category: (finding && finding.category) || null,
        fingerprint: (finding && finding.fingerprint) || null,
        summary: typeof fixSummary === "string" ? fixSummary.slice(0, 300) : null,
      },
    }]);
    return { available: true, indexed: true };
  } catch (err) {
    return { available: false, reason: `index_failed: ${err && err.message || err}` };
  }
}

/**
 * Retrieve the top-k prior fixes similar to a finding, reranked. Best-effort.
 * Returns { available, matches } — matches is [] when retrieval is off, so a
 * caller can always spread it into the fix context unconditionally.
 */
export async function retrieveSimilarFixes(env, finding, k = 5, ctx = {}) {
  if (!retrievalAvailable(env)) return { available: false, matches: [] };
  const emb = await embedTexts(env, [descriptorFor(finding)], ctx);
  if (!emb.available || !emb.vectors || !emb.vectors[0]) return { available: false, matches: [] };
  let hits;
  try {
    const res = await env.VECTORIZE.query(emb.vectors[0], { topK: Math.max(1, k), returnMetadata: true });
    hits = (res && res.matches) || [];
  } catch {
    return { available: false, matches: [] };
  }
  // Rerank is itself best-effort; if it is not reachable, fall back to the
  // vector-similarity order Vectorize already returned.
  const reranked = await rerank(env, finding, hits, ctx);
  return { available: true, matches: reranked };
}

async function rerank(env, finding, hits, ctx) {
  if (!hits.length) return [];
  const routed = await resolveStageModel(env, { stage: "rerank" });
  if (!routed.model || !(env && env.AI && typeof env.AI.run === "function")) return hits;
  try {
    const out = await env.AI.run(routed.model, {
      query: descriptorFor(finding),
      contexts: hits.map((h) => ({ text: (h.metadata && h.metadata.summary) || (h.metadata && h.metadata.ruleId) || "" })),
    });
    const ranking = out && (out.response || out.result);
    if (Array.isArray(ranking)) {
      return ranking
        .map((r) => hits[r.id != null ? r.id : r.index])
        .filter(Boolean);
    }
  } catch {
    // fall through to the similarity order
  }
  return hits;
}

/**
 * The source-free descriptor text a finding is embedded/queried by. Carries
 * the finding's shape (rule, category, title, taint) but NOT the customer's
 * source lines — embeddings are over the finding's identity, not its code.
 */
export function descriptorFor(finding, fixSummary) {
  const f = finding || {};
  const cwe = Array.isArray(f.cwe) ? f.cwe.join(" ") : (f.cwe || "");
  return [
    f.ruleId || "", f.category || "", f.title || "", cwe,
    f.evidence && f.evidence.source ? `taint ${f.evidence.source} ${f.evidence.sink || ""}` : "",
    typeof fixSummary === "string" ? fixSummary : "",
  ].filter(Boolean).join(" · ").slice(0, 1000);
}

function extractEmbeddings(out) {
  if (!out) return null;
  // Workers AI embedding shapes: { data: [[...]] } or { data: [{embedding}] }
  // or { result: { data } }.
  const data = out.data || (out.result && out.result.data);
  if (Array.isArray(data) && data.length) {
    if (Array.isArray(data[0])) return data;
    if (data[0] && Array.isArray(data[0].embedding)) return data.map((d) => d.embedding);
  }
  return null;
}
