// POST /api/pipeline/run — actually run the five-stage fix pipeline.
//
// THE GAP THIS CLOSES. fix/pipeline.js has held the whole orchestrator —
// triage, deep validation, fix generation, cross-model verification, the
// budget funnel and the route-to-agent parking — with a full test suite, and
// NO CALLER. Nothing in the Worker ever invoked it, which meant the Fix
// Pipeline page could choose models for a pipeline it could not start, and
// `waiting_for_agent` was an outcome no finding could ever actually reach. The
// handoff endpoint therefore had no parked findings to hand over, and fell
// back to returning every finding in the run.
//
// Two input modes, mirroring /api/fix/propose:
//
//   { runId }                       run the pipeline over a stored scan's
//                                   source findings; the Worker refetches only
//                                   the files those findings name
//   { findings, files }             the caller holds the source (MCP client
//                                   with a checkout, the CLI, a test)
//
// The stage config is validated SERVER-SIDE before anything runs: a config the
// client would have been told is invalid cannot be smuggled past the UI by
// posting here directly.
//
// Nothing customer-source is persisted. The pipeline result attached to the
// run holds verdicts, fingerprints and model names — never file contents (see
// fingerprintView/slimTriage/slimValidation in fix/pipeline.js).

import { runFullPipeline } from "../fix/pipeline.js";
import { validateStageConfig, estimatePipelineCost, expandRouting, STAGE_IDS } from "../ai/stages.js";
import { getRun, runScopeFor, attachPipelineResult } from "./runs.js";
import { fetchFindingFile } from "./fix.js";
import { captureException } from "../observability.js";
import { writeAudit, AUDIT_ACTIONS } from "../audit.js";

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

// How many distinct files the Worker will refetch for one pipeline run. A scan
// can name hundreds; fetching all of them would turn one request into a repo
// crawl. Findings whose file is not fetched still go through triage and
// validation — only fix generation needs the source — so the cap degrades the
// run rather than failing it.
const MAX_FETCH_FILES = 12;

// How many findings one call will put through the pipeline. Each survivor
// costs real model calls, so an unbounded run is an unbounded bill.
const MAX_FINDINGS = 50;

/** The org's customer-billed AI spend for the current calendar month. */
async function monthToDateSpend(env, orgId) {
  if (!env || !env.DB || !orgId) return null;
  const d = new Date();
  const startAt = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
  try {
    const row = await env.DB.prepare(
      `SELECT SUM(algosize_price) AS spend, COUNT(*) AS calls,
              SUM(CASE WHEN algosize_price IS NULL THEN 1 ELSE 0 END) AS unpriced
         FROM ai_usage
        WHERE org_id = ? AND created_at >= ?`
    ).bind(orgId, startAt).first();
    if (!row || !row.calls) return 0;
    // Spend that could not be priced is spend we cannot measure. Reporting the
    // measured part as if it were the total would let an org cross a budget
    // limit invisibly, so an unmeasured call makes the whole figure unknown —
    // budgetStatus then reads "unmeasured", which is explicitly not "under".
    if (row.unpriced > 0) return null;
    return typeof row.spend === "number" ? row.spend : 0;
  } catch {
    return null;
  }
}

function configuredBudget(env) {
  const n = Number(env && env.AI_BUDGET_USD);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function pickConfig(c) {
  const out = {};
  for (const id of STAGE_IDS) {
    if (c && typeof c[id] === "string" && c[id]) out[id] = c[id];
  }
  return out;
}

export async function runPipelineHandler(request, env, ctx) {
  const scope = await runScopeFor(request, env);
  if (!scope) return json({ error: "unauthorized" }, 401);

  let body;
  try { body = await request.json(); }
  catch { return json({ error: "invalid_json", message: "request body must be valid JSON" }, 400); }

  const config = pickConfig(body && body.config);
  const routeToMcp = expandRouting(
    Array.isArray(body && body.routeToMcp)
      ? body.routeToMcp.filter((s) => STAGE_IDS.includes(s)) : []);

  // Server-side enforcement, before any model is called. The same rules the
  // dashboard shows inline — a fix cannot grade its own author, and a model
  // must be able to do its stage's job — decide whether this run happens.
  const check = validateStageConfig(config, { routeToMcp });
  if (!check.ok) {
    return json({
      schema: "algosize.pipeline-run/1",
      error: "invalid_stage_config",
      message: "The stage configuration was rejected; no models were called.",
      errors: check.errors,
    }, 422);
  }

  // ---- resolve findings + files ------------------------------------------
  let findings = null, files = [], runId = null, sourceMode = null;

  if (typeof body.runId === "string" && body.runId) {
    runId = body.runId;
    const run = await getRun(env, scope, runId);
    if (!run) return json({ error: "not_found", message: "no such run" }, 404);
    findings = ((run.result && run.result.source && run.result.source.findings) || [])
      .filter((f) => f && typeof f.fingerprint === "string");
    sourceMode = "run";

    // Routing the fix stage means the platform never generates a patch, so it
    // never needs the customer's source: the run stops at validation and parks.
    // Not fetching is the honest consequence of that, not an optimisation.
    if (!routeToMcp.includes("fix")) {
      const repoUrl = (run.input && run.input.repoUrl) || null;
      if (repoUrl) {
        const paths = [...new Set(findings.map((f) => f.path).filter(Boolean))].slice(0, MAX_FETCH_FILES);
        for (const path of paths) {
          const got = await fetchFindingFile(repoUrl, path, env);
          if (got.file) files.push(got.file);
        }
      }
    }
  } else if (Array.isArray(body.findings)) {
    findings = body.findings.filter((f) => f && typeof f === "object");
    files = Array.isArray(body.files) ? body.files : [];
    sourceMode = "inline";
  } else {
    return json({ error: "invalid_payload",
      message: "provide `runId` (a stored scan) or `findings` [+ `files`]" }, 400);
  }

  if (!findings.length) {
    return json({ error: "no_findings",
      message: "that scan has no source findings to run the pipeline over" }, 400);
  }
  const capped = findings.length > MAX_FINDINGS;
  findings = findings.slice(0, MAX_FINDINGS);

  // ---- budget -------------------------------------------------------------
  const orgId = scope.orgId || null;
  const limitUsd = configuredBudget(env);
  const spendUsd = limitUsd ? await monthToDateSpend(env, orgId) : 0;

  // ---- run ----------------------------------------------------------------
  let outcome;
  const startedAt = Date.now();
  try {
    outcome = await runFullPipeline({
      findings, files, env,
      meter: { orgId, userId: (request.user && request.user.userId) || null, scanId: runId },
      budget: { spendUsd, limitUsd },
      options: {
        routeToMcp,
        frameworks: Array.isArray(body.frameworks) ? body.frameworks.slice(0, 8) : [],
        language: typeof body.language === "string" ? body.language : null,
        provider: typeof body.provider === "string" ? body.provider : null,
      },
    });
  } catch (err) {
    await captureException(env, ctx, err, {
      request, userId: request.user && request.user.userId,
      tags: { source: "pipeline", phase: "run" },
    });
    return json({ error: "pipeline_failed", message: "The fix pipeline errored. Try again." }, 500);
  }

  const ms = Date.now() - startedAt;
  const estimate = estimatePipelineCost(config, { routeToMcp });

  const pipeline = {
    schema: "algosize.pipeline-result/1",
    ranAt: Math.floor(startedAt / 1000),
    ms,
    config,
    routeToMcp,
    summary: outcome.summary,
    results: outcome.results,
    // What was NOT looked at, said out loud. A run that silently examined the
    // first 50 of 300 findings and reported "3 fix-ready" reads as a clean
    // sweep of the whole scan.
    coverage: {
      findingsConsidered: findings.length,
      findingsInScan: capped ? null : findings.length,
      capped,
      filesFetched: files.length,
      sourceAvailable: files.length > 0,
    },
  };

  // Attach to the scan run so the handoff can find the parked findings later.
  let attached = false;
  if (runId) {
    attached = await attachPipelineResult(env, scope, runId, pipeline);
  }

  try {
    await writeAudit(env, ctx, {
      actor: (request.user && request.user.email) || (orgId ? `org:${orgId}` : "unknown"),
      actorUserId: (request.user && request.user.userId) || null,
      orgId,
      action: AUDIT_ACTIONS.FIX_PROPOSED,
      targetType: "run", targetId: runId,
      metadata: {
        via: "pipeline_run", sourceMode, routeToMcp,
        considered: findings.length, funnel: outcome.summary.funnel,
      },
    });
  } catch { /* auditing is diagnostic, never load-bearing */ }

  const parked = outcome.results.filter((r) => r.outcome === "waiting_for_agent").length;
  return json({
    schema: "algosize.pipeline-run/1",
    runId, sourceMode, attached,
    ...pipeline,
    // The one number the page acts on next: how many findings are now sitting
    // waiting for an agent to pick up over MCP.
    parked,
    estimate: estimate.perFinding,
  }, 200);
}
