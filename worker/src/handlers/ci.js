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

import { auditManifests } from "./analyze.js";
import { persistRun } from "./runs.js";
import { storeReportFor } from "../reports/render.js";
import { SUPPORTED_FILES as LOCKFILE_NAMES, MAX_LOCKFILE_BYTES } from "../analyzers/lockfile.js";
import { validateArchitectureInput, analyzeArchitecture } from "../analyzers/architecture.js";
import { recordSnapshot } from "../arch/snapshots.js";
import { captureException } from "../observability.js";

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

function validate(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, status: 400, error: "invalid_payload", message: "Request body must be a JSON object." };
  }

  const lockfiles = Array.isArray(body.lockfiles) ? body.lockfiles : [];
  const archFiles = Array.isArray(body.files) ? body.files : [];

  if (lockfiles.length === 0 && archFiles.length === 0) {
    return {
      ok: false, status: 400, error: "no_inputs",
      message: "Provide `lockfiles` (dependency audit) and/or `files` (architecture analysis), " +
               `each an array of { path, content }. Supported lockfiles: ${LOCKFILE_NAMES.join(", ")}.`,
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
  // the half the caller never asked for.
  if (manifests.length === 0 && archFiles.length === 0) {
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
  const ciContext = { repo: v.value.repo, ref: v.value.ref, commitSha: v.value.commitSha };

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
      reportUrl: run ? `${origin}/api/runs/${run.id}/report` : null,
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
        summary: archResult.summary,
        worstSeverity: worstSeverityOf(bySeverity),
        failed: archFailed,
        ...(archRun ? {} : { warning: "The analysis ran but the result could not be saved, so it will not appear in the dashboard." }),
      };
    }
  }

  // Top-level fields keep describing the dependency audit, so every existing
  // consumer — including the workflow's own jq — reads the same shape it
  // always has. `failed` is the verdict ACROSS both analyzers, which is what a
  // build gates on; architecture contributes to it only when the caller opted
  // in via `arch_fail_on`, which defaults to "none".
  return json({
    runId:         vuln ? vuln.runId : null,
    reportUrl:     vuln ? vuln.reportUrl : null,
    summary:       vuln ? vuln.summary : pickCounts({}),
    worstSeverity: vuln ? vuln.worstSeverity : null,
    failed:        Boolean((vuln && vuln.failed) || (architecture && architecture.failed)),
    ...(vuln && vuln.warning ? { warning: vuln.warning } : {}),
    ...(architecture ? { architecture } : {}),
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

          locks = []
          for p in tracked:
              if os.path.basename(p) in LOCK_NAMES:
                  c = read(p)
                  if c is not None:
                      locks.append({"path": p, "content": c})

          candidates = [p for p in tracked if not is_env(p)]
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
          } >> "$GITHUB_OUTPUT"
          # The dependency table only exists when lockfiles were submitted; a
          # repo with none still gets an architecture summary rather than an
          # empty comment claiming zero advisories.
          : > table.md
          if [ "$(jq -r 'has("summary") and (.runId != null)' response.json)" = "true" ]; then
            jq -r '"| Severity | Count |\\n|---|---|\\n| Critical | \\(.summary.critical) |\\n| High | \\(.summary.high) |\\n| Medium | \\(.summary.medium) |\\n| Low | \\(.summary.low) |"' response.json >> table.md
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
    "$comment": "monthlyCeilingUsd is the number that fails a build, checked against the CHEAPEST priced provider. Omit it (or set it to null) to annotate the pull request without ever failing — which is the right setting until you have watched a few runs and trust the figure. `compose` is repo-root-relative.",
    compose: "docker-compose.yml",
    monthlyCeilingUsd: null,
    providers: ["hetzner", "aws"],
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

      - name: Collect source
        if: steps.key.outputs.skip != 'true'
        id: collect
        run: |
          # Source only, and bounded. Build output and vendored dependencies
          # carry no signal about YOUR architecture and would dominate the graph.
          find . \\
            -path ./node_modules -prune -o \\
            -path ./.git -prune -o \\
            -path ./dist -prune -o \\
            -path ./build -prune -o \\
            -path ./vendor -prune -o \\
            -type f \\( -name '*.js' -o -name '*.mjs' -o -name '*.ts' -o -name '*.tsx' -o -name '*.py' -o -name '*.go' \\) \\
            -size -200k -print | head -400 | sed 's|^\./||' > files.txt

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

          if [ "$HTTP" != "200" ]; then
            echo "::warning::The architecture endpoint returned HTTP $HTTP — annotating without a verdict."
            echo "skip=true" >> "$GITHUB_OUTPUT"
            exit 0
          fi

          jq -r '.architecture
                 | "clusters=\\(.summary.clusters // 0)",
                   "findings=\\(.summary.findings // 0)",
                   "worst=\\(.worstSeverity // "none")",
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
          } > comment.md
          gh pr comment "$PR" --body-file comment.md --edit-last || \\
            gh pr comment "$PR" --body-file comment.md

          if [ "\${{ steps.run.outputs.failed }}" = "true" ]; then
            echo "::error::Architecture findings exceeded the configured threshold."
            exit 1
          fi
`;
}
