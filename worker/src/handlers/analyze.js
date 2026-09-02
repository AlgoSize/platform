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
import { ALL_KNOWN_EXTENSIONS, FETCHABLE_FILENAMES, GENERATED_LOCKFILES } from "../analyzers/sast/languages.js";
import { profileRepository } from "../analyzers/sast/profile.js";
import { validateAlgoInput, analyzeAlgo } from "../analyzers/algo.js";
import { validateArchitectureInput, analyzeArchitecture } from "../analyzers/architecture.js";
import { recordSnapshot } from "../arch/snapshots.js";
import {
  parseLockfile,
  SUPPORTED_FILES as LOCKFILE_NAMES,
  MAX_LOCKFILE_BYTES,
  MAX_PACKAGES_PER_AUDIT,
} from "../analyzers/lockfile.js";
import { osvBatchQuery, osvHydrateVulns } from "../analyzers/osv.js";
import { buildAuditSummary } from "../analyzers/audit.js";
import { runUserCode } from "../analyzers/sandbox_runner.js";
import { validateOptimizerInput, runOptimizer } from "../analyzers/optimizer.js";
import { queuePersist } from "./runs.js";
import { getActiveOrg } from "./_orgs.js";
import { storeReportFor } from "../reports/render.js";
import { captureException } from "../observability.js";
import { analyzerVersion } from "../analyzer-version.js";

// After a 200 from any analyzer, queue a non-blocking write to the per-user
// run-history KV. Skipped when there's no logged-in user (e.g. an unauth'd
// integration test calling the handler directly), no RUNS binding, or a
// non-200 status — we never persist failures or validation errors.
async function maybePersist(ctx, env, request, analyzer, input, response) {
  if (!response || response.status !== 200) return;
  if (!env || !env.DB) return;

  // Run persistence is ORG-FIRST.
  //
  // This used to require request.user.userId and return early without it. An
  // API key authenticates as the organisation and sets request.org with NO
  // request.user — so every analyzer call made with a key was analysed,
  // metered and billed, and then produced no run row, no report in R2, and no
  // architecture snapshot. The work was charged for and thrown away, and the
  // dashboard showed nothing.
  //
  // persistRun has always accepted an org-only owner (`if (!userId && !orgId)
  // return null`), so the gap was entirely in this caller. MCP traffic is
  // key- or token-authenticated by construction, which would have made every
  // MCP analysis invisible for the same reason.
  const userId = (request.user && request.user.userId) || null;
  const directOrgId = (request.org && request.org.orgId) || null;
  if (!userId && !directOrgId) return;
  let result;
  try { result = await response.clone().json(); }
  catch { return; }
  const ms = typeof result.wallTimeMs === "number" ? result.wallTimeMs : null;

  // File the run against the user's org as well as the user. Runs became
  // org-scoped in migrations/0007 for CI ingestion, but this path still wrote
  // org_id NULL — so a dashboard run stayed invisible to the rest of the team
  // and its report had no org to key on in R2. Resolved here rather than
  // inside persistRun so the lookup happens once per run, not once per caller.
  // A key already names its org, so there is nothing to look up. Only the
  // session path needs the membership query.
  let orgId = directOrgId;
  if (!orgId && userId) {
    try {
      const active = await getActiveOrg(env, userId);
      orgId = active ? active.org.orgId : null;
    } catch { /* history is best-effort; an org lookup failure must not lose it */ }
  }

  // Which credential produced this run, for the runs feed's provenance label.
  // The id is a key id or an opaque token id — never the secret itself, which
  // by then exists only as a hash anyway.
  const credentialKind =
    request.authMethod === "mcp_oauth" ? "mcp_oauth"
    : request.authMethod === "api_key" ? "api_key"
    : "session";
  const credentialId = request.mcpTokenId || request.apiKeyId || null;

  // Render the client-facing report as soon as the run is filed, so a share
  // link opened minutes later serves from R2 instead of rendering on the
  // reader's request. No-ops when the bucket is unbound, or for analyzers that
  // produce no report — see reports/render.js.
  // Architecture runs also become a versioned snapshot (migrations/0018), so
  // "what changed since last time" has something to compare against. A manual
  // upload has no repository behind it, so repo_url and branch stay NULL —
  // which is what makes the chain link manual uploads to each other rather
  // than to some repo's nightly history.
  //
  // Fire-and-forget on the same waitUntil budget as the report render, and
  // best-effort like everything else here: a snapshot that cannot be written
  // must not cost the user the analysis they actually asked for.
  if (analyzer === "arch" && orgId && result && result.graph) {
    const snap = recordSnapshot(env, ctx, {
      orgId, source: "manual", graph: result.graph,
      findingCount: Array.isArray(result.findings) ? result.findings.length : 0,
    }).catch(() => null);
    if (ctx && typeof ctx.waitUntil === "function") ctx.waitUntil(snap);
  }

  const persisted = queuePersist(ctx, env, {
    userId, orgId, analyzer, input, result, ms, credentialKind, credentialId,
  })
    .then((run) => (run ? storeReportFor(env, ctx, run) : null))
    .catch((err) => { console.error("maybePersist: report store failed", err); return null; });
  if (ctx && typeof ctx.waitUntil === "function") ctx.waitUntil(persisted);
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

  return json({ ...result, analyzerVersion: analyzerVersion(env) }, 200);
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

  return json({ ...result, analyzerVersion: analyzerVersion(env) }, 200);
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
// How many lockfiles one audit will read. A monorepo has a handful; the cap
// exists for the pathological repository, and the audit reports what it read.
const MAX_LOCKFILES = 12;
// Directories whose lockfiles describe somebody else's dependency tree.
const VENDORED_RE = /(^|\/)(node_modules|vendor|bundle|\.git|dist|build|_site|fixtures?|__tests__)(\/|$)/;

/**
 * Find every supported lockfile in the repository, at any depth, through the
 * git tree API.
 *
 * The by-name fetch below reads the repository ROOT only, which silently
 * mis-audits every monorepo: this repository keeps its lockfiles in worker/
 * and tests/e2e/ and has only a Gemfile.lock at the root, so the audit graded
 * the Ruby tree "A - 0, no advisories in the last sweep" while the npm
 * packages carrying six high-severity advisories were never fetched. A
 * confident clean bill of health over dependencies nobody looked at is the
 * worst answer a security scanner can give, and it is worse than an error.
 *
 * Returns null - not an empty list - when the tree cannot be listed, so the
 * caller falls back to the root-name fetch rather than reporting a private
 * or renamed repository as having no dependencies.
 */
async function discoverLockfiles({ owner, repo }, fetchImpl, env) {
  const headers = { "User-Agent": "algosize-audit", Accept: "application/vnd.github+json" };
  if (env && env.GITHUB_TOKEN) headers.Authorization = `Bearer ${env.GITHUB_TOKEN}`;

  for (const branch of ["main", "master"]) {
    const url = `https://api.github.com/repos/${owner}/${repo}/git/trees/${branch}?recursive=1`;
    let res;
    try { res = await fetchImpl(url, { headers }); } catch { continue; }
    if (res.status === 429 || res.status === 403) {
      const e = new Error(
        "GitHub is rate-limiting our requests for this repo's lockfiles. Wait a minute and try again.",
      );
      e.fetchError = true; e.code = "github_rate_limited"; e.status = 503;
      throw e;
    }
    if (!res.ok) continue;

    let body;
    try { body = await res.json(); } catch { continue; }
    const entries = Array.isArray(body && body.tree) ? body.tree : [];

    const wanted = entries
      .filter((e) => e && e.type === "blob" && typeof e.path === "string")
      .filter((e) => LOCKFILE_NAMES.includes(e.path.split("/").pop()))
      .filter((e) => !VENDORED_RE.test(e.path))
      .filter((e) => !(typeof e.size === "number" && e.size > MAX_LOCKFILE_BYTES))
      // Shallowest first: a root lockfile matters more than a deep one when
      // the cap bites.
      .sort((a, b) => a.path.split("/").length - b.path.split("/").length
        || (a.path < b.path ? -1 : 1))
      .slice(0, MAX_LOCKFILES);

    if (!wanted.length) return [];

    const results = await Promise.all(wanted.map(async ({ path }) => {
      const raw = `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${encodeURI(path)}`;
      let r;
      try { r = await fetchImpl(raw); } catch { return null; }
      if (r.status === 429 || r.status === 403) return null;
      if (!r.ok) return null;
      const text = await r.text();
      if (text.length > MAX_LOCKFILE_BYTES) return null;
      // `filename` keeps the full path so an advisory can be traced to the
      // tree it came from - two package-lock.json files are two answers.
      return { filename: path, content: text };
    }));
    const found = results.filter(Boolean);
    if (found.length > 0) return found;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Source-code discovery for the SAST pass
// ---------------------------------------------------------------------------
//
// The dependency audit answers "are the packages you install known-bad". It
// says nothing about the code in the repository, which is where most of a
// team's own vulnerabilities live. This fetch is what gives the source
// scanner something to read on the `repoUrl` path.
//
// Every bound here exists because this runs inside a Worker with a subrequest
// budget and a CPU limit, and because a scan that times out is worth less than
// a smaller scan that finishes and says what it skipped.

// What counts as a source file is DERIVED from the language registry
// (analyzers/sast/languages.js), not written out here.
//
// It used to be a literal thirteen-extension regex, and that regex was the
// scanner's real coverage boundary: a Rust, C#, Swift, Kotlin, Solidity or
// Terraform repository matched nothing, was fetched as zero files, and was
// reported `no_source_files` — "No files in a language this scanner reads were
// found". A reader takes that to mean the repository has nothing worth
// scanning. It meant we never looked.
//
// Eleven rules in the SAST registry are tagged `languages: ["*"]` and fire on
// any text. They could have run on every one of those repositories. Deriving
// the filter from the registry is what connects them: adding a language there
// now makes its files fetched, scanned and profiled, with no edit here.
const SOURCE_NAME_RE = /(?:^|\/)(?:\.github\/workflows\/[\w.-]+\.ya?ml)$/i;

/** Extensions the registry knows, as one anchored alternation. */
const SOURCE_EXT_RE = new RegExp(
  `\\.(?:${ALL_KNOWN_EXTENSIONS.map((e) => e.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})$`, "i");

/** Exact basenames worth fetching: hand-authored manifests plus extensionless
 *  languages. Generated lockfiles are excluded — see FETCHABLE_FILENAMES. */
const SOURCE_BASENAMES = new Set(FETCHABLE_FILENAMES);

/**
 * True when the tree entry is something the scanner can use.
 *
 * Three ways in, and the second is the one the old regex could not express: a
 * manifest like `requirements.txt` or `go.mod` carries no language extension
 * and is exactly what the dependency audit reads.
 */
const GENERATED_LOCKFILE_SET = new Set(GENERATED_LOCKFILES);

function isScannablePath(path) {
  const base = String(path).replace(/\\/g, "/").split("/").pop().toLowerCase();
  // Checked FIRST, because a generated lockfile also matches by extension:
  // `package-lock.json` is `.json`, which the registry knows. It is hundreds
  // of kilobytes of machine-written content that the dependency audit already
  // fetches through its own path, and no source rule can say anything useful
  // about it — so letting it in spends two of the scan's scarcest budgets
  // (120 files, 3 MB) to learn nothing.
  if (GENERATED_LOCKFILE_SET.has(base)) return false;
  if (SOURCE_BASENAMES.has(base)) return true;
  if (base === "dockerfile" || base.startsWith("dockerfile.")) return true;
  if (base === ".env" || base.startsWith(".env.")) return true;
  if (base.endsWith(".csproj") || base.endsWith(".fsproj")) return true;
  return SOURCE_EXT_RE.test(base) || SOURCE_NAME_RE.test(path);
}
// Directories whose contents are somebody else's code, generated, or a
// deliberate collection of bad examples. Scanning our own test fixtures would
// report the scanner's own corpus as vulnerabilities — which is true and
// useless.
// Exported: the CI ingest path needs the SAME exclusions. It did not have
// them, and the consequence was immediate and embarrassing — the gate scanned
// this repository's own deliberately-vulnerable corpus under
// scripts/fixtures/sast/vulnerable/ and reported 533 findings, 23 critical,
// on a pull request that introduced none of them. True, and useless, which is
// exactly what this list exists to prevent. One definition, both paths.
export const SOURCE_SKIP_RE = /(^|\/)(node_modules|vendor|bundle|\.git|dist|build|out|coverage|_site|target|\.next|\.venv|venv|__pycache__|site-packages|third_party|fixtures?|__fixtures__|testdata)(\/|$)/i;
const MAX_SOURCE_FILES = 120;
const MAX_SOURCE_FILE_BYTES = 200 * 1024;
const MAX_SOURCE_TOTAL_BYTES = 3 * 1024 * 1024;

/**
 * Fetch a bounded set of source files for the SAST pass.
 *
 * Returns `{ files, truncated, totalInRepo }`, or null when the tree cannot be
 * listed at all. Null is NOT an empty list: a private repo, a renamed default
 * branch, or a throttle must never be reported as "we read your code and it
 * was clean". The caller renders the two differently.
 */
async function discoverSourceFiles({ owner, repo }, fetchImpl, env) {
  const headers = { "User-Agent": "algosize-sast", Accept: "application/vnd.github+json" };
  if (env && env.GITHUB_TOKEN) headers.Authorization = `Bearer ${env.GITHUB_TOKEN}`;

  for (const branch of ["main", "master"]) {
    let res;
    try {
      res = await fetchImpl(
        `https://api.github.com/repos/${owner}/${repo}/git/trees/${branch}?recursive=1`,
        { headers });
    } catch { continue; }
    if (res.status === 429 || res.status === 403) return null;
    if (!res.ok) continue;

    let body;
    try { body = await res.json(); } catch { continue; }
    const entries = Array.isArray(body && body.tree) ? body.tree : [];

    const blobs = entries.filter((e) => e && e.type === "blob" && typeof e.path === "string");

    // Profile the WHOLE tree, not the eligible subset. The profiler's job is
    // to describe the repository — including the parts this scan will not
    // read — so handing it the post-filter list would produce a coverage
    // report that never mentions a gap, which is the one thing a coverage
    // report exists to do.
    const profile = profileRepository({ entries: blobs.map((e) => ({ path: e.path, size: e.size })) });

    const eligible = blobs
      .filter((e) => isScannablePath(e.path))
      .filter((e) => !SOURCE_SKIP_RE.test(e.path))
      .filter((e) => !/\.(?:min|bundle)\.js$/i.test(e.path))
      .filter((e) => !(typeof e.size === "number" && e.size > MAX_SOURCE_FILE_BYTES));

    if (!eligible.length) return { files: [], truncated: false, totalInRepo: 0, profile };

    // Shallowest first. When the cap bites, application code near the root
    // beats a deeply nested script — and the response says it was capped.
    const wanted = eligible
      .sort((a, b) => a.path.split("/").length - b.path.split("/").length ||
                      (a.path < b.path ? -1 : 1))
      .slice(0, MAX_SOURCE_FILES);

    let budget = MAX_SOURCE_TOTAL_BYTES;
    const results = await Promise.all(wanted.map(async ({ path }) => {
      if (budget <= 0) return null;
      let r;
      try {
        r = await fetchImpl(`https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${encodeURI(path)}`);
      } catch { return null; }
      if (!r.ok) return null;
      const content = await r.text();
      if (content.length > MAX_SOURCE_FILE_BYTES) return null;
      budget -= content.length;
      if (budget < 0) return null;
      return { path, content };
    }));

    const files = results.filter(Boolean);
    if (files.length > 0 || eligible.length === 0) {
      // Re-profile with the manifests we now hold. Dependency names are the
      // strongest framework signal there is, and they exist only in file
      // CONTENT — the first pass, from paths alone, can see that a
      // package.json is present but not that it depends on `next`.
      const contents = {};
      for (const f of files) contents[f.path] = f.content;
      const enriched = profileRepository({
        entries: blobs.map((e) => ({ path: e.path, size: e.size })),
        contents,
      });
      return {
        files,
        truncated: eligible.length > files.length,
        totalInRepo: eligible.length,
        profile: enriched,
      };
    }
  }
  return null;
}

async function fetchLockfilesFromGithub({ owner, repo }, fetchImpl, env) {
  const discovered = await discoverLockfiles({ owner, repo }, fetchImpl, env);
  if (discovered !== null && discovered.length > 0) return discovered;

  for (const branch of ["main", "master"]) {
    const fetches = LOCKFILE_NAMES.map(async (filename) => {
      const url = `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${filename}`;
      let res;
      try { res = await fetchImpl(url); }
      catch { return { filename, status: 0, content: null }; }
      if (res.status === 404) return { filename, status: 404, content: null };
      // 429/403 is GitHub throttling us, not "this repo has no lockfiles".
      // Treating them as a miss produced a confident `no_lockfiles_found`
      // 404 — telling the user their repo has no dependencies to audit when
      // in truth we were rate-limited and never looked.
      if (res.status === 429 || res.status === 403) {
        const e = new Error(
          "GitHub is rate-limiting our requests for this repo's lockfiles. Wait a minute and try again.",
        );
        e.fetchError = true; e.code = "github_rate_limited"; e.status = 503;
        throw e;
      }
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
  try {
    result = await Promise.resolve(analyzeVuln(validation.value));
    // Same verdict block the dependency audit returns, so a caller can read
    // one shape regardless of which mode they used.
    result = { ...result, summary: buildAuditSummary({ findings: result.findings }) };
  }
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

/**
 * The dependency audit, as a Response.
 *
 * Exported because the scheduled monitor consumer (src/monitors/run.js) runs
 * exactly this — same fetch, same parse, same OSV lookup, same summary — so
 * a monitored repo and a manually-scanned one can never produce different
 * verdicts. It returns a Response rather than the raw result because that is
 * what the HTTP path needs and what every error branch below already
 * produces; the consumer reads the JSON body back out. `request` is only
 * used for observability context and may be null.
 */
export async function runLockfileAudit(body, env, request, ctx) {
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
    manifests = await fetchLockfilesFromGithub(repo, fetchImpl, env);
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

  // The parse → OSV → summarise core is shared with the CI ingestion endpoint
  // (handlers/ci.js), which submits lockfile CONTENT instead of a repo URL.
  // Same computation either way: CI supplies inputs and the Worker computes
  // the report, so a CI verdict and a dashboard verdict on the same lockfile
  // can never disagree.
  const audit = await auditManifests(manifests, fetchImpl, { env, ctx, request, userId });
  if (!audit.ok) return json(audit.body, audit.status);

  // The source scan rides along, and fails SOFT. The dependency audit is the
  // contract this endpoint has always honoured; a GitHub hiccup while reading
  // source must degrade to "we could not read the code" beside a complete
  // advisory list, never to a 502 that loses both. `status` carries which of
  // those happened so the UI never renders an unread repository as clean.
  const source = await runSourceScan(repo, fetchImpl, env, ctx, request, userId);

  return json({
    repoUrl: `https://github.com/${repo.owner}/${repo.repo}`,
    ...audit.result,
    source,
    analyzerVersion: analyzerVersion(env),
  }, 200);
}

/**
 * Scan repository source, as a block that is always present and always says
 * what state it is in.
 *
 * There is no branch here that returns undefined or omits the block. A
 * missing key reads as "this feature does not exist" and an empty findings
 * list reads as "your code is clean" — and both are wrong when what actually
 * happened is that the tree could not be listed. Every path sets `status`.
 */
async function runSourceScan(repo, fetchImpl, env, ctx, request, userId) {
  let discovered;
  try {
    discovered = await discoverSourceFiles(repo, fetchImpl, env);
  } catch (err) {
    try {
      await captureException(env || {}, ctx, err, {
        request, userId,
        tags: { source: "analyzer", analyzer: "analyze/vuln", subpath: "source_fetch",
                upstream: "github.com" },
      });
    } catch { /* observability must never mask the audit */ }
    discovered = null;
  }

  if (discovered === null) {
    return {
      status: "unavailable",
      message: "The repository's source could not be read (private repository, or GitHub rate-limited the request). The dependency audit above is unaffected.",
      findings: [], summary: null, coverage: null,
    };
  }
  if (!discovered.files.length) {
    const profile = (discovered.profile && discovered.profile.repositoryProfile) || null;
    return {
      status: "no_source_files",
      // The profile is what turns this from a dead end into an answer. This
      // branch used to say only "no files in a language this scanner reads",
      // which is the same sentence for an empty repository and for a Rust
      // codebase the extension filter silently excluded. Now it can name what
      // IS there and why none of it was read.
      message: profile && profile.languages.length
        ? `No readable source files were fetched. ${discovered.profile.summary}`
        : "No files in a language this scanner reads were found in the repository.",
      findings: [], summary: null, coverage: null,
      profile,
      profileSummary: (discovered.profile && discovered.profile.summary) || null,
    };
  }

  try {
    const result = analyzeVuln({ files: discovered.files });
    return {
      status: "ok",
      findings: result.findings,
      summary: result.summary,
      coverage: {
        ...result.coverage,
        filesEligible: discovered.totalInRepo,
        truncated: discovered.truncated,
      },
      // What the scanner decided it could do with this repository, and what it
      // could not. Present on every ok scan so a reader never has to infer
      // coverage from the absence of findings.
      profile: (discovered.profile && discovered.profile.repositoryProfile) || null,
      profileSummary: (discovered.profile && discovered.profile.summary) || null,
    };
  } catch (err) {
    console.error("analyze/vuln: source scan error", err);
    try {
      await captureException(env || {}, ctx, err, {
        request, userId,
        tags: { source: "analyzer", analyzer: "analyze/vuln", subpath: "source_scan" },
      });
    } catch { /* as above */ }
    return {
      status: "failed",
      message: "The source scanner errored on this repository. The dependency audit above is unaffected.",
      findings: [], summary: null, coverage: null,
    };
  }
}

/**
 * Parse manifests, query OSV, and build the audit verdict.
 *
 * Returns `{ ok: true, result }` or `{ ok: false, status, body }` rather than a
 * Response, because two callers need different envelopes around the same
 * answer: the HTTP analyzer wraps it with the repo URL it fetched from, and the
 * CI endpoint wraps it with the commit it was computed for.
 *
 * `manifests` are `{ filename, content }` pairs — already fetched or already
 * submitted; this function performs no IO of its own beyond the OSV lookup.
 */
export async function auditManifests(manifests, fetchImpl, { env, ctx, request, userId } = {}) {
  // Parse each manifest. A single bad lockfile fails the whole audit — same
  // posture as the CUR analyzer (we want the user to fix obvious garbage
  // rather than getting a half-correct CVE list).
  const allPackages = [];
  const summary = [];
  // Set when the per-audit package cap cuts the list short, so the response
  // can say the audit was partial instead of implying full coverage.
  let truncatedPackages = false;
  let totalPackagesFound = 0;
  for (const m of manifests) {
    let parsed;
    try { parsed = parseLockfile(m.filename, m.content); }
    catch (err) {
      if (err && err.lockfileError) {
        return { ok: false, status: 400, body: {
          error: "invalid_lockfile",
          message: `${m.filename}: ${err.message}`,
          helpUrl: VULN_HELP_URL,
        } };
      }
      throw err;
    }
    summary.push({
      filename: m.filename,
      ecosystem: parsed.ecosystem,
      packageCount: parsed.packages.length,
    });
    totalPackagesFound += parsed.packages.length;
    for (const p of parsed.packages) {
      if (allPackages.length >= MAX_PACKAGES_PER_AUDIT) { truncatedPackages = true; continue; }
      allPackages.push({ name: p.name, version: p.version, ecosystem: parsed.ecosystem });
    }
  }

  let advisories = [];
  // Truncation counters — filled in by the OSV client so the response can
  // admit when the audit was partial (see analyzers/audit.js `complete`).
  const partial = {
    filesTruncated: truncatedPackages,
    packagesTruncated: false,
    vulnsTruncated: false,
  };
  if (allPackages.length > 0) {
    try {
      const matches = await osvBatchQuery(allPackages, fetchImpl, partial);
      advisories = await osvHydrateVulns(matches, fetchImpl, partial);
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
      return { ok: false, status: 502, body: {
        error: "osv_unavailable",
        message: "Couldn't reach OSV.dev to look up advisories. Try again in a moment.",
        helpUrl: VULN_HELP_URL,
      } };
    }
  }

  const fixCommand = pickFixCommand(summary);
  return { ok: true, result: {
    scanned: {
      manifests: summary,
      totalPackages: allPackages.length,
      // When the cap bit, `totalPackages` is what we audited and
      // `packagesFound` is what was actually in the lockfiles.
      packagesFound: totalPackagesFound,
    },
    // The audited package list, kept so a CycloneDX SBOM can be produced from
    // a stored run without re-fetching and re-parsing the lockfiles — which we
    // could not do anyway, since we deliberately do not retain lockfile
    // content (see handlers/ci.js). Bounded by MAX_PACKAGES_PER_AUDIT (1000),
    // so this adds tens of KB to the stored result at worst.
    //
    // These are the packages that were AUDITED. When `scanned.packagesFound`
    // exceeds `scanned.totalPackages` the lockfiles held more than the cap and
    // the SBOM is correspondingly partial — which toCycloneDX records rather
    // than presenting a truncated inventory as a complete one.
    packages: allPackages,
    counts: countSeverities(advisories),
    advisories,
    topAdvisories: advisories.slice(0, 10),
    fixCommand,
    summary: buildAuditSummary({ advisories, fixCommand, partial }),
  } };
}

// ---------------------------------------------------------------------------
// Algorithm optimizer (Task #16) — sandbox + LLM
// ---------------------------------------------------------------------------

/**
 * Invoke the sandbox. Prefers the SANDBOX service binding when available
 * (so a runaway user loop only burns CPU on the sibling Worker), else falls
 * back to in-process execution so single-Worker dev mode and tests work.
 */
// Exported for the scheduled monitors' optimizer pass (monitors/analyzers.js)
// — the same sandbox invoker the dashboard endpoint uses, so a nightly grade
// and an on-demand grade for the same function can never disagree about how
// the code was run.
export async function runInSandbox(env, code, input) {
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
  // No service binding. The in-process runner compiles the submitted function
  // with `new Function`, which works in Node — the Replit server, the CI
  // entrypoint, the test suite — and which a Cloudflare Workers isolate
  // forbids outright. So inside a deployed Worker this fallback cannot run at
  // all, and what came back was V8's own sentence wearing the wrong label:
  //
  //   { error: "compile_error",
  //     message: "Code generation from strings disallowed for this context" }
  //
  // `compile_error` blames the user's function for something the runtime
  // refused to do to any input, and the message names nothing anyone can act
  // on. The nightly optimizer sweep surfaced exactly that, once per entry —
  // "bigo-mean — Code generation from strings disallowed for this context" —
  // so a monitor with a perfectly valid config read as a config problem.
  const fallback = await runUserCode(code, input);
  if (fallback && fallback.ok === false && /code generation from strings/i.test(fallback.message || "")) {
    return {
      ok: false,
      error: "sandbox_not_configured",
      message: "The SANDBOX service binding is not available, and this runtime cannot " +
               "execute submitted code without it. Deploy the algosize-sandbox Worker " +
               "and bind it as SANDBOX (see worker/wrangler.toml).",
    };
  }
  return fallback;
}

async function runAlgoSandbox(body, env) {
  // The whole pipeline — validation, sample run, Big-O probe, refactor
  // suggestion — lives in analyzers/optimizer.js so the CI entrypoint
  // (scripts/optimizer-ci.mjs) runs the exact same implementation. This
  // wrapper only contributes what is HTTP- or Worker-shaped: the sandbox
  // service binding and the Response envelope.
  const v = validateOptimizerInput(body);
  if (!v.ok) return json({ error: v.error, message: v.message }, 400);

  const result = await runOptimizer(v.value, {
    runner: (code, input) => runInSandbox(env, code, input),
    env,
  });
  if (!result.ok) {
    return json({ error: result.error, message: result.message, ms: result.ms }, 400);
  }

  return json({
    wallTimeMs: result.wallTimeMs,
    heapBytes: result.heapBytes,
    sampleResult: result.sampleResult,
    truncated: result.truncated,
    bigO: result.bigO,
    suggestion: result.suggestion,
    sandbox: env && env.SANDBOX ? "service_binding" : "in_process",
    analyzerVersion: analyzerVersion(env),
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

/**
 * POST /api/analyze/architecture
 *
 * Body: `{ files: [{ path, content }, ...] }` — manifests, configs and source
 * submitted by the dashboard or by CI. Returns `{ graph, findings,
 * recommendations, summary, limits }`.
 *
 * Pure static analysis: no network, no LLM, and nothing is fetched from the
 * infrastructure being analyzed. The whole input arrives in the request body,
 * which is also why the analyzer enforces its own size caps rather than
 * relying on the platform's.
 */
/**
 * POST /api/analyze/profile — the repository profiler as a standalone answer.
 *
 * Body: `{ repoUrl }`.
 *
 * Free and unmetered, deliberately. It reads one git-tree listing and no file
 * contents, so it costs a single upstream request; and its whole purpose is to
 * let someone find out what a scan WOULD cover before paying for one. Metering
 * the question "will this tool even work on my repository?" is how a scanner
 * gets a reputation for being useless on languages it simply never told anyone
 * it could not read.
 *
 * The same profile rides along inside every repo scan's `source.profile`, so
 * this endpoint adds a surface rather than a second code path.
 */
export async function analyzeProfileHandler(request, env, ctx) {
  let body;
  try { body = await request.json(); }
  catch { return json({ error: "invalid_json", message: "request body must be valid JSON" }, 400); }

  const repo = parseGithubUrl(body && body.repoUrl);
  if (!repo) {
    return json({
      error: "invalid_repo_url",
      message: "`repoUrl` must be a public GitHub repository URL, e.g. https://github.com/owner/name",
    }, 400);
  }

  const fetchImpl = (env && env.FETCH) || fetch;
  let discovered;
  try {
    discovered = await discoverSourceFiles(repo, fetchImpl, env);
  } catch (err) {
    await captureException(env, ctx, err, {
      request, userId: request.user && request.user.userId,
      tags: { source: "analyzer", analyzer: "analyze/profile", upstream: "github.com" },
    });
    discovered = null;
  }

  // Same rule as the scan: an unreadable repository is reported as unreadable,
  // never as a repository with no languages in it.
  if (!discovered || !discovered.profile) {
    return json({
      error: "repo_unreadable",
      message: "The repository's tree could not be listed (private repository, or GitHub rate-limited the request).",
    }, 502);
  }

  return json({
    repoUrl: `https://github.com/${repo.owner}/${repo.repo}`,
    ...discovered.profile,
  }, 200);
}

export async function analyzeArchitectureHandler(request, env, ctx) {
  let body;
  try { body = await request.json(); }
  catch { return json({ error: "invalid_json", message: "request body must be valid JSON" }, 400); }

  const validation = validateArchitectureInput(body);
  if (!validation.ok) {
    return json({ error: validation.error, message: validation.message }, 400);
  }

  let result;
  try {
    result = analyzeArchitecture(validation.value);
  } catch (err) {
    console.error("analyze/architecture: engine error", err);
    await captureException(env, ctx, err, {
      request,
      userId: request.user && request.user.userId,
      tags:   { source: "analyzer", analyzer: "analyze/architecture" },
    });
    return json({ error: "analyzer_failed", message: "could not analyze the submitted files" }, 500);
  }

  const response = json(result, 200);
  // Persist the FINDINGS and summary, not the submitted source. An
  // architecture submission is the customer's entire codebase; storing it in
  // run history would turn a convenience feature into a second copy of their
  // repository, and `safeInput` would silently truncate it anyway.
  await maybePersist(
    ctx, env, request, "arch",
    { fileCount: validation.value.files.length, paths: validation.value.files.slice(0, 50).map((f) => f.path) },
    response,
  );
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
  return json({ ...result, analyzerVersion: analyzerVersion(env) }, 200);
}

