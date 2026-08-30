// Language, manifest and support-tier signatures — the declarative half of
// the repository profiler.
//
// ---------------------------------------------------------------------------
// WHY THIS EXISTS
// ---------------------------------------------------------------------------
//
// Coverage used to be decided by one regex in handlers/analyze.js:
//
//   const SOURCE_EXT_RE = /\.(?:js|mjs|cjs|jsx|ts|tsx|py|rb|go|php|java|sh|bash)$/i;
//
// A repository outside that list — Rust, C#, Kotlin, Swift, C++, Solidity, or
// an infrastructure repo of Terraform and YAML — was fetched as zero files and
// reported as `no_source_files`: "No files in a language this scanner reads
// were found." Which reads as *there is nothing here to scan*.
//
// That was never true. Eleven rules in the registry are tagged
// `languages: ["*"]` — hardcoded private keys, cloud credentials, weak crypto
// constants, `curl | sh` — and every one of them fires on Rust as readily as
// on JavaScript. The rules existed. The files were never fetched, so they
// could not fire, and the report said the repository had nothing to read.
//
// So this file is not a lookup table bolted onto the scanner. It is the
// scanner's answer to "what can I actually do with this repository?", and
// handlers/analyze.js derives its fetch filter from it. Adding an entry here
// is the whole of adding a language: the files start being fetched, the
// language-agnostic rules start firing on them, and the coverage summary
// starts naming it.
//
// ---------------------------------------------------------------------------
// TIERS
// ---------------------------------------------------------------------------
//
// A tier is a claim about ANALYSIS DEPTH THAT EXISTS TODAY, not an aspiration.
// Tier 2 is currently empty, and that is deliberate: writing TypeScript into
// it because a TS parser is on the roadmap would make the coverage summary a
// promise instead of a description.
//
//   1  semantic   AST plus taint tracking — the engine follows a value from
//                 an untrusted source to a dangerous sink
//   2  ast        parsed to a syntax tree, no dataflow
//   3  pattern    line and structure matching only
//   4  config     not parsed as code at all; still yields secrets, config
//                 findings, and dependency data from manifests

export const TIER = Object.freeze({
  SEMANTIC: 1,
  AST:      2,
  PATTERN:  3,
  CONFIG:   4,
});

export const TIER_LABEL = Object.freeze({
  1: "deep semantic scan",
  2: "parser/AST scan",
  3: "generic pattern scan",
  4: "dependency/config-only scan",
});

/**
 * What each tier means in one sentence, for the human-readable summary.
 *
 * Phrased as what the reader GETS, not as what the engine does, because the
 * summary is read by someone deciding whether to trust a clean result.
 */
export const TIER_MEANING = Object.freeze({
  1: "values are followed from request to sink, so an injection is reported with its source",
  2: "code is parsed to a syntax tree, but values are not followed across statements",
  3: "individual lines are matched against known-dangerous shapes",
  4: "not read as code; secrets, configuration mistakes and dependencies are still checked",
});

// ---------------------------------------------------------------------------
// Languages
// ---------------------------------------------------------------------------
//
// `ext`       file extensions, lowercase, without the dot
// `filenames` exact basenames (lowercased) that identify the language
// `tier`      the deepest analysis available for it TODAY
// `label`     display name
//
// Ordering within this object is the display order of the coverage summary.

export const LANGUAGES = Object.freeze({
  javascript: {
    label: "JavaScript",
    // The only tier 1 language. acorn parses it and sast/ast.js follows taint
    // through assignment, template literals and concatenation.
    tier: TIER.SEMANTIC,
    ext: ["js", "mjs", "cjs", "jsx"],
  },
  typescript: {
    label: "TypeScript",
    // Tier 3, not tier 2. acorn treats a type annotation as a syntax error, so
    // every .ts file handed to it throws — the pattern engine is genuinely all
    // that runs. Naming it tier 2 here would be the coverage summary lying
    // about the product's largest language.
    tier: TIER.PATTERN,
    ext: ["ts", "tsx", "mts", "cts"],
  },
  python:     { label: "Python",     tier: TIER.PATTERN, ext: ["py", "pyi"] },
  ruby:       { label: "Ruby",       tier: TIER.PATTERN, ext: ["rb", "rake"], filenames: ["rakefile"] },
  go:         { label: "Go",         tier: TIER.PATTERN, ext: ["go"] },
  java:       { label: "Java",       tier: TIER.PATTERN, ext: ["java"] },
  kotlin:     { label: "Kotlin",     tier: TIER.PATTERN, ext: ["kt", "kts"] },
  scala:      { label: "Scala",      tier: TIER.PATTERN, ext: ["scala", "sc"] },
  csharp:     { label: "C#",         tier: TIER.PATTERN, ext: ["cs", "csx"] },
  php:        { label: "PHP",        tier: TIER.PATTERN, ext: ["php", "phtml"] },
  rust:       { label: "Rust",       tier: TIER.PATTERN, ext: ["rs"] },
  swift:      { label: "Swift",      tier: TIER.PATTERN, ext: ["swift"] },
  c:          { label: "C/C++",      tier: TIER.PATTERN, ext: ["c", "h", "cc", "cpp", "cxx", "hpp", "hh"] },
  objc:       { label: "Objective-C", tier: TIER.PATTERN, ext: ["m", "mm"] },
  dart:       { label: "Dart",       tier: TIER.PATTERN, ext: ["dart"] },
  elixir:     { label: "Elixir",     tier: TIER.PATTERN, ext: ["ex", "exs"] },
  perl:       { label: "Perl",       tier: TIER.PATTERN, ext: ["pl", "pm"] },
  lua:        { label: "Lua",        tier: TIER.PATTERN, ext: ["lua"] },
  solidity:   { label: "Solidity",   tier: TIER.PATTERN, ext: ["sol"] },
  shell:      { label: "Shell",      tier: TIER.PATTERN, ext: ["sh", "bash", "zsh", "ksh"] },
  html:       { label: "HTML/templates", tier: TIER.PATTERN, ext: ["html", "htm", "ejs", "hbs", "erb", "jinja", "j2", "twig", "vue", "svelte"] },
  sql:        { label: "SQL",        tier: TIER.PATTERN, ext: ["sql"] },

  // ---- tier 4: read for secrets and configuration, never parsed as code ---
  yaml:       { label: "YAML",       tier: TIER.CONFIG, ext: ["yml", "yaml"] },
  json:       { label: "JSON",       tier: TIER.CONFIG, ext: ["json", "jsonc"] },
  toml:       { label: "TOML",       tier: TIER.CONFIG, ext: ["toml"] },
  xml:        { label: "XML",        tier: TIER.CONFIG, ext: ["xml", "plist", "csproj", "props", "targets"] },
  terraform:  { label: "Terraform",  tier: TIER.CONFIG, ext: ["tf", "tfvars"] },
  dockerfile: { label: "Docker",     tier: TIER.CONFIG, ext: ["dockerfile"], filenames: ["dockerfile", "containerfile"] },
  properties: { label: "Properties", tier: TIER.CONFIG, ext: ["properties", "ini", "cfg", "conf"] },
  env:        { label: "Env files",  tier: TIER.CONFIG, ext: [], filenames: [".env"] },
  gradle:     { label: "Gradle",     tier: TIER.CONFIG, ext: ["gradle"] },
});

// ---------------------------------------------------------------------------
// Manifests and lockfiles
// ---------------------------------------------------------------------------
//
// `audited` is the field that keeps this honest.
//
// Detecting `Cargo.toml` proves a Rust project. It does NOT mean the
// dependency audit can read it — analyzers/lockfile.js parses exactly five
// files (package-lock.json, yarn.lock, requirements.txt, Gemfile.lock,
// go.sum), and everything else is a manifest we can recognise and not resolve.
//
// A profiler that routed "dependency" wherever it saw a manifest would put
// `dependency-risk` in the scan plan for a Rust repository, the audit would
// return nothing, and the report would show a clean dependency result for a
// crate graph nobody looked at. So the plan says `dependency (unsupported
// manifest)` and names the file instead.

export const MANIFESTS = Object.freeze([
  // ---- npm ---------------------------------------------------------------
  { file: "package.json",       language: "javascript", kind: "manifest", audited: false,
    note: "resolved versions come from the lockfile, not from ranges here" },
  { file: "package-lock.json",  language: "javascript", kind: "lockfile", generated: true, audited: true },
  { file: "yarn.lock",          language: "javascript", kind: "lockfile", generated: true, audited: true },
  { file: "pnpm-lock.yaml",     language: "javascript", kind: "lockfile", generated: true, audited: false },
  { file: "bun.lockb",          language: "javascript", kind: "lockfile", generated: true, audited: false },
  { file: "tsconfig.json",      language: "typescript", kind: "config",   audited: false },
  // ---- python ------------------------------------------------------------
  { file: "requirements.txt",   language: "python", kind: "lockfile", audited: true },
  { file: "pyproject.toml",     language: "python", kind: "manifest", audited: false },
  { file: "poetry.lock",        language: "python", kind: "lockfile", generated: true, audited: false },
  { file: "pipfile",            language: "python", kind: "manifest", audited: false },
  { file: "pipfile.lock",       language: "python", kind: "lockfile", generated: true, audited: false },
  { file: "setup.py",           language: "python", kind: "manifest", audited: false },
  // ---- go ----------------------------------------------------------------
  { file: "go.mod",             language: "go", kind: "manifest", audited: false },
  { file: "go.sum",             language: "go", kind: "lockfile", generated: true, audited: true },
  // ---- ruby --------------------------------------------------------------
  { file: "gemfile",            language: "ruby", kind: "manifest", audited: false },
  { file: "gemfile.lock",       language: "ruby", kind: "lockfile", generated: true, audited: true },
  // ---- rust --------------------------------------------------------------
  { file: "cargo.toml",         language: "rust", kind: "manifest", audited: false },
  { file: "cargo.lock",         language: "rust", kind: "lockfile", generated: true, audited: false },
  // ---- jvm ---------------------------------------------------------------
  { file: "pom.xml",            language: "java",   kind: "manifest", audited: false },
  { file: "build.gradle",       language: "java",   kind: "manifest", audited: false },
  { file: "build.gradle.kts",   language: "kotlin", kind: "manifest", audited: false },
  // ---- php ---------------------------------------------------------------
  { file: "composer.json",      language: "php", kind: "manifest", audited: false },
  { file: "composer.lock",      language: "php", kind: "lockfile", generated: true, audited: false },
  // ---- .net --------------------------------------------------------------
  { file: "directory.packages.props", language: "csharp", kind: "manifest", audited: false },
  { file: "packages.config",    language: "csharp", kind: "manifest", audited: false },
  // ---- apple -------------------------------------------------------------
  { file: "podfile",            language: "swift", kind: "manifest", audited: false },
  { file: "podfile.lock",       language: "swift", kind: "lockfile", generated: true, audited: false },
  { file: "package.swift",      language: "swift", kind: "manifest", audited: false },
  // ---- other -------------------------------------------------------------
  { file: "pubspec.yaml",       language: "dart",   kind: "manifest", audited: false },
  { file: "mix.exs",            language: "elixir", kind: "manifest", audited: false },
]);

/** Extension-suffixed manifests, which cannot be matched by basename. */
const MANIFEST_SUFFIXES = Object.freeze([
  { suffix: ".csproj", language: "csharp", kind: "manifest", audited: false },
  { suffix: ".fsproj", language: "csharp", kind: "manifest", audited: false },
]);

// ---------------------------------------------------------------------------
// Ignore rules
// ---------------------------------------------------------------------------
//
// Configurable per call, with these as the default. Two groups, and the
// distinction matters when someone edits this list:
//
//   somebody else's code   node_modules, vendor, third_party, site-packages
//   our own or generated   dist, build, .next, coverage, __pycache__
//
// `fixtures` is the entry that looks wrong and is not. This scanner ships a
// deliberately vulnerable corpus under scripts/fixtures/, and scanning it
// reports our own test data as findings — true, and useless.
export const DEFAULT_IGNORED_DIRS = Object.freeze([
  "node_modules", "vendor", "bundle", "third_party", "site-packages",
  ".git", ".hg", ".svn",
  "dist", "build", "out", "bin", "obj", "target", "_site", "generated",
  ".next", ".nuxt", ".svelte-kit", ".output",
  "coverage", "cache", ".cache", "tmp", "temp",
  ".venv", "venv", "__pycache__", ".tox",
  "fixtures", "__fixtures__", "testdata",
  "Pods", "DerivedData",
]);

/** Files that are generated or minified regardless of where they sit. */
export const DEFAULT_IGNORED_FILE_RE = /\.(?:min|bundle|generated)\.[a-z0-9]+$|\.map$|-lock\.json$/i;

// ---------------------------------------------------------------------------
// Derived indexes
// ---------------------------------------------------------------------------
//
// Built once at module load from the tables above. Every consumer reads these
// rather than re-deriving, so a new language reaches the file filter, the
// language detector and the coverage summary from a single edit.

const EXT_TO_LANGUAGE = new Map();
const FILENAME_TO_LANGUAGE = new Map();
for (const [id, spec] of Object.entries(LANGUAGES)) {
  for (const ext of spec.ext || []) {
    // First registration wins, so an accidental duplicate is a no-op rather
    // than silently re-pointing an extension at a different language.
    if (!EXT_TO_LANGUAGE.has(ext)) EXT_TO_LANGUAGE.set(ext, id);
  }
  for (const name of spec.filenames || []) {
    if (!FILENAME_TO_LANGUAGE.has(name)) FILENAME_TO_LANGUAGE.set(name, id);
  }
}

const MANIFEST_BY_FILE = new Map(MANIFESTS.map((m) => [m.file, m]));

/** Every extension the registry knows, for the discovery filter. */
export const ALL_KNOWN_EXTENSIONS = Object.freeze([...EXT_TO_LANGUAGE.keys()].sort());

/** Every exact basename the registry recognises, for path-based detection. */
export const ALL_KNOWN_FILENAMES = Object.freeze(
  [...new Set([...FILENAME_TO_LANGUAGE.keys(), ...MANIFEST_BY_FILE.keys()])].sort());

/**
 * The subset worth FETCHING for the source scan.
 *
 * Generated lockfiles are recognised from the tree listing — which costs one
 * path — and deliberately not downloaded here. `package-lock.json` is hundreds
 * of kilobytes of machine-written JSON, the dependency audit fetches it
 * separately through its own path, and pulling it into the source scan spends
 * two of the scan's scarcest resources (120 files, 3 MB) on content no source
 * rule can say anything useful about.
 *
 * Hand-authored manifests stay: `package.json`, `go.mod` and `Gemfile` are
 * small and carry the dependency names that framework detection needs.
 */
export const GENERATED_LOCKFILES = Object.freeze(
  MANIFESTS.filter((m) => m.generated).map((m) => m.file));

export const FETCHABLE_FILENAMES = Object.freeze(
  [...new Set([
    ...FILENAME_TO_LANGUAGE.keys(),
    ...MANIFESTS.filter((m) => !m.generated).map((m) => m.file),
  ])].sort());

/**
 * The language of a path, or null when the registry does not know it.
 *
 * Null rather than a "text" fallback: the profiler counts unknown files as
 * explicitly unrecognised so the summary can report them, and a catch-all
 * bucket would hide that count inside a language that was never detected.
 */
export function languageOfPath(path) {
  const base = basenameOf(path);
  if (!base) return null;

  // Dotfiles first: `.env.production` is an env file, and its "extension"
  // would otherwise read as `production`.
  if (base === ".env" || base.startsWith(".env.")) return "env";
  if (base === "dockerfile" || base.startsWith("dockerfile.")) return "dockerfile";
  if (base === "containerfile") return "dockerfile";

  const exact = FILENAME_TO_LANGUAGE.get(base);
  if (exact) return exact;

  // Longest-match on compound extensions (.gradle.kts before .kts) so a
  // Kotlin build script is not filed as generic Kotlin source.
  if (base.endsWith(".gradle.kts")) return "kotlin";
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return null;
  return EXT_TO_LANGUAGE.get(base.slice(dot + 1)) || null;
}

/** The manifest spec for a path, or null. */
export function manifestOfPath(path) {
  const base = basenameOf(path);
  if (!base) return null;
  const exact = MANIFEST_BY_FILE.get(base);
  if (exact) return exact;
  for (const s of MANIFEST_SUFFIXES) {
    if (base.endsWith(s.suffix)) {
      return { file: base, language: s.language, kind: s.kind, audited: s.audited };
    }
  }
  return null;
}

/**
 * Lowercased final path segment.
 *
 * Backslashes are normalised too. Paths reach this module from the GitHub
 * tree API (always forward slashes) and from callers that may have built one
 * on Windows; splitting on `/` alone would treat `src\app.js` as a single
 * basename and detect nothing.
 */
export function basenameOf(path) {
  const s = String(path || "").replace(/\\/g, "/");
  const seg = s.slice(s.lastIndexOf("/") + 1);
  return seg.toLowerCase();
}

/** Normalise a repository-relative path for display and comparison. */
export function normalizePath(path) {
  return String(path || "")
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/^\/+/, "");
}
