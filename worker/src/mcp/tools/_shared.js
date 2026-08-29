// Helpers every tool adapter uses, so twenty files do not each invent their
// own way of turning an HTTP response into something a model can read.
//
// Nothing here reaches the product. The only route into Algosize is
// `callHandler`, and these functions operate purely on what it returned —
// which is what keeps `test-mcp-purity.mjs` satisfied and, more importantly,
// keeps quota and entitlement decisions in one place.

import { SCOPES } from "../tokens.js";

export { SCOPES };

/**
 * Turn a non-2xx handler response into a tool error result.
 *
 * Returns null when the response succeeded, so callers read:
 *
 *     const fail = failureOf(res, "…context…");
 *     if (fail) return fail;
 *
 * Two status codes get special treatment because the model can act on them
 * and `handlers/mcp.js` meters them separately:
 *
 *   402 → the org is out of runs. The model must be told to stop trying
 *         analyses, not to retry — a retry burns nothing but wastes a turn
 *         and reads to the user as the assistant being stuck.
 *   429 → too fast. A retry IS appropriate here, later.
 *
 * Everything else becomes a plain isError result carrying the handler's own
 * message. We surface the product's wording rather than inventing our own:
 * the handlers already explain themselves in language written for a human,
 * and paraphrasing loses the specifics ("Provide a GitHub repo URL like…").
 */
export function failureOf(res, context) {
  if (res.ok) return null;

  const body    = res.json || {};
  const message = body.message || body.error || res.text || "The request failed.";

  if (res.status === 402) {
    return {
      text:
        `${context} was refused: this organisation has used its monthly analysis allowance ` +
        `(${body.monthlyRunsUsed ?? "?"} of ${body.monthlyRunsLimit ?? "?"} runs). ` +
        `Do not retry — the allowance resets next month, or the plan can be upgraded at ` +
        `${body.upgradeUrl || "https://algosize.com/#pricing"}. ` +
        `Read-only tools still work and cost nothing.`,
      isError: true,
      errorCode: "quota_exceeded",
      structured: {
        monthlyRunsUsed:  body.monthlyRunsUsed ?? null,
        monthlyRunsLimit: body.monthlyRunsLimit ?? null,
        upgradeUrl:       body.upgradeUrl || null,
      },
    };
  }

  if (res.status === 429) {
    return {
      text: `${context} was rate limited. Wait a few seconds and try again.`,
      isError: true,
      errorCode: "rate_limited",
    };
  }

  return {
    text: `${context} failed: ${message}`,
    isError: true,
    errorCode: body.error || `http_${res.status}`,
  };
}

/** Compact counts object → "3 critical, 1 high" (omitting zeroes). */
export function describeCounts(counts) {
  if (!counts || typeof counts !== "object") return "no severity breakdown";
  const parts = ["critical", "high", "medium", "low", "unknown"]
    .filter((k) => Number(counts[k]) > 0)
    .map((k) => `${counts[k]} ${k}`);
  return parts.length ? parts.join(", ") : "no findings";
}

/**
 * A schema fragment for "the files to analyse".
 *
 * Strict on purpose — `additionalProperties: false` everywhere. A model handed
 * a loose schema sends plausible-looking garbage, the handler rejects it with
 * a 400, and on a metered route that 400 has already cost a run. Tightening
 * the schema is the cheapest place to prevent that.
 */
export const FILES_SCHEMA = Object.freeze({
  type: "array",
  description: "The files to analyse. Send real file contents, not summaries.",
  items: {
    type: "object",
    properties: {
      path:    { type: "string", description: "Repository-relative path, e.g. \"docker-compose.yml\"." },
      content: { type: "string", description: "The file's full text." },
    },
    required: ["path", "content"],
    additionalProperties: false,
  },
  minItems: 1,
  maxItems: 400,
});

/** Standard annotations for a read-only tool. */
export const READ_ONLY = Object.freeze({
  readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false,
});

/** Standard annotations for a tool that creates or changes something. */
export const MUTATING = Object.freeze({
  readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false,
});

/** Truncate prose that would otherwise flood a model's context. */
export function clip(text, max = 4000) {
  const s = String(text ?? "");
  return s.length <= max ? s : `${s.slice(0, max)}\n… (truncated at ${max} characters)`;
}
