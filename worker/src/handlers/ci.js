// CI ingestion — the endpoint a customer's build pipeline posts to.
//
//   POST /api/ci/runs      run the audit on submitted lockfiles and/or the
//                          architecture analysis on submitted manifests and
//                          source, storing one run per analyzer
//   GET  /api/ci/snippet   the workflow YAML, for the dashboard to render
//
// TWO ANALYZERS, ONE REQUEST. `lockfiles` drives the dependency audit and
// `files` drives the Architecture X-ray; both are optional and at least one
// must be present. They travel together because a pipeline that has already
// checked out the repository should not pay for two round trips, and because
// one CI invocation is one logical run of "audit my repo" — the quota gate
// upstream counts it once for the same reason.
//
// Each analyzer still files its OWN row (analyzer "vuln" / "arch", both with
// source "ci"), because the runs table stores one analyzer per row and the
// dashboard's feed filters on it. A combined row would have to invent a
// severity scale spanning advisories and architecture findings, which are not
// the same unit.
//
// API KEY ONLY. A cookie session is refused even though requireAuth would
// happily accept one, for two reasons. A browser session is a human sitting
// in front of a page — that path is /api/analyze/vuln, which already exists.
// And a cookie is CSRF-reachable in a way a bearer token is not: if this
// endpoint accepted cookies, any page a signed-in user visited could post
// runs into their history. The key is the credential CI is meant to hold,
// and it is the only one accepted.
//
// CI SUBMITS INPUTS, THE WORKER COMPUTES THE REPORT. The body carries lockfile
// content, never findings. A client-computed verdict is a verdict the customer
// can edit — accepting one would mean a build could report itself clean by
// posting an empty advisory list, and every report we store would be
// unfalsifiable. The same auditManifests() the dashboard analyzer calls runs
// here, so both paths produce the same answer from the same bytes.

import { auditManifests, SOURCE_SKIP_RE } from "./analyze.js";
import { analyzeVuln } from "../analyzers/vuln.js";
import { persistRun } from "./runs.js";
import { decorateSourceWithAcceptances } from "../risk/decorate.js";
import { storeReportFor } from "../reports/render.js";
import { SUPPORTED_FILES as LOCKFILE_NAMES, MAX_LOCKFILE_BYTES } from "../analyzers/lockfile.js";
import { validateArchitectureInput, analyzeArchitecture } from "../analyzers/architecture.js";
import { recordSnapshot } from "../arch/snapshots.js";
import { captureException } from "../observability.js";
import { analyzerVersion } from "../analyzer-version.js";

// Total submitted bytes. Generous next to the per-file cap (a monorepo can
// legitimately have a dozen lockfiles) but bounded, because this endpoint is
// reachable by any valid key and a Worker has a fixed memory ceiling.
export const MAX_TOTAL_LOCKFILE_BYTES = 8 * 1024 * 1024;
export const MAX_LOCKFILES = 50;

// Severity ordering, worst first. `fail_on` names the threshold at which the
// build should break.
const SEVERITY_ORDER = ["critical", "high", "medium", "low"];
const FAIL_ON_VALUES = [...SEVERITY_ORDER, "none"];
const DEFAULT_FAIL_ON = "high";

// Architecture findings do NOT break the build unless asked to. A published
// advisory is a fact about a version; an architecture finding is a judgement
// about a design, and the two do not deserve the same default. A pipeline that
// starts going red on design opinions the moment someone adds `files` to their
// payload is a pipeline people delete — the same reasoning the workflow's
// missing-key guard is built on. Opt in with `arch_fail_on`.
const DEFAULT_ARCH_FAIL_ON = "none";

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

/**
 * Whether a set of severity counts trips the configured threshold.
 *
 * `fail_on: "high"` means "fail on high AND anything worse" — a critical must
 * never pass a gate set at high. `"none"` never fails, for teams that want the
 * report and the Security-tab upload without blocking the build yet.
 */
export function shouldFail(counts, failOn = DEFAULT_FAIL_ON) {
  if (failOn === "none") return false;
  const threshold = SEVERITY_ORDER.indexOf(failOn);
  if (threshold < 0) return false;
  for (let i = 0; i <= threshold; i++) {
    if ((counts[SEVERITY_ORDER[i]] || 0) > 0) return true;
  }
  return false;
}

/** The worst severity actually present, or null for a clean run. */
export function worstSeverityOf(counts) {
  for (const s of SEVERITY_ORDER) if ((counts[s] || 0) > 0) return s;
  return null;
}

// At most this many graded entries per report. The gate already caps what it
// audits; this is the boundary's own limit so a hand-rolled POST cannot file
// an unbounded row.
const MAX_OPTIMIZER_ENTRIES = 100;
const OPTIMIZER_VERDICTS = ["ok", "unknown", "regression", "error"];

/**
 * Validate the `optimizer` block: the report scripts/optimizer-ci.mjs writes.
 *
 * Returns { value } when present and well-formed, { value: null } when absent,
 * or { error } — the same shape validate() returns — when present and wrong.
 * Absent is not an error: most submissions are a dependency audit and say
 * nothing about the optimizer.
 *
 * Only the fields the runs feed renders are kept. The report also carries
 * per-probe timings, and copying those in would put the customer's measured
 * performance data in our database for no reader.
 */
function validateOptimizerReport(raw) {
  if (raw === undefined || raw === null) return { value: null };
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return { error: { ok: false, status: 400, error: "invalid_optimizer",
      message: "`optimizer` must be the JSON report object written by the optimizer gate." } };
  }
  const results = Array.isArray(raw.results) ? raw.results : null;
  if (!results) {
    return { error: { ok: false, status: 400, error: "invalid_optimizer",
      message: "`optimizer.results` must be an array of graded entries." } };
  }
  if (results.length > MAX_OPTIMIZER_ENTRIES) {
    return { error: { ok: false, status: 413, error: "too_many_optimizer_entries",
      message: `Submit at most ${MAX_OPTIMIZER_ENTRIES} graded entries per run (received ${results.length}).` } };
  }

  const str = (v, max) => (typeof v === "string" ? v.slice(0, max) : null);
  const entries = results.map((r) => ({
    name:         str(r && r.name, 200),
    functionName: str(r && r.functionName, 200),
    file:         str(r && r.file, 500),
    grade:        str(r && r.bigO && r.bigO.label, 40),
    ceiling:      str(r && r.ceiling, 40),
    verdict:      OPTIMIZER_VERDICTS.includes(r && r.verdict) ? r.verdict : "unknown",
  }));
  const count = (v) => entries.filter((e) => e.verdict === v).length;

  return {
    value: {
      audited:     entries.length,
      ok:          count("ok"),
      unknown:     count("unknown"),
      regressions: count("regression"),
      errors:      count("error"),
      entries,
    },
  };
}

function validate(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, status: 400, error: "invalid_payload", message: "Request body must be a JSON object." };
  }

  const lockfiles = Array.isArray(body.lockfiles) ? body.lockfiles : [];
  const archFiles = Array.isArray(body.files) ? body.files : [];

  // The optimizer is the one analyzer whose CI measurement happens in the
  // CUSTOMER'S runner, not here: grading a function means executing it, and
  // the gate runs it in-process under Node against the PR's own checkout. So
  // this endpoint receives a finished report rather than input to analyse —
  // which is why it is accepted as its own kind of submission, and why the
  // run it files records that the numbers were measured there.
  //
  // Without it the optimizer was the only gate that could not appear in the
  // runs feed at all: it called no endpoint, so a nightly regression and a CI
  // regression lived in two different places and only one of them was the
  // product.
  const optimizerReport = validateOptimizerReport(body.optimizer);
  if (optimizerReport.error) return optimizerReport.error;

  if (lockfiles.length === 0 && archFiles.length === 0 && !optimizerReport.value) {
    return {
      ok: false, status: 400, error: "no_inputs",
      message: "Provide `lockfiles` (dependency audit), `files` (architecture analysis) " +
               "and/or `optimizer` (a complexity report from the optimizer gate). " +
               `Supported lockfiles: ${LOCKFILE_NAMES.join(", ")}.`,
    };
  }
  if (lockfiles.length > MAX_LOCKFILES) {
    return {
      ok: false, status: 413, error: "too_many_lockfiles",
      message: `Submit at most ${MAX_LOCKFILES} lockfiles per run (received ${lockfiles.length}).`,
    };
  }

  const failOn = body.fail_on === undefined || body.fail_on === null ? DEFAULT_FAIL_ON : body.fail_on;
  if (!FAIL_ON_VALUES.includes(failOn)) {
    return {
      ok: false, status: 400, error: "invalid_fail_on",
      message: `\`fail_on\` must be one of: ${FAIL_ON_VALUES.join(", ")}.`,
    };
  }

  const archFailOn = body.arch_fail_on === undefined || body.arch_fail_on === null
    ? DEFAULT_ARCH_FAIL_ON
    : body.arch_fail_on;
  if (!FAIL_ON_VALUES.includes(archFailOn)) {
    return {
      ok: false, status: 400, error: "invalid_arch_fail_on",
      message: `\`arch_fail_on\` must be one of: ${FAIL_ON_VALUES.join(", ")}.`,
    };
  }

  const manifests = [];
  let totalBytes = 0;

  for (const f of lockfiles) {
    if (!f || typeof f !== "object") continue;
    const path = typeof f.path === "string" ? f.path.trim().replace(/^\.\//, "") : "";
    const content = typeof f.content === "string" ? f.content : "";
    if (!path || !content) continue;

    const filename = path.split("/").pop();
    // Unsupported names are dropped, not rejected: a workflow that globs the
    // repo will pick up files we cannot parse, and failing the whole run over
    // one of them would make the step feel broken rather than selective.
    if (!LOCKFILE_NAMES.includes(filename)) continue;

    if (content.length > MAX_LOCKFILE_BYTES) {
      return {
        ok: false, status: 413, error: "lockfile_too_large",
        message: `${path} is ${Math.round(content.length / 1024)} KB, over the ${Math.round(MAX_LOCKFILE_BYTES / 1024)} KB per-file limit. ` +
                 `Submit it on its own, or exclude it from the glob in your workflow.`,
      };
    }
    totalBytes += content.length;
    if (totalBytes > MAX_TOTAL_LOCKFILE_BYTES) {
      return {
        ok: false, status: 413, error: "payload_too_large",
        message: `Total lockfile content exceeds ${Math.round(MAX_TOTAL_LOCKFILE_BYTES / 1024 / 1024)} MB. ` +
                 `Split the run, or narrow which lockfiles the workflow collects.`,
      };
    }
    manifests.push({ filename, path, content });
  }

  // Only fatal when there is nothing else to do. A workflow that globs the
  // repo can legitimately hand us architecture inputs and no recognisable
  // lockfile — failing that run would report the whole audit as broken over
  // the half the caller never asked for. The optimizer gate submits neither:
  // it posts a finished complexity report and nothing else, so it counts as
  // something else to do just as architecture inputs do.
  if (manifests.length === 0 && archFiles.length === 0 && !optimizerReport.value) {
    return {
      ok: false, status: 400, error: "no_supported_lockfiles",
      message: `None of the submitted files is a supported lockfile. Supported: ${LOCKFILE_NAMES.join(", ")}.`,
    };
  }

  // Architecture input is validated by the analyzer's OWN validator, not a
  // second copy of the same rules here: the caps, the oversized-file handling
  // and the wording then cannot drift from the dashboard path that shares it.
  let archInput = null;
  if (archFiles.length > 0) {
    const av = validateArchitectureInput({ files: archFiles });
    if (!av.ok) {
      const status = av.error === "too_many_files" || av.error === "payload_too_large" ? 413 : 400;
      return { ok: false, status, error: av.error, message: av.message };
    }
    archInput = av.value;
  }

  return {
    ok: true,
    value: {
      repo:      typeof body.repo === "string" ? body.repo.slice(0, 200) : null,
      ref:       typeof body.ref === "string" ? body.ref.slice(0, 200) : null,
      commitSha: typeof body.commit_sha === "string" ? body.commit_sha.slice(0, 64) : null,
      failOn,
      archFailOn,
      manifests,
      archInput,
      optimizer: optimizerReport.value,
    },
  };
}

// ---------------------------------------------------------------------------
// POST /api/ci/runs
// ---------------------------------------------------------------------------
export async function ciRunHandler(request, env, ctx) {
  // API key only — see the module header.
  if (request.authMethod !== "api_key" || !request.org || !request.org.orgId) {
    return json({
      error: "api_key_required",
      message: "This endpoint accepts an Algosize API key only (Authorization: Bearer ask_live_…). " +
               "Create one in the dashboard under API keys.",
    }, 401);
  }
  const orgId = request.org.orgId;

  let body;
  try { body = await request.json(); }
  catch { return json({ error: "invalid_json", message: "Request body must be valid JSON." }, 400); }

  const v = validate(body);
  if (!v.ok) return json({ error: v.error, message: v.message }, v.status);

  const fetchImpl = (env && env.FETCH) || globalThis.fetch;
  const origin = (env.SITE_ORIGIN || "").replace(/\/$/, "");
  const version = analyzerVersion(env);
  const ciContext = { repo: v.value.repo, ref: v.value.ref, commitSha: v.value.commitSha };

  // ---------------------------------------------------------------------
  // Source scan — on the files the workflow ALREADY submits
  // ---------------------------------------------------------------------
  //
  // `files` has always carried real source content: the architecture step
  // globs .js/.ts/.py/.go and posts it so the X-ray can find import edges.
  // Those same bytes are exactly what the SAST engine wants, and until now
  // the gate read them for architecture and threw the security half away.
  //
  // So this costs no extra upload, no extra workflow step, and no second
  // trip: the PR comment stops being a severity table that speaks only for
  // third-party packages, which is what it was on every repository including
  // this one's own pull requests.
  //
  // Fails SOFT. The dependency audit is the contract this endpoint has always
  // honoured, and a source-scanner bug must degrade to "the code was not
  // scanned" beside a complete advisory list — never take the gate down.
  let sourceScan = null;
  // The SAME exclusions the repo-scan path applies. The architecture glob is
  // deliberately broad — the X-ray wants every manifest it can get — but a
  // SECURITY scan of those same bytes must not read a repository's test
  // corpus. Without this filter the gate reported 533 findings and 23
  // criticals on a pull request that introduced none of them, every one from
  // this repository's own scripts/fixtures/sast/vulnerable/app.js.
  //
  // Applied server-side rather than only in the generated workflow, because a
  // workflow already installed in someone's repository does not re-generate
  // itself: fixing it here fixes every existing installation at once.
  const scanFiles = (v.value.archInput ? v.value.archInput.files : [])
    .filter((f) => !SOURCE_SKIP_RE.test(f.path));
  if (scanFiles.length) {
    try {
      const scanned = analyzeVuln({ files: scanFiles });
      sourceScan = {
        status: "ok",
        findings: scanned.findings,
        summary: scanned.summary,
        coverage: scanned.coverage,
      };
    } catch (err) {
      await captureException(env, ctx, err, {
        request, tags: { source: "ci_ingest", phase: "source_scan" },
      });
      sourceScan = {
        status: "failed",
        message: "The source scanner errored on the submitted files. The dependency audit is unaffected.",
        findings: [], summary: null, coverage: null,
      };
    }
  }

  // ---------------------------------------------------------------------
  // Dependency audit — only when lockfiles were submitted
  // ---------------------------------------------------------------------
  let vuln = null;
  if (v.value.manifests.length > 0) {
    const audit = await auditManifests(v.value.manifests, fetchImpl, { env, ctx, request });
    // A failed audit is still fatal for the whole request: it means we could
    // not answer the question the build is blocking on, and returning 200 with
    // a half-answer would let a broken audit read as a clean one.
    if (!audit.ok) return json(audit.body, audit.status);

    const counts = audit.result.counts || {};
    const failed = shouldFail(counts, v.value.failOn);

    // The stored result carries the CI context alongside the audit, so the
    // dashboard row can say which commit it was and link back to the build.
    const result = {
      ...audit.result,
      analyzerVersion: version,
      // Under the same key the dashboard and the nightly sweep use, so a CI
      // run, a manual scan and a monitored repo all render through one path.
      ...(sourceScan ? { source: sourceScan } : {}),
      ci: { ...ciContext, failOn: v.value.failOn, failed },
    };

    let run = null;
    try {
      // Awaited, not queued: the response has to carry the runId, and a report
      // URL pointing at a row that does not exist yet would 404 the moment the
      // workflow followed it.
      run = await persistRun(env, {
        orgId,
        userId: null,          // a key authenticates as the org; no human ran this
        analyzer: "vuln",
        source: "ci",
        input: {
          ...ciContext,
          // Paths only. The lockfiles themselves are the customer's source; the
          // audit has already extracted everything we need from them.
          lockfiles: v.value.manifests.map((m) => m.path),
        },
        result,
      });
    } catch (err) {
      await captureException(env, ctx, err, { request, tags: { source: "ci_ingest", phase: "persist" } });
    }

    // Render the client-facing report into R2 while the build waits for nothing:
    // this is queued, not awaited, because the workflow only needs the verdict
    // and the report URL. No-ops when the bucket is unbound.
    if (run) {
      const stored = storeReportFor(env, ctx, run).catch(() => null);
      if (ctx && typeof ctx.waitUntil === "function") ctx.waitUntil(stored);
    }

    vuln = {
      runId: run ? run.id : null,
      // The DASHBOARD viewer, not the raw API route. `/api/runs/:id/report`
      // is requireAuth (index.js), so the link a pull-request comment showed
      // every reviewer answered 401 for anyone not signed in — and for anyone
      // who was, it rendered the bare API response rather than the report they
      // would have opened from the runs feed. A link in a review thread has to
      // land somewhere a person can read.
      //
      // The API route is unchanged and still serves the machine formats the
      // workflow itself uses; only what we hand to a human moved.
      reportUrl: run ? `${origin}/dashboard/#/report/${run.id}` : null,
      summary: pickCounts(counts),
      worstSeverity: worstSeverityOf(counts),
      failed,
      // The audit succeeded but we could not file it. Returning the verdict is
      // still the right call — the build gets its answer — but the response must
      // not hand back a report URL that will 404.
      ...(run ? {} : { warning: "The audit ran but the result could not be saved, so it will not appear in the dashboard." }),
    };
  }

  // ---------------------------------------------------------------------
  // Architecture X-ray — only when `files` were submitted
  // ---------------------------------------------------------------------
  let architecture = null;
  if (v.value.archInput) {
    let archResult = null;
    try {
      archResult = analyzeArchitecture(v.value.archInput);
    } catch (err) {
      await captureException(env, ctx, err, {
        request, tags: { source: "ci_ingest", phase: "architecture" },
      });
      // With no dependency audit to fall back on there is nothing to return,
      // so this is the whole request's failure. With one, the build still gets
      // its primary verdict and the architecture half reports its own failure
      // rather than discarding an audit that worked.
      if (!vuln) {
        return json({ error: "analyzer_failed", message: "Could not analyze the submitted files." }, 500);
      }
      architecture = { runId: null, error: "analyzer_failed", failed: false };
    }

    if (archResult) {
      const bySeverity = (archResult.summary && archResult.summary.bySeverity) || {};
      const archFailed = shouldFail(bySeverity, v.value.archFailOn);

      // A versioned snapshot per CI run (migrations/0018). This is the source
      // that makes drift answerable on a pull request — "did this branch add a
      // dependency" is a question about two graphs, and the commit sha is what
      // lets a reviewer say WHICH two. Best-effort: a snapshot that fails to
      // write must never turn a passing build red.
      const archSnap = recordSnapshot(env, ctx, {
        orgId,
        repoUrl:   ciContext.repo || null,
        branch:    ciContext.ref || null,
        commitSha: ciContext.commitSha || null,
        source:    "ci",
        graph:     archResult.graph,
        findingCount: Array.isArray(archResult.findings) ? archResult.findings.length : 0,
      }).catch(() => null);
      if (ctx && typeof ctx.waitUntil === "function") ctx.waitUntil(archSnap);

      let archRun = null;
      try {
        archRun = await persistRun(env, {
          orgId,
          userId: null,
          analyzer: "arch",
          source: "ci",
          // Findings and paths, never the submitted source. An architecture
          // submission is a slice of the customer's codebase; storing it would
          // make run history a second copy of their repository — the same
          // reasoning the dashboard's architecture handler is built on.
          input: {
            ...ciContext,
            fileCount: v.value.archInput.files.length,
            paths: v.value.archInput.files.slice(0, 50).map((f) => f.path),
          },
          result: {
            ...archResult,
            analyzerVersion: version,
            ci: { ...ciContext, failOn: v.value.archFailOn, failed: archFailed },
          },
        });
      } catch (err) {
        await captureException(env, ctx, err, {
          request, tags: { source: "ci_ingest", phase: "persist_architecture" },
        });
      }

      architecture = {
        runId: archRun ? archRun.id : null,
        // An architecture run opens as the EXPLORER, not the report viewer —
        // the map is the artefact. Until this existed the gate posted counts
        // and no link at all, so the run it had just created ("3 clusters, 25
        // findings") was unreachable from the pull request that caused it.
        mapUrl: archRun ? `${origin}/dashboard/#/arch/${archRun.id}` : null,
        summary: archResult.summary,
        worstSeverity: worstSeverityOf(bySeverity),
        failed: archFailed,
        ...(archRun ? {} : { warning: "The analysis ran but the result could not be saved, so it will not appear in the dashboard." }),
      };
    }
  }

  // ---------------------------------------------------------------------
  // Algorithm optimizer — a finished report, not input to analyse
  // ---------------------------------------------------------------------
  let optimizer = null;
  if (v.value.optimizer) {
    const rep = v.value.optimizer;
    let optRun = null;
    try {
      optRun = await persistRun(env, {
        orgId,
        userId: null,
        analyzer: "algo",
        source: "ci",
        input: { ...ciContext, audited: rep.audited },
        result: {
          analyzerVersion: version,
          // `measuredBy` is not decoration. Every other run in this feed was
          // measured by us; this one was measured by the customer's runner,
          // because grading a function means executing it and the gate does
          // that against the pull request's own checkout. A reader comparing
          // a CI grade with a nightly one should be able to see that they
          // were produced in different places.
          measuredBy: "ci_runner",
          audited: rep.audited,
          ok: rep.ok,
          unknown: rep.unknown,
          regressions: rep.regressions,
          errors: rep.errors,
          entries: rep.entries,
          ci: { ...ciContext, failed: rep.regressions > 0 || rep.errors > 0 },
        },
      });
    } catch (err) {
      await captureException(env, ctx, err, {
        request, tags: { source: "ci_ingest", phase: "persist_optimizer" },
      });
    }
    optimizer = {
      runId: optRun ? optRun.id : null,
      reportUrl: optRun ? `${origin}/dashboard/#/report/${optRun.id}` : null,
      audited: rep.audited,
      regressions: rep.regressions,
      errors: rep.errors,
      ...(optRun ? {} : { warning: "The report was accepted but could not be saved, so it will not appear in the dashboard." }),
    };
  }

  // Accepted risks are applied to a SEPARATE object, built here — after every
  // persistRun above has already been awaited with the raw `sourceScan`.
  // `runs.result_json` therefore keeps what the scanner found, and the
  // acceptance stays a read-side fact that a revocation undoes everywhere at
  // once. Decorating `sourceScan` in place would have written the acceptance
  // into history and given a stale row something to carry.
  const reportedScan = await decorateSourceWithAcceptances(env, sourceScan, {
    orgId, repoUrl: ciContext.repo,
  });

  // Top-level fields keep describing the dependency audit, so every existing
  // consumer — including the workflow's own jq — reads the same shape it
  // always has. `failed` is the verdict ACROSS both analyzers, which is what a
  // build gates on; architecture contributes to it only when the caller opted
  // in via `arch_fail_on`, which defaults to "none".
  return json({
    analyzerVersion: version,
    runId:         vuln ? vuln.runId : null,
    reportUrl:     vuln ? vuln.reportUrl : null,
    summary:       vuln ? vuln.summary : pickCounts({}),
    worstSeverity: vuln ? vuln.worstSeverity : null,
    failed:        Boolean((vuln && vuln.failed) || (architecture && architecture.failed)),
    ...(vuln && vuln.warning ? { warning: vuln.warning } : {}),
    ...(architecture ? { architecture } : {}),
    // The security half of the files already submitted. Reported beside the
    // architecture block rather than folded into `summary`, because a reader
    // has to be able to tell which half a number came from: `npm audit fix`
    // clears one and does nothing for the other.
    //
    // Deliberately NOT folded into the top-level `failed` either. Source
    // findings annotate today and gate never — the same posture
    // `monthlyCeilingUsd: null` takes in algosize.budget.json. A brand-new
    // analyzer that starts failing builds on its first run gets deleted from
    // the workflow before anyone reads a finding, and then it protects nobody.
    ...(reportedScan ? { source: {
      status:   reportedScan.status,
      // `findings` and `summary` STILL COUNT EVERYTHING, accepted included.
      //
      // That is deliberate, and it is the conservative choice rather than the
      // lazy one. A workflow already installed in a customer's repository does
      // not regenerate itself, and it renders these two fields with no idea
      // that an acceptance register exists. Narrowing them to open-only would
      // make an old installation print a smaller number with nothing beside it
      // explaining where the rest went — "0 open" with no "1 accepted", which
      // is the exact failure the register was built to prevent.
      //
      // So the open/accepted split arrives as ADDITIONAL fields, and the
      // generated workflow reads them with a jq default so both shapes render.
      findings: reportedScan.status === "ok" ? reportedScan.summary.total : 0,
      summary:  reportedScan.status === "ok" ? reportedScan.summary.bySeverity : null,
      ...(reportedScan.status === "ok" && reportedScan.summary.accepted
        && reportedScan.summary.accepted.total
        ? {
            open:     reportedScan.summary.open.total,
            accepted: reportedScan.summary.accepted.total,
            // Never silently: a lapsed acceptance is open again at full
            // severity, and the build comment is where somebody would first
            // notice that a signature ran out.
            ...(reportedScan.summary.expiredAcceptances
              ? { expiredAcceptances: reportedScan.summary.expiredAcceptances } : {}),
            ...(reportedScan.summary.drifted ? { drifted: reportedScan.summary.drifted } : {}),
          }
        : {}),
      // The top few, so the comment can name something concrete instead of
      // asking the reader to go and look. Open findings first — an accepted
      // one is not what a reader of a build comment needs named.
      top: (reportedScan.findings || [])
        .filter((f) => !f.accepted)
        .slice(0, 5).map((f) => ({
          severity: f.severity, ruleId: f.ruleId, title: f.title,
          path: f.path, line: f.line, confidence: f.confidence,
        })),
      ...(reportedScan.message ? { message: reportedScan.message } : {}),
    } } : {}),
    // Deliberately NOT folded into the top-level `failed`. The optimizer gate
    // decides its own verdict from the ceilings in optimizer.config.json and
    // has already exited non-zero by the time it files this; making the
    // ingest response also assert failure would give one build two sources of
    // truth about whether it passed.
    ...(optimizer ? { optimizer } : {}),
  }, 200);
}

function pickCounts(counts) {
  return {
    critical: counts.critical || 0,
    high:     counts.high     || 0,
    medium:   counts.medium   || 0,
    low:      counts.low      || 0,
  };
}

// ---------------------------------------------------------------------------
// GET /api/ci/snippet
// ---------------------------------------------------------------------------

/**
 * The workflow YAML, for the dashboard's CI setup wizard (D-3) to render.
 *
 * Serves the same text as .github/workflows/algosize-audit.yml.example, with
 * the caller's SITE_ORIGIN substituted so a self-hosted or staging deployment
 * gets a snippet that points at itself.
 *
 * It NEVER contains a key. The workflow reads `secrets.ALGOSIZE_API_KEY`, and
 * the snippet only ever names that secret — this endpoint has no access to key
 * plaintext anyway (only sha256 hashes are stored), which is the property that
 * makes "the snippet cannot leak a key" structural rather than a promise.
 */
export function ciSnippetHandler(request, env) {
  const origin = (env.SITE_ORIGIN || "https://algosize.com").replace(/\/$/, "");
  const url = new URL(request.url);
  const failOn = FAIL_ON_VALUES.includes(url.searchParams.get("fail_on"))
    ? url.searchParams.get("fail_on")
    : DEFAULT_FAIL_ON;
  const archFailOn = FAIL_ON_VALUES.includes(url.searchParams.get("arch_fail_on"))
    ? url.searchParams.get("arch_fail_on")
    : DEFAULT_ARCH_FAIL_ON;

  return json({
    filename: ".github/workflows/algosize-audit.yml",
    secretName: "ALGOSIZE_API_KEY",
    setupSteps: [
      "Create an API key in the dashboard (API keys → Create key). Copy it — it is shown once.",
      "Add it to the repository as a secret named ALGOSIZE_API_KEY: " +
        "gh secret set ALGOSIZE_API_KEY --body '<the key>'",
      "Commit the workflow file below.",
    ],
    workflow: buildWorkflow({ origin, failOn, archFailOn }),
  }, 200);
}

export function buildWorkflow({ origin, failOn = DEFAULT_FAIL_ON, archFailOn = DEFAULT_ARCH_FAIL_ON }) {
  return `name: Algosize dependency audit

on:
  pull_request:
  push:
    branches: [main, master]
  schedule:
    # Weekly, so a dependency that becomes vulnerable between pushes is still
    # caught. New advisories are published against code that has not changed.
    - cron: "0 6 * * 1"

permissions:
  contents: read
  # Required to upload the SARIF report to the Security tab.
  security-events: write
  # Required for the sticky PR comment.
  pull-requests: write

jobs:
  audit:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      # Everything below is skipped when the secret is absent, and the job
      # passes with a notice instead of failing. A workflow that goes red the
      # moment it is pasted — before the key exists — reads as "this product
      # is broken", and the first thing anyone does with a red required check
      # is delete it. The same guard is why this file can live in the Algosize
      # repo itself before the secret is provisioned.
      - name: Check for the API key
        id: key
        env:
          ALGOSIZE_API_KEY: \${{ secrets.ALGOSIZE_API_KEY }}
        run: |
          if [ -n "$ALGOSIZE_API_KEY" ]; then
            echo "present=true" >> "$GITHUB_OUTPUT"
          else
            echo "present=false" >> "$GITHUB_OUTPUT"
            echo "::notice::ALGOSIZE_API_KEY is not set — skipping the dependency audit. Add the secret to enable it."
          fi

      # Collects BOTH analyzers' inputs in one pass, so the pipeline makes a
      # single request and the dashboard gets a dependency audit and an
      # Architecture X-ray from the same commit.
      #
      # Everything starts from \`git ls-files\`, which is the whole trick: it
      # lists tracked files only, so build output, node_modules and anything
      # else gitignored is excluded without maintaining a denylist that would
      # rot. Nothing here reaches outside the checkout.
      - name: Collect lockfiles and architecture inputs
        id: collect
        if: steps.key.outputs.present == 'true'
        run: |
          python3 - <<'PY'
          import json, os, subprocess

          LOCK_NAMES = {"package-lock.json", "yarn.lock", "requirements.txt",
                        "Gemfile.lock", "go.sum"}
          # What the architecture analyzer actually parses: service topology
          # from compose/wrangler/Terraform/k8s, plus source for the import
          # edges between them.
          CONFIG_NAMES = {"wrangler.toml", "package.json", "_config.yml", "_config.yaml",
                          "docker-compose.yml", "docker-compose.yaml",
                          "compose.yml", "compose.yaml"}
          CONFIG_SUFFIX = (".tf", ".yml", ".yaml")
          SOURCE_SUFFIX = (".js", ".mjs", ".cjs", ".jsx", ".ts", ".tsx")

          # Below the server's own caps, so a repo that is merely large gets a
          # complete answer and only a genuinely huge one gets a flagged
          # partial. The server reports its own truncation independently.
          MAX_FILES, MAX_TOTAL, MAX_ONE = 1500, 10 * 1024 * 1024, 512 * 1024

          tracked = subprocess.run(["git", "ls-files"],
                                   capture_output=True, text=True).stdout.split()

          def read(p):
              try:
                  with open(p, encoding="utf-8") as fh:
                      return fh.read()
              except (OSError, UnicodeDecodeError):
                  return None

          # .env files are never sent. The analyzer does scan them for
          # hardcoded secrets, but a CI job shipping a real .env to any API is
          # a worse trade than the finding is worth — and a committed .env is
          # a problem to fix at the source, not to inventory remotely.
          def is_env(p):
              b = os.path.basename(p)
              return b == ".env" or b.startswith(".env.")

          def is_config(p):
              b = os.path.basename(p)
              return (b in CONFIG_NAMES
                      or b.startswith("Dockerfile")
                      or p.endswith(CONFIG_SUFFIX))

          # Test corpora are excluded from the payload entirely, and both
          # analyzers are better for it. A scanner's fixture directory is a
          # deliberate collection of bad examples: reading it as a security
          # scan reports the corpus as vulnerabilities — true, and useless —
          # and this repository's own gate did exactly that, 535 findings and
          # 23 criticals from files that exist to be found. The architecture
          # map has the same problem from the other side: a fake Express app
          # under fixtures/ becomes a service that does not exist.
          #
          # The server applies the same exclusions on ingest, so a workflow
          # generated before this change is still protected. This is the
          # cheaper half — the bytes never leave the runner.
          TEST_CORPUS = {"fixtures", "fixture", "__fixtures__", "testdata"}

          def is_test_corpus(p):
              return any(part in TEST_CORPUS for part in p.split("/"))

          locks = []
          for p in tracked:
              if os.path.basename(p) in LOCK_NAMES:
                  c = read(p)
                  if c is not None:
                      locks.append({"path": p, "content": c})

          candidates = [p for p in tracked if not is_env(p) and not is_test_corpus(p)]
          # Configs first: they carry the topology. If a budget runs out it
          # should cost import edges, never whole services.
          ordered = ([p for p in candidates if is_config(p)]
                     + [p for p in candidates if p.endswith(SOURCE_SUFFIX)])

          arch, total, truncated = [], 0, False
          for p in ordered:
              if len(arch) >= MAX_FILES:
                  truncated = True
                  break
              c = read(p)
              if c is None:
                  continue
              n = len(c.encode("utf-8"))
              if n > MAX_ONE:
                  truncated = True
                  continue
              if total + n > MAX_TOTAL:
                  truncated = True
                  break
              total += n
              arch.append({"path": p, "content": c})

          with open("payload.json", "w", encoding="utf-8") as fh:
              json.dump({
                  "repo": os.environ["GITHUB_REPOSITORY"],
                  "ref": os.environ["GITHUB_REF"],
                  "commit_sha": os.environ["GITHUB_SHA"],
                  "fail_on": "${failOn}",
                  "arch_fail_on": "${archFailOn}",
                  "lockfiles": locks,
                  "files": arch,
              }, fh)

          with open(os.environ["GITHUB_OUTPUT"], "a", encoding="utf-8") as out:
              out.write("lockfiles=%d\\n" % len(locks))
              out.write("archfiles=%d\\n" % len(arch))
          if truncated:
              print("::notice::Architecture inputs were capped at %d files / %d MB; "
                    "the analysis will report itself as partial."
                    % (MAX_FILES, MAX_TOTAL // 1024 // 1024))
          print("Collected %d lockfile(s) and %d architecture input(s)."
                % (len(locks), len(arch)))
          PY

      - name: Run the Algosize audit
        if: steps.key.outputs.present == 'true' && (steps.collect.outputs.lockfiles != '0' || steps.collect.outputs.archfiles != '0')
        id: audit
        run: |
          HTTP=$(curl -sS -o response.json -w '%{http_code}' \\
            -X POST "${origin}/api/ci/runs" \\
            -H "Authorization: Bearer \${{ secrets.ALGOSIZE_API_KEY }}" \\
            -H "Content-Type: application/json" \\
            --data @payload.json)
          # See the note in the other gates: a 402 is the monthly allowance,
          # not a defect in this pull request. Warned and skipped rather than
          # failed — but SAID OUT LOUD in the pull request comment below,
          # because an audit that did not run must never be mistaken for one
          # that found nothing.
          if [ "$HTTP" = "402" ]; then
            echo "::warning::$(jq -r '.message // "Monthly run allowance exhausted."' response.json)"
            echo "quota=true" >> "$GITHUB_OUTPUT"
            exit 0
          fi
          if [ "$HTTP" != "200" ]; then
            echo "::error::Algosize returned HTTP $HTTP"
            cat response.json
            exit 1
          fi
          {
            echo "run_id=$(jq -r '.runId // empty' response.json)"
            echo "failed=$(jq -r '.failed' response.json)"
            echo "report_url=$(jq -r '.reportUrl // empty' response.json)"
            echo "arch_run_id=$(jq -r '.architecture.runId // empty' response.json)"
            echo "analyzer_version=$(jq -r '.analyzerVersion // \"unknown\"' response.json)"
          } >> "$GITHUB_OUTPUT"
          # The dependency table only exists when lockfiles were submitted; a
          # repo with none still gets an architecture summary rather than an
          # empty comment claiming zero advisories.
          : > table.md
          if [ "$(jq -r 'has("summary") and (.runId != null)' response.json)" = "true" ]; then
            jq -r '"| Severity | Count |\\n|---|---|\\n| Critical | \\(.summary.critical) |\\n| High | \\(.summary.high) |\\n| Medium | \\(.summary.medium) |\\n| Low | \\(.summary.low) |"' response.json >> table.md
          fi
          # The security half of the same files. Before this, the comment was a
          # severity table that spoke only for third-party packages — a clean
          # table on a pull request that introduced a SQL injection.
          if [ "$(jq -r '.source.status // empty' response.json)" = "ok" ]; then
            {
              echo ""
              jq -r '"**Code scan** · \\(.source.findings) finding(s) (\\(.source.summary.critical) critical, \\(.source.summary.high) high) in the files submitted"' response.json
              # Accepted risks, when the response carries them. The jq default
              # keeps this line working against a server that predates the
              # register, and the count is NEVER printed on its own — a reader
              # who sees a number go down has to be told where it went.
              if [ "$(jq -r '.source.accepted // 0' response.json)" != "0" ]; then
                echo ""
                jq -r '"_\\(.source.accepted) of these are signed off in the accepted-risk register (\\(.source.open) open). They are still reported, still exported, and still counted above._"' response.json
              fi
              if [ "$(jq -r '.source.expiredAcceptances // 0' response.json)" != "0" ]; then
                echo ""
                jq -r '"⚠️ _\\(.source.expiredAcceptances) acceptance(s) have EXPIRED and are open again at full severity._"' response.json
              fi
              if [ "$(jq -r '.source.drifted // 0' response.json)" != "0" ]; then
                echo ""
                jq -r '"⚠️ _\\(.source.drifted) finding(s) match a signed acceptance but the code has changed underneath it, so the signature no longer covers them._"' response.json
              fi
              if [ "$(jq -r '.source.findings' response.json)" != "0" ]; then
                echo ""
                jq -r '.source.top[] | "- \\(.severity | ascii_upcase) \\(.path):\\(.line) — \\(.title)"' response.json
              fi
            } >> table.md
          elif [ "$(jq -r 'has("source")' response.json)" = "true" ]; then
            {
              echo ""
              jq -r '"**Code scan** · did not run — \\(.source.message // "no reason given")"' response.json
            } >> table.md
          fi
          if [ "$(jq -r 'has("architecture")' response.json)" = "true" ]; then
            {
              echo ""
              jq -r '"**Architecture X-ray** · \\(.architecture.summary.clusters) clusters · \\(.architecture.summary.nodes) services · \\(.architecture.summary.findings) findings (\\(.architecture.summary.bySeverity.critical) critical, \\(.architecture.summary.bySeverity.high) high)"' response.json
              if [ "$(jq -r '.architecture.summary.complete' response.json)" != "true" ]; then
                echo ""
                echo "_Coverage was partial — some files were skipped or capped, so these counts are a lower bound._"
              fi
            } >> table.md
          fi

      - name: Download the SARIF report
        if: steps.audit.outputs.run_id != ''
        run: |
          curl -sS -f -o algosize.sarif \\
            -H "Authorization: Bearer \${{ secrets.ALGOSIZE_API_KEY }}" \\
            "${origin}/api/runs/\${{ steps.audit.outputs.run_id }}/report?format=sarif"

      - name: Upload to the Security tab
        if: steps.audit.outputs.run_id != ''
        uses: github/codeql-action/upload-sarif@v3
        with:
          sarif_file: algosize.sarif
          category: algosize

      # The audit did not run because the allowance is spent. Said in the
      # pull request, in the same sticky comment, so a reviewer reading the
      # thread cannot mistake silence for a clean audit — the whole point of
      # a gate is that its absence is visible.
      - name: Say the audit did not run
        if: github.event_name == 'pull_request' && steps.audit.outputs.quota == 'true'
        uses: actions/github-script@v7
        with:
          script: |
            const MARKER = '<!-- algosize-audit -->';
            const body = [
              MARKER,
              '### Algosize dependency audit — not run',
              '',
              'This organisation has used its monthly analysis allowance, so **no audit ran for this commit**.',
              'That is not a clean result: the dependencies in this pull request have not been checked.',
              '',
              'The allowance resets monthly, or an upgrade lifts it: https://algosize.com/#pricing',
            ].join('\\n');
            const { data: comments } = await github.rest.issues.listComments({
              owner: context.repo.owner, repo: context.repo.repo,
              issue_number: context.issue.number, per_page: 100,
            });
            const existing = comments.find((c) => c.body && c.body.includes(MARKER));
            if (existing) {
              await github.rest.issues.updateComment({
                owner: context.repo.owner, repo: context.repo.repo,
                comment_id: existing.id, body,
              });
            } else {
              await github.rest.issues.createComment({
                owner: context.repo.owner, repo: context.repo.repo,
                issue_number: context.issue.number, body,
              });
            }

      - name: Comment on the pull request
        if: github.event_name == 'pull_request' && steps.audit.outputs.run_id != ''
        uses: actions/github-script@v7
        with:
          script: |
            const fs = require('fs');
            const table = fs.readFileSync('table.md', 'utf8');
            // One sticky comment per PR, updated in place. Appending a new
            // comment every push buries the conversation and trains people to
            // collapse the bot.
            const MARKER = '<!-- algosize-audit -->';
            const body = [
              MARKER,
              '### Algosize dependency audit',
              '',
              table,
              '',
              'Analyzer build: \${{ steps.audit.outputs.analyzer_version || 'unknown' }}',
              '',
              '[View the full report](\${{ steps.audit.outputs.report_url }})',
            ].join('\\n');
            const { data: comments } = await github.rest.issues.listComments({
              owner: context.repo.owner, repo: context.repo.repo,
              issue_number: context.issue.number, per_page: 100,
            });
            const existing = comments.find((c) => c.body && c.body.includes(MARKER));
            if (existing) {
              await github.rest.issues.updateComment({
                owner: context.repo.owner, repo: context.repo.repo,
                comment_id: existing.id, body,
              });
            } else {
              await github.rest.issues.createComment({
                owner: context.repo.owner, repo: context.repo.repo,
                issue_number: context.issue.number, body,
              });
            }

      # Trips on the dependency audit's '${failOn}' threshold, and on the
      # architecture analysis only if arch_fail_on is set to something other
      # than "none" (currently '${archFailOn}') — a design finding should not
      # break a build unless someone chose that.
      - name: Fail the build on new findings
        if: steps.audit.outputs.failed == 'true'
        run: |
          echo "::error::Algosize found findings at or above the configured threshold (dependencies: '${failOn}', architecture: '${archFailOn}'). See \${{ steps.audit.outputs.report_url }}"
          exit 1
`;
}

// ---------------------------------------------------------------------------
// GET /api/ci/optimizer-snippet — the Algorithm optimizer's per-PR gate
// ---------------------------------------------------------------------------
//
// Same shape as the audit snippet: the customer's workflow collects inputs
// from their own checkout and POSTs them to our API, so the verdict CI gets
// and the verdict the dashboard would give for the same function are computed
// by the same code. Which functions get audited is optimizer.config.json at
// the repo root — the same manifest the scheduled monitors' optimizer pass
// reads, so the nightly sweep and the per-PR gate watch the same list by
// construction.
export function ciOptimizerSnippetHandler(request, env) {
  const origin = (env.SITE_ORIGIN || "https://algosize.com").replace(/\/$/, "");
  return json({
    filename: ".github/workflows/algosize-optimizer.yml",
    configFilename: "optimizer.config.json",
    secretName: "ALGOSIZE_API_KEY",
    setupSteps: [
      "Create an API key in the dashboard (API keys → Create key) and add it as the ALGOSIZE_API_KEY repository secret — the same key the dependency audit uses.",
      "Commit optimizer.config.json at the repo root, naming the self-contained functions to watch (example below).",
      "Commit the workflow file below.",
    ],
    configExample: buildOptimizerConfigExample(),
    workflow: buildOptimizerWorkflow({ origin }),
  }, 200);
}

export function buildOptimizerConfigExample() {
  return JSON.stringify({
    "$comment": "Each entry names one SELF-CONTAINED function: no imports, no closures over file-level helpers. `baseline` is a CEILING, not an expectation — set it one bucket above the true complexity so timing noise cannot fail a build; the check exists to catch real regressions like O(n) -> O(n^2). `file` is repo-root-relative.",
    entries: [
      {
        name: "example-sum",
        file: "src/math.js",
        functionName: "sum",
        sampleInput: [3, 1, 4, 1, 5],
        baseline: "O(n log n)",
      },
    ],
  }, null, 2);
}

export function buildOptimizerWorkflow({ origin }) {
  return `name: Algosize algorithm optimizer

# Big-O regression gate. Reads optimizer.config.json, slices each named
# function out of its file, and asks the Algosize API to measure it — the
# same analyzer behind the dashboard's Algorithm optimizer and the scheduled
# monitors' nightly pass, so all three always agree about a function.
#
# The build fails only when a measured complexity lands ABOVE the entry's
# declared baseline ceiling. A function that cannot be found or measured is
# reported and skipped, not failed: a red build about config is how the gate
# gets deleted.

on:
  pull_request:

permissions:
  contents: read

jobs:
  optimizer:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      # Skipped-with-notice when the secret is absent, same as the audit
      # workflow: a workflow that goes red the moment it is pasted reads as
      # "this product is broken".
      - name: Check for the API key
        id: key
        env:
          ALGOSIZE_API_KEY: \${{ secrets.ALGOSIZE_API_KEY }}
        run: |
          if [ -n "$ALGOSIZE_API_KEY" ]; then
            echo "present=true" >> "$GITHUB_OUTPUT"
          else
            echo "present=false" >> "$GITHUB_OUTPUT"
            echo "::notice::ALGOSIZE_API_KEY is not set — skipping the optimizer gate. Add the secret to enable it."
          fi

      - name: Audit configured functions
        if: steps.key.outputs.present == 'true'
        env:
          ALGOSIZE_API_KEY: \${{ secrets.ALGOSIZE_API_KEY }}
        run: |
          # acorn does the function slicing — a real parse, not a regex.
          npm install --no-save --no-audit --no-fund acorn >/dev/null 2>&1
          node - <<'NODE'
          const fs = require("fs");
          const acorn = require("acorn");

          // Both spellings of the polynomial labels rank identically: the API
          // measures "O(n²)" while config ceilings are typed "O(n^2)". Labels
          // past O(n³) carry a raw exponent ("O(n^4.2)") and rank by it;
          // anything unparseable — "unknown" included — ranks worst.
          const RANKS = new Map([
            ["O(1)", 0], ["O(log n)", 1], ["O(n)", 2], ["O(n log n)", 3],
            ["O(n²)", 4], ["O(n^2)", 4], ["O(n³)", 5], ["O(n^3)", 5],
          ]);
          const rank = (l) => {
            if (RANKS.has(l)) return RANKS.get(l);
            const m = typeof l === "string" ? l.match(/^O\\(n\\^([0-9.]+)\\)$/) : null;
            if (m && Number.parseFloat(m[1]) > 3) return Math.min(5 + (Number.parseFloat(m[1]) - 3), 99);
            return 100;
          };

          function extractFunction(source, name) {
            const ast = acorn.parse(source, { ecmaVersion: "latest", sourceType: "module" });
            for (const node of ast.body) {
              const fn = node.type === "FunctionDeclaration" ? node
                : (node.type === "ExportNamedDeclaration" || node.type === "ExportDefaultDeclaration")
                  && node.declaration && node.declaration.type === "FunctionDeclaration"
                  ? node.declaration : null;
              if (fn && fn.id && fn.id.name === name) return source.slice(fn.start, fn.end);
            }
            return null;
          }

          async function main() {
            if (!fs.existsSync("optimizer.config.json")) {
              console.log("::notice::optimizer.config.json not found — nothing to audit.");
              return;
            }
            const config = JSON.parse(fs.readFileSync("optimizer.config.json", "utf8"));
            const entries = Array.isArray(config.entries) ? config.entries : [];
            let failed = 0;

            for (const entry of entries) {
              const label = entry.name || entry.functionName || "unnamed";
              if (!entry.file || !entry.functionName) {
                console.log("::warning::" + label + ": entry missing file or functionName — skipped");
                continue;
              }
              if (!fs.existsSync(entry.file)) {
                console.log("::warning::" + label + ": " + entry.file + " not found — skipped");
                continue;
              }
              const code = extractFunction(fs.readFileSync(entry.file, "utf8"), entry.functionName);
              if (!code) {
                console.log("::warning::" + label + ": function " + entry.functionName + " not found in " + entry.file + " — skipped");
                continue;
              }

              const res = await fetch("${origin}/api/analyze/algo", {
                method: "POST",
                headers: {
                  "content-type": "application/json",
                  authorization: "Bearer " + process.env.ALGOSIZE_API_KEY,
                },
                body: JSON.stringify({ code, sampleInput: entry.sampleInput }),
              });
              const body = await res.json().catch(() => ({}));
              // A spent allowance is a billing state, not a defect in this
              // pull request. This gate already skipped rather than failed on
              // any non-OK status, which was the right shape by accident;
              // naming 402 explicitly means the log says WHY, in the server's
              // own words, instead of "API 402 (quota_exceeded)".
              if (res.status === 402) {
                console.log("::warning::" + (body.message || "Monthly run allowance exhausted.") + " Complexity was not measured for " + label + ".");
                continue;
              }
              if (!res.ok) {
                console.log("::warning::" + label + ": API " + res.status + " (" + (body.error || "error") + ") — skipped");
                continue;
              }
              const measured = body.bigO && body.bigO.label || "unknown";
              const ceiling = entry.baseline || null;
              if (ceiling && rank(measured) > rank(ceiling)) {
                console.log("::error::" + label + ": measured " + measured + " exceeds the declared ceiling " + ceiling);
                failed++;
              } else {
                console.log(label + ": " + measured + (ceiling ? " (ceiling " + ceiling + ")" : ""));
              }
            }
            if (failed > 0) process.exit(1);
          }
          main().catch((err) => { console.log("::error::" + err.message); process.exit(1); });
          NODE
`;
}

// ---------------------------------------------------------------------------
// GET /api/ci/estimate-snippet
// ---------------------------------------------------------------------------

/**
 * The infrastructure-cost budget gate.
 *
 * Deliberately the only gate that stores nothing. It posts a compose file to
 * /api/estimate, reads the cheapest monthly total, and compares it to a
 * ceiling committed in the repository. The estimator's HTTP boundary refuses
 * to record parsed resource values, so a gate that needed run history to work
 * would have to weaken that — this one does not need it. What ends up in run
 * history is the aggregate the recorder keeps, which is a side effect of the
 * call rather than a dependency of the gate.
 *
 * The budget lives in the repo rather than in a dashboard setting for the
 * same reason the optimizer's ceilings do: the number that fails a build
 * should be reviewable in the pull request that changes it.
 */
export function ciEstimateSnippetHandler(request, env) {
  const origin = (env.SITE_ORIGIN || "https://algosize.com").replace(/\/$/, "");
  return json({
    filename: ".github/workflows/algosize-estimate.yml",
    configFilename: "algosize.budget.json",
    secretName: "ALGOSIZE_API_KEY",
    setupSteps: [
      "Use the same ALGOSIZE_API_KEY repository secret the dependency audit uses — there is nothing new to create.",
      "Commit algosize.budget.json at the repo root with your monthly ceiling, or leave it out to annotate without ever failing a build.",
      "Commit the workflow file below.",
    ],
    configExample: buildBudgetExample(),
    workflow: buildEstimateWorkflow({ origin }),
  }, 200);
}

export function buildBudgetExample() {
  return JSON.stringify({
    "$comment": "monthlyCeilingUsd is the number that fails a build, checked against the CHEAPEST priced provider. Omit it (or set it to null) to annotate the pull request without ever failing — which is the right setting until you have watched a few runs and trust the figure. `compose` is repo-root-relative. `cur` names a COMMITTED Cost & Usage Report for the cloud-spend gate; leave it null unless you actually commit one, and the gate will skip with a notice rather than fail. monthlySpendCeilingUsd is that gate's ceiling, and is about money already spent, not money projected.",
    compose: "docker-compose.yml",
    monthlyCeilingUsd: null,
    providers: ["hetzner", "aws"],
    cur: null,
    monthlySpendCeilingUsd: null,
  }, null, 2);
}

export function buildEstimateWorkflow({ origin }) {
  return `name: Algosize infrastructure cost

# Prices the committed compose file on every pull request and, when a ceiling
# is declared, fails the build if the cheapest provider is over it.
#
# What this does NOT do, and will not be made to do: connect to a cloud
# account. There is no credential here and none is accepted. Every figure is
# a list price applied to what the compose file declares — which is why it
# can run on a fork's pull request, and why it says "not your bill" every
# time it reports one.

on:
  pull_request:

permissions:
  contents: read
  pull-requests: write

jobs:
  estimate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      # Missing secret is a skip with a notice, never a red build. A gate that
      # fails closed on setup is a gate somebody deletes on their first busy
      # afternoon.
      - name: Check for the API key
        id: key
        env:
          ALGOSIZE_API_KEY: \${{ secrets.ALGOSIZE_API_KEY }}
        run: |
          if [ -z "$ALGOSIZE_API_KEY" ]; then
            echo "::notice::ALGOSIZE_API_KEY is not set — skipping the cost estimate."
            echo "skip=true" >> "$GITHUB_OUTPUT"
          fi

      - name: Read the budget
        if: steps.key.outputs.skip != 'true'
        id: budget
        run: |
          COMPOSE=docker-compose.yml
          CEILING=
          PROVIDERS='["hetzner","aws"]'
          if [ -f algosize.budget.json ]; then
            COMPOSE=$(jq -r '.compose // "docker-compose.yml"' algosize.budget.json)
            CEILING=$(jq -r '.monthlyCeilingUsd // empty' algosize.budget.json)
            PROVIDERS=$(jq -c '.providers // ["hetzner","aws"]' algosize.budget.json)
          fi
          echo "compose=$COMPOSE"     >> "$GITHUB_OUTPUT"
          echo "ceiling=$CEILING"     >> "$GITHUB_OUTPUT"
          echo "providers=$PROVIDERS" >> "$GITHUB_OUTPUT"
          if [ ! -f "$COMPOSE" ]; then
            echo "::notice::No $COMPOSE in this repository — nothing to price."
            echo "skip=true" >> "$GITHUB_OUTPUT"
          fi

      - name: Estimate
        if: steps.key.outputs.skip != 'true' && steps.budget.outputs.skip != 'true'
        id: run
        env:
          ALGOSIZE_API_KEY: \${{ secrets.ALGOSIZE_API_KEY }}
        run: |
          jq -n \\
            --rawfile compose "\${{ steps.budget.outputs.compose }}" \\
            --argjson providers '\${{ steps.budget.outputs.providers }}' \\
            '{inputType:"compose", content:$compose, options:{providers:$providers}}' > payload.json

          HTTP=$(curl -sS -o response.json -w '%{http_code}' \\
            -X POST "${origin}/api/estimate" \\
            -H "Authorization: Bearer $ALGOSIZE_API_KEY" \\
            -H "Content-Type: application/json" \\
            --data @payload.json)

          # A 402 is the monthly run allowance, not a defect in this pull
          # request. It is a WARNING and a skip, never a red build: the free
          # tier is five runs, an active repository reaches that in an
          # afternoon, and reddening every pull request until someone pays is
          # the fastest way to get this gate deleted — which costs the team
          # their audit as well as us the customer. Exactly the reasoning the
          # missing-key check above is built on, and it applies harder here,
          # because a missing key is a one-time setup step while this recurs
          # every month.
          if [ "$HTTP" = "402" ]; then
            echo "::warning::$(jq -r '.message // "Monthly run allowance exhausted."' response.json)"
            echo "quota=true" >> "$GITHUB_OUTPUT"
            echo "skip=true" >> "$GITHUB_OUTPUT"
            exit 0
          fi
          if [ "$HTTP" != "200" ]; then
            echo "::warning::The estimator returned HTTP $HTTP — annotating without a verdict."
            jq -r '.message // .error // "no detail"' response.json || true
            echo "skip=true" >> "$GITHUB_OUTPUT"
            exit 0
          fi

          # Cheapest priced provider. Providers that could not be priced are
          # excluded rather than counted as zero.
          jq -r '[.providers[] | select(.estimatedTotalMicroUsd != null)]
                 | sort_by(.estimatedTotalMicroUsd) | .[0]
                 | "cheapest_usd=\\(.estimatedTotalMicroUsd / 1000000)",
                   "cheapest_name=\\(.providerName // .providerId)"' response.json >> "$GITHUB_OUTPUT"
          jq -r '"resources=\\(.normalizedSpec.resources | length)"' response.json >> "$GITHUB_OUTPUT"

      - name: Comment and gate
        if: steps.key.outputs.skip != 'true' && steps.budget.outputs.skip != 'true' && steps.run.outputs.skip != 'true'
        env:
          GH_TOKEN: \${{ github.token }}
          CEILING:  \${{ steps.budget.outputs.ceiling }}
          USD:      \${{ steps.run.outputs.cheapest_usd }}
          NAME:     \${{ steps.run.outputs.cheapest_name }}
          RESOURCES: \${{ steps.run.outputs.resources }}
          PR: \${{ github.event.pull_request.number }}
        run: |
          VERDICT="No ceiling is set, so this is an annotation only."
          FAIL=0
          if [ -n "$CEILING" ]; then
            if awk "BEGIN{exit !($USD > $CEILING)}"; then
              VERDICT="Over the \$$CEILING/mo ceiling."
              FAIL=1
            else
              VERDICT="Within the \$$CEILING/mo ceiling."
            fi
          fi

          {
            echo "<!-- algosize-estimate -->"
            echo "### Infrastructure cost"
            echo
            echo "**\$$USD / month** on $NAME — cheapest of the priced providers, $RESOURCES resources."
            echo
            echo "$VERDICT"
            echo
            echo "_List prices against the committed compose file. Not a quote, and not your bill._"
            echo "_No cloud account was contacted and no credential was used._"
          } > comment.md

          gh pr comment "$PR" --body-file comment.md --edit-last || \\
            gh pr comment "$PR" --body-file comment.md

          if [ "$FAIL" = "1" ]; then
            echo "::error::Estimated monthly cost \$$USD exceeds the \$$CEILING ceiling."
            exit 1
          fi
`;
}

// ---------------------------------------------------------------------------
// GET /api/ci/cost-snippet
// ---------------------------------------------------------------------------

/**
 * The cloud-spend gate.
 *
 * The awkward one, and the reason it shipped last: every other gate reads
 * something a repository naturally contains — a lockfile, a compose file, a
 * wrangler.toml. A Cost & Usage Report is a billing export, often hundreds of
 * megabytes, frequently containing account ids, and almost nobody commits one.
 *
 * So this gate is built to be ABSENT most of the time and to say so quietly:
 * with no CUR committed it skips with a notice, exactly as a missing key
 * does, and never turns a pull request red for a file that was never meant to
 * be there. It earns its place for the teams who DO commit a trimmed monthly
 * export — the spend is then reviewed in the pull request that changes it,
 * next to the infrastructure that caused it, rather than in a console nobody
 * opens.
 *
 * It reads the same algosize.budget.json the estimator uses rather than
 * inventing a second config file: both answer a question about money, and one
 * file that holds every threshold is one file to review.
 *
 * Like the estimator's gate, no cloud account is contacted. The CUR is a file
 * the repository already has; there is no connector here and no credential is
 * accepted.
 */
export function ciCostSnippetHandler(request, env) {
  const origin = (env.SITE_ORIGIN || "https://algosize.com").replace(/\/$/, "");
  return json({
    filename: ".github/workflows/algosize-cost.yml",
    configFilename: "algosize.budget.json",
    secretName: "ALGOSIZE_API_KEY",
    setupSteps: [
      "Use the same ALGOSIZE_API_KEY repository secret every other gate uses — there is nothing new to create.",
      "Commit a Cost & Usage Report export and name it in algosize.budget.json under `cur`. Without one the gate skips with a notice and never fails a build.",
      "Commit the workflow file below.",
    ],
    configExample: buildBudgetExample(),
    workflow: buildCostWorkflow({ origin }),
  }, 200);
}

export function buildCostWorkflow({ origin }) {
  return `name: Algosize cloud spend

# Analyses a COMMITTED Cost & Usage Report on every pull request and reports
# the biggest spenders and savings. When a spend ceiling is declared it fails
# the build; without one it annotates and never fails.
#
# No cloud account is contacted and no credential is accepted. The CUR is a
# file this repository already contains — if it does not contain one, this
# gate skips with a notice rather than turning the pull request red for a
# file that was never meant to be committed.

on:
  pull_request:

permissions:
  contents: read
  pull-requests: write

jobs:
  cost:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Check for the API key
        id: key
        env:
          ALGOSIZE_API_KEY: \${{ secrets.ALGOSIZE_API_KEY }}
        run: |
          if [ -z "$ALGOSIZE_API_KEY" ]; then
            echo "::notice::ALGOSIZE_API_KEY is not set — skipping the cloud-spend analysis."
            echo "skip=true" >> "$GITHUB_OUTPUT"
          fi

      # A missing CUR is the NORMAL case, not a misconfiguration: a billing
      # export is large and usually private. Skipping quietly is the whole
      # reason this gate is safe to paste into any repository.
      - name: Locate the CUR export
        if: steps.key.outputs.skip != 'true'
        id: cur
        run: |
          CUR=
          CEILING=
          if [ -f algosize.budget.json ]; then
            CUR=$(jq -r '.cur // empty' algosize.budget.json)
            CEILING=$(jq -r '.monthlySpendCeilingUsd // empty' algosize.budget.json)
          fi
          if [ -z "$CUR" ]; then
            echo "::notice::No \\\`cur\\\` named in algosize.budget.json — nothing to analyse."
            echo "skip=true" >> "$GITHUB_OUTPUT"
          elif [ ! -f "$CUR" ]; then
            echo "::notice::$CUR is named in algosize.budget.json but is not committed — nothing to analyse."
            echo "skip=true" >> "$GITHUB_OUTPUT"
          else
            echo "cur=$CUR" >> "$GITHUB_OUTPUT"
            echo "ceiling=$CEILING" >> "$GITHUB_OUTPUT"
          fi

      - name: Analyse the report
        if: steps.key.outputs.skip != 'true' && steps.cur.outputs.skip != 'true'
        id: run
        env:
          ALGOSIZE_API_KEY: \${{ secrets.ALGOSIZE_API_KEY }}
        run: |
          HTTP=$(curl -sS -o response.json -w '%{http_code}' \\
            -X POST "${origin}/api/analyze/cost" \\
            -H "Authorization: Bearer $ALGOSIZE_API_KEY" \\
            -H "Content-Type: text/csv" \\
            --data-binary @"\${{ steps.cur.outputs.cur }}")

          # A 402 is the monthly run allowance, not a defect in this pull
          # request. It is a WARNING and a skip, never a red build: the free
          # tier is five runs, an active repository reaches that in an
          # afternoon, and reddening every pull request until someone pays is
          # the fastest way to get this gate deleted — which costs the team
          # their audit as well as us the customer. Exactly the reasoning the
          # missing-key check above is built on, and it applies harder here,
          # because a missing key is a one-time setup step while this recurs
          # every month.
          if [ "$HTTP" = "402" ]; then
            echo "::warning::$(jq -r '.message // "Monthly run allowance exhausted."' response.json)"
            echo "quota=true" >> "$GITHUB_OUTPUT"
            echo "skip=true" >> "$GITHUB_OUTPUT"
            exit 0
          fi
          if [ "$HTTP" != "200" ]; then
            echo "::warning::The cost analyzer returned HTTP $HTTP — annotating without a verdict."
            jq -r '.message // .error // "no detail"' response.json || true
            echo "skip=true" >> "$GITHUB_OUTPUT"
            exit 0
          fi

          jq -r '"spend=\\(.currentSpend // 0)",
                 "savings_pct=\\(.totalSavingsPct // 0)",
                 "wins=\\(.suggestions | length)"' response.json >> "$GITHUB_OUTPUT"
          # Top three savings by value, as one markdown table.
          jq -r '"| Win | Impact | Est. monthly saving |",
                 "|---|---|---|",
                 (.suggestions | sort_by(-.savingsEstimate) | .[0:3][]
                  | "| \\(.title) | \\(.impact) | $\\(.savingsEstimate | floor) |")' response.json > table.md

      - name: Comment and gate
        if: steps.key.outputs.skip != 'true' && steps.cur.outputs.skip != 'true' && steps.run.outputs.skip != 'true'
        env:
          GH_TOKEN: \${{ github.token }}
          CEILING: \${{ steps.cur.outputs.ceiling }}
          SPEND:   \${{ steps.run.outputs.spend }}
          PCT:     \${{ steps.run.outputs.savings_pct }}
          WINS:    \${{ steps.run.outputs.wins }}
          PR: \${{ github.event.pull_request.number }}
        run: |
          VERDICT="No spend ceiling is set, so this is an annotation only."
          FAIL=0
          if [ -n "$CEILING" ]; then
            if awk "BEGIN{exit !($SPEND > $CEILING)}"; then
              VERDICT="Over the \\$$CEILING/mo ceiling."
              FAIL=1
            else
              VERDICT="Within the \\$$CEILING/mo ceiling."
            fi
          fi

          {
            echo "<!-- algosize-cost -->"
            echo "### Cloud spend"
            echo
            echo "**\\$$SPEND / month** in the committed report — $WINS savings win(s), up to $PCT% recoverable."
            echo
            cat table.md
            echo
            echo "$VERDICT"
            echo
            echo "_Read from the committed Cost & Usage Report. No cloud account was contacted and no credential was used._"
          } > comment.md

          gh pr comment "$PR" --body-file comment.md --edit-last || \\
            gh pr comment "$PR" --body-file comment.md

          if [ "$FAIL" = "1" ]; then
            echo "::error::Monthly spend \\$$SPEND exceeds the \\$$CEILING ceiling."
            exit 1
          fi
`;
}

// ---------------------------------------------------------------------------
// GET /api/ci/architecture-snippet
// ---------------------------------------------------------------------------

/**
 * The architecture gate.
 *
 * POST /api/ci/runs has accepted `files` since the X-ray shipped, but there
 * was no workflow and no snippet, so the capability existed and nobody could
 * reach it without hand-writing YAML against an undocumented body. This is
 * that YAML.
 *
 * Defaults to arch_fail_on "none" — annotate, never fail. Architecture
 * findings are judgements about structure rather than facts about a
 * published advisory, and a build that goes red over a judgement on the day
 * it is switched on is a build people learn to ignore.
 */
export function ciArchitectureSnippetHandler(request, env) {
  const origin = (env.SITE_ORIGIN || "https://algosize.com").replace(/\/$/, "");
  return json({
    filename: ".github/workflows/algosize-architecture.yml",
    secretName: "ALGOSIZE_API_KEY",
    setupSteps: [
      "Use the same ALGOSIZE_API_KEY repository secret the dependency audit uses.",
      "Commit the workflow file below. It annotates by default and fails nothing until you raise arch_fail_on.",
    ],
    workflow: buildArchitectureWorkflow({ origin }),
  }, 200);
}

export function buildArchitectureWorkflow({ origin }) {
  return `name: Algosize architecture

# Maps the module graph on every pull request and reports what changed shape.
# Submits source PATHS and contents to the same endpoint the dependency audit
# uses; the result is stored as findings and paths, never as a copy of the
# files.
#
# arch_fail_on is "none" by default: this annotates and fails nothing. Raise
# it to "critical" once you have watched a few runs and agree with what it
# calls critical.

on:
  pull_request:

permissions:
  contents: read
  pull-requests: write

jobs:
  architecture:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Check for the API key
        id: key
        env:
          ALGOSIZE_API_KEY: \${{ secrets.ALGOSIZE_API_KEY }}
        run: |
          if [ -z "$ALGOSIZE_API_KEY" ]; then
            echo "::notice::ALGOSIZE_API_KEY is not set — skipping the architecture map."
            echo "skip=true" >> "$GITHUB_OUTPUT"
          fi

      - name: Collect manifests and source
        if: steps.key.outputs.skip != 'true'
        id: collect
        run: |
          # MANIFESTS FIRST, then source. This order is the whole point: the
          # analyzer builds its clusters and services from manifests
          # (wrangler.toml, compose, Dockerfile, Terraform, k8s) and uses
          # source only for the import edges between them. Collecting source
          # alone returns a graph with zero clusters and zero findings, which
          # renders as "worst: none" — a clean bill of health for a repository
          # nobody actually mapped. That is the failure this ordering exists
          # to prevent, and truncation at the cap must never cost a
          # manifest to make room for one more source file.
          #
          # Build output and vendored dependencies carry no signal about YOUR
          # architecture and would dominate the graph, so they are pruned.
          find . \\
            -name node_modules -prune -o \\
            -name .git -prune -o \\
            -name dist -prune -o \\
            -name build -prune -o \\
            -name vendor -prune -o \\
            -name _site -prune -o \\
            -type f \\( -name 'wrangler.toml' -o -name 'docker-compose.y*ml' -o -name 'compose.y*ml' -o -name 'Dockerfile*' -o -name '*.tf' -o -name '_config.y*ml' \\) \\
            -size -200k -print | sed 's|^\./||' > manifests.txt

          find . \\
            -name node_modules -prune -o \\
            -name .git -prune -o \\
            -name dist -prune -o \\
            -name build -prune -o \\
            -name vendor -prune -o \\
            -name _site -prune -o \\
            -type f \\( -name '*.js' -o -name '*.mjs' -o -name '*.ts' -o -name '*.tsx' -o -name '*.py' -o -name '*.go' \\) \\
            -size -200k -print | sed 's|^\./||' > source.txt

          # Manifests are never truncated; source fills whatever budget is left.
          MANIFESTS=$(wc -l < manifests.txt | tr -d ' ')
          BUDGET=$((400 - MANIFESTS))
          [ "$BUDGET" -lt 0 ] && BUDGET=0
          cat manifests.txt > files.txt
          head -"$BUDGET" source.txt >> files.txt
          echo "::notice::Collected $MANIFESTS manifest(s) and $(( $(wc -l < files.txt) - MANIFESTS )) source file(s)."

          COUNT=$(wc -l < files.txt | tr -d ' ')
          echo "count=$COUNT" >> "$GITHUB_OUTPUT"
          if [ "$COUNT" = "0" ]; then
            echo "::notice::No source files matched — nothing to map."
            echo "skip=true" >> "$GITHUB_OUTPUT"
          fi

      - name: Map
        if: steps.key.outputs.skip != 'true' && steps.collect.outputs.skip != 'true'
        id: run
        env:
          ALGOSIZE_API_KEY: \${{ secrets.ALGOSIZE_API_KEY }}
        run: |
          jq -Rn --arg repo "\${{ github.repository }}" \\
                 --arg ref "\${{ github.head_ref }}" \\
                 --arg sha "\${{ github.event.pull_request.head.sha }}" \\
            '{repo:$repo, ref:$ref, commit_sha:$sha, arch_fail_on:"none",
              files:[inputs | {path:., content:""}]}' < files.txt > skeleton.json

          # Read each file into its entry. Done in jq rather than in the shell
          # so contents are JSON-escaped exactly once.
          python3 - <<'PY' > payload.json
          import json, pathlib
          skel = json.load(open("skeleton.json"))
          out = []
          for entry in skel["files"]:
              p = pathlib.Path(entry["path"])
              try:
                  out.append({"path": entry["path"], "content": p.read_text(errors="replace")})
              except OSError:
                  pass
          skel["files"] = out
          json.dump(skel, open("/dev/stdout", "w"))
          PY

          HTTP=$(curl -sS -o response.json -w '%{http_code}' \\
            -X POST "${origin}/api/ci/runs" \\
            -H "Authorization: Bearer $ALGOSIZE_API_KEY" \\
            -H "Content-Type: application/json" \\
            --data @payload.json)

          # A 402 is the monthly run allowance, not a defect in this pull
          # request. It is a WARNING and a skip, never a red build: the free
          # tier is five runs, an active repository reaches that in an
          # afternoon, and reddening every pull request until someone pays is
          # the fastest way to get this gate deleted — which costs the team
          # their audit as well as us the customer. Exactly the reasoning the
          # missing-key check above is built on, and it applies harder here,
          # because a missing key is a one-time setup step while this recurs
          # every month.
          if [ "$HTTP" = "402" ]; then
            echo "::warning::$(jq -r '.message // "Monthly run allowance exhausted."' response.json)"
            echo "quota=true" >> "$GITHUB_OUTPUT"
            echo "skip=true" >> "$GITHUB_OUTPUT"
            exit 0
          fi
          if [ "$HTTP" != "200" ]; then
            echo "::warning::The architecture endpoint returned HTTP $HTTP — annotating without a verdict."
            echo "skip=true" >> "$GITHUB_OUTPUT"
            exit 0
          fi

          jq -r '.architecture
                 | "clusters=\\(.summary.clusters // 0)",
                   "findings=\\(.summary.findings // 0)",
                   "worst=\\(.worstSeverity // "none")",
                   "map_url=\\(.mapUrl // "")",
                   "failed=\\(.failed)"' response.json >> "$GITHUB_OUTPUT"

      - name: Comment
        if: steps.key.outputs.skip != 'true' && steps.collect.outputs.skip != 'true' && steps.run.outputs.skip != 'true'
        env:
          GH_TOKEN: \${{ github.token }}
          PR: \${{ github.event.pull_request.number }}
        run: |
          {
            echo "<!-- algosize-architecture -->"
            echo "### Architecture"
            echo
            echo "\${{ steps.collect.outputs.count }} files · \${{ steps.run.outputs.clusters }} clusters · \${{ steps.run.outputs.findings }} findings (worst: \${{ steps.run.outputs.worst }})"
            # A gate that posts counts and no way to see them makes the reader
            # take the number on faith. The run exists; this is the link to it.
            if [ -n "\${{ steps.run.outputs.map_url }}" ]; then
              echo
              echo "[Open the map](\${{ steps.run.outputs.map_url }})"
            fi
          } > comment.md
          gh pr comment "$PR" --body-file comment.md --edit-last || \\
            gh pr comment "$PR" --body-file comment.md

          if [ "\${{ steps.run.outputs.failed }}" = "true" ]; then
            echo "::error::Architecture findings exceeded the configured threshold."
            exit 1
          fi
`;
}
