// CI ingestion — the endpoint a customer's build pipeline posts to.
//
//   POST /api/ci/runs      run the audit on submitted lockfiles, store a run
//   GET  /api/ci/snippet   the workflow YAML, for the dashboard to render
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

  const lockfiles = body.lockfiles;
  if (!Array.isArray(lockfiles) || lockfiles.length === 0) {
    return {
      ok: false, status: 400, error: "no_lockfiles",
      message: `Provide \`lockfiles\`: an array of { path, content }. Supported files: ${LOCKFILE_NAMES.join(", ")}.`,
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

  if (manifests.length === 0) {
    return {
      ok: false, status: 400, error: "no_supported_lockfiles",
      message: `None of the submitted files is a supported lockfile. Supported: ${LOCKFILE_NAMES.join(", ")}.`,
    };
  }

  return {
    ok: true,
    value: {
      repo:      typeof body.repo === "string" ? body.repo.slice(0, 200) : null,
      ref:       typeof body.ref === "string" ? body.ref.slice(0, 200) : null,
      commitSha: typeof body.commit_sha === "string" ? body.commit_sha.slice(0, 64) : null,
      failOn,
      manifests,
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
  const audit = await auditManifests(v.value.manifests, fetchImpl, { env, ctx, request });
  if (!audit.ok) return json(audit.body, audit.status);

  const counts = audit.result.counts || {};
  const failed = shouldFail(counts, v.value.failOn);

  // The stored result carries the CI context alongside the audit, so the
  // dashboard row can say which commit it was and link back to the build.
  const result = {
    ...audit.result,
    ci: { repo: v.value.repo, ref: v.value.ref, commitSha: v.value.commitSha, failOn: v.value.failOn, failed },
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
        repo: v.value.repo, ref: v.value.ref, commitSha: v.value.commitSha,
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

  if (!run) {
    // The audit succeeded but we could not file it. Returning the verdict is
    // still the right call — the build gets its answer — but the response must
    // not hand back a report URL that will 404.
    return json({
      runId: null,
      reportUrl: null,
      summary: pickCounts(counts),
      worstSeverity: worstSeverityOf(counts),
      failed,
      warning: "The audit ran but the result could not be saved, so it will not appear in the dashboard.",
    }, 200);
  }

  const origin = (env.SITE_ORIGIN || "").replace(/\/$/, "");
  return json({
    runId: run.id,
    reportUrl: `${origin}/api/runs/${run.id}/report`,
    summary: pickCounts(counts),
    worstSeverity: worstSeverityOf(counts),
    failed,
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

  return json({
    filename: ".github/workflows/algosize-audit.yml",
    secretName: "ALGOSIZE_API_KEY",
    setupSteps: [
      "Create an API key in the dashboard (API keys → Create key). Copy it — it is shown once.",
      "Add it to the repository as a secret named ALGOSIZE_API_KEY: " +
        "gh secret set ALGOSIZE_API_KEY --body '<the key>'",
      "Commit the workflow file below.",
    ],
    workflow: buildWorkflow({ origin, failOn }),
  }, 200);
}

export function buildWorkflow({ origin, failOn = DEFAULT_FAIL_ON }) {
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

      - name: Collect lockfiles
        id: collect
        if: steps.key.outputs.present == 'true'
        run: |
          python3 - <<'PY' > payload.json
          import json, os, subprocess
          NAMES = {"package-lock.json", "yarn.lock", "requirements.txt", "Gemfile.lock", "go.sum"}
          files = subprocess.run(["git", "ls-files"], capture_output=True, text=True).stdout.split()
          out = []
          for p in files:
              if os.path.basename(p) not in NAMES:
                  continue
              try:
                  with open(p, encoding="utf-8") as fh:
                      out.append({"path": p, "content": fh.read()})
              except (OSError, UnicodeDecodeError):
                  pass
          print(json.dumps({
              "repo": os.environ["GITHUB_REPOSITORY"],
              "ref": os.environ["GITHUB_REF"],
              "commit_sha": os.environ["GITHUB_SHA"],
              "fail_on": "${failOn}",
              "lockfiles": out,
          }))
          PY
          echo "count=$(python3 -c 'import json;print(len(json.load(open("payload.json"))["lockfiles"]))')" >> "$GITHUB_OUTPUT"

      - name: Run the Algosize audit
        if: steps.key.outputs.present == 'true' && steps.collect.outputs.count != '0'
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
          } >> "$GITHUB_OUTPUT"
          jq -r '"| Severity | Count |\\n|---|---|\\n| Critical | \\(.summary.critical) |\\n| High | \\(.summary.high) |\\n| Medium | \\(.summary.medium) |\\n| Low | \\(.summary.low) |"' response.json > table.md

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

      - name: Fail the build on new findings
        if: steps.audit.outputs.failed == 'true'
        run: |
          echo "::error::Algosize found advisories at or above the '${failOn}' threshold. See \${{ steps.audit.outputs.report_url }}"
          exit 1
`;
}
