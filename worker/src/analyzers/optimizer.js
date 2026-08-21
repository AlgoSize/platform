// Algorithm optimizer — the framework-agnostic core.
//
// Extracted from handlers/analyze.js (Task #16's runAlgoSandbox) so the same
// implementation serves BOTH callers:
//
//   - POST /api/analyze/algo        handlers/analyze.js wraps this in HTTP
//   - scripts/optimizer-ci.mjs      the CI entrypoint calls it from Node
//
// Zero dependency on Request/Response or Worker bindings. Everything
// environment-shaped is injected:
//
//   runner(code, input)  how to execute user code. The Worker injects its
//                        SANDBOX-service-binding wrapper; CI and tests default
//                        to the in-process runUserCode — same code, same
//                        instrumentation, no edge runtime required, which is
//                        what makes this module runnable headless.
//   env                  read for the LLM provider config only (llm.js).
//   enableRefactor       tri-state: true / false / undefined = read
//                        env.ENABLE_REFACTOR_SUGGESTIONS, defaulting to ON so
//                        the web endpoint's behavior is unchanged (it has
//                        always returned a suggestion — real or stub). CI
//                        passes false to skip the LLM round-trip entirely.
//
// The probe design is unchanged from the handler: one measured run on the
// caller's sample input (the headline number), then three synthetic sizes for
// the Big-O fit, accepting partial probe failure rather than failing the run.

import { runUserCode } from "./sandbox_runner.js";
import { inferBigO } from "./bigo.js";
import { getRefactorSuggestion } from "./llm.js";
import * as acorn from "acorn";

export const PROBE_SIZES = [100, 1000, 10000];

/**
 * Slice a named top-level function declaration out of a file's source.
 *
 * Shared by the CI entrypoint (scripts/optimizer-ci.mjs) and the scheduled
 * monitors' optimizer pass (monitors/analyzers.js), so the function the
 * nightly sweep grades is character-for-character the one the per-PR gate
 * grades. A proper parse rather than a regex because a regex that finds
 * function boundaries in real JavaScript is a parser with fewer tests.
 *
 * Returns the exact source slice, or null when no top-level declaration
 * (plain, `export`, or `export default`) carries that name.
 */
export function extractFunction(source, functionName) {
  const ast = acorn.parse(source, { ecmaVersion: "latest", sourceType: "module" });
  for (const node of ast.body) {
    const fn = node.type === "FunctionDeclaration" ? node
      : (node.type === "ExportNamedDeclaration" || node.type === "ExportDefaultDeclaration")
        && node.declaration && node.declaration.type === "FunctionDeclaration"
        ? node.declaration : null;
    if (fn && fn.id && fn.id.name === functionName) {
      return source.slice(fn.start, fn.end);
    }
  }
  return null;
}

/**
 * Generate a synthetic input of the requested size in the same broad shape
 * as the user's sample input. Two shapes — array and number — cover the vast
 * majority of "single-arg algorithm" demos. Anything else returns null and
 * Big-O probing is skipped for that run.
 */
export function synthInputForSize(sample, n) {
  if (Array.isArray(sample)) {
    // Cycle the user's sample so element types/values stay realistic at
    // larger sizes (e.g. arrays of strings stay arrays of strings).
    if (sample.length === 0) {
      return Array.from({ length: n }, (_, i) => i);
    }
    return Array.from({ length: n }, (_, i) => sample[i % sample.length]);
  }
  if (typeof sample === "number" && Number.isFinite(sample)) {
    return n;
  }
  return null;
}

/**
 * Accepts { code, sampleInput? }. sampleInput may be any JSON value and
 * defaults to a length-100 integer array — a sensible "first run" for the
 * array-shaped demos in the dashboard.
 *
 * The error contract is the Worker's, verbatim: the dashboard's "Paste a
 * function first." lives in the frontend's pre-submit validation and never
 * reaches this layer.
 */
export function validateOptimizerInput(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, error: "invalid_payload", message: "request body must be a JSON object" };
  }
  if (typeof body.code !== "string" || body.code.trim() === "") {
    return { ok: false, error: "invalid_payload", message: "`code` (non-empty string) is required" };
  }
  const sampleInput = "sampleInput" in body
    ? body.sampleInput
    : Array.from({ length: 100 }, (_, i) => i);
  return { ok: true, value: { code: body.code, sampleInput } };
}

function refactorEnabled(enableRefactor, env) {
  if (enableRefactor === true || enableRefactor === false) return enableRefactor;
  const raw = env && env.ENABLE_REFACTOR_SUGGESTIONS;
  if (raw === undefined || raw === null || raw === "") return true;   // web default: unchanged
  return !/^(false|0|off|no)$/i.test(String(raw).trim());
}

/**
 * Run the optimizer. Returns a plain object, never a Response:
 *
 *   { ok: true, wallTimeMs, heapBytes, sampleResult, truncated, bigO,
 *     suggestion }                                — suggestion is the llm.js
 *                                                  shape, or a
 *                                                  provider:"disabled" marker
 *                                                  when the flag is off
 *   { ok: false, error, message, ms? }            — sandbox rejection; the
 *                                                  HTTP layer maps this to 400
 */
export async function runOptimizer({ code, sampleInput }, { runner, env, enableRefactor } = {}) {
  const run = runner || ((c, i) => runUserCode(c, i));

  // 1. Single measured run with the caller's actual sample input.
  const sampleRun = await run(code, sampleInput);
  if (!sampleRun.ok) {
    return {
      ok: false,
      error: sampleRun.error,
      message: sampleRun.message || "sandbox run failed",
      ms: sampleRun.ms,
    };
  }

  // 2. Big-O probe at 3 sizes; partial failure degrades to "unknown" with a
  //    stated reason rather than failing the whole request.
  const probePoints = [];
  let probeNote = null;
  for (const n of PROBE_SIZES) {
    const synth = synthInputForSize(sampleInput, n);
    if (synth === null) {
      probeNote = "Big-O probe skipped: sample input is not an array or number";
      break;
    }
    const r = await run(code, synth);
    if (!r.ok) {
      probeNote = `Big-O probe stopped at n=${n}: ${r.error}`;
      break;
    }
    probePoints.push({ n, ms: r.ms });
  }

  const bigO = probePoints.length >= 2
    ? inferBigO(probePoints)
    : { label: "unknown", exponent: null, points: probePoints, reason: probeNote || "not enough probe points" };

  // 3. Refactor suggestion — behind the flag. "disabled" is a distinct
  //    provider so a report can tell "skipped by config" apart from "no
  //    provider configured" (the stub), which lead to different fixes.
  let suggestion;
  if (refactorEnabled(enableRefactor, env)) {
    suggestion = await getRefactorSuggestion(
      { code, bigO: bigO.label, ms: sampleRun.ms },
      env || {},
    );
  } else {
    suggestion = {
      provider: "disabled",
      text: "Refactor suggestions are disabled (ENABLE_REFACTOR_SUGGESTIONS=false).",
      code: null,
      language: "javascript",
    };
  }

  return {
    ok: true,
    wallTimeMs: sampleRun.ms,
    heapBytes: sampleRun.heapBytes,
    sampleResult: sampleRun.result,
    truncated: !!sampleRun.truncated,
    bigO,
    suggestion,
  };
}
