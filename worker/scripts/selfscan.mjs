// Scan the tracked source that ships with this repository.
//
// This intentionally calls the pure analyzer directly instead of the HTTP
// handler: the check must not need credentials, a Worker runtime, or network
// access. It is a smoke test for the rules against the codebase that contains
// those rules.

import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { analyzeVuln } from "../src/analyzers/vuln.js";
import { SOURCE_SKIP_RE } from "../src/handlers/analyze.js";
import { ALL_KNOWN_EXTENSIONS, ALL_KNOWN_FILENAMES } from "../src/analyzers/sast/languages.js";

const workerDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoDir = resolve(workerDir, "..");
const MAX_FILE_BYTES = 200 * 1024;
const BATCH_SIZE = 50;
const sourceExtensions = new Set(ALL_KNOWN_EXTENSIONS.map((extension) => `.${extension}`));
const sourceFilenames = new Set(ALL_KNOWN_FILENAMES);

function trackedFiles() {
  const output = execFileSync("git", ["ls-files", "-z"], {
    cwd: repoDir,
    encoding: "utf8",
  });
  return output.split("\0").filter(Boolean).filter((file) => {
    const normalized = file.replaceAll("\\", "/");
    if (SOURCE_SKIP_RE.test(normalized)) return false;
    const base = normalized.split("/").pop().toLowerCase();
    const extension = extname(base);
    return sourceExtensions.has(extension) || sourceFilenames.has(base);
  });
}

const files = [];
for (const file of trackedFiles()) {
  const absolute = join(repoDir, file);
  let size;
  try {
    size = statSync(absolute).size;
  } catch {
    continue;
  }
  if (size > MAX_FILE_BYTES) continue;
  files.push({
    path: relative(repoDir, absolute).replaceAll("\\", "/"),
    content: readFileSync(absolute, "utf8"),
  });
}

const findings = [];
for (let i = 0; i < files.length; i += BATCH_SIZE) {
  const result = analyzeVuln({ files: files.slice(i, i + BATCH_SIZE) });
  findings.push(...result.findings);
}

const critical = findings.filter((finding) => finding.severity === "critical");
console.log(`Self-scan: ${files.length} tracked source files, ${findings.length} findings, ${critical.length} critical`);
for (const finding of critical) {
  console.error(`CRITICAL ${finding.path}:${finding.line} — ${finding.type}`);
}

if (critical.length > 0) {
  process.exitCode = 1;
}