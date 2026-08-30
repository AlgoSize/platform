#!/usr/bin/env node
// check-bindings — refuse to deploy an environment whose bindings are placeholders.
//
// wrangler.toml carries placeholder ids for every staging binding:
//
//   D1  DB        00000000-0000-0000-0000-00000000stg1
//   KV  SESSIONS  0000000000000000000000000000stg1
//   KV  USERS     0000000000000000000000000000stg2
//
// None is a real Cloudflare resource. `wrangler deploy --env staging` does not
// treat that as an error — it deploys a Worker whose storage points at nothing,
// and the failure surfaces later as runtime errors on a URL that looks live.
// The deploy workflow accepts `staging` from a branch push or a manual
// dispatch, so this is reachable today, not hypothetical.
//
// A placeholder is a promise that someone will come back. This makes the
// promise enforceable: the deploy stops here, naming the bindings and the
// commands that create them, instead of succeeding into a broken environment.
//
// Usage:  node scripts/check-bindings.mjs <environment>
// Exit:   0 = every binding has a real id; 1 = placeholders found; 2 = usage error

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));

// A placeholder is an id whose meaningful characters are all zeros. Real
// Cloudflare ids are hex from a real generator and never look like this; the
// trailing tag ("stg1") is how a human labelled the gap it left behind.
export const PLACEHOLDER_RE = /^0{8,}(-0{4,}){0,4}-?[a-z0-9]{0,8}$/i;

export function isPlaceholderId(id) {
  const v = String(id || "").trim();
  if (!v) return false;
  // Strip the conventional hyphens of a UUID, then ask whether anything but
  // zeros and a short human tag is left. `00000000-0000-0000-0000-00000000stg1`
  // → `000000000000000000000000000000stg1`, which is zeros plus "stg1".
  const bare = v.replace(/-/g, "");
  return /^0+[a-z0-9]{0,8}$/i.test(bare) && /^0{8,}/.test(bare);
}

/**
 * Every `id`/`database_id` declared for one environment.
 *
 * `envName` may be DEFAULT_ENV, which means the top-level blocks — the ones
 * that apply when `wrangler deploy` is run with no `--env`. Those were missed
 * by the first version of this script, and they matter more than the named
 * ones: the default D1 id in wrangler.toml IS a placeholder
 * (00000000-0000-0000-0000-000000000000), because local dev uses an in-memory
 * SQLite and never reads it. A bare `wrangler deploy` would therefore have
 * sailed past a check whose entire purpose is to stop exactly that.
 *
 * Deliberately a line scanner rather than a TOML parser: this runs in the
 * deploy workflow before dependencies are guaranteed to be installed, and the
 * shape it needs — a table header, then key = "value" — is unambiguous in the
 * subset wrangler.toml actually uses.
 */
export const DEFAULT_ENV = "(default)";

export function bindingsForEnv(toml, envName) {
  const isDefault = envName === DEFAULT_ENV;
  // Named env: [[env.staging.kv_namespaces]]. Default env: [[kv_namespaces]],
  // and anything under an [env.*] header must NOT count — that is another
  // environment's configuration, and mixing them is how a gate passes the
  // wrong ids.
  const named = new RegExp(`^\\[+env\\.${envName}\\.([a-z0-9_]+)\\]+`, "i");
  const topLevel = /^\[+([a-z0-9_]+)\]+/i;
  const anyEnv = /^\[+env\./i;
  const out = [];
  let section = null;
  let binding = null;

  for (const raw of toml.split("\n")) {
    const line = raw.replace(/\s+#.*$/, "").trim();
    if (!line) continue;

    if (line.startsWith("[")) {
      if (isDefault) {
        const m = anyEnv.test(line) ? null : topLevel.exec(line);
        section = m ? m[1].toLowerCase() : null;
      } else {
        const m = named.exec(line);
        section = m ? m[1].toLowerCase() : null;
      }
      binding = null;
      continue;
    }
    if (!section) continue;

    const kv = /^([a-z_]+)\s*=\s*"([^"]*)"/i.exec(line);
    if (!kv) continue;
    const [, key, value] = kv;

    if (key === "binding") binding = value;
    if (key === "id" || key === "database_id") {
      out.push({ section, binding: binding || "(unnamed)", key, value });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// CLI. Guarded so the module can be imported by the test suite without the
// argv parsing below running on import and exiting the process.
// ---------------------------------------------------------------------------

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) main();

function main() {
// No argument means the default environment, mirroring `wrangler deploy` with
// no --env. Refusing to run without a name would have left the one
// unprotected path unprotected.
const envName = process.argv[2] || DEFAULT_ENV;

const toml = readFileSync(join(HERE, "..", "wrangler.toml"), "utf8");
const bindings = bindingsForEnv(toml, envName);

if (!bindings.length) {
  // Never silently pass an environment we could not read. An empty result is
  // "we did not find the section", which is not the same as "it is clean" —
  // the whole point of this check is that unmeasured must not read as fine.
  console.error(`check-bindings: no [env.${envName}.*] binding ids found in wrangler.toml.`);
  console.error("Either the environment name is wrong or the file layout changed; refusing to pass it as clean.");
  process.exit(1);
}

const placeholders = bindings.filter((b) => isPlaceholderId(b.value));

if (!placeholders.length) {
  console.log(`check-bindings: ${bindings.length} binding id(s) for env.${envName}, none are placeholders.`);
  process.exit(0);
}

console.error(`\ncheck-bindings: env.${envName} has ${placeholders.length} placeholder binding id(s).\n`);
for (const b of placeholders) {
  console.error(`  ${b.section.padEnd(14)} ${b.binding.padEnd(10)} ${b.value}`);
}
console.error(`
Deploying would create a Worker whose storage points at resources that do not
exist. Create them, paste the printed ids into wrangler.toml, and commit:

  cd worker
  ./node_modules/.bin/wrangler d1 create algosize-${envName} --config wrangler.toml
  ./node_modules/.bin/wrangler kv namespace create SESSIONS --config wrangler.toml --env ${envName}
  ./node_modules/.bin/wrangler kv namespace create USERS    --config wrangler.toml --env ${envName}

DEPLOY.md §7.1 documents the same sequence.
`);
process.exit(1);
}
