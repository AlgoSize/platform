// Algorithm optimizer — CI entrypoint.
//
//   node scripts/optimizer-ci.mjs [--all] [--base <ref>] [--config <path>]
//                                 [--report <path>] [--refactor]
//
// Runs the SAME core module the web endpoint uses (analyzers/optimizer.js —
// in-process sandbox, Big-O probe at 3 sizes, optional refactor suggestion)
// against the functions listed in optimizer.config.json at the repo root.
//
// Default mode audits only entries whose `file` changed vs `--base`
// (origin/main), so a PR pays for exactly what it touched; `--all` audits
// every entry. Auditing arbitrary changed files blindly is deliberately NOT
// supported: the sandbox rejects imports, async, Promise and friends as
// hostile (each ban maps to a real escape vector — see sandbox_runner.js),
// so real application modules would all be refused. The config names the
// self-contained functions worth watching, and this script watches them.
//
// Exit codes: 0 = every audited entry within its baseline (or measured
// "unknown", which warns without failing — an unmeasurable run is not
// evidence of a regression); 1 = at least one regression past its baseline,
// or a broken config entry (missing file/function), which should be loud.
//
// Refactor suggestions are OFF here unless --refactor or
// ENABLE_REFACTOR_SUGGESTIONS=true — CI usually only needs the Big-O gate,
// and skipping the LLM round-trip keeps the check fast and free.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import * as acorn from "acorn";

import { runOptimizer } from "../src/analyzers/optimizer.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

// Severity ladder for the regression gate. Anything unrecognised (O(n^4.1),
// exotic labels) ranks worst so a runaway can never pass by being weird.
const RANK = ["O(1)", "O(log n)", "O(n)", "O(n log n)", "O(n²)", "O(n³)"];
export function rankOf(label) {
  const norm = String(label || "")
    .replace(/\^2\)/, "²)").replace(/\^3\)/, "³)").trim();
  const i = RANK.indexOf(norm);
  return i === -1 ? RANK.length : i;
}

/** Slice the named top-level function declaration out of a file's source. */
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

function parseArgs(argv) {
  const args = { all: false, base: "origin/main", refactor: false,
                 config: resolve(ROOT, "optimizer.config.json"),
                 report: resolve(ROOT, "optimizer-report.json") };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--all") args.all = true;
    else if (a === "--refactor") args.refactor = true;
    else if (a === "--base") args.base = argv[++i];
    else if (a === "--config") args.config = resolve(ROOT, argv[++i]);
    else if (a === "--report") args.report = resolve(ROOT, argv[++i]);
  }
  return args;
}

function changedFiles(base) {
  try {
    const out = execSync(`git diff --name-only ${base}...HEAD`, { cwd: ROOT, encoding: "utf8" });
    return { ok: true, files: new Set(out.split("\n").map((s) => s.trim()).filter(Boolean)) };
  } catch (err) {
    return { ok: false, reason: String(err && err.message || err).split("\n")[0] };
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!existsSync(args.config)) {
    console.error(`optimizer-ci: no config at ${args.config} — nothing to audit.`);
    process.exit(1);
  }
  const config = JSON.parse(readFileSync(args.config, "utf8"));
  const entries = Array.isArray(config.entries) ? config.entries : [];

  // Which entries run: changed-files filter by default, everything on --all.
  let selected = entries;
  let mode = "all";
  if (!args.all) {
    const diff = changedFiles(args.base);
    if (diff.ok) {
      mode = `changed vs ${args.base}`;
      selected = entries.filter((e) => diff.files.has(e.file));
    } else {
      // A shallow clone or missing remote must not silently skip the audit.
      console.warn(`optimizer-ci: git diff failed (${diff.reason}) — falling back to --all.`);
      mode = "all (diff unavailable)";
    }
  }

  const enableRefactor = args.refactor
    || /^(true|1|on|yes)$/i.test(String(process.env.ENABLE_REFACTOR_SUGGESTIONS || ""));
  if (enableRefactor
      && !process.env.OPENAI_API_KEY
      && !(process.env.CLOUDFLARE_ACCOUNT_ID && process.env.CLOUDFLARE_AI_TOKEN)) {
    console.warn(
      "optimizer-ci: refactor suggestions requested but no AI credentials are set " +
      "(need OPENAI_API_KEY, or CLOUDFLARE_ACCOUNT_ID + CLOUDFLARE_AI_TOKEN). " +
      "Continuing with the Big-O gate only; suggestions will be stubs.");
  }

  const results = [];
  for (const entry of selected) {
    const r = { name: entry.name, file: entry.file, functionName: entry.functionName,
                baseline: entry.baseline || null, note: entry.note || null };
    const path = resolve(ROOT, entry.file);
    if (!existsSync(path)) {
      r.verdict = "error"; r.error = `file not found: ${entry.file}`;
      results.push(r); continue;
    }
    let code = null;
    try { code = extractFunction(readFileSync(path, "utf8"), entry.functionName); }
    catch (err) { r.verdict = "error"; r.error = `parse failed: ${err.message}`; results.push(r); continue; }
    if (!code) {
      r.verdict = "error"; r.error = `function ${entry.functionName} not found in ${entry.file}`;
      results.push(r); continue;
    }

    const run = await runOptimizer(
      { code, sampleInput: entry.sampleInput },
      { env: process.env, enableRefactor },
    );
    if (!run.ok) {
      r.verdict = "error"; r.error = `${run.error}: ${run.message}`;
      results.push(r); continue;
    }

    r.bigO = run.bigO;
    r.wallTimeMs = run.wallTimeMs;
    if (enableRefactor && run.suggestion && run.suggestion.provider !== "disabled") {
      r.suggestion = run.suggestion;
    }
    if (run.bigO.label === "unknown") {
      r.verdict = "unknown";
    } else if (entry.baseline && rankOf(run.bigO.label) > rankOf(entry.baseline)) {
      r.verdict = "regression";
    } else {
      r.verdict = "ok";
    }
    results.push(r);
  }

  const summary = {
    mode,
    audited: results.length,
    ok: results.filter((r) => r.verdict === "ok").length,
    unknown: results.filter((r) => r.verdict === "unknown").length,
    regressions: results.filter((r) => r.verdict === "regression").length,
    errors: results.filter((r) => r.verdict === "error").length,
  };
  writeFileSync(args.report, JSON.stringify({ summary, results }, null, 2) + "\n");

  // Console summary.
  console.log(`\nAlgorithm optimizer — ${summary.audited} entr${summary.audited === 1 ? "y" : "ies"} (${mode})\n`);
  for (const r of results) {
    const mark = r.verdict === "ok" ? "✓" : r.verdict === "unknown" ? "?" : "✗";
    const measured = r.bigO ? r.bigO.label : "—";
    const detail = r.verdict === "error" ? r.error
      : `measured ${measured}${r.baseline ? ` (baseline ≤ ${r.baseline})` : ""}`;
    console.log(`  ${mark} ${r.name} [${r.functionName} in ${r.file}] — ${detail}`);
    if (r.verdict === "unknown" && r.bigO && r.bigO.reason) {
      console.log(`      reason: ${r.bigO.reason}`);
    }
  }
  console.log(`\n  report: ${args.report}`);

  if (summary.regressions > 0 || summary.errors > 0) {
    console.error(`\noptimizer-ci: FAILED — ${summary.regressions} regression(s), ${summary.errors} error(s).`);
    process.exit(1);
  }
  console.log("\noptimizer-ci: passed.");
}

// Only run as a script — the exports above are imported by test-optimizer.mjs.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => { console.error("optimizer-ci: crashed", err); process.exit(1); });
}
