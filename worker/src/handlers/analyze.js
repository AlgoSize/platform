// HTTP handlers for the analyzer endpoints:
//   POST /api/analyze/cost   (Task #5 / Task #14 — CUR upload added)
//   POST /api/analyze/vuln   (Task #6)
//   POST /api/analyze/algo   (Task #7)
//
// All analyzers share the same parse → validate → analyze → respond shape,
// so we factor it into `runAnalyzer` to avoid drift across endpoints. The
// rule engines themselves live in ../analyzers/* and are pure functions, so
// any one of them can later be swapped for an LLM-backed implementation
// without touching this file.
//
// The cost endpoint additionally accepts a CUR (Cost & Usage Report) CSV
// upload — either as multipart/form-data with a `file` field or as a raw
// text/csv body. The pre-existing JSON path (services array) keeps working
// unchanged for backwards compatibility with any external API consumer.

import { validateCostInput, analyzeCost } from "../analyzers/cost.js";
import { analyzeCur, _CUR_HELP_URL } from "../analyzers/cur.js";
import { validateVulnInput, analyzeVuln } from "../analyzers/vuln.js";
import { validateAlgoInput, analyzeAlgo } from "../analyzers/algo.js";
import {
  parseLockfile,
  SUPPORTED_FILES as LOCKFILE_NAMES,
  MAX_LOCKFILE_BYTES,
  MAX_PACKAGES_PER_AUDIT,
} from "../analyzers/lockfile.js";
import { osvBatchQuery, osvHydrateVulns } from "../analyzers/osv.js";
import { runUserCode } from "../analyzers/sandbox_runner.js";
import { inferBigO } from "../analyzers/bigo.js";
import { getRefactorSuggestion } from "../analyzers/llm.js";
import { queuePersist } from "./runs.js";
import { captureException } from "../observability.js";

// After a 200 from any analyzer, queue a non-blocking write to the per-user
// run-history KV. Skipped when there's no logged-in user (e.g. an unauth'd
// integration test calling the handler directly), no RUNS binding, or a
// non-200 status — we never persist failures or validation errors.
async function maybePersist(ctx, env, request, analyzer, input, response) {
  if (!response || response.status !== 200) return;
  const userId = request.user && request.user.userId;
  if (!userId || !env || !env.RUNS) return;
  let result;
  try { result = await response.clone().json(); }
  catch { return; }
  const ms = typeof result.wallTimeMs === "number" ? result.wallTimeMs : null;
  queuePersist(ctx, env, { userId, analyzer, input, result, ms });
}

// 100 MB cap on uploads. At ~150 bytes per CUR row, this comfortably covers
// the 10k–500k-row range called out in the Task #14 plan (~530k rows fit in
// 100 MB) while staying well under the Cloudflare Workers 128 MB memory
// ceiling. Bigger accounts should split by month or filter to a single
// account before upload — and we have a follow-up (#28) to accept gzipped
// CURs which would multiply effective capacity by ~5×.
const MAX_CUR_BYTES = 100 * 1024 * 1024;

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

async function runAnalyzer(request, validate, analyze, label, env, ctx) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid_json", message: "request body must be valid JSON" }, 400);
  }

  const validation = validate(body);
  if (!validation.ok) {
    return json({ error: validation.error, message: validation.message }, 400);
  }

  let result;
  try {
    // Wrap in Promise.resolve so a future async analyzer (e.g. an LLM-backed
    // implementation) works without changing this layer; sync analyzers are
    // unaffected because Promise.resolve(value) yields a resolved promise.
    result = await Promise.resolve(analyze(validation.value));
  } catch (err) {
    console.error(`${label}: engine error`, err);
    // Observability (Task #22): an analyzer engine throwing is a real
    // bug worth a stack trace — the per-analyzer label tag lets us
    // group them in Sentry separately.
    await captureException(env, ctx, err, {
      request,
      userId: request.user && request.user.userId,
      tags:   { source: "analyzer", analyzer: label },
    });
    return json({ error: "analyzer_failed", message: "could not analyze the provided payload" }, 500);
  }

  return json(result, 200);
}

// ---------------------------------------------------------------------------
// CUR upload path
// ---------------------------------------------------------------------------

async function readCurText(request) {
  const ct = (request.headers.get("content-type") || "").toLowerCase();

  // Cheap pre-flight on Content-Length so we can reject obvious oversize
  // uploads before reading the body.
  const len = parseInt(request.headers.get("content-length") || "0", 10);
  if (len > 0 && len > MAX_CUR_BYTES) {
    return { tooLarge: true };
  }

  if (ct.includes("multipart/form-data")) {
    const form = await request.formData();
    const file = form.get("file");
    if (!file || typeof file === "string") {
      return { error: { code: "missing_file", message: "no `file` field in multipart upload", status: 400 } };
    }
    if (typeof file.size === "number" && file.size > MAX_CUR_BYTES) {
      return { tooLarge: true };
    }
    return { text: await file.text() };
  }

  // text/csv (or anything else routed here): read the raw body. We re-check
  // size *after* reading because Content-Length may be absent (chunked /
  // streamed uploads), and we still want to enforce the 50 MB cap rather
  // than buffering arbitrary bytes. Note: text.length counts UTF-16 code
  // units, which is an upper bound on the byte size for ASCII-heavy CUR
  // payloads — close enough for a defensive cap.
  const text = await request.text();
  if (text.length > MAX_CUR_BYTES) {
    return { tooLarge: true };
  }
  return { text };
}

async function runCurAnalyzer(request, env, ctx) {
  let read;
  try {
    read = await readCurText(request);
  } catch (err) {
    console.error("analyze/cost: csv read error", err);
    return json({ error: "read_failed", message: "could not read uploaded file" }, 400);
  }

  if (read.tooLarge) {
    return json(
      {
        error: "file_too_large",
        message: `CUR file must be ≤ ${Math.floor(MAX_CUR_BYTES / 1024 / 1024)} MB. Try a smaller billing period.`,
      },
      413,
    );
  }
  if (read.error) {
    return json({ error: read.error.code, message: read.error.message }, read.error.status);
  }

  let result;
  try {
    result = analyzeCur(read.text);
  } catch (err) {
    if (err && err.curError) {
      return json(
        { error: "invalid_cur", message: err.message, helpUrl: err.helpUrl || _CUR_HELP_URL },
        400,
      );
    }
    console.error("analyze/cost: CUR engine error", err);
    // Observability (Task #22): only the unexpected (non-curError)
    // path captures — invalid_cur is a 400 user-input issue, not a
    // bug.
    await captureException(env, ctx, err, {
      request,
      userId: request.user && request.user.userId,
      tags:   { source: "analyzer", analyzer: "analyze/cost", subpath: "cur_csv" },
    });
    return json({ error: "analyzer_failed", message: "could not analyze the CUR" }, 500);
  }

  return json(result, 200);
}

/**
 * POST /api/analyze/cost
 *
 * Auth is enforced by `requireAuth` middleware in the router — by the time
 * this handler runs, `request.user` is populated. Dispatches on Content-Type:
 *   - multipart/form-data or text/csv  → CUR CSV analyzer (Task #14)
 *   - application/json (or anything else) → original JSON services analyzer
 */
export async function analyzeCostHandler(request, env, ctx) {
  const ct = (request.headers.get("content-type") || "").toLowerCase();
  if (ct.includes("multipart/form-data") || ct.startsWith("text/csv")) {
    const response = await runCurAnalyzer(request, env, ctx);
    // CUR uploads can be tens of MB — too big to keep in KV. Persist a
    // marker so the run shows in history but Re-run is greyed out.
    await maybePersist(ctx, env, request, "cost",
      { _omitted: true, reason: "cur_upload" }, response);
    return response;
  }
  // JSON path — parse the body once so we can reuse it for persistence.
  let body;
  try { body = await request.json(); }
  catch { return json({ error: "invalid_json", message: "request body must be valid JSON" }, 400); }
  const response = await runAnalyzerWithBody(
    body, validateCostInput, analyzeCost, "analyze/cost", request, env, ctx);
  await maybePersist(ctx, env, request, "cost", body, response);
  return response;
}

// ---------------------------------------------------------------------------
// Lockfile audit (Task #15) — repo-URL → fetch lockfiles → OSV.dev → CVEs
// ---------------------------------------------------------------------------

const VULN_HELP_URL = "https://osv.dev/";

function parseGithubUrl(s) {
  if (typeof s !== "string") return null;
  let u;
  try { u = new URL(s.trim()); } catch { return null; }
  if (u.hostname !== "github.com" && u.hostname !== "www.github.com") return null;
  const parts = u.pathname.split("/").filter(Boolean);
  if (parts.length < 2) return null;
  return { owner: parts[0], repo: parts[1].replace(/\.git$/, "") };
}

/**
 * Fetch every supported lockfile under a repo at HEAD. Tries `main` first,
 * then `master`. Within each branch attempt we fan out in parallel (5
 * subrequests) for speed. If `main` returns at least one lockfile we don't
 * probe `master` — saves bandwidth on the common case.
 *
 * Returns `[{ filename, content }]` or throws a tagged error on a real
 * upstream failure (vs. plain 404, which just yields an empty list).
 */
async function fetchLockfilesFromGithub({ owner, repo }, fetchImpl) {
  for (const branch of ["main", "master"]) {
    const fetches = LOCKFILE_NAMES.map(async (filename) => {
      const url = `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${filename}`;
      let res;
      try { res = await fetchImpl(url); }
      catch { return { filename, status: 0, content: null }; }
      if (res.status === 404) return { filename, status: 404, content: null };
      if (res.status >= 500) {
        const e = new Error(`GitHub raw content unavailable (HTTP ${res.status})`);
        e.fetchError = true; e.code = "github_unavailable"; e.status = 502;
        throw e;
      }
      if (!res.ok) return { filename, status: res.status, content: null };
      const text = await res.text();
      if (text.length > MAX_LOCKFILE_BYTES) {
        return { filename, status: 413, content: null }; // skip silently — too big
      }
      return { filename, status: 200, content: text };
    });
    const results = await Promise.all(fetches);
    const found = results.filter((r) => r.content !== null).map((r) => ({ filename: r.filename, content: r.content }));
    if (found.length > 0) return found;
  }
  return [];
}

/**
 * POST /api/analyze/vuln
 *
 * Auth is enforced by `requireAuth`. Two modes, dispatched on body shape:
 *
 *   { repoUrl: "https://github.com/owner/repo" }
 *     Lockfile audit (Task #15): fetches package-lock.json / yarn.lock /
 *     requirements.txt / Gemfile.lock / go.sum from the repo's default
 *     branch (main → master fallback), parses them, queries OSV.dev for
 *     known vulnerabilities, and returns severity counts + a top-10
 *     advisory list with CVE IDs and fix versions.
 *
 *   { code: "..." }  OR  { files: [{path, content}, ...] }
 *     Source-code heuristic scan (original Task #6 contract): regex-based
 *     secret/eval/SQL-concat detectors. Kept for backwards-compat with the
 *     existing JSON API and the 16+ existing tests.
 *
 * The `code`/`files` payload doesn't get a CVE list because OSV needs
 * versioned packages. The `repoUrl` payload doesn't get heuristic findings
 * because it's a lockfile, not source code. Two distinct features behind
 * one endpoint — the dispatch is cheap and keeps the API surface small.
 */
export async function analyzeVulnHandler(request, env, ctx) {
  let body;
  try { body = await request.json(); }
  catch { return json({ error: "invalid_json", message: "request body must be valid JSON" }, 400); }

  if (body && typeof body.repoUrl === "string") {
    const response = await runLockfileAudit(body, env, request, ctx);
    await maybePersist(ctx, env, request, "vuln", body, response);
    return response;
  }

  // Legacy heuristic path — same behavior as before Task #15.
  const validation = validateVulnInput(body);
  if (!validation.ok) return json({ error: validation.error, message: validation.message }, 400);
  let result;
  try { result = await Promise.resolve(analyzeVuln(validation.value)); }
  catch (err) {
    console.error("analyze/vuln: engine error", err);
    await captureException(env, ctx, err, {
      request,
      userId: request.user && request.user.userId,
      tags:   { source: "analyzer", analyzer: "analyze/vuln", subpath: "heuristic" },
    });
    return json({ error: "analyzer_failed", message: "could not analyze the provided payload" }, 500);
  }
  const response = json(result, 200);
  await maybePersist(ctx, env, request, "vuln", body, response);
  return response;
}

function pickFixCommand(manifests) {
  const has = (n) => manifests.some((m) => m.filename === n);
  if (has("package-lock.json") || has("yarn.lock"))    return "npm audit fix";
  if (has("requirements.txt"))                         return "pip install -U <package>  # for each affected package";
  if (has("Gemfile.lock"))                             return "bundle update <gem>  # for each affected gem";
  if (has("go.sum"))                                   return "go get -u && go mod tidy";
  return null;
}

function countSeverities(advisories) {
  const c = { critical: 0, high: 0, medium: 0, low: 0, unknown: 0 };
  for (const a of advisories) {
    if (c[a.severity] !== undefined) c[a.severity]++;
    else c.unknown++;
  }
  return c;
}

async function runLockfileAudit(body, env, request, ctx) {
  const repo = parseGithubUrl(body.repoUrl);
  if (!repo) {
    return json({
      error: "invalid_repo_url",
      message: "Provide a GitHub repo URL like https://github.com/owner/name",
    }, 400);
  }

  const fetchImpl = (env && env.FETCH) || globalThis.fetch;
  const userId = request && request.user && request.user.userId;

  let manifests;
  try {
    manifests = await fetchLockfilesFromGithub(repo, fetchImpl);
  } catch (err) {
    // Observability (Task #22): both 502 paths capture so an upstream
    // GitHub outage is visible in Sentry even though we return a clean
    // error to the user. Tag distinguishes the tagged
    // (github_unavailable) variant from a generic catch.
    if (err && err.fetchError) {
      try {
        await captureException(env || {}, ctx, err, {
          request, userId,
          tags: { source: "analyzer", analyzer: "analyze/vuln",
                  subpath: "lockfile_fetch", upstream: "github.com",
                  reason: err.code || "github_unavailable" },
        });
      } catch { /* never let observability mask the real error */ }
      return json({ error: err.code, message: err.message, helpUrl: VULN_HELP_URL }, err.status || 502);
    }
    console.error("analyze/vuln: lockfile fetch error", err);
    try {
      await captureException(env || {}, ctx, err, {
        request, userId,
        tags: { source: "analyzer", analyzer: "analyze/vuln",
                subpath: "lockfile_fetch", upstream: "github.com",
                reason: "fetch_failed" },
      });
    } catch { /* never let observability mask the real error */ }
    return json({ error: "fetch_failed", message: "could not fetch repo lockfiles" }, 502);
  }

  if (manifests.length === 0) {
    return json({
      error: "no_lockfiles_found",
      message: `No supported lockfile found in ${repo.owner}/${repo.repo} on main or master. Supported: ${LOCKFILE_NAMES.join(", ")}.`,
      helpUrl: "https://docs.github.com/en/repositories/working-with-files/managing-files",
    }, 404);
  }

  // Parse each manifest. A single bad lockfile fails the whole audit — same
  // posture as the CUR analyzer (we want the user to fix obvious garbage
  // rather than getting a half-correct CVE list).
  const allPackages = [];
  const summary = [];
  for (const m of manifests) {
    let parsed;
    try { parsed = parseLockfile(m.filename, m.content); }
    catch (err) {
      if (err && err.lockfileError) {
        return json({
          error: "invalid_lockfile",
          message: `${m.filename}: ${err.message}`,
          helpUrl: VULN_HELP_URL,
        }, 400);
      }
      throw err;
    }
    summary.push({
      filename: m.filename,
      ecosystem: parsed.ecosystem,
      packageCount: parsed.packages.length,
    });
    for (const p of parsed.packages) {
      allPackages.push({ name: p.name, version: p.version, ecosystem: parsed.ecosystem });
      if (allPackages.length >= MAX_PACKAGES_PER_AUDIT) break;
    }
    if (allPackages.length >= MAX_PACKAGES_PER_AUDIT) break;
  }

  let advisories = [];
  if (allPackages.length > 0) {
    try {
      const matches = await osvBatchQuery(allPackages, fetchImpl);
      advisories = await osvHydrateVulns(matches, fetchImpl);
    } catch (err) {
      console.error("analyze/vuln: OSV error", err);
      // Observability (Task #22): OSV outages are external — keep them
      // as a "warning"-equivalent (status:502 in HTTP, but capture as
      // exception so we still get the stack and a Sentry alert if it
      // spikes). Tagged so we can filter osv_unavailable noise out of
      // alert rules later. Threading `request` + `userId` here too —
      // /api/analyze/vuln is auth-gated so user context is always available.
      try {
        await captureException(env || {}, ctx, err, {
          request, userId,
          tags: { source: "analyzer", analyzer: "analyze/vuln", subpath: "osv", upstream: "osv.dev" },
        });
      } catch { /* never let observability errors mask the real one */ }
      return json({
        error: "osv_unavailable",
        message: "Couldn't reach OSV.dev to look up advisories. Try again in a moment.",
        helpUrl: VULN_HELP_URL,
      }, 502);
    }
  }

  return json({
    repoUrl: `https://github.com/${repo.owner}/${repo.repo}`,
    scanned: { manifests: summary, totalPackages: allPackages.length },
    counts: countSeverities(advisories),
    advisories,
    topAdvisories: advisories.slice(0, 10),
    fixCommand: pickFixCommand(summary),
  }, 200);
}

// ---------------------------------------------------------------------------
// Algorithm optimizer (Task #16) — sandbox + LLM
// ---------------------------------------------------------------------------

const ALGO_PROBE_SIZES = [100, 1000, 10000];

/**
 * Generate a synthetic input of the requested size in the same broad shape
 * as the user's sample input. We support two shapes — array and number —
 * which together cover the vast majority of "single-arg algorithm" demos.
 * Anything else returns null and we skip Big-O probing for that run.
 */
function synthInputForSize(sample, n) {
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
 * Invoke the sandbox. Prefers the SANDBOX service binding when available
 * (so a runaway user loop only burns CPU on the sibling Worker), else falls
 * back to in-process execution so single-Worker dev mode and tests work.
 */
async function runInSandbox(env, code, input) {
  if (env && env.SANDBOX && typeof env.SANDBOX.fetch === "function") {
    let res;
    try {
      res = await env.SANDBOX.fetch("https://sandbox.internal/run", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code, input }),
      });
    } catch (err) {
      return { ok: false, error: "sandbox_unreachable", message: String(err && err.message || err) };
    }
    try {
      return await res.json();
    } catch {
      return { ok: false, error: "sandbox_bad_response", message: "sandbox returned non-JSON" };
    }
  }
  return runUserCode(code, input);
}

function validateAlgoSandboxInput(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, error: "invalid_payload", message: "request body must be a JSON object" };
  }
  if (typeof body.code !== "string" || body.code.trim() === "") {
    return { ok: false, error: "invalid_payload", message: "`code` (non-empty string) is required" };
  }
  // sampleInput may be any JSON value (array, number, object, etc). It is
  // optional — if omitted we default to a length-100 integer array, which
  // is a sensible "first run" for the array-shaped demos in the dashboard.
  const sampleInput = "sampleInput" in body
    ? body.sampleInput
    : Array.from({ length: 100 }, (_, i) => i);
  return { ok: true, value: { code: body.code, sampleInput } };
}

async function runAlgoSandbox(body, env) {
  const v = validateAlgoSandboxInput(body);
  if (!v.ok) return json({ error: v.error, message: v.message }, 400);
  const { code, sampleInput } = v.value;

  // 1. Single measured run with the user's actual sample input — this is
  //    the wall-clock + result the dashboard surfaces as the headline number.
  const sampleRun = await runInSandbox(env, code, sampleInput);
  if (!sampleRun.ok) {
    return json({
      error: sampleRun.error,
      message: sampleRun.message || "sandbox run failed",
      ms: sampleRun.ms,
    }, 400);
  }

  // 2. Big-O probe at 3 sizes. We accept partial failures here — if the
  //    function blows up on a synthetic input shape, we still return the
  //    sample-run result with bigO = "unknown" rather than failing the
  //    whole request.
  const probePoints = [];
  let probeNote = null;
  for (const n of ALGO_PROBE_SIZES) {
    const synth = synthInputForSize(sampleInput, n);
    if (synth === null) {
      probeNote = "Big-O probe skipped: sample input is not an array or number";
      break;
    }
    const r = await runInSandbox(env, code, synth);
    if (!r.ok) {
      probeNote = `Big-O probe stopped at n=${n}: ${r.error}`;
      break;
    }
    probePoints.push({ n, ms: r.ms });
  }

  const bigO = probePoints.length >= 2
    ? inferBigO(probePoints)
    : { label: "unknown", exponent: null, points: probePoints, reason: probeNote || "not enough probe points" };

  // 3. LLM refactor suggestion. Falls back to a stub message when
  //    OPENAI_API_KEY is not configured — never throws.
  const suggestion = await getRefactorSuggestion(
    { code, bigO: bigO.label, ms: sampleRun.ms },
    env || {},
  );

  return json({
    wallTimeMs: sampleRun.ms,
    heapBytes: sampleRun.heapBytes,
    sampleResult: sampleRun.result,
    truncated: !!sampleRun.truncated,
    bigO,
    suggestion,
    sandbox: env && env.SANDBOX ? "service_binding" : "in_process",
  }, 200);
}

/**
 * POST /api/analyze/algo
 *
 * Auth is enforced by `requireAuth`. Dispatches on body shape:
 *   { code, sampleInput? } → real sandbox + Big-O probe + LLM refactor (Task #16)
 *   { source, language? }  → legacy heuristic engine (back-compat for any
 *                            external API consumer; the dashboard now sends
 *                            the new shape).
 */
export async function analyzeAlgoHandler(request, env, ctx) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid_json", message: "request body must be valid JSON" }, 400);
  }
  if (body && typeof body === "object" && typeof body.code === "string") {
    const response = await runAlgoSandbox(body, env);
    await maybePersist(ctx, env, request, "algo", body, response);
    return response;
  }
  // Legacy path — pass through the existing heuristic engine.
  const response = await runAnalyzerWithBody(
    body, validateAlgoInput, analyzeAlgo, "analyze/algo", request, env, ctx);
  await maybePersist(ctx, env, request, "algo", body, response);
  return response;
}

// Same as runAnalyzer but accepts an already-parsed body (so the algo
// dispatcher doesn't need to re-read the request stream). Optional
// request/env/ctx triple is forwarded to captureException on engine
// errors — when omitted (legacy callers, tests) we just console.error.
async function runAnalyzerWithBody(body, validate, analyze, label, request, env, ctx) {
  const validation = validate(body);
  if (!validation.ok) {
    return json({ error: validation.error, message: validation.message }, 400);
  }
  let result;
  try {
    result = await Promise.resolve(analyze(validation.value));
  } catch (err) {
    console.error(`${label}: engine error`, err);
    if (env) {
      await captureException(env, ctx, err, {
        request,
        userId: request && request.user && request.user.userId,
        tags:   { source: "analyzer", analyzer: label },
      });
    }
    return json({ error: "analyzer_failed", message: "could not analyze the provided payload" }, 500);
  }
  return json(result, 200);
}
