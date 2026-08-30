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

console.log("");
if (failures === 0) {
  console.log("\x1b[32m  all ops-check tests passed\x1b[0m\n");
  process.exit(0);
}
console.log(`\x1b[31m  ${failures} ops-check test(s) failed\x1b[0m\n`);
process.exit(1);
