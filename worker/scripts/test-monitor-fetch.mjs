// What the sweep asks GitHub for, and how it reports being refused.
//
// The scorecard went blank for a reason that never appeared in any test: the
// sweep listed the SAME git tree three times per monitor per hourly tick —
// once for the dependency audit, once for the source scanner, once for the
// X-ray — against an anonymous 60-requests-per-hour-per-IP budget shared
// across every Worker on Cloudflare's egress. Roughly twenty monitors an hour
// deployment-wide exhausted it, after which every cell downstream read
// "NOT MEASURED · GitHub rate-limited the request".
//
// No assertion could have caught that, because nothing counted requests. So
// the first group here counts them. The number is the point: it read 3 before
// this change and must read 1 after, and if it ever climbs back the suite says
// so rather than a customer noticing a blank grid.
//
// Run with:  node scripts/test-monitor-fetch.mjs

import { fetchRepoTree, fetchRawFile, ghHeaders, newTreeCache } from "../src/github.js";
import { discoverArchFiles, runArchForMonitor } from "../src/monitors/analyzers.js";
import { explainUnavailable, fixUnavailable, NOT_APPLICABLE_REASONS } from "../src/handlers/monitors.js";

let failures = 0;
const ok = (m) => console.log(`  \x1b[32m✓\x1b[0m ${m}`);
const fail = (m) => { console.log(`  \x1b[31m✗\x1b[0m ${m}`); failures++; };
const expect = (cond, label) => (cond ? ok(label) : fail(label));
const group = (name) => console.log(`\n\x1b[1m${name}\x1b[0m\n`);

// ---------------------------------------------------------------------------
// A fetch that records every call, so the tests can assert on traffic rather
// than only on results.
// ---------------------------------------------------------------------------
function recordingFetch({ tree = null, status = 200, raw = "x" } = {}) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, headers: (init && init.headers) || null });
    const isTree = url.includes("api.github.com");
    if (isTree) {
      if (status !== 200) {
        return { ok: false, status, json: async () => ({}), text: async () => "" };
      }
      return {
        ok: true, status: 200,
        json: async () => ({ tree: tree || [] }),
        text: async () => "",
      };
    }
    return { ok: true, status: 200, text: async () => raw, json: async () => ({}) };
  };
  impl.calls = calls;
  impl.treeCalls = () => calls.filter((c) => c.url.includes("api.github.com"));
  impl.rawCalls = () => calls.filter((c) => c.url.includes("raw.githubusercontent.com"));
  return impl;
}

const TREE = [
  { type: "blob", path: "package.json", size: 100 },
  { type: "blob", path: "worker/wrangler.toml", size: 100 },
];

// ===========================================================================
group("one tree listing per sweep, not three");
// ===========================================================================
{
  // The cache is what makes three analyzers cost one request. Without it each
  // caller pays again for an answer it already has.
  const f = recordingFetch({ tree: TREE });
  const cache = newTreeCache();
  const repo = { owner: "acme", repo: "api", branch: "main" };

  const a = await fetchRepoTree(repo, f, {}, cache);
  const b = await fetchRepoTree(repo, f, {}, cache);
  const c = await fetchRepoTree(repo, f, {}, cache);

  expect(f.treeCalls().length === 1,
    `three analyzers sharing a sweep cache cost ONE tree listing (got ${f.treeCalls().length})`);
  expect(a.entries === b.entries && b.entries === c.entries,
    "and every caller gets the same answer, not a re-fetch");

  // The old behaviour, kept as a contrast so the number above means something.
  const bare = recordingFetch({ tree: TREE });
  await fetchRepoTree(repo, bare, {}, null);
  await fetchRepoTree(repo, bare, {}, null);
  await fetchRepoTree(repo, bare, {}, null);
  expect(bare.treeCalls().length === 3,
    "without a cache the same three calls cost three listings — the behaviour this replaces");

  // A cache must not leak between repositories.
  const f2 = recordingFetch({ tree: TREE });
  const shared = newTreeCache();
  await fetchRepoTree({ owner: "acme", repo: "api", branch: "main" }, f2, {}, shared);
  await fetchRepoTree({ owner: "acme", repo: "other", branch: "main" }, f2, {}, shared);
  expect(f2.treeCalls().length === 2,
    "two different repositories are two listings — the cache keys on the repo");
}

// ===========================================================================
group("every request carries the token, including raw content");
// ===========================================================================
{
  const env = { GITHUB_TOKEN: "ghp_testtoken" };

  const f = recordingFetch({ tree: TREE });
  await fetchRepoTree({ owner: "a", repo: "b", branch: "main" }, f, env, null);
  await fetchRawFile({ owner: "a", repo: "b", branch: "main", path: "package.json" }, f, env);

  const authed = f.calls.filter((c) => c.headers && c.headers.Authorization);
  expect(authed.length === f.calls.length,
    `every request sends Authorization when the token is set (${authed.length}/${f.calls.length})`);

  // This is the specific regression. Raw content outnumbers tree listings
  // roughly fifty to one, and every one of those used to go out bare, so
  // setting the token fixed about a fifth of the traffic.
  expect(f.rawCalls().every((c) => c.headers && c.headers.Authorization),
    "raw.githubusercontent.com requests are authenticated too, not just the API");

  expect(ghHeaders(env).Authorization === "Bearer ghp_testtoken",
    "the header is a bearer token in the shape GitHub expects");
}

{
  // Unset must behave exactly as before — anonymous, not broken.
  const f = recordingFetch({ tree: TREE });
  await fetchRepoTree({ owner: "a", repo: "b", branch: "main" }, f, {}, null);
  await fetchRawFile({ owner: "a", repo: "b", branch: "main", path: "x" }, f, {});
  expect(f.calls.every((c) => !c.headers || !c.headers.Authorization),
    "with no token set, no Authorization header is sent at all");
  expect(!("GITHUB_TOKEN" in ghHeaders({})),
    "and the token name never leaks into the headers");
}

// ===========================================================================
group("a refusal says whose problem it is");
// ===========================================================================
{
  for (const [status, field, label] of [
    [403, "throttled", "403 is throttling"],
    [429, "throttled", "429 is throttling"],
    [503, "throttled", "a 5xx is throttling"],
    [401, "unauthorized", "401 is OUR token being rejected"],
    [404, "unavailable", "404 is the repository not being there"],
  ]) {
    const f = recordingFetch({ status });
    const r = await fetchRepoTree({ owner: "a", repo: "b", branch: "main" }, f, {}, null);
    expect(r[field] === true, `${label} → { ${field}: true }`);
  }

  // Same outcome, different cause — and one caller acts on the difference.
  for (const [status, expected] of [[403, 403], [429, 429], [503, 503]]) {
    const f = recordingFetch({ status });
    const r = await fetchRepoTree({ owner: "a", repo: "b", branch: "main" }, f, {}, null);
    expect(r.status === expected,
      `a throttled listing carries its status (${status}), so a quota refusal and ` +
      "a broken API are not the same answer");
  }

  // The bug this closes: a 401 used to fall through the same branch as a 404,
  // so an expired deployment token made every repository on the platform read
  // as though it did not exist.
  const f = recordingFetch({ status: 401 });
  const r = await fetchRepoTree({ owner: "a", repo: "b", branch: "main" }, f, {}, null);
  expect(!r.unavailable, "a rejected token is NOT reported as a missing repository");
}

{
  // A throttled sweep must leave the baseline alone. If it moved, one bad
  // hour would report the whole codebase as new the next time it succeeded.
  const f = recordingFetch({ status: 403 });
  const monitor = { monitorId: "m1", repoUrl: "https://github.com/a/b", branch: "main" };
  const arch = await runArchForMonitor(monitor, {}, f);
  expect(arch.status === "skipped" && arch.reason === "github_throttled",
    "a throttled architecture sweep skips with github_throttled");

  const f401 = recordingFetch({ status: 401 });
  const arch401 = await runArchForMonitor(monitor, {}, f401);
  expect(arch401.status === "skipped" && arch401.reason === "github_unauthorized",
    "and a rejected token skips with github_unauthorized, not no_manifests");
}

// ===========================================================================
group("a broken tree API does not cancel the fallback that could still work");
// ===========================================================================
{
  // api.github.com and raw.githubusercontent.com are separate services. When
  // the tree listing 5xxes, the root-name fetch is still worth trying — and
  // the audit that comes back from it, shallower but real, beats an error.
  //
  // A quota refusal is the opposite: raw draws on the SAME budget, so trying
  // it only spends requests to fail identically. Both used to be one branch.
  const { runLockfileAudit } = await import("../src/handlers/analyze.js");

  const treeBroken = async (url) => {
    if (url.includes("api.github.com")) {
      return { ok: false, status: 502, json: async () => ({}), text: async () => "" };
    }
    if (url.includes("package-lock.json")) {
      return { ok: true, status: 200, text: async () => JSON.stringify({
        lockfileVersion: 3,
        packages: { "node_modules/left-pad": { version: "1.3.0" } },
      }), json: async () => ({}) };
    }
    if (url.includes("osv.dev")) {
      return { ok: true, status: 200, json: async () => ({ results: [{ vulns: [] }] }),
               text: async () => "{}" };
    }
    return { ok: false, status: 404, text: async () => "", json: async () => ({}) };
  };

  const res = await runLockfileAudit(
    { repoUrl: "https://github.com/a/b" }, { FETCH: treeBroken }, null, null);
  expect(res.status === 200,
    `a 5xx on the tree listing still audits the root lockfile (got ${res.status})`);

  const throttled = async (url) => {
    if (url.includes("api.github.com")) {
      return { ok: false, status: 403, json: async () => ({}), text: async () => "" };
    }
    return { ok: false, status: 404, text: async () => "", json: async () => ({}) };
  };
  const res2 = await runLockfileAudit(
    { repoUrl: "https://github.com/a/b" }, { FETCH: throttled }, null, null);
  const body2 = await res2.json();
  expect(res2.status === 503 && body2.error === "github_rate_limited",
    `a quota refusal says so rather than reporting no lockfiles (got ${res2.status} ${body2.error})`);
}

// ===========================================================================
group("a column with nothing to measure does not read as a failure");
// ===========================================================================
{
  // Two of the six scorecard columns on our own repository will never have
  // anything to measure: there is no docker-compose.yml to price and no AWS
  // cost export to read, because this runs on Cloudflare. Rendering those
  // identically to a column that tried and failed is the same mistake the
  // compliance catalog already refuses to make between "not covered" and
  // "insufficient evidence".
  const naReasons = ["no_compose", "no_cur", "no_config", "no_manifests", "no_source_files"];
  for (const r of naReasons) {
    expect(NOT_APPLICABLE_REASONS.has(r), `${r} is classified not-applicable`);
  }

  const failures_ = ["github_throttled", "github_unauthorized", "sandbox_unreachable",
                     "sandbox_not_configured", "source_unreadable", "config_invalid",
                     "budget_invalid", "cur_missing", "no_entries_ran"];
  const misfiled = failures_.filter((r) => NOT_APPLICABLE_REASONS.has(r));
  expect(misfiled.length === 0,
    "a transient failure or a broken config is NOT not-applicable" +
    (misfiled.length ? ` — misfiled: ${misfiled.join(", ")}` : ""));

  // I first asserted the opposite here — that a not-applicable reason should
  // carry no remedy, on the theory that there is nothing to fix. Reading the
  // remedies disproved it: "Commit a docker-compose.yml, or point `compose` in
  // algosize.budget.json at the one you already use" is exactly what a reader
  // with a compose stack elsewhere needs. Not-applicable means nothing to
  // measure HERE, not nothing the reader could ever do, so the guidance stays.
  // What changes is the visual state and the absence of an implied failure.
  const withoutFix = naReasons.filter((r) => !fixUnavailable(r));
  expect(withoutFix.length === 0,
    "every not-applicable reason still says what would make the column measurable" +
    (withoutFix.length ? ` — missing on ${withoutFix.join(", ")}` : ""));

  expect(naReasons.every((r) => explainUnavailable(r).length > 20),
    "and each says, in its own words, why there is nothing to measure today");

  expect(explainUnavailable("github_unauthorized").includes("our side") ||
         explainUnavailable("github_unauthorized").includes("deployment"),
    "and a rejected token names itself as our problem, not the customer's");
}

// ===========================================================================
console.log();
if (failures === 0) {
  console.log("\x1b[32m  all monitor-fetch tests passed\x1b[0m\n");
  process.exit(0);
} else {
  console.log(`\x1b[31m  ${failures} monitor-fetch test(s) failed\x1b[0m\n`);
  process.exit(1);
}
