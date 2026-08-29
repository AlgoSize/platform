// LLM client — refactor suggestions for the algorithm optimizer, and the
// generic chat entrypoint the per-finding fix generator (analyzers/fixgen.js)
// shares so the provider chain exists exactly once.
//
// Provider chain, first configured one wins:
//
//   1. Workers AI binding (env.AI) — Kimi K3 when an AI Gateway is
//      configured, else Kimi K2.6. Keyless: the
//      binding is granted by wrangler.toml's [ai] block, so the deployed
//      Worker needs no external API secret at all — nothing to provision,
//      and nothing for a secret wipe to take out.
//   2. Workers AI REST — for callers OUTSIDE a Worker (the CI entrypoint runs
//      in Node, where no binding exists). Needs CLOUDFLARE_ACCOUNT_ID +
//      CLOUDFLARE_AI_TOKEN (a token scoped to Workers AI — NOT the deploy
//      token, which has no AI permission).
//   3. OpenAI — the original provider, kept for anyone already running with
//      OPENAI_API_KEY set.
//   4. Nothing configured → the caller decides; getRefactorSuggestion falls
//      back to a descriptive stub so the dashboard stays fully functional.
//
// Fetch implementations are injectable (env.OPENAI_FETCH / env.WORKERS_AI_FETCH)
// so tests can mock either upstream without monkey-patching the global.

const ENDPOINT = "https://api.openai.com/v1/chat/completions";
const DEFAULT_MODEL = "gpt-4o-mini";
// Kimi K3 is Moonshot's flagship — 2.8T parameters, a 1M-token context, and
// always-on reasoning — and it is NOT a drop-in replacement for the K2.x
// slugs, for three reasons that each break something if missed:
//
//   1. The slug has NO `@cf/` prefix. Cloudflare lists K3 as
//      `moonshotai/kimi-k3`, a THIRD-PARTY catalog entry, whereas K2.5/K2.6/
//      K2.7 are first-party `@cf/moonshotai/...` models. The prefix is the
//      marker: `@cf/` means Workers AI runs it, `{author}/{model}` means
//      Cloudflare brokers it.
//   2. Third-party models require an AI Gateway and bill through Unified
//      Billing. A binding call without a gateway id does not fall back to
//      anything — it fails.
//   3. The REST leg needs a different URL. First-party models are invoked at
//      /ai/run/<model>; third-party ones go to the OpenAI-compatible
//      /ai/v1/chat/completions with the model named in the BODY. Sending a
//      third-party slug to /ai/run/ 404s.
//
// So the default is conditional rather than a constant: K3 when a gateway is
// configured to carry it, and the proven K2.6 path otherwise. That ordering
// is deliberate — an unconfigured account keeps working exactly as it does
// today instead of silently losing refactor suggestions to a model it cannot
// reach. Override either way with env.WORKERS_AI_MODEL.
const KIMI_K3            = "moonshotai/kimi-k3";
const KIMI_K2_6          = "@cf/moonshotai/kimi-k2.6";
const DEFAULT_WORKERS_AI_MODEL = KIMI_K2_6;

/** A third-party catalog entry is anything without the `@cf/` prefix. */
function isThirdPartyModel(model) {
  return typeof model === "string" && !model.startsWith("@cf/");
}

/**
 * Which model to use, and how to reach it.
 *
 * An explicit env.WORKERS_AI_MODEL always wins — including when it names a
 * third-party model and no gateway is set, because an operator who typed a
 * slug deserves the real error rather than a silent substitution.
 */
function resolveModel(env) {
  const gateway  = (env && env.AI_GATEWAY_ID) || null;
  const explicit = env && env.WORKERS_AI_MODEL;
  const model    = explicit || (gateway ? KIMI_K3 : DEFAULT_WORKERS_AI_MODEL);
  return { model, gateway, thirdParty: isThirdPartyModel(model) };
}
const MAX_TEXT_CHARS = 1500;            // hard ceiling on rendered prose
const TIMEOUT_MS = 15000;
// Kimi (and reasoning models generally) spend part of their token budget on
// a hidden reasoning/thinking pass before the visible completion — the same
// max_tokens cap that comfortably covers a plain chat model's answer can be
// consumed entirely by reasoning, leaving zero tokens for the 100-300 word
// explanation and code block the system prompt actually asks for, which
// surfaces as a silent "Workers AI returned an empty reply". Enforced only
// on the Workers AI leg: a cap is a ceiling, not a target, so raising it is
// harmless for a non-reasoning model (it stops at its own natural end), and
// OpenAI's default model isn't a reasoning model so its budget is untouched.
const WORKERS_AI_MIN_MAX_TOKENS = 4096;

const SYSTEM_PROMPT =
  "You are a senior performance engineer. The user shows you a JavaScript " +
  "function and a measured Big-O complexity. Reply with: " +
  "(a) a 100-300 word explanation of the bottleneck and the refactor approach, " +
  "(b) the rewritten function in a single ```js fenced code block. " +
  "Keep the rewritten function's name and signature identical to the original. " +
  "Do not include any other code blocks or markdown.";

// ---------------------------------------------------------------------------
// Generic chat — the one provider chain
// ---------------------------------------------------------------------------

/**
 * Run one chat exchange through the provider chain.
 *
 * @returns {Promise<{ok:true, provider:string, reply:string}
 *                 | {ok:false, configured:boolean, reason:string}>}
 *   `configured: false` means NO provider had credentials at all — callers
 *   render their "how to turn this on" notice. `configured: true` with
 *   ok:false means a provider was tried and failed; `reason` says how.
 */
export async function llmChat({ system, user, maxTokens = 800, temperature = 0.2 }, env) {
  const messages = [
    { role: "system", content: system },
    { role: "user",   content: user },
  ];
  let configured = false;
  let reason = null;

  const workersAiMaxTokens = Math.max(maxTokens, WORKERS_AI_MIN_MAX_TOKENS);

  // 1. Workers AI binding.
  if (env && env.AI && typeof env.AI.run === "function") {
    configured = true;
    try {
      const { model, gateway, thirdParty } = resolveModel(env);
      const input = { messages, max_tokens: workersAiMaxTokens, temperature };
      // K3 replaced K2.x's `thinking` parameter with `reasoning_effort`.
      // Sent only for third-party (K3) calls: a first-party K2.x model would
      // reject the unknown key.
      if (thirdParty && env.WORKERS_AI_REASONING_EFFORT) {
        input.reasoning_effort = env.WORKERS_AI_REASONING_EFFORT;
      }
      // Third-party models are only reachable THROUGH a gateway. Passing the
      // option unconditionally would be wrong for the @cf/ path, where a
      // stale gateway id turns a working call into a failing one.
      const opts = gateway && thirdParty ? { gateway: { id: gateway } } : undefined;
      const out = opts
        ? await env.AI.run(model, input, opts)
        : await env.AI.run(model, input);
      const reply = extractWorkersAiReply(out);
      if (reply.trim()) return { ok: true, provider: "workers-ai", reply };
      reason = "Workers AI returned an empty reply";
    } catch (err) {
      reason = `Workers AI failed: ${err && err.message || err}`;
    }
  }

  // 2. Workers AI REST (Node callers — no binding available).
  if (env && env.CLOUDFLARE_ACCOUNT_ID && env.CLOUDFLARE_AI_TOKEN) {
    configured = true;
    const fetchImpl = env.WORKERS_AI_FETCH || (typeof fetch !== "undefined" ? fetch : null);
    if (!fetchImpl) {
      reason = "no fetch implementation available";
    } else {
      const { model, thirdParty } = resolveModel(env);
      const base = `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}`;
      // Two different endpoints, and the wrong one 404s. First-party models
      // are invoked by name in the PATH; third-party ones go to the
      // OpenAI-compatible route with the model named in the BODY.
      const url  = thirdParty ? `${base}/ai/v1/chat/completions` : `${base}/ai/run/${model}`;
      const body = { messages, max_tokens: workersAiMaxTokens, temperature };
      if (thirdParty) body.model = model;
      if (thirdParty && env.WORKERS_AI_REASONING_EFFORT) {
        body.reasoning_effort = env.WORKERS_AI_REASONING_EFFORT;
      }
      const r = await timedJsonFetch(fetchImpl, url, {
        headers: { authorization: `Bearer ${env.CLOUDFLARE_AI_TOKEN}` },
        body,
      });
      if (r.ok) {
        // The two endpoints nest their payload differently: /ai/run wraps the
        // model output in `result`, while the chat-completions route returns
        // it at the top level. Reading only `.result` against K3 would find
        // undefined and report an empty reply for a call that worked.
        const reply = extractWorkersAiReply(thirdParty ? r.json : (r.json && r.json.result));
        if (reply.trim()) return { ok: true, provider: "workers-ai", reply };
        reason = "Workers AI returned an empty reply";
      } else {
        reason = `Workers AI ${r.reason}`;
      }
    }
  }

  // 3. OpenAI.
  if (env && env.OPENAI_API_KEY) {
    configured = true;
    const fetchImpl = env.OPENAI_FETCH || (typeof fetch !== "undefined" ? fetch : null);
    if (!fetchImpl) {
      reason = "no fetch implementation available";
    } else {
      const r = await timedJsonFetch(fetchImpl, ENDPOINT, {
        headers: { authorization: `Bearer ${env.OPENAI_API_KEY}` },
        body: {
          model: env.OPENAI_MODEL || DEFAULT_MODEL,
          temperature, max_tokens: maxTokens, messages,
        },
      });
      if (r.ok) {
        const reply = r.json && r.json.choices && r.json.choices[0] && r.json.choices[0].message
          ? String(r.json.choices[0].message.content || "") : "";
        if (reply.trim()) return { ok: true, provider: "openai", reply };
        reason = "OpenAI returned an empty reply";
      } else {
        reason = `OpenAI ${r.reason}`;
      }
    }
  }

  return { ok: false, configured, reason: reason || "no LLM provider configured" };
}

/**
 * Workers AI's response shape depends on the model, not just the endpoint.
 * Traditional text-generation models (e.g. Llama) return `{ response }`.
 * Chat-completion-style models — Kimi K2 among them — return the
 * OpenAI-compatible `{ choices: [{ message: { content } }] }` shape instead.
 * Reading only `.response` against one of those returns an always-empty
 * string, which this function previously did — the caller then reported
 * "Workers AI returned an empty reply" no matter what the model actually
 * said. Both shapes are checked; `.response` first since it's the more
 * common/traditional case, matching every existing mock and test fixture.
 *
 * Exported so tests can pin both shapes directly, not just observe them
 * through a full llmChat() round trip.
 */
export function extractWorkersAiReply(result) {
  if (!result) return "";
  if (typeof result.response === "string") return result.response;
  const choice = Array.isArray(result.choices) ? result.choices[0] : null;
  const content = choice && choice.message && choice.message.content;
  return typeof content === "string" ? content : "";
}

/** POST JSON with a timeout; normalise every failure to { ok:false, reason }. */
async function timedJsonFetch(fetchImpl, url, { headers, body }) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), TIMEOUT_MS);
  let res;
  try {
    res = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal: ac.signal,
    });
  } catch (err) {
    clearTimeout(t);
    return { ok: false, reason: `request failed: ${err && err.message || err}` };
  }
  clearTimeout(t);
  if (!res.ok) return { ok: false, reason: `HTTP ${res.status}` };
  try {
    return { ok: true, json: await res.json() };
  } catch {
    return { ok: false, reason: "returned non-JSON" };
  }
}

// ---------------------------------------------------------------------------
// Refactor suggestions (algorithm optimizer)
// ---------------------------------------------------------------------------

/**
 * @param {object} args
 * @param {string} args.code      User's original function source.
 * @param {string} args.bigO      Inferred Big-O label (e.g. "O(n²)").
 * @param {number} args.ms        Measured wall-clock time on the sample input.
 * @param {object} env            Worker env — see the provider chain above.
 * @returns {Promise<{provider:string, text:string, code:string|null, language:string}>}
 */
export async function getRefactorSuggestion({ code, bigO, ms }, env) {
  const userPrompt =
    `Detected complexity: ${bigO}.\n` +
    `Measured time on sample input: ${formatMs(ms)}.\n\n` +
    "Original function:\n```js\n" + code + "\n```";

  const r = await llmChat({ system: SYSTEM_PROMPT, user: userPrompt }, env || {});
  if (r.ok) return parseLlmReply(r.reply, r.provider);
  // Unconfigured → the generic "how to turn this on" stub; a configured
  // provider that failed → the stub carries the reason (tests pin e.g. the
  // HTTP status surviving into the text).
  return r.configured ? stubSuggestion(bigO, r.reason) : stubSuggestion(bigO);
}

/**
 * Extract the first ```js / ```javascript code block and the surrounding prose.
 * Exported so tests can verify parser behaviour deterministically.
 *
 * `provider` defaults to "openai" for back-compat with existing callers and
 * tests; the Workers AI paths pass their own tag.
 */
export function parseLlmReply(text, provider = "openai") {
  const blockRe = /```(?:js|javascript)?\s*\n([\s\S]*?)```/i;
  const m = blockRe.exec(text);
  const codeBlock = m ? m[1].trim() : null;
  // Strip ALL fenced blocks from the prose so we never duplicate code in the
  // explanation, and clamp to the rendering ceiling.
  let prose = text.replace(/```[\s\S]*?```/g, "").trim();
  if (prose.length > MAX_TEXT_CHARS) {
    prose = prose.slice(0, MAX_TEXT_CHARS) + "…";
  }
  return {
    provider,
    text: prose,
    code: codeBlock,
    language: "javascript",
  };
}

function stubSuggestion(bigO, why) {
  // Name the switches that actually turn suggestions on. This code path is
  // reached precisely when no provider is configured (or the configured one
  // failed), so telling the user to deploy to Cloudflare — which changes
  // nothing on its own — sends them down the wrong path.
  const baseText = bigO === "unknown"
    ? "We could not measure the function's complexity, so AI refactor suggestions are unavailable for this run."
    : `Detected complexity: ${bigO}. AI-powered refactor suggestions turn on once the Workers AI binding is deployed ` +
      "(the [ai] block in wrangler.toml) or OPENAI_API_KEY is set on the Worker " +
      "(`wrangler secret put OPENAI_API_KEY`). " +
      "Complexity analysis, timing, and Big-O detection are fully functional without either.";
  return {
    provider: "stub",
    text: why ? `${baseText} (${why})` : baseText,
    code: null,
    language: "javascript",
  };
}

function formatMs(ms) {
  if (typeof ms !== "number" || !isFinite(ms)) return "unknown";
  if (ms < 1) return ms.toFixed(3) + " ms";
  if (ms < 100) return ms.toFixed(2) + " ms";
  return Math.round(ms) + " ms";
}
