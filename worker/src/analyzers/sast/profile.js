// Repository language profiler — the pre-scan step that decides what the
// vulnerability scanner can actually do with a repository, and says so.
//
// ---------------------------------------------------------------------------
// THE WALKER IS A TREE LISTING, NOT A FILESYSTEM
// ---------------------------------------------------------------------------
//
// This runs inside a Cloudflare Worker. There is no `fs`, no `readdir`, and
// nothing to recurse into. The repository arrives as a flat array of
// `{ path, size }` from the GitHub git-tree API, which returns the whole tree
// in one request — so "walking" is filtering a list, and the expensive part
// that a local walker optimises away does not exist here.
//
// That shapes the module's contract, and improves it: `profileRepository()` is
// a PURE FUNCTION of a path list. It performs no IO, so every test in
// test-sast-profile.mjs is a literal array of paths, and a fixture repository
// is six lines rather than a directory tree. Content sampling is optional and
// supplied by the caller for the handful of signals a path cannot carry
// (dependency names, Go's stdlib imports).
//
// ---------------------------------------------------------------------------
// WHAT IT IS FOR
// ---------------------------------------------------------------------------
//
// Before this existed, coverage was one regex of thirteen extensions. A Rust,
// C#, Swift, Kotlin or Terraform repository was fetched as zero files and
// reported `no_source_files` — "No files in a language this scanner reads were
// found" — which a reader takes to mean *there is nothing here to scan*.
//
// Eleven rules in the registry are language-agnostic. They fire on Rust source
// as readily as on JavaScript. The rules existed and the files were never
// fetched, so the report described an empty scan as an empty repository.
//
// The profiler replaces that silence with a plan: what is here, how deeply
// each part can be analysed, which analyzers will run, and — the part that
// matters most — what will NOT be covered and why.

import {
  LANGUAGES, TIER, TIER_LABEL, TIER_MEANING,
  DEFAULT_IGNORED_DIRS, DEFAULT_IGNORED_FILE_RE,
  languageOfPath, manifestOfPath, normalizePath, basenameOf,
} from "./languages.js";
import { detectFrameworks } from "./frameworks.js";

// ---------------------------------------------------------------------------
// Analyzer routing
// ---------------------------------------------------------------------------
//
// Every id here is an analyzer that EXISTS in this codebase. Nothing routes to
// a pipeline that has not been built:
//
//   taint       sast/ast.js          acorn AST + intraprocedural taint
//   pattern     analyzers/vuln.js    line and structure rules
//   secrets     analyzers/secrets.js credential formats, all languages
//   config      analyzers/vuln.js    the Dockerfile/CORS/cookie/CI rules
//   dependency  analyzers/lockfile.js + osv.js
//
// The tier decides the code analyzers. Secrets is unconditional — a credential
// is a credential in a language nobody can parse — and dependency is decided
// separately, by whether an AUDITABLE lockfile is present rather than by
// whether the language is supported.
const ANALYZERS_BY_TIER = Object.freeze({
  [TIER.SEMANTIC]: ["taint", "pattern", "secrets"],
  [TIER.AST]:      ["ast", "pattern", "secrets"],
  [TIER.PATTERN]:  ["pattern", "secrets"],
  [TIER.CONFIG]:   ["config", "secrets"],
});

/** Caps. Sampling is bounded so profiling stays cheap enough to run every scan. */
const MAX_EVIDENCE_PER_LANGUAGE = 4;

/**
 * Profile a repository from its tree listing.
 *
 * @param {object}   input
 * @param {Array}    input.entries      `{ path, size? }`, or plain path strings
 * @param {object}   [input.contents]   optional `{ path: text }` for manifests
 *                                      the caller already fetched; used only
 *                                      for dependency and import signals
 * @param {string[]} [input.ignoredDirs] overrides DEFAULT_IGNORED_DIRS
 * @param {RegExp}   [input.ignoredFileRe]
 * @returns {{ repositoryProfile: object, summary: string }}
 */
export function profileRepository({
  entries = [],
  contents = {},
  ignoredDirs = DEFAULT_IGNORED_DIRS,
  ignoredFileRe = DEFAULT_IGNORED_FILE_RE,
} = {}) {
  // ---- 1. walk + ignore --------------------------------------------------
  const ignore = makeIgnoreEngine(ignoredDirs, ignoredFileRe);
  const all = entries
    .map((e) => (typeof e === "string" ? { path: e } : e))
    .filter((e) => e && typeof e.path === "string")
    .map((e) => ({ ...e, path: normalizePath(e.path) }))
    .filter((e) => e.path);

  const kept = [], ignoredHits = new Map();
  for (const entry of all) {
    const reason = ignore(entry.path);
    if (reason) {
      ignoredHits.set(reason, (ignoredHits.get(reason) || 0) + 1);
      continue;
    }
    kept.push(entry);
  }

  // ---- 2. language detection --------------------------------------------
  const byLanguage = new Map();
  const unrecognised = [];
  const extensionsSeen = new Set();

  for (const entry of kept) {
    const lang = languageOfPath(entry.path);
    if (!lang) {
      // A manifest is READ even when its extension carries no language:
      // `requirements.txt` has no language signature and is the file the
      // dependency audit actually parses. Listing it as "not read" told the
      // reader the opposite of what happens.
      if (!manifestOfPath(entry.path)) unrecognised.push(entry.path);
      continue;
    }
    const base = basenameOf(entry.path);
    const dot = base.lastIndexOf(".");
    if (dot > 0) extensionsSeen.add(base.slice(dot + 1));

    let rec = byLanguage.get(lang);
    if (!rec) {
      rec = { fileCount: 0, extensions: new Set(), evidence: [] };
      byLanguage.set(lang, rec);
    }
    rec.fileCount++;
    if (dot > 0) rec.extensions.add("." + base.slice(dot + 1));
    if (rec.evidence.length < MAX_EVIDENCE_PER_LANGUAGE) rec.evidence.push(entry.path);
  }

  // ---- 3. manifests ------------------------------------------------------
  const manifests = [];
  for (const entry of kept) {
    const spec = manifestOfPath(entry.path);
    if (!spec) continue;
    manifests.push({
      path: entry.path,
      file: spec.file,
      language: spec.language,
      kind: spec.kind,
      // The field that stops the plan overclaiming — see languages.js.
      audited: spec.audited,
      ...(spec.note ? { note: spec.note } : {}),
    });
    // A manifest is itself evidence of its language even when no source file
    // of that language survived the cap: a repo whose only Rust artifact in
    // the listing is Cargo.toml is still a Rust repository.
    if (!byLanguage.has(spec.language) && LANGUAGES[spec.language]) {
      byLanguage.set(spec.language, {
        fileCount: 0, extensions: new Set(), evidence: [entry.path],
      });
    }
  }

  // ---- 4. frameworks -----------------------------------------------------
  const dependencies = collectDependencyNames(contents);
  const imports = collectImportStrings(contents);
  const frameworks = detectFrameworks({
    paths: kept.map((e) => e.path),
    dependencies,
    extensions: extensionsSeen,
    imports,
  });

  // ---- 5. tiers + routing ------------------------------------------------
  const auditableManifests = manifests.filter((m) => m.audited);
  const dependencyAvailable = auditableManifests.length > 0;

  const languages = [...byLanguage.entries()]
    .map(([id, rec]) => {
      const spec = LANGUAGES[id];
      const analyzers = [...(ANALYZERS_BY_TIER[spec.tier] || ANALYZERS_BY_TIER[TIER.PATTERN])];
      // Dependency analysis attaches to the LANGUAGE whose manifest we can
      // actually parse, not to every language that has a manifest. Routing it
      // onto Rust because Cargo.toml exists would put a dependency result in
      // the plan that the audit cannot produce, and an empty result reads as
      // a clean crate graph.
      if (auditableManifests.some((m) => m.language === id)) analyzers.push("dependency");
      return {
        id,
        name: spec.label,
        fileCount: rec.fileCount,
        extensions: [...rec.extensions].sort(),
        supportTier: spec.tier,
        supportTierLabel: TIER_LABEL[spec.tier],
        analyzers,
        evidence: rec.evidence,
      };
    })
    // Deepest support first, then by volume: the reader's first question is
    // "what got the good scan", not "what is there most of".
    .sort((a, b) => a.supportTier - b.supportTier || b.fileCount - a.fileCount ||
                    a.name.localeCompare(b.name));

  // ---- 6. coverage summary ----------------------------------------------
  const selectedAnalyzers = [...new Set(languages.flatMap((l) => l.analyzers))].sort();

  // Everything the scan will NOT do, stated rather than implied. This is the
  // half of a coverage report that a reader cannot reconstruct themselves, and
  // the half a scanner is tempted to omit.
  const gaps = [];
  const unauditable = manifests.filter((m) => !m.audited && m.kind === "lockfile");
  if (unauditable.length) {
    gaps.push({
      kind: "dependency_manifest_unsupported",
      detail: `Found ${unauditable.map((m) => m.file).join(", ")}, which the dependency audit cannot parse. ` +
              "Those packages are not checked against advisories.",
      paths: unauditable.map((m) => m.path).slice(0, 5),
    });
  }
  const belowAst = languages.filter((l) => l.supportTier >= TIER.PATTERN && l.supportTier < TIER.CONFIG);
  if (belowAst.length) {
    gaps.push({
      kind: "pattern_only_languages",
      detail: `${listPhrase(belowAst.map((l) => l.name))} ${belowAst.length === 1 ? "is" : "are"} matched line by line. ` +
              "A finding that depends on following a value across statements will not be reported.",
    });
  }
  if (unrecognised.length) {
    gaps.push({
      kind: "unrecognised_files",
      detail: unrecognised.length === 1
        ? "1 file is in no language the registry knows and was not read."
        : `${unrecognised.length} files are in no language the registry knows and were not read.`,
      paths: unrecognised.slice(0, 5),
    });
  }

  const ignoredPaths = [...ignoredHits.entries()]
    .map(([rule, fileCount]) => ({ rule, fileCount }))
    .sort((a, b) => b.fileCount - a.fileCount);

  const repositoryProfile = {
    languages,
    frameworks,
    manifests,
    ignoredPaths,
    filesConsidered: all.length,
    filesProfiled: kept.length,
    scanPlan: {
      languagesDetected:  languages.map((l) => l.name),
      frameworksDetected: frameworks.map((f) => f.name),
      selectedAnalyzers,
      dependencyAudit: dependencyAvailable
        ? { available: true, from: auditableManifests.map((m) => m.path) }
        : { available: false, reason: manifests.length
            ? "no lockfile the audit can parse"
            : "no dependency manifest found" },
      gaps,
    },
  };

  return { repositoryProfile, summary: summarize(repositoryProfile) };
}

// ---------------------------------------------------------------------------
// Ignore engine
// ---------------------------------------------------------------------------

/**
 * Build a path -> ignore-reason function.
 *
 * Returns the RULE that matched rather than a boolean, so the coverage summary
 * can report "node_modules: 4,102 files" instead of an opaque total. A reader
 * who thinks the scan missed something needs to see which rule swallowed it.
 */
export function makeIgnoreEngine(dirs = DEFAULT_IGNORED_DIRS, fileRe = DEFAULT_IGNORED_FILE_RE) {
  const set = new Set(dirs.map((d) => d.toLowerCase()));
  return function ignoreReason(path) {
    const segments = String(path).toLowerCase().split("/");
    // Every segment except the last, which is the filename.
    for (let i = 0; i < segments.length - 1; i++) {
      if (set.has(segments[i])) return segments[i];
    }
    if (fileRe && fileRe.test(path)) return "generated file";
    return null;
  };
}

// ---------------------------------------------------------------------------
// Content signals
// ---------------------------------------------------------------------------
//
// Path-only detection cannot see a dependency name, and dependency names are
// the strongest framework signal there is. These readers are deliberately
// shallow — a regex over a manifest we already fetched for the audit, never a
// parse of every file — which keeps profiling cheap enough to run before every
// scan.

/** Dependency names from whatever manifests the caller supplied. */
export function collectDependencyNames(contents = {}) {
  const names = new Set();
  for (const [path, text] of Object.entries(contents)) {
    if (typeof text !== "string" || !text) continue;
    const base = basenameOf(path);

    if (base === "package.json" || base === "composer.json") {
      try {
        const json = JSON.parse(text);
        for (const field of ["dependencies", "devDependencies", "peerDependencies", "require", "require-dev"]) {
          const block = json && json[field];
          if (block && typeof block === "object") Object.keys(block).forEach((n) => names.add(n));
        }
      } catch { /* a malformed manifest costs framework signal, never the scan */ }
      continue;
    }
    if (base === "requirements.txt" || base === "pipfile") {
      for (const line of text.split("\n")) {
        const m = /^\s*([A-Za-z0-9._-]+)\s*(?:[<>=!~[]|$)/.exec(line);
        if (m) names.add(m[1]);
      }
      continue;
    }
    if (base === "pyproject.toml" || base === "cargo.toml") {
      for (const line of text.split("\n")) {
        const m = /^\s*([A-Za-z0-9._-]+)\s*=/.exec(line);
        if (m) names.add(m[1]);
      }
      continue;
    }
    if (base === "gemfile") {
      for (const m of text.matchAll(/^\s*gem\s+["']([^"']+)["']/gm)) names.add(m[1]);
      continue;
    }
    if (base === "go.mod") {
      for (const m of text.matchAll(/^\s+([\w.\-/]+)\s+v[\d]/gm)) names.add(m[1]);
      continue;
    }
    if (base === "pom.xml" || base.endsWith(".csproj") || base === "build.gradle" || base === "build.gradle.kts") {
      for (const m of text.matchAll(/<artifactId>([^<]+)<\/artifactId>/g)) names.add(m[1]);
      for (const m of text.matchAll(/Include="([^"]+)"/g)) names.add(m[1]);
      for (const m of text.matchAll(/["']([\w.\-]+:[\w.\-]+)(?::[^"']+)?["']/g)) {
        names.add(m[1].split(":").pop());
        names.add(m[1]);
      }
      continue;
    }
  }
  return [...names];
}

/** Import strings, for frameworks that live in a standard library. */
export function collectImportStrings(contents = {}) {
  const imports = new Set();
  for (const [path, text] of Object.entries(contents)) {
    if (typeof text !== "string") continue;
    if (!/\.go$/i.test(path)) continue;
    for (const m of text.matchAll(/^\s*(?:import\s+)?["']([\w./-]+)["']/gm)) imports.add(m[1]);
  }
  return [...imports];
}

// ---------------------------------------------------------------------------
// Human-readable summary
// ---------------------------------------------------------------------------

/**
 * One paragraph a person can act on.
 *
 * Structured as: what is here, how well each part is covered, what was found
 * on top, and what is NOT covered. The last sentence is the one that stops a
 * clean report being over-read, so it is never omitted when a gap exists.
 */
export function summarize(profile) {
  const langs = profile.languages || [];
  if (!langs.length) {
    return "No files in a language this scanner recognises were found. " +
           "Nothing was read, which is not the same as nothing being wrong — " +
           "add a language signature if this repository should be covered.";
  }

  const parts = [];
  const named = langs.slice(0, 6).map((l) => l.name);
  parts.push(`Detected ${listPhrase(named)}${langs.length > 6 ? `, and ${langs.length - 6} more` : ""}.`);

  const byTier = new Map();
  for (const l of langs) {
    if (!byTier.has(l.supportTier)) byTier.set(l.supportTier, []);
    byTier.get(l.supportTier).push(l.name);
  }
  for (const tier of [...byTier.keys()].sort()) {
    parts.push(`${listPhrase(byTier.get(tier))} ${byTier.get(tier).length === 1 ? "gets" : "get"} ` +
               `${TIER_LABEL[tier]} — ${TIER_MEANING[tier]}.`);
  }

  const fw = profile.frameworks || [];
  if (fw.length) {
    const confident = fw.filter((f) => f.confidence !== "low").map((f) => f.name);
    parts.push(confident.length
      ? `Frameworks detected: ${listPhrase(confident)}.`
      : `No framework was identified confidently; weak signals for ${listPhrase(fw.map((f) => f.name))}.`);
  }

  const plan = profile.scanPlan || {};
  if (plan.dependencyAudit && !plan.dependencyAudit.available) {
    parts.push(`Dependencies are not audited: ${plan.dependencyAudit.reason}.`);
  }
  for (const gap of (plan.gaps || []).filter((g) => g.kind !== "pattern_only_languages")) {
    parts.push(gap.detail);
  }

  return parts.join(" ");
}

/** "a, b and c" */
function listPhrase(items) {
  const list = items.filter(Boolean);
  if (!list.length) return "nothing";
  if (list.length === 1) return list[0];
  return `${list.slice(0, -1).join(", ")} and ${list[list.length - 1]}`;
}
