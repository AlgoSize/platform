// The secondary monitor analyzers: Architecture X-ray, Infrastructure Cost
// Estimator and Algorithm optimizer, run on a monitor's schedule.
//
// One rule makes all three admissible to the sweep, and this module is where
// it is enforced: EVERY input is a committed repository file, fetched from
// GitHub raw content by well-known name. No cloud-account connector, no
// credential storage, nothing contacted except GitHub and our own analyzers.
// The estimator in particular is scheduled here only in that restricted
// sense — it prices the committed compose file against the bundled catalog,
// exactly as if the user had uploaded it; it still never connects to a cloud
// account, and its route-level "no connector, no credential storage" promise
// is unchanged.
//
// ---------------------------------------------------------------------------
// Failure posture — softer than the vuln audit's, deliberately
// ---------------------------------------------------------------------------
// The vuln audit is the monitor's primary job: when it fails upstream the
// whole check throws so the Queue redelivers. These three are additions to
// that job. If one of them cannot run tonight — GitHub throttled the extra
// fetches, the sandbox was unreachable — it is SKIPPED with the reason
// captured, and crucially its baseline is left untouched (recordMonitorRun
// only writes a baseline that is explicitly provided). The next successful
// run diffs against the last successful one, so an outage costs a night's
// coverage, never a false "everything here is new again" email.
//
// A permanent condition — no manifests in the repo, no optimizer.config.json
// — is also a quiet skip, not an error: the monitor's owner chose the toggle
// before adding the file, or removed the file after, and nightly failure
// emails about configuration are exactly the noise that gets a monitor
// muted.

import { analyzeArchitecture, validateArchitectureInput } from "../analyzers/architecture.js";
import { runOptimizer, extractFunction } from "../analyzers/optimizer.js";
import { estimateHandler } from "../handlers/estimate.js";
import { runInSandbox } from "../handlers/analyze.js";

// Root-level manifests the Architecture X-ray can parse, fetched by name —
// the same access pattern the lockfile audit uses. Manifests in
// subdirectories are out of reach of name-based fetching and that limit is
// stated in the dashboard copy rather than silently narrowing the promise.
export const ARCH_MANIFEST_NAMES = Object.freeze([
  "wrangler.toml",
  "docker-compose.yml", "docker-compose.yaml",
  "compose.yml", "compose.yaml",
  "Dockerfile",
  "_config.yml",
]);

// The estimator prices the compose file specifically — its committed-file
// adapter. wrangler.toml describes bindings, not paid capacity, so it has
// nothing to price.
const COMPOSE_NAMES = ["docker-compose.yml", "docker-compose.yaml", "compose.yml", "compose.yaml"];

export const OPTIMIZER_CONFIG_NAME = "optimizer.config.json";

// Bounds for the optimizer pass. Each entry is two sandbox runs plus three
// Big-O probes; a config with hundreds of entries would turn one queue
// message into a marathon. Twelve covers any plausible watchlist, and when
// the cap bites it is REPORTED in the result rather than silently truncating.
export const MAX_ALGO_ENTRIES = 12;
const MAX_FILE_BYTES = 512 * 1024;

// ---------------------------------------------------------------------------
// Fetching — same shape as the lockfile fetch in handlers/analyze.js
// ---------------------------------------------------------------------------

/**
 * Fetch a set of root-level files by name from a GitHub repo.
 *
 * `branch` pins the monitor's configured branch; without one, main then
 * master, taking the first branch that yields anything. 404 is a miss;
 * 403/429 and 5xx return { throttled: true } so the caller can skip WITHOUT
 * advancing baselines — GitHub saying "slow down" must not read as "these
 * files no longer exist".
 */
export async function fetchRepoFilesByName({ owner, repo, branch }, names, fetchImpl) {
  const branches = branch ? [branch] : ["main", "master"];
  for (const b of branches) {
    let throttled = false;
    const results = await Promise.all(names.map(async (filename) => {
      const url = `https://raw.githubusercontent.com/${owner}/${repo}/${b}/${encodeURI(filename)}`;
      let res;
      try { res = await fetchImpl(url); } catch { return null; }
      if (res.status === 429 || res.status === 403 || res.status >= 500) { throttled = true; return null; }
      if (!res.ok) return null;
      const text = await res.text();
      if (text.length > MAX_FILE_BYTES) return null;   // skip silently — too big
      return { path: filename, content: text };
    }));
    if (throttled) return { files: [], throttled: true };
    const found = results.filter(Boolean);
    if (found.length > 0) return { files: found, throttled: false };
  }
  return { files: [], throttled: false };
}

export function parseGithubRepoUrl(repoUrl) {
  let u;
  try { u = new URL(repoUrl); } catch { return null; }
  const parts = u.pathname.split("/").filter(Boolean);
  if (parts.length < 2) return null;
  return { owner: parts[0], repo: parts[1].replace(/\.git$/, "") };
}

// ---------------------------------------------------------------------------
// Architecture X-ray
// ---------------------------------------------------------------------------

/** Identity of an arch finding for diffing: same philosophy as advisoryKey. */
export function archFindingKey(f) {
  if (!f || typeof f !== "object") return null;
  return `${f.target || "unknown"}|${f.lens || "unknown"}|${f.rule || "unknown"}`;
}

/**
 * Run the X-ray over a monitor's repo.
 *
 * Returns one of:
 *   { status: "ok", findings, keys }     keys sorted, for the baseline
 *   { status: "no_manifests" }           nothing at root the X-ray can read
 *   { status: "skipped", reason }        transient — baseline must not move
 */
export async function runArchForMonitor(monitor, env, fetchImpl) {
  const repo = parseGithubRepoUrl(monitor.repoUrl);
  if (!repo) return { status: "skipped", reason: "bad_repo_url" };

  const fetched = await fetchRepoFilesByName(
    { ...repo, branch: monitor.branch }, ARCH_MANIFEST_NAMES, fetchImpl);
  if (fetched.throttled) return { status: "skipped", reason: "github_throttled" };
  if (!fetched.files.length) return { status: "no_manifests" };

  const v = validateArchitectureInput({ files: fetched.files });
  if (!v.ok) return { status: "skipped", reason: v.error || "invalid_input" };

  let result;
  try { result = analyzeArchitecture(v.value); }
  catch (err) { return { status: "skipped", reason: "analyzer_failed", detail: String(err && err.message || err) }; }

  const findings = Array.isArray(result.findings) ? result.findings : [];
  const keys = [...new Set(findings.map(archFindingKey).filter(Boolean))].sort();
  // `result` is the WHOLE analyzer output — graph, clusters, findings — in
  // exactly the shape POST /api/analyze/architecture returns. The sweep uses
  // only findings and keys; it rides along so the inspect endpoint
  // (monitors/inspect.js) can hand the X-ray a result it can draw without a
  // second code path that could drift from this one.
  return { status: "ok", findings, keys, result };
}

/** Diff arch findings against the stored baseline. Same contract as diffAdvisories. */
export function diffArchFindings(findings, keys, previousKeys) {
  const isBaseline = previousKeys === null || previousKeys === undefined;
  if (isBaseline) {
    return { newFindings: findings.slice(), currentKeys: keys, isBaseline: true,
             shouldAlert: findings.length > 0 };
  }
  const previous = new Set(previousKeys);
  const newFindings = findings.filter((f) => {
    const k = archFindingKey(f);
    return k && !previous.has(k);
  });
  return { newFindings, currentKeys: keys, isBaseline: false, shouldAlert: newFindings.length > 0 };
}

// ---------------------------------------------------------------------------
// Infrastructure Cost Estimator
// ---------------------------------------------------------------------------

/**
 * Price the committed compose file.
 *
 * Goes through the real estimateHandler with a synthetic request rather than
 * re-plumbing the parse → validate → price pipeline: that handler IS the
 * sanitizing boundary (size caps, secret detection, sanitized failures), and
 * a scheduled estimate must not get a second, laxer path around it. The
 * handler reads nothing from the request but a header, so a bare synthetic
 * Request is the whole integration.
 *
 * Returns:
 *   { status: "ok", byProvider, providers }   byProvider: id → total microUSD
 *   { status: "no_compose" }                  nothing to price
 *   { status: "skipped", reason }             transient or rejected
 */
export async function runEstimateForMonitor(monitor, env, ctx, fetchImpl) {
  const repo = parseGithubRepoUrl(monitor.repoUrl);
  if (!repo) return { status: "skipped", reason: "bad_repo_url" };

  const fetched = await fetchRepoFilesByName(
    { ...repo, branch: monitor.branch }, COMPOSE_NAMES, fetchImpl);
  if (fetched.throttled) return { status: "skipped", reason: "github_throttled" };
  if (!fetched.files.length) return { status: "no_compose" };

  const request = new Request("https://internal/api/estimate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ inputType: "compose", content: fetched.files[0].content }),
  });

  let body;
  try {
    const response = await estimateHandler(request, env, ctx);
    body = await response.json();
    if (!response.ok) return { status: "skipped", reason: body && body.error || "estimate_failed" };
  } catch (err) {
    return { status: "skipped", reason: "estimate_failed", detail: String(err && err.message || err) };
  }

  const providers = Array.isArray(body.providers) ? body.providers : [];
  const byProvider = {};
  for (const p of providers) {
    if (p && typeof p.providerId === "string" && typeof p.estimatedTotalMicroUsd === "number") {
      byProvider[p.providerId] = p.estimatedTotalMicroUsd;
    }
  }
  // Same reason as the arch pass: `body` is what POST /api/estimate returned,
  // so the estimator page can render a monitored repo through its existing
  // renderer instead of a parallel one.
  return { status: "ok", byProvider, providers, disclaimer: body.disclaimer || null, result: body };
}

/**
 * Diff an estimate against the stored baseline.
 *
 * Alerts on any provider whose monthly total moved, and on providers
 * appearing or disappearing — a config change that adds a resource shows up
 * as both. Totals are integer micro-USD, so "moved" is exact, not a float
 * comparison.
 */
export function diffEstimate(byProvider, previous) {
  const isBaseline = previous === null || previous === undefined;
  if (isBaseline) {
    return { changes: [], isBaseline: true, shouldAlert: Object.keys(byProvider).length > 0 };
  }
  const prev = previous.byProvider || {};
  const changes = [];
  for (const [id, total] of Object.entries(byProvider)) {
    if (!(id in prev)) changes.push({ providerId: id, from: null, to: total });
    else if (prev[id] !== total) changes.push({ providerId: id, from: prev[id], to: total });
  }
  for (const id of Object.keys(prev)) {
    if (!(id in byProvider)) changes.push({ providerId: id, from: prev[id], to: null });
  }
  return { changes, isBaseline: false, shouldAlert: changes.length > 0 };
}

/** Micro-USD → "$123.45" for the email. One rounding site, not three. */
export function formatMicroUsd(micro) {
  if (typeof micro !== "number" || !Number.isFinite(micro)) return "—";
  return "$" + (micro / 1_000_000).toFixed(2);
}

// ---------------------------------------------------------------------------
// Algorithm optimizer
// ---------------------------------------------------------------------------

// Complexity buckets in improving-to-worsening order, for regression checks.
//
// The analyzer (analyzers/bigo.js) emits superscript labels — "O(n²)",
// "O(n³)" — while humans typing a ceiling into optimizer.config.json will
// write "O(n^2)"; both spellings MUST rank identically or every polynomial
// grade silently falls into the unranked-worst bucket and an n²→n³
// regression becomes invisible. Past O(n³) the analyzer reports the raw
// exponent ("O(n^4.2)"), ranked by that exponent; anything unparseable —
// including "unknown" — ranks worst, because a function whose complexity
// became unmeasurable is a change worth hearing about, not one to hide
// behind an unsortable label.
const BIGO_RANKS = new Map([
  ["O(1)", 0], ["O(log n)", 1], ["O(n)", 2], ["O(n log n)", 3],
  ["O(n²)", 4], ["O(n^2)", 4], ["O(n³)", 5], ["O(n^3)", 5],
]);
const UNRANKED_WORST = 100;
export function bigORank(label) {
  if (BIGO_RANKS.has(label)) return BIGO_RANKS.get(label);
  const m = typeof label === "string" ? label.match(/^O\(n\^([0-9.]+)\)$/) : null;
  if (m) {
    const k = Number.parseFloat(m[1]);
    if (Number.isFinite(k) && k > 3) return Math.min(5 + (k - 3), UNRANKED_WORST - 1);
  }
  return UNRANKED_WORST;
}

/**
 * Run the Big-O audit over the functions optimizer.config.json names.
 *
 * The config file is the SAME manifest the CI workflow uses, so the nightly
 * sweep and the per-PR gate watch the same functions by construction.
 * Refactor suggestions are forced OFF here: an LLM call per function per
 * night per monitor is spend with no reader, and the grade is the signal.
 *
 * Returns:
 *   { status: "ok", grades, skippedEntries }  grades: name → "O(n)"
 *   { status: "no_config" }                   repo has no optimizer.config.json
 *   { status: "skipped", reason }             transient — baseline must not move
 */
export async function runAlgoForMonitor(monitor, env, fetchImpl) {
  const repo = parseGithubRepoUrl(monitor.repoUrl);
  if (!repo) return { status: "skipped", reason: "bad_repo_url" };

  const cfgFetch = await fetchRepoFilesByName(
    { ...repo, branch: monitor.branch }, [OPTIMIZER_CONFIG_NAME], fetchImpl);
  if (cfgFetch.throttled) return { status: "skipped", reason: "github_throttled" };
  if (!cfgFetch.files.length) return { status: "no_config" };

  let config;
  try { config = JSON.parse(cfgFetch.files[0].content); }
  catch { return { status: "skipped", reason: "config_invalid" }; }
  const entries = Array.isArray(config && config.entries) ? config.entries : [];
  if (!entries.length) return { status: "no_config" };

  const capped = entries.slice(0, MAX_ALGO_ENTRIES);
  const grades = {};
  const skippedEntries = [];
  if (entries.length > MAX_ALGO_ENTRIES) {
    skippedEntries.push({
      name: `…and ${entries.length - MAX_ALGO_ENTRIES} more`,
      reason: `config lists ${entries.length} entries; the sweep audits the first ${MAX_ALGO_ENTRIES}`,
    });
  }

  // Files fetched once each, however many entries share them.
  const wantedFiles = [...new Set(capped
    .map((e) => e && typeof e.file === "string" ? e.file : null)
    .filter(Boolean))];
  const srcFetch = await fetchRepoFilesByName(
    { ...repo, branch: monitor.branch }, wantedFiles, fetchImpl);
  if (srcFetch.throttled) return { status: "skipped", reason: "github_throttled" };
  const sources = {};
  for (const f of srcFetch.files) sources[f.path] = f.content;

  for (const entry of capped) {
    const name = (entry && (entry.name || entry.functionName)) || "unnamed";
    if (!entry || typeof entry.file !== "string" || typeof entry.functionName !== "string") {
      skippedEntries.push({ name, reason: "entry missing file or functionName" });
      continue;
    }
    const source = sources[entry.file];
    if (source === undefined) {
      skippedEntries.push({ name, reason: `${entry.file} not found in the repo` });
      continue;
    }
    let code;
    try { code = extractFunction(source, entry.functionName); }
    catch { code = null; }
    if (!code) {
      skippedEntries.push({ name, reason: `function ${entry.functionName} not found in ${entry.file}` });
      continue;
    }

    const run = await runOptimizer(
      { code, sampleInput: "sampleInput" in entry ? entry.sampleInput : undefined },
      { runner: (c, i) => runInSandbox(env, c, i), env, enableRefactor: false },
    );
    if (!run.ok) {
      // Sandbox unreachable is transient for the WHOLE pass — half a grade
      // map recorded as the baseline would report the missing half as
      // "regressed to unknown" the moment the sandbox came back.
      if (run.error === "sandbox_unreachable") {
        return { status: "skipped", reason: "sandbox_unreachable" };
      }
      skippedEntries.push({ name, reason: run.message || run.error || "sandbox rejected the function" });
      continue;
    }
    grades[name] = (run.bigO && run.bigO.label) || "unknown";
  }

  if (!Object.keys(grades).length && skippedEntries.length) {
    return { status: "skipped", reason: "no_entries_ran" };
  }
  // `entries` is the committed optimizer.config.json, capped the same way the
  // grades were. It rides along so the optimizer page can show each measured
  // grade against the CEILING the repo asked for — a grade with no ceiling
  // beside it is a number, not a verdict.
  return { status: "ok", grades, skippedEntries, entries: capped };
}

/**
 * Diff grades against the stored baseline.
 *
 * Alerts on REGRESSIONS only — a grade moving to a worse bucket, or to
 * "unknown". Improvements ride along in the email when one is already being
 * sent, but never trigger one: "your function got faster" at 3am is not an
 * alert. The baseline run records grades silently for the same reason —
 * unlike advisories, a grade is not actionable until it moves.
 */
export function diffAlgoGrades(grades, previous) {
  const isBaseline = previous === null || previous === undefined;
  if (isBaseline) {
    return { regressions: [], improvements: [], isBaseline: true, shouldAlert: false };
  }
  const prev = previous.byName || {};
  const regressions = [];
  const improvements = [];
  for (const [name, label] of Object.entries(grades)) {
    if (!(name in prev)) continue;   // newly-watched function: its first grade is its baseline
    const before = prev[name];
    if (bigORank(label) > bigORank(before)) regressions.push({ name, from: before, to: label });
    else if (bigORank(label) < bigORank(before)) improvements.push({ name, from: before, to: label });
  }
  return { regressions, improvements, isBaseline: false, shouldAlert: regressions.length > 0 };
}
