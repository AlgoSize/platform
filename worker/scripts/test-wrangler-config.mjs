// Config invariants for worker/wrangler.toml and the repo-root wrangler.jsonc.
//
// These are cheap assertions about deploy configuration that would otherwise
// only surface as a production outage. They exist because of a real one:
//
//   [env.production] set `routes = [algosize.com/api/*]` (kept dormant for a
//   future custom-domain switch) and left `workers_dev` unset, while
//   SITE_ORIGIN pointed at https://algosize.guillaumelauzier.workers.dev.
//   Wrangler resolves the workers.dev host with
//       deployToWorkersDev = config.workers_dev ?? routes.length === 0
//   so a non-empty `routes` made it `false`, and `wrangler deploy` — which
//   reported success — took the API off the very host SITE_ORIGIN names.
//   /api/me started answering 404 and the post-deploy smoke test caught it.
//
// A full TOML parser is overkill here (and Node has none built in), so this
// reads the file section by section. That is sufficient for the flat
// `[env.<name>]` blocks this config uses, and the parser asserts its own
// assumptions below so it can't silently start reading nothing.
//
// Run with:  node scripts/test-wrangler-config.mjs

import { readFileSync, existsSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TOML_PATH = join(__dirname, "..", "wrangler.toml");

let failures = 0;
const ok   = (msg) => console.log(`  \x1b[32m✓\x1b[0m ${msg}`);
const fail = (msg) => { console.log(`  \x1b[31m✗\x1b[0m ${msg}`); failures++; };
const expect = (cond, label) => cond ? ok(label) : fail(label);

const raw = readFileSync(TOML_PATH, "utf8");

/**
 * Split the file into `[header]` / `[[header]]` sections, dropping comments
 * and blank lines. Returns a Map of header → array of body lines. Repeated
 * `[[array]]` headers accumulate into the same key.
 */
function parseSections(text) {
  const sections = new Map();
  let current = "__root__";
  sections.set(current, []);
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const header = /^\[\[?([^\]]+)\]\]?$/.exec(trimmed);
    if (header) {
      current = header[1].trim();
      if (!sections.has(current)) sections.set(current, []);
      continue;
    }
    sections.get(current).push(trimmed);
  }
  return sections;
}

/** Read a scalar `key = value` from a section's lines. Returns raw text. */
function readKey(lines, key) {
  for (const line of lines || []) {
    const m = new RegExp(`^${key}\\s*=\\s*(.+)$`).exec(line);
    if (m) return m[1].trim();
  }
  return null;
}

const unquote = (v) => (v === null ? null : v.replace(/^["']|["']$/g, ""));

const sections = parseSections(raw);

// ---------------------------------------------------------------------------
console.log("\nparser sanity — these guard the assertions below\n");
// ---------------------------------------------------------------------------

expect(sections.has("env.production"), "found [env.production]");
expect(sections.has("env.staging"), "found [env.staging]");
expect(sections.has("env.production.vars"), "found [env.production.vars]");
expect(unquote(readKey(sections.get("env.production"), "name")) === "algosize",
       "production worker is named algosize");

// ---------------------------------------------------------------------------
console.log("\nOAuth discovery is routed at the apex, by exact path\n");
// ---------------------------------------------------------------------------
// The MCP OAuth flow starts with a client fetching
// https://algosize.com/.well-known/oauth-protected-resource — the spec puts
// discovery at the ORIGIN ROOT, so the algosize.com/api/* route does not
// cover it. src/index.js has registered both handlers all along; without the
// zone routes below the requests never reach this Worker at all, and the
// Claude.ai "add a connector" path dead-ends before it starts.
//
// Asserted here because a missing route is invisible in every other check:
// the code is present, the tests pass, the deploy succeeds, and only a real
// browser attempting a real connection ever finds out.
for (const [envName, host] of [["production", "algosize.com"],
                               ["staging", "staging.algosize.com"]]) {
  const envLines = sections.get(`env.${envName}`) || [];
  const patterns = envLines
    .map((l) => /pattern\s*=\s*"([^"]+)"/.exec(l))
    .filter(Boolean).map((m) => m[1]);

  for (const doc of ["oauth-protected-resource", "oauth-authorization-server"]) {
    const want = `${host}/.well-known/${doc}`;
    expect(patterns.includes(want), `${envName}: routes ${want}`);
  }

  // Exact paths, not a wildcard. /.well-known/* would claim every well-known
  // path on the zone — ACME challenges among them — and this Worker answers
  // JSON 404 for the ones it does not implement, which would break issuance
  // rather than falling through to the site Worker.
  expect(!patterns.some((pat) => pat.includes("/.well-known/*")),
    `${envName}: no /.well-known/* wildcard — it would claim ACME and every other well-known path`);
}

// ---------------------------------------------------------------------------
console.log("\nworkers.dev must be explicit wherever routes are set\n");
// ---------------------------------------------------------------------------

for (const envName of ["production", "staging"]) {
  const envLines  = sections.get(`env.${envName}`) || [];
  const varsLines = sections.get(`env.${envName}.vars`) || [];

  // `routes = [` opens a multi-line array; the scalar reader sees the "[".
  const hasRoutes = envLines.some((l) => /^routes\s*=/.test(l));
  const workersDev = readKey(envLines, "workers_dev");
  const siteOrigin = unquote(readKey(varsLines, "SITE_ORIGIN"));

  expect(siteOrigin !== null && /^https?:\/\//.test(siteOrigin),
         `${envName}: SITE_ORIGIN is an absolute URL (${siteOrigin})`);

  const originIsWorkersDev = !!siteOrigin && /\.workers\.dev$/.test(new URL(siteOrigin).hostname);

  // The rule wrangler applies:
  //   deployToWorkersDev = config.workers_dev ?? routes.length === 0
  const deployToWorkersDev = workersDev === null ? !hasRoutes : workersDev === "true";

  if (originIsWorkersDev) {
    expect(deployToWorkersDev,
           `${envName}: SITE_ORIGIN is a workers.dev host, so the deploy must publish it ` +
           `(routes=${hasRoutes}, workers_dev=${workersDev}) — set workers_dev = true`);
  } else {
    expect(hasRoutes,
           `${envName}: SITE_ORIGIN is a custom domain (${siteOrigin}), so a route must be bound`);
    ok(`${envName}: serves from its route; workers.dev publishing is ${deployToWorkersDev}`);
  }
}

// ---------------------------------------------------------------------------
console.log("\nevery environment carries the vars the Worker reads at runtime\n");
// ---------------------------------------------------------------------------

for (const envName of ["production", "staging"]) {
  const varsLines = sections.get(`env.${envName}.vars`) || [];
  for (const key of ["SITE_ORIGIN", "COOKIE_NAME"]) {
    expect(readKey(varsLines, key) !== null, `${envName}: ${key} is set`);
  }
}

// ---------------------------------------------------------------------------
console.log("\nthe root wrangler.jsonc can actually build what it deploys\n");
// ---------------------------------------------------------------------------
//
// The site Worker's config pointed `assets.directory` at `_site_build`, a
// gitignored artifact that nothing in CI produced — so "Workers Builds:
// algosize" failed on every commit for weeks with:
//
//   ✘ The directory specified by the "assets.directory" field in your
//     configuration file does not exist: /opt/buildhome/repo/_site_build
//
// The fix is a `build.command` that produces the directory before wrangler
// reads it. These assertions exist because that pairing is invisible: the
// config is syntactically valid, and wrangler only complains at deploy time
// in an environment nobody runs locally.

{
  const JSONC_PATH = join(__dirname, "..", "..", "wrangler.jsonc");
  const jsonc = readFileSync(JSONC_PATH, "utf8");
  // Line comments only — this file has no block comments and no strings
  // containing "//", both of which this strip would mangle.
  const site = JSON.parse(jsonc.replace(/^\s*\/\/.*$/gm, ""));

  expect(site.name !== "algosize",
    `the site Worker is not named "algosize" (got "${site.name}") — sharing the API Worker's ` +
    "service name would let a site deploy replace the live API");

  // The $schema path is read by editors, not by wrangler, so a broken one
  // fails silently — this repo shipped one for a while (it pointed at a
  // root node_modules that has never existed; the real one is vendored
  // under worker/).
  const schemaPath = site.$schema;
  expect(Boolean(schemaPath) && existsSync(join(__dirname, "..", "..", schemaPath)),
    `$schema points at a file that actually exists ("${schemaPath}")`);

  const dir = site.assets && site.assets.directory;
  expect(Boolean(dir), "it declares an assets directory");

  // A request wrangler cannot match falls through to whatever
  // not_found_handling names. Left unset it is an empty 404 with no body —
  // site/404.html exists specifically so visitors get the real page instead.
  expect(site.assets && site.assets.not_found_handling === "404-page",
    "assets.not_found_handling is \"404-page\"");
  expect(existsSync(join(__dirname, "..", "..", "site", "404.html")),
    "and site/404.html — the page that setting points at — exists");

  // Jekyll's permalinks are directory-style (a post at /blog/foo/ builds to
  // blog/foo/index.html on disk); without this a request for /blog/foo with
  // no trailing slash 404s even though the page exists.
  expect(site.assets && site.assets.html_handling === "auto-trailing-slash",
    "assets.html_handling is \"auto-trailing-slash\", matching Jekyll's directory-style permalinks");

  // The staged-cutover guard rail. Both routes are live now — DEPLOY.md §9.3
  // (production) landed in its own commit, deliberately, after the staging
  // rehearsal in §9.2, not as a side effect of an unrelated site change.
  // This still asserts both are present and asserts the staging route was
  // never dropped in the process of adding the production one.
  const routes = (site.routes || []).map((r) => r.pattern);
  expect(routes.includes("staging.algosize.com/*"),
    "the staging route (DEPLOY.md §9.2) is present");
  expect(routes.some((p) => /^algosize\.com\/\*?$/.test(p)),
    "the production route (DEPLOY.md §9.3) is present — algosize.com is served by this Worker");

  // routes.length === 0 is what makes workers_dev default true; the moment
  // routes is non-empty that default flips, and without this key the
  // workers.dev URL DEPLOY.md §9.1 relies on would silently go dark.
  expect(site.workers_dev === true,
    "workers_dev is explicitly true, so adding routes above didn't silently disable the " +
    "workers.dev preview URL §9.1 depends on");

  const cmd = site.build && site.build.command;
  expect(Boolean(cmd),
    "and a build command that produces it — an assets directory nothing builds is the exact " +
    "failure that kept this check red on every commit");

  if (cmd && dir) {
    expect(cmd.includes(dir),
      `the build command writes to the declared assets directory ("${dir}")`);
    // The gitignore entry is what makes the build command load-bearing rather
    // than merely redundant, so the two are asserted together.
    const ignore = readFileSync(join(__dirname, "..", "..", ".gitignore"), "utf8");
    expect(ignore.split(/\r?\n/).some((l) => l.trim().replace(/\/$/, "") === dir.replace(/\/$/, "")),
      `"${dir}" is gitignored, so it only ever exists because the build command made it`);
  }

  // Ruby 3.4 moved a set of libraries out of DEFAULT gems and into bundled
  // gems. A bundled gem is only on the load path if the Gemfile declares it,
  // so a dependency that quietly `require`s one breaks the moment the build
  // runs on 3.4 — while still passing locally on an older Ruby, which is
  // exactly how this reached CI:
  //
  //   bundler: failed to load command: jekyll
  //   'Kernel#require': cannot load such file -- csv (LoadError)
  //
  // Nothing in the Gemfile uses these directly. jekyll.rb requires "csv" and
  // safe_yaml requires "base64", so they are transitive requirements that no
  // gem declares, which is why they have to be named explicitly.
  const lock = readFileSync(join(__dirname, "..", "..", "site", "Gemfile.lock"), "utf8");
  const declared = (lock.match(/^DEPENDENCIES\n([\s\S]*?)\n\n/m) || [])[1] || "";
  for (const [gem, why] of [["csv", "jekyll.rb"], ["base64", "safe_yaml"]]) {
    expect(new RegExp(`^\\s+${gem}$`, "m").test(declared),
      `site/Gemfile declares "${gem}" — required by ${why}, and a bundled rather than ` +
      "default gem on Ruby >= 3.4, which is what the Cloudflare build image runs");
  }

  // A build that renders differently from what jekyll.yml produces is worse
  // than no site: it invites decisions about a build nobody actually shipped.
  // (jekyll.yml is still live — GitHub Pages retires in DEPLOY.md §9.4, not
  // yet — so this is two ACTIVE pipelines that have to keep agreeing.)
  const workflow = readFileSync(
    join(__dirname, "..", "..", ".github", "workflows", "jekyll.yml"), "utf8");
  for (const flag of ["_config.yml,_config.production.yml", "JEKYLL_ENV"]) {
    expect(cmd.includes(flag) && workflow.includes(flag),
      `the site Worker build and the still-live Pages build agree on ${flag}`);
  }

  // site-worker.yml is what actually deploys this config now — the
  // assertions above are inert if nothing in CI ever runs `wrangler deploy`
  // against this file.
  const deploy = readFileSync(
    join(__dirname, "..", "..", ".github", "workflows", "site-worker.yml"), "utf8");
  expect(deploy.includes("wrangler deploy") && deploy.includes("wrangler.jsonc"),
    "site-worker.yml deploys (not just builds) this config");
  // The comments legitimately mention `npx wrangler` (that is what the old
  // Cloudflare image ran), so this checks the run: lines, not the whole file.
  const runLines = deploy.split("\n").filter((l) => /^\s*run:/.test(l));
  expect(runLines.some((l) => l.includes("wrangler")) && !runLines.some((l) => l.includes("npx wrangler")),
    "and does it with the vendored wrangler binary, not `npx wrangler` — an unpinned npx " +
    "install is exactly how the Cloudflare Workers Builds image picked up an untested Ruby " +
    "and wrangler version in the first place");
}

// ---------------------------------------------------------------------------
console.log("\nthe Worker actually bundles\n");
// ---------------------------------------------------------------------------
{
  // Added after a real failure: src/estimator/catalog.js imported its pricing
  // data with `with { type: "json" }`, which Node 22 accepts and the esbuild
  // inside wrangler 3.78 does not. Every unit test passed, because Node ran
  // the file directly. Nothing caught it for a whole PR either, because
  // nothing imported the estimator into the router yet — so esbuild never
  // reached the file. The moment the route was wired up, `wrangler dev`
  // refused to build and the API would not have deployed at all.
  //
  // Running the same bundler over the same entrypoint turns "the Worker can
  // be built" into a two-second unit test instead of something only the e2e
  // job discovers by booting wrangler.
  let esbuild = null;
  try {
    esbuild = (await import("esbuild")).default || (await import("esbuild"));
  } catch {
    // esbuild arrives via wrangler. If that ever stops being true, say so
    // loudly rather than silently skipping the check.
    expect(false, "esbuild is resolvable (it ships with wrangler) so the bundle check can run");
  }
  if (esbuild) {
    let built = null, buildError = null;
    try {
      built = await esbuild.build({
        entryPoints: [join(__dirname, "..", "src", "index.js")],
        bundle: true, write: false, format: "esm", platform: "neutral",
        logLevel: "silent", external: ["node:*", "cloudflare:*"],
      });
    } catch (err) {
      buildError = err;
    }
    expect(built !== null,
      buildError
        ? `the Worker entrypoint bundles — ${(buildError.errors || []).map((e) => e.text).join("; ").slice(0, 160)}`
        : "the Worker entrypoint bundles with the same esbuild wrangler uses");
    if (built) {
      const bytes = built.outputFiles[0].contents.length;
      // Workers' compressed limit is 1 MB; this is the uncompressed bundle, so
      // it is a smoke signal rather than the real ceiling. A sudden jump here
      // usually means a dependency got pulled in by accident.
      expect(bytes > 0 && bytes < 3 * 1024 * 1024,
        `bundle is a sane size (${(bytes / 1024).toFixed(0)} KB uncompressed)`);
    }
  }
}

// ---------------------------------------------------------------------------
console.log("\nthe e2e Worker boots with remote bindings off\n");
// ---------------------------------------------------------------------------
//
// wrangler 4 opens a remote proxy session for any binding it cannot emulate,
// and `[ai]` is one — Workers AI has no local implementation. Without a
// CLOUDFLARE_API_TOKEN (and the e2e job must not have one) wrangler exits 1
// before it listens, and all Playwright can say is "Process from
// config.webServer was not able to start". Asserted here because that error
// names neither wrangler, nor the AI binding, nor the flag that fixes it.
{
  const cfg = readFileSync(
    join(__dirname, "..", "..", "tests", "e2e", "playwright.config.js"), "utf8");
  const devCmd = (cfg.match(/^\s*command:\s*"([^"]*wrangler dev[^"]*)"/m) || [])[1];
  expect(Boolean(devCmd), "playwright.config.js starts the Worker with `wrangler dev`");
  if (devCmd) {
    expect(/(^|\s)(--local|-l)(\s|$)/.test(devCmd),
      "and passes --local, so the AI binding reports itself unsupported instead of " +
      "demanding a CLOUDFLARE_API_TOKEN the test job deliberately does not have");
  }
}

// ---------------------------------------------------------------------------
console.log("\nevery CI job runs a Node new enough for the wrangler we pin\n");
// ---------------------------------------------------------------------------
//
// wrangler's bin refuses to start below its own floor:
//
//   if (semiver(process.versions.node, MIN_NODE_VERSION) < 0) { ... exit }
//
// so a wrangler upgrade that raises that floor above the workflows' pin does
// not fail a test — it fails the DEPLOY, and only once it is on main. The
// 3.x → 4.x upgrade did exactly this: the floor went 18 → 22 while every
// workflow still said 20.
//
// The floor is read from the lockfile rather than node_modules so this holds
// before `npm ci` has ever run, and so it tracks the version actually pinned
// rather than whatever happens to be installed.
//
// Checked against EVERY node-version in .github/workflows, not only the jobs
// that name wrangler on a run: line. e2e.yml is the reason: it boots wrangler
// through Playwright's `webServer`, so no run: line mentions it, and any
// narrower scan misses the one job that actually starts the binary.
{
  const lockPath = join(__dirname, "..", "package-lock.json");
  const lock = JSON.parse(readFileSync(lockPath, "utf8"));
  const entry = lock.packages && lock.packages["node_modules/wrangler"];
  expect(Boolean(entry), "worker/package-lock.json pins wrangler");

  const declared = entry && entry.engines && entry.engines.node;
  expect(Boolean(declared),
    "and the lockfile records wrangler's engines.node — without it there is no floor to check");

  const floor = declared ? parseInt(/(\d+)/.exec(declared)[1], 10) : null;
  if (floor !== null) {
    ok(`wrangler ${entry.version} requires Node >= ${floor} (engines.node "${declared}")`);

    const wfDir = join(__dirname, "..", "..", ".github", "workflows");
    const files = readdirSync(wfDir).filter((f) => /\.ya?ml$/.test(f)).sort();
    // If the scan ever matches nothing — a rename, a syntax change in
    // setup-node — it must say so rather than passing by finding no work.
    let pins = 0;
    for (const file of files) {
      const text = readFileSync(join(wfDir, file), "utf8");
      for (const m of text.matchAll(/^\s*node-version:\s*["']?(\d+)/gm)) {
        pins++;
        const major = parseInt(m[1], 10);
        expect(major >= floor,
          `${file}: node-version ${major} >= wrangler's floor of ${floor}`);
      }
    }
    expect(pins > 0,
      "found at least one node-version pin to check — zero means the scan stopped matching, " +
      "not that every job is fine");
  }
}

// ---------------------------------------------------------------------------
console.log(failures === 0
  ? "\n\x1b[32mAll wrangler-config tests passed\x1b[0m\n"
  : `\n\x1b[31m${failures} wrangler-config test(s) failed\x1b[0m\n`);
process.exit(failures === 0 ? 0 : 1);
