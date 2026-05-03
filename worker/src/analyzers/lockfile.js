// Lockfile parsers — pure, dependency-free.
//
// Given a filename + raw text, normalise into:
//   { ecosystem: "npm"|"PyPI"|"RubyGems"|"Go", packages: [{name, version}] }
//
// Supported lockfiles (matches the Task #15 plan):
//   - package-lock.json   (npm; lockfileVersion 1, 2, 3)
//   - yarn.lock           (yarn classic)
//   - requirements.txt    (Python pip — pinned versions only)
//   - Gemfile.lock        (Ruby bundler)
//   - go.sum              (Go modules)
//
// Everything is a small hand-written parser. We deliberately avoid pulling in
// real package managers: this code runs inside a 128 MB Cloudflare Worker.
// Edge cases we DO handle (covered by tests):
//   - npm v1 nested `dependencies` AND v2/v3 flat `packages` keyed by path
//   - yarn header lines with multiple comma-separated quoted ranges
//   - scoped npm packages (@scope/name)
//   - go.sum dedup of `module v.../go.mod` hash lines
// Edge cases we DO NOT handle (documented as out-of-scope for v1):
//   - pnpm-lock.yaml, Pipfile.lock, poetry.lock, composer.lock
//   - editable installs / VCS URLs in requirements.txt (e.g. `-e git+...`)
//   - yarn berry (yarn 2+) — different format; would need separate parser

export const SUPPORTED_FILES = [
  "package-lock.json",
  "yarn.lock",
  "requirements.txt",
  "Gemfile.lock",
  "go.sum",
];

// Per-file size cap. Real lockfiles in big monorepos can hit a few MB; this
// keeps the worst-case parse time bounded and protects against pathological
// inputs (e.g. a hostile repo with a 100 MB package-lock.json).
export const MAX_LOCKFILE_BYTES = 5 * 1024 * 1024;

// Per-audit package cap. OSV's /v1/querybatch accepts up to 1000 queries per
// request, so we hard-cap the deduplicated package list there.
export const MAX_PACKAGES_PER_AUDIT = 1000;

export function lockfileError(message) {
  const e = new Error(message);
  e.lockfileError = true;
  return e;
}

/**
 * Dispatch on filename's basename (case-insensitive). Returns
 * `{ ecosystem, packages }` or throws a `lockfileError`.
 */
export function parseLockfile(filename, content) {
  if (typeof content !== "string") {
    throw lockfileError("lockfile content must be a string");
  }
  const base = String(filename || "").split("/").pop().toLowerCase();
  switch (base) {
    case "package-lock.json": return { ecosystem: "npm",      packages: parsePackageLockJson(content) };
    case "yarn.lock":         return { ecosystem: "npm",      packages: parseYarnLock(content) };
    case "requirements.txt":  return { ecosystem: "PyPI",     packages: parseRequirementsTxt(content) };
    case "gemfile.lock":      return { ecosystem: "RubyGems", packages: parseGemfileLock(content) };
    case "go.sum":            return { ecosystem: "Go",       packages: parseGoSum(content) };
    default:
      throw lockfileError(`unsupported lockfile: ${filename}`);
  }
}

// ---------------------------------------------------------------------------
// package-lock.json
// ---------------------------------------------------------------------------

function parsePackageLockJson(content) {
  let json;
  try { json = JSON.parse(content); }
  catch { throw lockfileError("package-lock.json is not valid JSON"); }
  if (!json || typeof json !== "object") {
    throw lockfileError("package-lock.json must be a JSON object");
  }

  const out = new Map();
  const add = (name, version) => {
    if (typeof name !== "string" || typeof version !== "string") return;
    if (!name || !version) return;
    const key = name + "@" + version;
    if (!out.has(key)) out.set(key, { name, version });
  };

  // v2/v3: flat `packages` keyed by path. Top-level "" entry is the root
  // project itself — skip it.
  if (json.packages && typeof json.packages === "object") {
    for (const [pkgPath, entry] of Object.entries(json.packages)) {
      if (pkgPath === "" || !entry || typeof entry !== "object") continue;
      // Last "node_modules/<X>" segment in the path is the dependency name.
      // For nested deps (e.g. "node_modules/foo/node_modules/bar") this lifts
      // out the deepest name correctly. Scoped packages "@scope/name" stay
      // intact because lastIndexOf finds the deepest "node_modules/" marker.
      const marker = "node_modules/";
      const lastIdx = pkgPath.lastIndexOf(marker);
      if (lastIdx === -1) continue;
      const name = pkgPath.slice(lastIdx + marker.length);
      // Reject obvious garbage (paths that contain an extra slash but aren't
      // scoped packages — those wouldn't be a valid dep name).
      if (name.includes("/") && !name.startsWith("@")) continue;
      if (name.startsWith("@") && name.split("/").length !== 2) continue;
      add(name, entry.version);
    }
  }

  // v1 (and as a backup for v2/v3): recursive `dependencies` tree.
  function walk(deps) {
    if (!deps || typeof deps !== "object") return;
    for (const [name, entry] of Object.entries(deps)) {
      if (entry && typeof entry === "object") {
        add(name, entry.version);
        walk(entry.dependencies);
      }
    }
  }
  walk(json.dependencies);

  return Array.from(out.values());
}

// ---------------------------------------------------------------------------
// yarn.lock (yarn classic)
// ---------------------------------------------------------------------------
//
// Format:
//   "@types/node@^18.0.0", "@types/node@^18.5.0":
//     version "18.18.0"
//     resolved "..."
//
// Strategy: stream lines, accumulate (header range list, indented version)
// pairs, flush on blank line.

function parseYarnLock(content) {
  const out = new Map();
  let currentNames = null;
  let currentVersion = null;

  const flush = () => {
    if (currentNames && currentVersion) {
      for (const name of currentNames) {
        const key = name + "@" + currentVersion;
        if (!out.has(key)) out.set(key, { name, version: currentVersion });
      }
    }
    currentNames = null;
    currentVersion = null;
  };

  for (const raw of content.split(/\r?\n/)) {
    if (raw.length === 0)         { flush(); continue; }
    if (raw.startsWith("#"))      continue;
    if (raw[0] !== " " && raw[0] !== "\t") {
      // Header line, e.g. `"@types/node@^18.0.0", lodash@^4.17.21:`
      flush();
      const trimmed = raw.endsWith(":") ? raw.slice(0, -1) : raw;
      // Split on commas not inside quotes.
      const parts = [];
      let buf = "", inQuote = false;
      for (const c of trimmed) {
        if (c === '"') { inQuote = !inQuote; continue; }
        if (c === "," && !inQuote) { if (buf.trim()) parts.push(buf.trim()); buf = ""; continue; }
        buf += c;
      }
      if (buf.trim()) parts.push(buf.trim());

      const names = [];
      for (const p of parts) {
        // "name@range" — name may itself start with @ for scoped packages
        // (@scope/name@^1.0.0). Use the LAST @ that isn't at index 0.
        let at = -1;
        for (let i = p.length - 1; i > 0; i--) {
          if (p[i] === "@") { at = i; break; }
        }
        if (at <= 0) continue;
        names.push(p.slice(0, at));
      }
      currentNames = names.length ? names : null;
    } else {
      // Indented field line. We only care about `version "x.y.z"`.
      const m = /^\s+version\s+"?([^"\s]+)"?\s*$/.exec(raw);
      if (m) currentVersion = m[1];
    }
  }
  flush();
  return Array.from(out.values());
}

// ---------------------------------------------------------------------------
// requirements.txt (Python pip)
// ---------------------------------------------------------------------------
//
// Only pinned versions (`pkg==1.2.3` or `pkg===1.2.3`) get audited — pinned
// is the only form OSV can definitively match. Range specs (`>=`, `~=`)
// are silently skipped: they're widely used in dev requirements where the
// resolved version isn't fixed, and reporting "maybe vulnerable" hurts trust.

function parseRequirementsTxt(content) {
  const out = new Map();
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.split("#")[0].trim();
    if (!line) continue;
    if (line.startsWith("-")) continue;            // -r other.txt, -e ...
    if (/^(git\+|https?:|file:)/i.test(line)) continue;
    const m = /^([A-Za-z0-9][A-Za-z0-9._-]*)\s*===?\s*([0-9A-Za-z][0-9A-Za-z.+!-]*)/.exec(line);
    if (!m) continue;
    const name = m[1].toLowerCase();
    const version = m[2];
    const key = name + "@" + version;
    if (!out.has(key)) out.set(key, { name, version });
  }
  return Array.from(out.values());
}

// ---------------------------------------------------------------------------
// Gemfile.lock (Ruby bundler)
// ---------------------------------------------------------------------------
//
// Relevant section:
//   GEM
//     remote: ...
//     specs:
//       pkg (1.2.3)
//         dep1 (>= 1.0)
// Top-level specs (4 spaces of indent) are the gems we want; indented (6+)
// are dep ranges, which we skip.

function parseGemfileLock(content) {
  const out = new Map();
  let inGem = false;
  let inSpecs = false;

  for (const raw of content.split(/\r?\n/)) {
    if (/^[A-Z]/.test(raw)) {
      inGem = raw.startsWith("GEM");
      inSpecs = false;
      continue;
    }
    if (!inGem) continue;
    if (/^\s*specs:\s*$/.test(raw)) { inSpecs = true; continue; }
    if (!inSpecs) continue;
    // Top-level gem entry: exactly 4 leading spaces.
    const m = /^ {4}([A-Za-z0-9][A-Za-z0-9_.-]*)\s+\(([0-9A-Za-z][0-9A-Za-z.+-]*)\)\s*$/.exec(raw);
    if (!m) continue;
    const key = m[1] + "@" + m[2];
    if (!out.has(key)) out.set(key, { name: m[1], version: m[2] });
  }
  return Array.from(out.values());
}

// ---------------------------------------------------------------------------
// go.sum
// ---------------------------------------------------------------------------
//
// Each line: `<module> <version> h1:<hash>` or `<module> <version>/go.mod h1:<hash>`.
// We dedupe the `/go.mod` hash lines (same module+version appears twice).

function parseGoSum(content) {
  const out = new Map();
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const parts = line.split(/\s+/);
    if (parts.length < 3) continue;
    const name = parts[0];
    const version = parts[1];
    if (version.endsWith("/go.mod")) continue;
    if (!/^v\d/.test(version)) continue;
    const key = name + "@" + version;
    if (!out.has(key)) out.set(key, { name, version });
  }
  return Array.from(out.values());
}
