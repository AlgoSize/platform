// Repository language profiler.
//
// The profiler is a pure function of a path list, so these tests need no
// network, no filesystem and no fixture directories — a repository is an
// array of strings. That is the whole reason the module was shaped that way.
//
// What is actually being pinned, in order of how much it would cost to get
// wrong:
//
//   1. COVERAGE IS DERIVED, NOT LISTED. handlers/analyze.js builds its fetch
//      filter from the registry. If that link breaks, a language can be
//      "supported" in the registry and never fetched — which is exactly the
//      silent failure the profiler was built to end.
//   2. Nothing overclaims. A detected manifest is not an audited manifest; a
//      tier is what exists today, not what is on the roadmap.
//   3. Framework detection is weighted, so a directory name alone can never
//      produce a confident wrong answer.
//
// Run with:  node scripts/test-sast-profile.mjs

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  profileRepository, makeIgnoreEngine, collectDependencyNames, summarize,
} from "../src/analyzers/sast/profile.js";
import {
  LANGUAGES, MANIFESTS, TIER, ALL_KNOWN_EXTENSIONS, ALL_KNOWN_FILENAMES, FETCHABLE_FILENAMES,
  languageOfPath, manifestOfPath, normalizePath,
} from "../src/analyzers/sast/languages.js";
import { FRAMEWORKS, detectFrameworks } from "../src/analyzers/sast/frameworks.js";
import * as FIX from "./fixtures/sast/repos.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));

let failures = 0;
const ok   = (m) => console.log(`  \x1b[32m✓\x1b[0m ${m}`);
const fail = (m) => { console.log(`  \x1b[31m✗\x1b[0m ${m}`); failures++; };
const expect = (c, m) => (c ? ok(m) : fail(m));
const group  = (n) => console.log(`\n\x1b[1m${n}\x1b[0m\n`);

const profile = (fixture) => profileRepository(fixture).repositoryProfile;
const langNames = (p) => p.languages.map((l) => l.name);
const lang = (p, name) => p.languages.find((l) => l.name === name);
const fw = (p, name) => p.frameworks.find((f) => f.name === name);

// ===========================================================================
group("language detection");
// ===========================================================================
{
  const cases = [
    ["src/app.js", "javascript"], ["src/app.mjs", "javascript"], ["a.jsx", "javascript"],
    ["src/app.ts", "typescript"], ["c.tsx", "typescript"],
    ["etl.py", "python"], ["lib.rs", "rust"], ["Main.kt", "kotlin"],
    ["App.swift", "swift"], ["Program.cs", "csharp"], ["main.go", "go"],
    ["server.rb", "ruby"], ["index.php", "php"], ["Main.java", "java"],
    ["Token.sol", "solidity"], ["run.sh", "shell"], ["main.tf", "terraform"],
    ["values.yaml", "yaml"], ["pkg.json", "json"], ["Cargo.toml", "toml"],
    ["a.c", "c"], ["b.hpp", "c"], ["s.scala", "scala"], ["m.ex", "elixir"],
  ];
  const wrong = cases.filter(([p, want]) => languageOfPath(p) !== want);
  expect(wrong.length === 0,
    `every extension maps to its language${wrong.length ? " — wrong: " + wrong.map(([p, w]) => `${p} wanted ${w} got ${languageOfPath(p)}`).join("; ") : ` (${cases.length} checked)`}`);

  // Names without a normal extension.
  expect(languageOfPath("Dockerfile") === "dockerfile", "a bare Dockerfile is detected");
  expect(languageOfPath("deploy/Dockerfile.prod") === "dockerfile", "…and a suffixed one");
  expect(languageOfPath(".env") === "env" && languageOfPath(".env.production") === "env",
    "an .env file is not read as an extension called 'production'");
  expect(languageOfPath("android/build.gradle.kts") === "kotlin",
    "a compound extension takes the longest match (.gradle.kts is Kotlin)");
  expect(languageOfPath("README.md") === null && languageOfPath("logo.png") === null,
    "an unknown extension is null, not a catch-all bucket that hides the count");

  // Windows separators. Paths reach the profiler from callers, not only from
  // the GitHub API, and splitting on "/" alone would detect nothing.
  expect(languageOfPath("src\\lib\\db.ts") === "typescript",
    "a backslash path still resolves its basename");
  expect(normalizePath("./src/a.js") === "src/a.js" && normalizePath("\\x\\y.py") === "x/y.py",
    "paths normalise to forward slashes without a leading ./ or /");
}

// ===========================================================================
group("manifests are detected without being overclaimed");
// ===========================================================================
{
  expect(manifestOfPath("package-lock.json").audited === true,
    "package-lock.json is audited — analyzers/lockfile.js parses it");
  expect(manifestOfPath("services/worker/Cargo.toml").language === "rust",
    "Cargo.toml is recognised at any depth and attributed to Rust");
  expect(manifestOfPath("Cargo.lock").audited === false,
    "…and Cargo.lock is NOT audited: recognising a lockfile is not resolving it");
  expect(manifestOfPath("pnpm-lock.yaml").audited === false,
    "pnpm-lock.yaml is detected and honestly marked unauditable");
  expect(manifestOfPath("src/Acme.csproj").language === "csharp",
    "a suffix-matched manifest (.csproj) resolves");

  // The guard that keeps the two lists in step. If someone marks a manifest
  // `audited: true` without teaching lockfile.js to parse it, the scan plan
  // starts promising a dependency result nobody can produce.
  const lockfileSrc = readFileSync(join(__dirname, "..", "src", "analyzers", "lockfile.js"), "utf8");
  const supported = (/export const SUPPORTED_FILES = \[([\s\S]*?)\]/.exec(lockfileSrc) || [])[1] || "";
  const parseable = new Set([...supported.matchAll(/"([^"]+)"/g)].map((m) => m[1].toLowerCase()));
  const lying = MANIFESTS.filter((m) => m.audited && !parseable.has(m.file));
  expect(lying.length === 0,
    `every manifest marked audited is one lockfile.js can parse${
      lying.length ? " — overclaimed: " + lying.map((m) => m.file).join(", ") : ` (${parseable.size} parseable)`}`);
}

// ===========================================================================
group("the ignore engine reports WHICH rule swallowed a file");
// ===========================================================================
{
  const ignore = makeIgnoreEngine();
  expect(ignore("node_modules/react/index.js") === "node_modules",
    "a vendored path names the rule, not just 'ignored'");
  expect(ignore("apps/web/.next/server/page.js") === ".next",
    "…at any depth");
  expect(ignore("src/app.js") === null, "ordinary source is kept");
  expect(ignore("src/bundle.min.js") === "generated file",
    "a minified file is ignored by the file rule");
  // The filename is not a directory. A file literally called `dist` at the
  // repository root is source, not a build directory.
  expect(ignore("dist") === null,
    "the LAST segment is a filename and is never matched as a directory");
  expect(ignore("dist/app.js") === "dist", "…while a real dist/ directory is ignored");

  // Configurable, as required — and provably so.
  const permissive = makeIgnoreEngine([], null);
  expect(permissive("node_modules/react/index.js") === null,
    "ignore rules are configurable: an empty list ignores nothing");

  const p = profile(FIX.NEXT_TS_APP);
  const nm = p.ignoredPaths.find((i) => i.rule === "node_modules");
  expect(nm && nm.fileCount === 2,
    `the summary counts files per ignored rule (got ${JSON.stringify(p.ignoredPaths)})`);
}

// ===========================================================================
group("framework detection is weighted, and shows its evidence");
// ===========================================================================
{
  const next = profile(FIX.NEXT_TS_APP);
  expect(fw(next, "Next.js") && fw(next, "Next.js").confidence === "high",
    "Next.js: dependency + config file + directory reaches high confidence");
  expect(fw(next, "Next.js").evidence.some((e) => /dependency: next/.test(e)) &&
         fw(next, "Next.js").evidence.some((e) => /next\.config\.js/.test(e)),
    `…and the evidence names both signals (got ${JSON.stringify(fw(next, "Next.js").evidence)})`);
  expect(fw(next, "React") && fw(next, "React").confidence === "high",
    "React is detected from the dependency plus tsx files");

  const flask = profile(FIX.PYTHON_FLASK);
  expect(fw(flask, "Flask") && fw(flask, "Flask").confidence === "high",
    "Flask from requirements.txt, case-insensitively");

  const django = profile(FIX.PYTHON_DJANGO);
  expect(fw(django, "Django") && fw(django, "Django").confidence === "high",
    "Django from manage.py plus settings.py plus the dependency");

  const spring = profile(FIX.JAVA_SPRING);
  expect(fw(spring, "Spring / Spring Boot"),
    "Spring from the Maven artifactId and application.yml");

  const rails = profile(FIX.RUBY_RAILS);
  expect(fw(rails, "Ruby on Rails") && fw(rails, "Ruby on Rails").confidence === "high",
    "Rails from the Gemfile plus config/routes.rb");

  const go = profile(FIX.GO_SERVICE);
  expect(fw(go, "Gin"), "Gin from the go.mod require block");
  expect(fw(go, "net/http service"),
    "…and net/http, which has no dependency entry and is only visible as an import");
}

// ---------------------------------------------------------------------------
console.log("\na directory name alone never produces a confident framework\n");
// ---------------------------------------------------------------------------
//
// `pages/` and `app/` belong to Next.js, to Rails, and to plenty of sites
// running neither. A static site with both must not be reported as Next.js —
// that sends a reviewer looking for server-side data loading in a project
// that has never had any. This is the regression test for that.
{
  const p = profile(FIX.FALSE_SIGNAL_STATIC_SITE);
  const next = fw(p, "Next.js");
  expect(!next || next.confidence === "low",
    `pages/ and app/ with no dependency stays at low confidence (got ${next ? next.confidence : "not detected"})`);
  expect(!fw(p, "React"),
    "and React is not claimed from directory shape at all");
  expect(!fw(p, "Ruby on Rails"),
    "…nor Rails, whose own directory signature (app/controllers) is absent");

  // The weighting is what does this, so pin the mechanism too.
  const bare = detectFrameworks({ paths: ["pages/index.html", "app/x.css"] });
  const nextBare = bare.find((f) => f.name === "Next.js");
  expect(!nextBare || nextBare.score < 3,
    "two weight-1 directory signals cannot reach the high-confidence threshold");
  const withDep = detectFrameworks({ paths: ["pages/index.js"], dependencies: ["next"] });
  expect(withDep.find((f) => f.name === "Next.js").confidence === "high",
    "…while one dependency signal alone does");
}

// ===========================================================================
group("support tiers describe what exists today");
// ===========================================================================
{
  expect(LANGUAGES.javascript.tier === TIER.SEMANTIC,
    "JavaScript is tier 1 — acorn parses it and sast/ast.js tracks taint through it");
  expect(LANGUAGES.typescript.tier === TIER.PATTERN,
    "TypeScript is tier 3, NOT tier 2: acorn rejects type annotations, so the pattern engine is genuinely all that runs");
  expect(LANGUAGES.yaml.tier === TIER.CONFIG && LANGUAGES.terraform.tier === TIER.CONFIG,
    "config languages are tier 4 — not parsed as code, still scanned for secrets");

  // Tier 2 is deliberately unoccupied. If a language is ever added to it, the
  // AST analyzer has to exist for that language first — this assertion is the
  // reminder, and it names the trade rather than silently allowing it.
  const tier2 = Object.entries(LANGUAGES).filter(([, s]) => s.tier === TIER.AST);
  expect(tier2.length === 0,
    `tier 2 is empty until a non-JS parser ships — putting a language there early makes the coverage summary a promise (found: ${tier2.map(([id]) => id).join(", ")})`);

  const p = profile(FIX.NEXT_TS_APP);
  expect(lang(p, "JavaScript").analyzers.includes("taint"),
    "tier 1 routes the taint engine");
  expect(!lang(p, "TypeScript").analyzers.includes("taint"),
    "tier 3 does not — routing an engine that cannot parse the file is how coverage is faked");
  expect(lang(p, "TypeScript").analyzers.includes("pattern") &&
         lang(p, "TypeScript").analyzers.includes("secrets"),
    "…but it still gets pattern and secrets");
}

// ===========================================================================
group("analyzer routing and the scan plan");
// ===========================================================================
{
  const p = profile(FIX.MIXED_MONOREPO);
  const names = langNames(p);
  expect(["TypeScript", "Python", "Rust", "Terraform", "YAML"].every((n) => names.includes(n)),
    `a mixed monorepo detects every stack in it (got ${names.join(", ")})`);

  // The headline behaviour: Rust is UNSUPPORTED for deep analysis and is still
  // scanned. Before the profiler it was fetched as zero files.
  const rust = lang(p, "Rust");
  expect(rust && rust.supportTier === TIER.PATTERN,
    "Rust is present at pattern tier rather than absent");
  expect(rust.analyzers.includes("secrets") && rust.analyzers.includes("pattern"),
    "…and is routed to secrets + pattern, which is what 'unsupported' should mean");
  expect(!rust.analyzers.includes("dependency"),
    "…but NOT to dependency: Cargo.lock is detected and the audit cannot parse it");

  const py = lang(p, "Python");
  expect(py.analyzers.includes("dependency"),
    "Python IS routed to dependency — requirements.txt is one the audit reads");

  expect(p.scanPlan.dependencyAudit.available === true &&
         p.scanPlan.dependencyAudit.from.some((f) => /requirements\.txt$/.test(f)),
    `the plan names the file the audit will actually read (got ${JSON.stringify(p.scanPlan.dependencyAudit)})`);

  const gap = p.scanPlan.gaps.find((g) => g.kind === "dependency_manifest_unsupported");
  expect(gap && /pnpm-lock\.yaml|Cargo\.lock/.test(gap.detail),
    `the plan names the manifests it cannot audit (got ${gap ? gap.detail : "no gap reported"})`);

  expect(p.ignoredPaths.some((i) => i.rule === "node_modules") &&
         p.ignoredPaths.some((i) => i.rule === "target"),
    "vendored and build directories are excluded and reported");
  expect(!names.includes("Text"),
    "README.md contributes no phantom language");
}

// ---------------------------------------------------------------------------
console.log("\nan unsupported repository is described, not dismissed\n");
// ---------------------------------------------------------------------------
//
// This is the failure the whole module exists to fix. A Swift + Kotlin
// repository matched none of the thirteen extensions the old filter allowed,
// was fetched as zero files, and was reported "No files in a language this
// scanner reads were found" — the same sentence an empty repository gets.
{
  const p = profile(FIX.UNSUPPORTED_MOBILE);
  const names = langNames(p);
  expect(names.includes("Swift") && names.includes("Kotlin"),
    `Swift and Kotlin are detected rather than invisible (got ${names.join(", ")})`);
  expect(lang(p, "Swift").analyzers.includes("secrets"),
    "…and still get secrets scanning, which is language-agnostic");
  expect(p.scanPlan.selectedAnalyzers.includes("secrets"),
    "the plan therefore selects at least one real analyzer");
  expect(p.scanPlan.dependencyAudit.available === false &&
         /parse|manifest/.test(p.scanPlan.dependencyAudit.reason),
    `…and says plainly why dependencies are not audited (got "${p.scanPlan.dependencyAudit.reason}")`);

  const summary = profileRepository(FIX.UNSUPPORTED_MOBILE).summary;
  expect(/Swift/.test(summary) && /Kotlin/.test(summary),
    `the human summary names them (got "${summary}")`);
  expect(!/^No files/.test(summary),
    "…and does not open with the sentence that used to mean 'empty repository'");
}

// ===========================================================================
group("the human summary is honest about what it did not do");
// ===========================================================================
{
  const { summary } = profileRepository(FIX.MIXED_MONOREPO);
  expect(/deep semantic scan/.test(summary) && /generic pattern scan/.test(summary),
    "the summary states the depth per group, not just the language list");
  expect(/Next\.js/.test(summary), "…names the frameworks");
  expect(/cannot parse|not checked/.test(summary),
    `…and ends on what is NOT covered (got "${summary}")`);

  const empty = summarize({ languages: [], frameworks: [], scanPlan: {} });
  expect(/not the same as nothing being wrong/.test(empty),
    "an empty profile refuses to read as a clean bill of health");
}

// ===========================================================================
group("dependency-name extraction across ecosystems");
// ===========================================================================
{
  const names = collectDependencyNames({
    "package.json": JSON.stringify({ dependencies: { express: "4" }, devDependencies: { jest: "29" } }),
    "requirements.txt": "Flask==3.0.0\n# a comment\ndjango>=5\n",
    "Gemfile": 'gem "rails", "~> 7"\ngem "puma"\n',
    "go.mod": "module x\n\nrequire (\n\tgithub.com/gin-gonic/gin v1.9.1\n)\n",
    "pom.xml": "<artifactId>spring-boot-starter-web</artifactId>",
  });
  const want = ["express", "jest", "Flask", "django", "rails", "puma",
                "github.com/gin-gonic/gin", "spring-boot-starter-web"];
  const missing = want.filter((w) => !names.includes(w));
  expect(missing.length === 0,
    `every ecosystem's dependency names are read${missing.length ? " — missing: " + missing.join(", ") : ` (${names.length} found)`}`);

  // A broken manifest costs framework signal and must never cost the scan.
  const survived = collectDependencyNames({ "package.json": "{ not json" });
  expect(Array.isArray(survived) && survived.length === 0,
    "a malformed manifest yields no names rather than throwing");
}

// ---------------------------------------------------------------------------
console.log("\nthe registry is what the scanner actually fetches\n");
// ---------------------------------------------------------------------------
//
// The most valuable assertion in this file. handlers/analyze.js DERIVES its
// file filter from the registry; if that link is ever replaced with a literal
// list again, a language can be fully registered — tiered, routed, named in
// the coverage summary — and never fetched, so the profile would promise a
// scan that never happens. Checked against the source, because the failure is
// invisible at runtime: everything reports success and nothing is read.
{
  const src = readFileSync(join(__dirname, "..", "src", "handlers", "analyze.js"), "utf8");
  // Asserted at the CONSTRUCTION SITE, not by the identifier appearing
  // somewhere in the file. The first version of this test matched
  // /FETCHABLE_FILENAMES/ anywhere, which the import line satisfies on its own
  // — so replacing the filter body with a hardcoded list left the test green.
  // Verified by making exactly that change and watching this fail.
  expect(/new Set\(FETCHABLE_FILENAMES\)/.test(src),
    "analyze.js builds its basename filter FROM the registry export, not from a literal list");
  expect(/ALL_KNOWN_EXTENSIONS\.map\(/.test(src),
    "…and its extension filter is compiled from the registry's extensions");
  // Generated lockfiles are recognised and deliberately not downloaded: the
  // audit fetches them separately, and they would spend the source scan's
  // 120-file and 3 MB budgets on machine-written JSON.
  expect(/GENERATED_LOCKFILE_SET\.has\(base\)/.test(src),
    "…and excludes generated lockfiles before the extension check, since package-lock.json is also .json");
  expect(!/const SOURCE_EXT_RE = \/\\\.\(\?:js\|/.test(src),
    "…and the old hardcoded thirteen-extension regex is gone");

  // Spot-check the languages that used to be excluded entirely.
  for (const ext of ["rs", "cs", "kt", "swift", "sol", "tf", "cpp"]) {
    expect(ALL_KNOWN_EXTENSIONS.includes(ext),
      `.${ext} is in the registry, so it is now fetched and scanned`);
  }
  for (const name of ["cargo.toml", "go.mod", "pom.xml", "composer.json"]) {
    expect(FETCHABLE_FILENAMES.includes(name),
      `${name} is fetchable by exact name — a manifest has no language extension`);
  }
  for (const name of ["package-lock.json", "yarn.lock", "go.sum", "cargo.lock"]) {
    expect(ALL_KNOWN_FILENAMES.includes(name) && !FETCHABLE_FILENAMES.includes(name),
      `${name} is RECOGNISED but not fetched — detection from a path is free, downloading it is not`);
  }
}

// ===========================================================================
group("profiling is cheap enough to run before every scan");
// ===========================================================================
{
  // 5,000 paths is a large repository. The profiler must not parse anything.
  const entries = [];
  for (let i = 0; i < 5000; i++) {
    entries.push(`src/mod${i % 50}/file${i}.${["ts", "js", "py", "go", "yml"][i % 5]}`);
  }
  const started = Date.now();
  const p = profileRepository({ entries }).repositoryProfile;
  const ms = Date.now() - started;
  expect(p.filesProfiled === 5000, `all 5,000 paths profiled (got ${p.filesProfiled})`);
  expect(ms < 500, `…in under 500ms (took ${ms}ms)`);
  expect(p.languages.every((l) => l.evidence.length <= 4),
    "evidence is capped per language, so a huge repo cannot produce a huge profile");
}

// ===========================================================================
group("every registry entry is complete");
// ===========================================================================
{
  const badLang = Object.entries(LANGUAGES).filter(([, s]) =>
    !s.label || ![1, 2, 3, 4].includes(s.tier) || (!Array.isArray(s.ext) && !Array.isArray(s.filenames)));
  expect(badLang.length === 0,
    `every language has a label, a valid tier and signatures${badLang.length ? " — bad: " + badLang.map(([id]) => id).join(", ") : ` (${Object.keys(LANGUAGES).length} languages)`}`);

  const badFw = FRAMEWORKS.filter((f) =>
    !f.id || !f.name || !f.language ||
    !(f.dependency || f.configFile || f.markerFile || f.directory || f.importPattern));
  expect(badFw.length === 0,
    `every framework has an id, a name, a language and at least one signal${badFw.length ? " — bad: " + badFw.map((f) => f.id || "?").join(", ") : ` (${FRAMEWORKS.length} frameworks)`}`);

  const unknownLang = FRAMEWORKS.filter((f) => !LANGUAGES[f.language]);
  expect(unknownLang.length === 0,
    `every framework names a language the registry knows${unknownLang.length ? " — unknown: " + unknownLang.map((f) => f.id).join(", ") : ""}`);

  const dupeIds = FRAMEWORKS.map((f) => f.id).filter((id, i, a) => a.indexOf(id) !== i);
  expect(dupeIds.length === 0, `no duplicate framework ids${dupeIds.length ? ": " + dupeIds.join(", ") : ""}`);
}

console.log("");
if (failures === 0) {
  console.log("\x1b[32m  all profiler tests passed\x1b[0m\n");
  process.exit(0);
} else {
  console.log(`\x1b[31m  ${failures} profiler test(s) failed\x1b[0m\n`);
  process.exit(1);
}
