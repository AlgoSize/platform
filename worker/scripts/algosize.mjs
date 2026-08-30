#!/usr/bin/env node
// algosize — thin CLI over the Algosize HTTP API.
//
// The Worker cannot touch your checkout and holds no repository credential;
// this CLI is the other half of that contract. It runs where your code and
// your git identity already live, calls the same API the dashboard and MCP
// tools use, and applies validated fixes with YOUR git, on YOUR branch.
// Follows the repo's one CLI precedent (scripts/optimizer-ci.mjs): plain
// Node, zero dependencies.
//
// Usage:
//   ALGOSIZE_API_KEY=ask_live_… node scripts/algosize.mjs <command> [args]
//
// Commands:
//   profile-repo <repoUrl>              language/framework/coverage profile
//   scan <repoUrl>                      dependency audit + source scan
//   generate-fix --finding f.json --file path/to/file [--provider kimi]
//   validate-fix --finding f.json --original a.js --fixed b.js
//   import-sarif <log.sarif>            normalize an external scanner's log
//   export-sarif <runId> [out.sarif]    a stored run as SARIF
//   apply-fix <proposal.json> [--branch fix/name]
//                                       write proposal files; optionally on a
//                                       new git branch. PR creation stays with
//                                       you (`gh pr create`) — this tool will
//                                       not push.
//
// Environment:
//   ALGOSIZE_API_KEY   required for every remote command (ask_live_…)
//   ALGOSIZE_ORIGIN    default https://algosize.com

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";
import { execFileSync } from "node:child_process";

const ORIGIN = (process.env.ALGOSIZE_ORIGIN || "https://algosize.com").replace(/\/$/, "");
const KEY = process.env.ALGOSIZE_API_KEY || "";

const die = (msg, code = 1) => { console.error(`algosize: ${msg}`); process.exit(code); };

function flag(args, name) {
  const i = args.indexOf(`--${name}`);
  if (i === -1) return null;
  const v = args[i + 1];
  if (!v || v.startsWith("--")) die(`--${name} needs a value`);
  args.splice(i, 2);
  return v;
}

async function api(path, { method = "POST", body, raw = false } = {}) {
  if (!KEY) die("set ALGOSIZE_API_KEY (create one in the dashboard under API keys)");
  const res = await fetch(`${ORIGIN}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${KEY}`,
      ...(body !== undefined && !raw ? { "content-type": "application/json" } : {}),
    },
    body: body === undefined ? undefined : raw ? body : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* SARIF export etc. may not be relevant */ }
  if (!res.ok) {
    die(`${path} → ${res.status}: ${(json && (json.message || json.error)) || text.slice(0, 300)}`);
  }
  return { json, text };
}

const readJson = (p) => {
  try { return JSON.parse(readFileSync(p, "utf8")); }
  catch (e) { die(`could not read ${p}: ${e.message}`); }
};

// ---------------------------------------------------------------------------

const [, , command, ...args] = process.argv;

switch (command) {
  case "profile-repo": {
    const repoUrl = args[0] || die("usage: profile-repo <repoUrl>");
    const { json } = await api("/api/analyze/profile", { body: { repoUrl } });
    console.log(json.summary + "\n");
    for (const l of json.repositoryProfile.languages) {
      console.log(`  ${l.name.padEnd(16)} ${String(l.fileCount).padStart(5)} files  tier ${l.supportTier}  → ${l.analyzers.join(", ")}`);
    }
    for (const g of json.repositoryProfile.scanPlan.gaps || []) console.log(`\n  ! ${g.detail}`);
    break;
  }

  case "scan": {
    const repoUrl = args[0] || die("usage: scan <repoUrl>");
    const { json } = await api("/api/analyze/vuln", { body: { repoUrl } });
    const c = json.counts || {};
    console.log(`dependencies: ${c.critical || 0} critical, ${c.high || 0} high, ${c.medium || 0} medium, ${c.low || 0} low`);
    const src = json.source || {};
    if (src.status === "ok") {
      const s = src.summary.bySeverity;
      console.log(`code:         ${s.critical} critical, ${s.high} high, ${s.medium} medium, ${s.low} low across ${src.coverage.filesScanned} file(s)`);
      for (const f of src.findings.slice(0, 20)) {
        console.log(`  [${f.severity}] ${f.path}:${f.line} ${f.title} (${f.ruleId})`);
      }
      if (src.findings.length > 20) console.log(`  …and ${src.findings.length - 20} more`);
      console.log("\nFull findings JSON is on stdout of: scan --json (or the dashboard report).");
    } else if (src.status) {
      console.log(`code:         not scanned — ${src.message}`);
    }
    if (args.includes("--json")) console.log(JSON.stringify(json, null, 2));
    break;
  }

  case "generate-fix": {
    const findingPath = flag(args, "finding") || die("usage: generate-fix --finding f.json --file src/x.js [--provider kimi|claude|openai]");
    const filePath = flag(args, "file") || die("--file <path> is required: the fix is built against your working copy");
    const provider = flag(args, "provider");
    const finding = readJson(findingPath);
    const content = readFileSync(filePath, "utf8");
    const { json } = await api("/api/fix/propose", {
      body: { finding, files: [{ path: finding.path, content }], ...(provider ? { provider } : {}) },
    });
    console.log(`verdict: ${json.validation.verdict}${json.applyable ? " — applyable" : ""}`);
    for (const c of json.validation.checks) console.log(`  ${c.ok ? "✓" : "✗"} ${c.check}: ${c.detail}`);
    console.log(`not checked (run yourself): ${json.validation.checksNotRun.map((c) => c.check).join(", ")}`);
    const out = `fix-${json.taskId}.json`;
    writeFileSync(out, JSON.stringify(json, null, 2));
    writeFileSync(`fix-${json.taskId}.patch`, json.patch || "");
    console.log(`\nwrote ${out} and fix-${json.taskId}.patch`);
    console.log(json.applyable
      ? `apply with: node scripts/algosize.mjs apply-fix ${out} --branch fix/${finding.ruleId.split(".").pop()}`
      : "NOT applyable as-is — see the reasons above.");
    break;
  }

  case "validate-fix": {
    const findingPath = flag(args, "finding") || die("usage: validate-fix --finding f.json --original a.js --fixed b.js");
    const orig = flag(args, "original") || die("--original <path> required");
    const fixed = flag(args, "fixed") || die("--fixed <path> required");
    const finding = readJson(findingPath);
    const { json } = await api("/api/fix/validate", {
      body: {
        finding,
        original: { path: finding.path, content: readFileSync(orig, "utf8") },
        fixed:    { path: finding.path, content: readFileSync(fixed, "utf8") },
      },
    });
    console.log(`verdict: ${json.validation.verdict}${json.applyable ? " — applyable" : ""}`);
    for (const c of json.validation.checks) console.log(`  ${c.ok ? "✓" : "✗"} ${c.check}: ${c.detail}`);
    process.exit(json.applyable ? 0 : 1);
  }

  case "import-sarif": {
    const p = args[0] || die("usage: import-sarif <log.sarif>");
    const { json } = await api("/api/import/sarif", { body: readFileSync(p, "utf8"), raw: true });
    const s = json.summary.bySeverity;
    console.log(`imported ${json.coverage.imported}/${json.coverage.resultsInDocument} from ${json.coverage.tools.join(", ")}` +
      ` — ${s.critical} critical, ${s.high} high, ${s.medium} medium, ${s.low} low`);
    console.log(JSON.stringify(json.findings, null, 2));
    break;
  }

  case "export-sarif": {
    const runId = args[0] || die("usage: export-sarif <runId> [out.sarif]");
    const out = args[1] || `${runId}.sarif`;
    const { text } = await api(`/api/runs/${encodeURIComponent(runId)}/report?format=sarif`, { method: "GET" });
    writeFileSync(out, text);
    console.log(`wrote ${out}`);
    break;
  }

  case "apply-fix": {
    const p = args[0] || die("usage: apply-fix <fix-….json> [--branch fix/name]");
    const branch = flag(args, "branch");
    const fix = readJson(p);
    if (!fix.applyable) {
      die("this proposal did not pass static validation — refusing to apply it. Re-generate or fix by hand.");
    }
    if (branch) {
      try { execFileSync("git", ["checkout", "-b", branch], { stdio: "inherit" }); }
      catch { die(`could not create branch ${branch}`); }
    }
    const cwd = resolve(".");
    for (const f of fix.proposal.files) {
      const target = resolve(f.path);
      // The proposal names repository-relative paths; refuse anything that
      // escapes the working directory however it is spelled.
      if (target !== cwd && !target.startsWith(cwd + sep)) die(`refusing to write outside the working directory: ${f.path}`);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, f.content);
      console.log(`wrote ${f.path}`);
    }
    console.log("\nApplied. Now: run your tests, review the diff, commit, and open the PR yourself" +
      (branch ? ` (branch ${branch} is checked out)` : "") + ". Algosize does not push code.");
    break;
  }

  default:
    console.log(`algosize — code quality + security + fix orchestration

  profile-repo <repoUrl>      what a scan would cover, and how deeply
  scan <repoUrl>              dependency audit + source scan
  generate-fix --finding f.json --file src/x.js [--provider …]
  validate-fix --finding f.json --original a.js --fixed b.js
  import-sarif <log.sarif>    external results, normalized
  export-sarif <runId> [out]  a stored run as SARIF
  apply-fix <fix.json> [--branch fix/name]

env: ALGOSIZE_API_KEY (required), ALGOSIZE_ORIGIN (default https://algosize.com)`);
    process.exit(command ? 1 : 0);
}
