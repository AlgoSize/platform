// Operator-facing configuration checks: the sandbox probe and the three-state
// error-reporting row. Both exist so a question about production stops being
// answerable only from a Cloudflare dashboard.
import { adminSandboxCheckHandler } from "../src/handlers/admin.js";
import { adminSettingsHandler } from "../src/handlers/admin_panel.js";

let failures = 0;
const expect = (cond, label) => {
  if (cond) console.log(`  \x1b[32m✓\x1b[0m ${label}`);
  else { failures++; console.log(`  \x1b[31m✗\x1b[0m ${label}`); }
};

const req = { user: { email: "admin@algosize.com" } };
const call = async (env) => (await adminSandboxCheckHandler(req, env)).json();

// A sandbox stub whose /run behaviour we choose per case.
const sandbox = (impl) => ({ fetch: impl });
const ok = sandbox(async (_url, init) => {
  const { code, input } = JSON.parse(init.body);
  // Actually honour the contract: compile and run, so a probe that stops
  // proving anything fails here rather than passing on a canned 2.
  const fn = new Function(`${code}; return run;`)();
  return new Response(JSON.stringify({ ok: true, sampleResult: fn(input) }), { status: 200 });
});

console.log("\nthe sandbox probe distinguishes all four states\n");

{
  const r = await call({});
  expect(r.state === "not_bound" && r.ok === false, "no binding → not_bound");
  expect(/optimizer cannot grade/i.test(r.impact), "…and names the consequence, not just the fact");
  expect(/algosize-sandbox/.test(r.fix), "…and the remedy names the service to deploy");
}
{
  const r = await call({ SANDBOX: ok });
  expect(r.state === "bound_and_working" && r.ok === true, "working service → bound_and_working");
  expect(typeof r.elapsedMs === "number", "…with a round-trip time, so a slow sandbox is visible");
}
{
  const r = await call({ SANDBOX: sandbox(async () => { throw new Error("no route to host"); }) });
  expect(r.state === "unreachable", "throwing service → unreachable");
  expect(/no route to host/.test(r.message), "…quoting what the binding actually said");
}
{
  const r = await call({ SANDBOX: sandbox(async () => new Response("<html>", { status: 200 })) });
  expect(r.state === "bad_response", "non-JSON 200 → bad_response, not success");
}
{
  // The production failure this endpoint exists for: the service answers 200
  // but cannot execute. Reporting that as healthy because HTTP said 200 would
  // reproduce the original bug one layer up.
  const refuses = sandbox(async () => new Response(JSON.stringify({
    ok: false, error: "compile_error",
    message: "Code generation from strings disallowed for this context",
  }), { status: 200 }));
  const r = await call({ SANDBOX: refuses });
  expect(r.state === "bad_response" && r.ok === false,
    "a 200 carrying ok:false is NOT healthy — the exact production failure");
  expect(/code generation from strings/i.test(r.message),
    "…and surfaces the refusal verbatim");
}
{
  const wrong = sandbox(async () => new Response(JSON.stringify({ ok: true, sampleResult: 99 }), { status: 200 }));
  const r = await call({ SANDBOX: wrong });
  expect(r.state === "bad_response", "a wrong answer to the probe is not success either");
}

console.log("\nerror reporting has three states, not two\n");

const settings = async (env) => {
  const res = await adminSettingsHandler({ user: { email: "a@b.c" } }, env);
  const body = await res.json();
  return body.connections.find((c) => c.name === "Error reporting");
};

{
  const row = await settings({ ADMIN_EMAILS: "a@b.c" });
  expect(row.configured === false && row.missing.includes("SENTRY_DSN"),
    "nothing set → not configured, SENTRY_DSN listed as missing");
}
{
  const row = await settings({ ADMIN_EMAILS: "a@b.c", SENTRY_DSN: "https://k@o.ingest.sentry.io/1" });
  expect(row.configured === true && row.missing.length === 0 && /events are being sent/.test(row.detail),
    "DSN set → configured, nothing missing");
}
{
  const row = await settings({ ADMIN_EMAILS: "a@b.c", ERROR_REPORTING: "console" });
  expect(row.configured === true, "deliberate opt-out reads as a decision, not an oversight");
  expect(row.missing.length === 0, "…so SENTRY_DSN is no longer reported as missing");
  expect(/deliberately/i.test(row.detail), "…and the detail says the choice was made");
  expect(/not durable/i.test(row.note || ""), "…while still stating the cost of the choice");
}
{
  // The opt-out must not be able to hide a real DSN, and must not fire on a
  // value that merely mentions the word.
  const row = await settings({ ADMIN_EMAILS: "a@b.c", ERROR_REPORTING: "console-ish" });
  expect(row.configured === false, "an unrecognised ERROR_REPORTING value does not count as opting out");
}

console.log("\nthe sandbox row is testable from the settings panel\n");
{
  const res = await adminSettingsHandler({ user: { email: "a@b.c" } }, { ADMIN_EMAILS: "a@b.c", SANDBOX: ok });
  const body = await res.json();
  const row = body.connections.find((c) => c.name === "Measurement sandbox");
  expect(row && row.testEndpoint === "/api/admin/sandbox-check",
    "the panel offers a Test button wired to the probe endpoint");
  expect(body.environment.bindings.some((b) => b.name === "SANDBOX" && b.set === true),
    "…and the binding table still reports presence separately from reachability");
}

console.log("\nan unbound sandbox announces itself without being asked\n");
{
  const { adminOverviewHandler } = await import("../src/handlers/admin_panel.js");
  const { makeD1 } = await import("./_d1-stub.mjs");

  const overviewAlerts = async (env) => {
    const res = await adminOverviewHandler({ user: { email: "a@b.c" } },
      { ADMIN_EMAILS: "a@b.c", DB: makeD1(), ...env });
    const body = await res.json();
    return body.alerts || [];
  };

  const without = await overviewAlerts({});
  expect(without.some((a) => /measurement sandbox is not bound/i.test(a.text)),
    "with no binding, the overview raises it unprompted — the button is not the only way to find out");
  expect(without.some((a) => /measurement sandbox/i.test(a.text) && a.to === "settings"),
    "…and points at the settings section where the Test button lives");

  const withIt = await overviewAlerts({ SANDBOX: ok });
  expect(!withIt.some((a) => /measurement sandbox/i.test(a.text)),
    "with a binding, it says nothing — an alert that is always on is not an alert");
}

console.log("\nthe binding preflight covers the DEFAULT environment too\n");
{
  const { bindingsForEnv, isPlaceholderId, DEFAULT_ENV } =
    await import("./check-bindings.mjs");
  const { readFileSync } = await import("node:fs");
  const toml = readFileSync(new URL("../wrangler.toml", import.meta.url), "utf8");

  // `wrangler deploy` with no --env uses the top-level blocks, and the
  // default D1 id in this repo IS a placeholder. The first version of the
  // script only matched [env.<name>.*], so that path was unchecked — the one
  // case the gate most needed to catch.
  const dflt = bindingsForEnv(toml, DEFAULT_ENV);
  expect(dflt.length > 0, `the default environment declares ${dflt.length} binding id(s)`);
  expect(dflt.some((b) => isPlaceholderId(b.value)),
    "…and at least one is a placeholder, so a bare `wrangler deploy` is blocked");

  // The default reader must not absorb a named environment's bindings. Note
  // that default and production DO legitimately share their KV ids — this
  // repo's production block only overrides D1 — so "no ids in common" would
  // be a false premise. The D1 id is where they differ, and that difference
  // is what proves the two sections are read separately rather than merged.
  const prod = bindingsForEnv(toml, "production");
  const dbOf = (set) => (set.find((b) => b.binding === "DB") || {}).value;
  expect(dbOf(dflt) && dbOf(prod) && dbOf(dflt) !== dbOf(prod),
    `default DB (${dbOf(dflt)}) is read separately from production DB (${dbOf(prod)})`);
  expect(isPlaceholderId(dbOf(dflt)) && !isPlaceholderId(dbOf(prod)),
    "…and only the default one is a placeholder, which is the whole point");

  const staging = bindingsForEnv(toml, "staging");
  expect(dbOf(staging) !== dbOf(dflt) && dbOf(staging) !== dbOf(prod),
    "staging's DB is a third distinct value — no section bleeds into another");
}

console.log("\nERROR_REPORTING is documented where a reviewer will see it\n");
{
  const { readFileSync } = await import("node:fs");
  const toml = readFileSync(new URL("../wrangler.toml", import.meta.url), "utf8");
  // A policy decision belongs in [vars], in the diff — not in the secret
  // store where the people it informs cannot see it.
  //
  // Either form satisfies this: commented means the decision is still open
  // and the option is documented; uncommented means it was made. What must
  // NOT happen is the var going missing, or being set live with the rationale
  // stripped — which is exactly what a deploy-time-only change produces. The
  // setting was uncommented on 2026-09-02, and this assertion had to widen
  // rather than be deleted, because its subject is the rationale, not the
  // comment marker.
  expect(/^#?\s*ERROR_REPORTING\s*=\s*"console"/m.test(toml),
    "wrangler.toml carries the var, commented or set, with its rationale");
  // Window around the var, not forward-only: the rationale is written above
  // it, so a forward search misses it.
  const at = toml.search(/^#?\s*ERROR_REPORTING\s*=\s*"console"/m);
  const window = toml.slice(Math.max(0, at - 1600), at + 200);
  expect(/not durable/.test(window),
    "…and states the cost of choosing console-only, right beside it");
  // The rationale wraps across comment lines, so match it with the line
  // breaks and leading `#` collapsed out rather than as one literal string.
  const flat = window.replace(/\n\s*#\s*/g, " ");
  expect(/policy\s+choice, not a credential/.test(flat),
    "…and says why it is a var rather than a secret");
}

console.log("\nthe optimizer CLI does not build a shell string from --base\n");
{
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("./optimizer-ci.mjs", import.meta.url), "utf8");

  // A git branch name may legally contain ; $ & | and backticks, so `--base`
  // interpolated into a shell string was a command-injection primitive. No
  // workflow passes --base today, which is the only reason it was not
  // reachable; the usage line advertises it and wiring it to a CI ref is the
  // obvious next step.
  expect(!/execSync\s*\(/.test(src),
    "no execSync anywhere — a shell string is the whole hazard");
  expect(/execFileSync\("git", \["diff", "--name-only"/.test(src),
    "git is invoked with an argument array, so there is no shell to inject into");
  expect(!/`git [^`]*\$\{/.test(src),
    "no template literal builds a git command line from a variable");
}

console.log("\nthe analyzer says which build answered, from a fact not a guess\n");

{
  const { analyzerVersion } = await import("../src/analyzer-version.js");
  const { readFileSync } = await import("node:fs");
  const toml = readFileSync(new URL("../wrangler.toml", import.meta.url), "utf8");

  // The binding has to be declared in BOTH environments. Bindings are not
  // inherited from the top level into a named environment, so a config that
  // declares it once gives local dev a real version and production the
  // fallback — the one place the answer matters least being the only place
  // it is right.
  expect(/^\[version_metadata\]\s*\nbinding = "CF_VERSION_METADATA"/m.test(toml),
    "wrangler.toml declares the version metadata binding");
  expect(/^\[env\.production\.version_metadata\]\s*\nbinding = "CF_VERSION_METADATA"/m.test(toml),
    "…and again under [env.production], because bindings do not inherit");

  // The binding wins over the env var. This is the whole point: RELEASE_TAG
  // is set by nothing, so a resolver that preferred it would keep reporting
  // "unreleased" on every deploy that has a real version to report.
  expect(analyzerVersion({ CF_VERSION_METADATA: { id: "e864bf3d-f693-4c3d" },
                           RELEASE_TAG: "would-be-wrong" }) === "e864bf3d",
    "the deployment version wins over RELEASE_TAG");
  expect(analyzerVersion({ CF_VERSION_METADATA: { id: "abcdef01", tag: "v2.4.1" } }) === "v2.4.1",
    "…and a hand-set version tag wins over the id, being the meaningful one");

  // The env vars stay as a fallback: staging already sets one, and a runtime
  // without the binding must not lose provenance it does have.
  expect(analyzerVersion({ RELEASE_TAG: "staging-7" }) === "staging-7",
    "RELEASE_TAG still answers when there is no binding");
  expect(analyzerVersion({ RELEASE: "legacy" }) === "legacy",
    "…as does the older RELEASE name");

  // Never blank. A provenance field rendered as an empty string reads as a
  // rendering bug; "unreleased" is a claim a reader can act on.
  for (const [label, env] of [
    ["no env at all", undefined],
    ["empty env", {}],
    ["binding present but empty", { CF_VERSION_METADATA: {} }],
    ["binding with blank strings", { CF_VERSION_METADATA: { id: "  ", tag: " " } }],
    ["blank RELEASE_TAG", { RELEASE_TAG: "   " }],
  ]) {
    expect(analyzerVersion(env) === "unreleased", `${label} → "unreleased", never ""`);
  }
}

console.log("");
if (failures === 0) {
  console.log("\x1b[32m  all ops-check tests passed\x1b[0m\n");
  process.exit(0);
}
console.log(`\x1b[31m  ${failures} ops-check test(s) failed\x1b[0m\n`);
process.exit(1);
