// LLM refactor-suggestion client.
//
// Calls OpenAI Chat Completions with a constrained prompt; parses the first
// fenced JS code block out of the response. Falls back to a deterministic
// stub when OPENAI_API_KEY is not configured (so the dashboard is functional
// without a key — the user just sees a "set OPENAI_API_KEY to enable AI
// suggestions" notice instead of a 500).
//
// Cloudflare Workers can't use Replit's credential proxy at runtime, so we
// take the OpenAI key from a Worker secret (`wrangler secret put OPENAI_API_KEY`)
// or from `worker/.dev.vars` for local dev. See DEPLOY.md.
//
// The fetch implementation is injectable via `env.OPENAI_FETCH` so tests can
// mock the upstream without monkey-patching the global.

const ENDPOINT = "https://api.openai.com/v1/chat/completions";
const DEFAULT_MODEL = "gpt-4o-mini";
const MAX_TEXT_CHARS = 1500;            // hard ceiling on rendered prose
const TIMEOUT_MS = 15000;

const SYSTEM_PROMPT =
  "You are a senior performance engineer. The user shows you a JavaScript " +
  "function and a measured Big-O complexity. Reply with: " +
  "(a) a 100-300 word explanation of the bottleneck and the refactor approach, " +
  "(b) the rewritten function in a single ```js fenced code block. " +
  "Keep the rewritten function's name and signature identical to the original. " +
  "Do not include any other code blocks or markdown.";

/**
 * @param {object} args
 * @param {string} args.code      User's original function source.
 * @param {string} args.bigO      Inferred Big-O label (e.g. "O(n²)").
 * @param {number} args.ms        Measured wall-clock time on the sample input.
 * @param {object} env            Worker env — reads OPENAI_API_KEY, OPENAI_MODEL,
 *                                and optional OPENAI_FETCH for tests.
 * @returns {Promise<{provider:string, text:string, code:string|null, language:string}>}
 */
export async function getRefactorSuggestion({ code, bigO, ms }, env) {
  if (!env || !env.OPENAI_API_KEY) {
    return stubSuggestion(bigO);
  }

  const fetchImpl = env.OPENAI_FETCH || (typeof fetch !== "undefined" ? fetch : null);
  if (!fetchImpl) {
    return stubSuggestion(bigO, "no fetch implementation available");
  }

  const userPrompt =
    `Detected complexity: ${bigO}.\n` +
    `Measured time on sample input: ${formatMs(ms)}.\n\n` +
    "Original function:\n```js\n" + code + "\n```";

  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), TIMEOUT_MS);
  let res;
  try {
    res = await fetchImpl(ENDPOINT, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "authorization": `Bearer ${env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: env.OPENAI_MODEL || DEFAULT_MODEL,
        temperature: 0.2,
        max_tokens: 800,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user",   content: userPrompt },
        ],
      }),
      signal: ac.signal,
    });
  } catch (err) {
    clearTimeout(t);
    return stubSuggestion(bigO, `OpenAI request failed: ${err && err.message || err}`);
  }
  clearTimeout(t);

  if (!res.ok) {
    return stubSuggestion(bigO, `OpenAI HTTP ${res.status}`);
  }

  let json;
  try { json = await res.json(); }
  catch { return stubSuggestion(bigO, "OpenAI returned non-JSON"); }

  const reply = json && json.choices && json.choices[0] && json.choices[0].message
    ? String(json.choices[0].message.content || "")
    : "";

  return parseLlmReply(reply);
}

/**
 * Extract the first ```js / ```javascript code block and the surrounding prose.
 * Exported so tests can verify parser behaviour deterministically.
 */
export function parseLlmReply(text) {
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
    provider: "openai",
    text: prose,
    code: codeBlock,
    language: "javascript",
  };
}

function stubSuggestion(bigO, why) {
  const baseText = bigO === "unknown"
    ? "We could not measure the function's complexity, so AI refactor suggestions are unavailable for this run."
    : `Detected complexity: ${bigO}. AI-written refactor suggestions are disabled because OPENAI_API_KEY is not configured. ` +
      "Set the OPENAI_API_KEY secret on the Worker (see DEPLOY.md) to enable detailed rewrite suggestions for each run.";
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
