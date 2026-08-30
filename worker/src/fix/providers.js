// Agent-provider layer — normalized FixTask in, normalized reply out.
//
// ---------------------------------------------------------------------------
// THE BOUNDARY
// ---------------------------------------------------------------------------
//
// An adapter knows how to reach ONE vendor and how to ask it for structured
// output. It does not know what a finding is worth, whether a proposal is
// safe, or what happens after it returns — those live in orchestrate.js and
// validate.js. The test for whether logic belongs here: would it change if
// the platform swapped every rule pack tomorrow? If no, it is transport, and
// it belongs here; if yes, it is business logic, and it does not.
//
// Providers:
//
//   kimi     the Workers AI leg of the existing llmChat chain (Kimi K3 via
//            AI Gateway, else Kimi K2.6) — keyless on a deployed Worker
//   claude   the Anthropic API directly (env.ANTHROPIC_API_KEY). This is
//            "Claude" as a callable provider; Claude CODE as an interactive
//            agent connects from the OTHER side, as an MCP client of the
//            algosize_* fix tools, where it applies patches to its own local
//            checkout — a Worker has no checkout for it to apply anything to.
//   openai   the OpenAI leg of the existing chain, kept for parity
//
// Selection reuses llmChat rather than duplicating its transport code: llmChat
// tries "first configured leg wins", so an adapter pins its vendor by handing
// llmChat an env containing only that vendor's credentials. That is the whole
// trick, and it means retries, timeouts, gateway routing and reply extraction
// exist exactly once (llm.js) — the same single-chain argument fixgen.js makes.
//
// ---------------------------------------------------------------------------
// THE OUTPUT CONTRACT
// ---------------------------------------------------------------------------
//
// Every adapter asks its model for one JSON object:
//
//   { "explanation": string, "files": [{"path": string, "content": string}],
//     "riskNotes": string }
//
// Full file content, never a diff — a model-authored diff mis-anchors
// silently; a full file either is or is not what the model meant, and the
// platform computes its own diff from ground truth (fix/diff.js). A reply
// that does not parse to that shape is a NORMAL outcome, not an exception:
// it returns { ok:false, error:"invalid_response" } and the caller decides
// whether to retry with constraints.

import { llmChat } from "../analyzers/llm.js";
import { SCHEMAS, MAX_CONSTRAINTS } from "./schemas.js";

const ANTHROPIC_ENDPOINT = "https://api.anthropic.com/v1/messages";
const DEFAULT_ANTHROPIC_MODEL = "claude-sonnet-5";
const ANTHROPIC_TIMEOUT_MS = 30000;
const FIX_MAX_TOKENS = 4096;

// ---------------------------------------------------------------------------
// Prompt construction — shared by every adapter
// ---------------------------------------------------------------------------

const FIX_SYSTEM =
  "You are a senior application security engineer producing a MINIMAL fix for " +
  "one static-analysis finding. Rules: " +
  "(1) Change only what the finding requires; preserve formatting, names and " +
  "behaviour everywhere else. " +
  "(2) Return the COMPLETE corrected content of each file you change. " +
  "(3) Only touch the files provided. " +
  "(4) Reply with ONE JSON object and nothing else — no markdown fences, no " +
  "prose outside it: " +
  '{"explanation": "...", "files": [{"path": "...", "content": "..."}], ' +
  '"riskNotes": "..."}. ' +
  "`explanation` says what you changed and why it removes the vulnerability " +
  "(under 200 words). `riskNotes` names anything a reviewer should verify by " +
  "hand. Newlines in `content` must be escaped as \\n per JSON.";

function taskToUserPrompt(task, constraints = []) {
  const f = task.finding;
  const lines = [
    `Finding: ${f.title || f.ruleId}`,
    `Rule: ${f.ruleId}`,
    `Severity: ${f.severity || "unknown"} (confidence: ${f.confidence || "unknown"})`,
    f.cwe && f.cwe.length ? `CWE: ${f.cwe.join(", ")}` : null,
    f.owasp && f.owasp.length ? `OWASP: ${f.owasp.join(", ")}` : null,
    `Location: ${f.path}:${f.line}`,
    f.snippet ? `Flagged line: ${f.snippet}` : null,
    f.evidence && f.evidence.source ? `Taint source: ${f.evidence.source} → sink: ${f.evidence.sink || "?"}` : null,
    task.context && task.context.language ? `Language: ${task.context.language}` : null,
    task.context && task.context.frameworks && task.context.frameworks.length
      ? `Frameworks: ${task.context.frameworks.join(", ")}` : null,
    task.context && task.context.remediation ? `Remediation guidance: ${task.context.remediation}` : null,
    "",
    "Acceptance criteria:",
    "- the flagged pattern must be gone from the fixed code",
    "- no new vulnerability may be introduced",
    "- the file must remain syntactically valid",
  ];
  for (const c of (constraints || []).slice(0, MAX_CONSTRAINTS)) {
    lines.push(`- additional constraint: ${String(c).slice(0, 300)}`);
  }
  lines.push("");
  for (const file of task.files) {
    lines.push(`File ${file.path}:`);
    lines.push("```");
    lines.push(file.content);
    lines.push("```");
  }
  return lines.filter((l) => l !== null).join("\n");
}

/**
 * Pull the contract JSON out of a model reply.
 *
 * Models fence JSON despite instructions often enough that refusing fenced
 * replies would fail real fixes over formatting; models emit JSON with prose
 * around it too. So: strip fences, then parse the outermost {...} span.
 * Anything beyond that is genuinely unparseable and reported as such.
 */
export function parseFixReply(text) {
  if (typeof text !== "string" || !text.trim()) {
    return { ok: false, error: "invalid_response", message: "empty reply" };
  }
  let t = text.replace(/```(?:json)?/g, "");
  const start = t.indexOf("{");
  const end = t.lastIndexOf("}");
  if (start === -1 || end <= start) {
    return { ok: false, error: "invalid_response", message: "no JSON object in reply" };
  }
  try {
    const obj = JSON.parse(t.slice(start, end + 1));
    return { ok: true, value: obj };
  } catch (err) {
    return { ok: false, error: "invalid_response", message: `reply is not valid JSON: ${err.message}` };
  }
}

// ---------------------------------------------------------------------------
// Transports
// ---------------------------------------------------------------------------

/** llmChat with only the named vendor's credentials visible to the chain. */
async function chatVia(vendor, { system, user }, env) {
  const e = env || {};
  const scoped =
    vendor === "kimi" ? {
      AI: e.AI, AI_GATEWAY_ID: e.AI_GATEWAY_ID, WORKERS_AI_MODEL: e.WORKERS_AI_MODEL,
      CLOUDFLARE_ACCOUNT_ID: e.CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_AI_TOKEN: e.CLOUDFLARE_AI_TOKEN,
      WORKERS_AI_FETCH: e.WORKERS_AI_FETCH,
    } :
    vendor === "openai" ? {
      OPENAI_API_KEY: e.OPENAI_API_KEY, OPENAI_MODEL: e.OPENAI_MODEL, OPENAI_FETCH: e.OPENAI_FETCH,
    } : null;
  if (!scoped) return { ok: false, configured: false, reason: `unknown chat vendor ${vendor}` };
  return llmChat({ system, user, maxTokens: FIX_MAX_TOKENS, temperature: 0.1 }, scoped);
}

async function chatAnthropic({ system, user }, env) {
  const e = env || {};
  if (!e.ANTHROPIC_API_KEY) {
    return { ok: false, configured: false, reason: "ANTHROPIC_API_KEY not set" };
  }
  const fetchImpl = e.ANTHROPIC_FETCH || fetch;
  const model = e.ANTHROPIC_MODEL || DEFAULT_ANTHROPIC_MODEL;
  const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), ANTHROPIC_TIMEOUT_MS) : null;
  try {
    const res = await fetchImpl(ANTHROPIC_ENDPOINT, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": e.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model,
        max_tokens: FIX_MAX_TOKENS,
        system,
        messages: [{ role: "user", content: user }],
      }),
      signal: controller ? controller.signal : undefined,
    });
    if (!res.ok) {
      return { ok: false, configured: true, reason: `Anthropic API ${res.status}` };
    }
    const body = await res.json();
    const reply = Array.isArray(body.content)
      ? body.content.filter((b) => b && b.type === "text").map((b) => b.text).join("")
      : "";
    if (!reply.trim()) return { ok: false, configured: true, reason: "Anthropic returned an empty reply" };
    return { ok: true, provider: "claude", model: body.model || model, reply };
  } catch (err) {
    return { ok: false, configured: true, reason: `Anthropic request failed: ${err.message}` };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// The provider registry
// ---------------------------------------------------------------------------

/**
 * Every provider implements the same five calls. The last three are prompt
 * reframings of the first two rather than new machinery — deliberately, so a
 * new vendor is one transport function plus this table, not five.
 */
function makeProvider(id, chat) {
  return Object.freeze({
    id,

    /** FixTask -> raw contract object (schemas.toFixProposal normalizes it). */
    async createFixProposal(task, env, { constraints = [] } = {}) {
      const r = await chat({ system: FIX_SYSTEM, user: taskToUserPrompt(task, constraints) }, env);
      if (!r.ok) return { ok: false, configured: r.configured !== false, error: r.configured === false ? "provider_not_configured" : "provider_failed", message: r.reason };
      const parsed = parseFixReply(r.reply);
      if (!parsed.ok) return { ok: false, configured: true, error: parsed.error, message: parsed.message, rawReplyChars: r.reply.length };
      return { ok: true, raw: parsed.value, provider: id, model: r.model || null };
    },

    /** Same task, previous failure reasons folded in as hard constraints. */
    async retryFixWithConstraints(task, env, constraints) {
      return this.createFixProposal(task, env, { constraints });
    },

    /** Plain-language walkthrough of a task or proposal, for the review UI. */
    async explainFix(taskOrProposal, env) {
      const subject = taskOrProposal.schema === SCHEMAS.FIX_PROPOSAL
        ? `A proposed fix:\n${taskOrProposal.explanation}\n\nChanged files: ${taskOrProposal.files.map((f) => f.path).join(", ")}`
        : taskToUserPrompt(taskOrProposal);
      const r = await chat({
        system: "You are a security engineer explaining one finding and its fix to a developer who has not seen it before. 150 words maximum. No code blocks.",
        user: subject,
      }, env);
      if (!r.ok) return { ok: false, error: r.configured === false ? "provider_not_configured" : "provider_failed", message: r.reason };
      return { ok: true, text: r.reply.slice(0, 2000), provider: id };
    },

    /** What could go wrong if this proposal ships — for the human gate. */
    async summarizeRisk(proposal, env) {
      const r = await chat({
        system: "You are reviewing a security patch before merge. In under 120 words, name the realistic ways this change could break behaviour or weaken security, or say plainly that the change is low-risk and why. No code blocks.",
        user: `Explanation from the author:\n${proposal.explanation}\n\nAuthor's own risk notes:\n${proposal.riskNotes || "(none)"}\n\nFiles changed: ${proposal.files.map((f) => f.path).join(", ")}`,
      }, env);
      if (!r.ok) return { ok: false, error: r.configured === false ? "provider_not_configured" : "provider_failed", message: r.reason };
      return { ok: true, text: r.reply.slice(0, 1500), provider: id };
    },
  });
}

export const PROVIDERS = Object.freeze({
  kimi:   makeProvider("kimi",   (msg, env) => chatVia("kimi", msg, env)),
  claude: makeProvider("claude", chatAnthropic),
  openai: makeProvider("openai", (msg, env) => chatVia("openai", msg, env)),
});

export const DEFAULT_PROVIDER_ORDER = Object.freeze(["kimi", "claude", "openai"]);

/**
 * Resolve a provider by id, or the first configured one.
 *
 * "Configured" is judged from env shape alone, without a network call —
 * a provider with no credentials is skipped rather than tried-and-failed,
 * so the default path on a deployed Worker lands on the keyless [ai] binding.
 */
export function resolveProvider(requested, env) {
  const e = env || {};
  const configured = {
    kimi:   Boolean(e.AI || (e.CLOUDFLARE_ACCOUNT_ID && e.CLOUDFLARE_AI_TOKEN)),
    claude: Boolean(e.ANTHROPIC_API_KEY),
    openai: Boolean(e.OPENAI_API_KEY),
  };
  if (requested) {
    if (!PROVIDERS[requested]) {
      return { ok: false, error: "unknown_provider", message: `provider must be one of ${Object.keys(PROVIDERS).join(", ")}` };
    }
    if (!configured[requested]) {
      return { ok: false, error: "provider_not_configured", message: `${requested} has no credentials on this deployment` };
    }
    return { ok: true, provider: PROVIDERS[requested] };
  }
  for (const id of DEFAULT_PROVIDER_ORDER) {
    if (configured[id]) return { ok: true, provider: PROVIDERS[id] };
  }
  return { ok: false, error: "no_provider_configured",
    message: "No AI provider is configured. Deploy the Workers AI binding ([ai] in wrangler.toml), or set ANTHROPIC_API_KEY or OPENAI_API_KEY." };
}

/**
 * The same task through several providers, for a reviewer who wants options.
 *
 * Honest by construction: it returns each provider's proposal and error AS
 * THEY CAME BACK, and does not rank them — the validator scores safety and
 * the human picks. An LLM judging LLM output would add a third opinion, not
 * ground truth.
 */
export async function compareAlternativeFixes(task, env, providerIds = DEFAULT_PROVIDER_ORDER) {
  const out = [];
  for (const id of providerIds) {
    const resolved = resolveProvider(id, env);
    if (!resolved.ok) { out.push({ provider: id, ok: false, error: resolved.error }); continue; }
    const r = await resolved.provider.createFixProposal(task, env);
    out.push({ provider: id, ...r });
  }
  return out;
}
