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

import { readFileSync } from "node:fs";
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

  const dir = site.assets && site.assets.directory;
  expect(Boolean(dir), "it declares an assets directory");

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

  // A preview that renders differently from what GitHub Pages serves is worse
  // than no preview: it invites decisions about a build nobody ships.
  const workflow = readFileSync(
    join(__dirname, "..", "..", ".github", "workflows", "jekyll.yml"), "utf8");
  for (const flag of ["_config.yml,_config.production.yml", "JEKYLL_ENV"]) {
    expect(cmd.includes(flag) && workflow.includes(flag),
      `the preview build and the Pages build agree on ${flag}`);
  }
}

// ---------------------------------------------------------------------------
console.log(failures === 0
  ? "\n\x1b[32mAll wrangler-config tests passed\x1b[0m\n"
  : `\n\x1b[31m${failures} wrangler-config test(s) failed\x1b[0m\n`);
process.exit(failures === 0 ? 0 : 1);
