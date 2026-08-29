// The structural guarantee the whole MCP design rests on.
//
// Every tool must reach the product through `callHandler` and through nothing
// else, so that quota, entitlement and org scoping are decided in exactly one
// place. That is a property of the IMPORTS, which means it can be checked
// mechanically instead of trusted — and this is the check.
//
// It matters because the failure it prevents is invisible. A tool that
// imported an analyzer directly would work perfectly in every functional test:
// correct output, correct shape, no error. It would simply never charge a run.
// Nobody notices free analyses until the bill does not add up.
//
// Note on chains.js: it is the one module allowed to import handlers and
// enforceQuota, and it lives OUTSIDE tools/ precisely so this test can stay
// absolute about what tools/ may touch. A tool asks chains.js for a route's
// middleware and cannot construct its own, so it cannot drop the quota wrapper.

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TOOLS_DIR = join(__dirname, "..", "src", "mcp", "tools");

let failures = 0;
const ok   = (m) => console.log(`  \x1b[32m✓\x1b[0m ${m}`);
const fail = (m) => { console.log(`  \x1b[31m✗\x1b[0m ${m}`); failures++; };
const expect = (c, l) => (c ? ok(l) : fail(l));
const group  = (n) => console.log(`\n\x1b[1m${n}\x1b[0m\n`);

// Each rule is a pattern plus the reason it exists, so a failure explains
// itself rather than printing a regex at whoever tripped it.
const FORBIDDEN = [
  {
    re: /\benforceQuota\b/,
    why: "quota is applied by the chain in mcp/chains.js; a tool that touches enforceQuota can also omit it",
  },
  {
    re: /from\s+["'][^"']*\/entitlement\.js["']/,
    why: "plan gating belongs in handlers/mcp.js, once, not per tool",
  },
  {
    re: /from\s+["'][^"']*\/analyzers\//,
    why: "a tool that imports an analyzer bypasses the metered route entirely",
  },
  {
    re: /from\s+["'][^"']*\/handlers\//,
    why: "handlers are reached through callHandler with the route's real chain, never directly",
  },
  {
    re: /\benv\s*\.\s*DB\b/,
    why: "raw SQL in a tool is how an org_id filter goes missing — a cross-tenant leak",
  },
  {
    re: /\benv\s*\.\s*(SESSIONS|USERS|REPORTS|SCAN_QUEUE|USAGE|AI|SANDBOX)\b/,
    why: "a tool must not reach a binding directly; the handler behind callHandler owns that",
  },
];

group("no file under mcp/tools/ can bypass callHandler");

const files = readdirSync(TOOLS_DIR).filter((f) => f.endsWith(".js"));
expect(files.length >= 4, `found ${files.length} tool file(s) to check`);

for (const file of files) {
  const src = readFileSync(join(TOOLS_DIR, file), "utf8");
  // Strip comments before matching. The rules are about what the code DOES,
  // and this file's own prose names several of the forbidden identifiers —
  // a checker that flagged its own explanation would be unusable.
  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n").map((l) => l.replace(/\/\/.*$/, "")).join("\n");

  for (const rule of FORBIDDEN) {
    expect(!rule.re.test(code), `${file} — ${rule.why}`);
  }
}

group("every tool routes through callHandler");

for (const file of files) {
  if (file.startsWith("_") || file === "index.js") continue;
  const src = readFileSync(join(TOOLS_DIR, file), "utf8");
  expect(/import\s*\{[^}]*\bcallHandler\b[^}]*\}\s*from\s*["']\.\.\/dispatch\.js["']/.test(src),
    `${file} imports callHandler from mcp/dispatch.js`);
}

group("metering cannot lie");
{
  // A tool claiming `metered: true` must actually run through a chain that
  // contains enforceQuota, and one claiming false must not. Declared
  // independently they would drift, and the drift is only visible on an
  // invoice — so the two are compared directly here.
  const { TOOLS } = await import("../src/mcp/tools/index.js");
  const { CHAINS } = await import("../src/mcp/chains.js");

  const meteredChainKeys = new Set(
    Object.entries(CHAINS).filter(([, c]) => c.metered).map(([k]) => k));
  const meteredPaths = new Set(
    Object.values(CHAINS).filter((c) => c.metered).map((c) => c.path));

  expect(meteredChainKeys.size === 5,
    `exactly five routes carry enforceQuota (found ${meteredChainKeys.size}: ${[...meteredChainKeys].join(", ")})`);

  // The two the original plan had wrong. index.js registers /api/fix as
  // `analyzeRateLimit, requireAuth, generateFixHandler` and
  // /api/monitors/:id/run behind requireAuth alone — neither has enforceQuota,
  // so neither tool may claim to consume a run.
  expect(!meteredPaths.has("/api/fix"),
    "/api/fix is not metered — it explains a finding already paid for");
  expect(!meteredPaths.has("/api/monitors/:id/run"),
    "/api/monitors/:id/run is not metered at the route level");

  const meteredToolNames = TOOLS.filter((t) => t.metered).map((t) => t.name).sort();
  expect(meteredToolNames.length === 5,
    `five tools declare metered:true (found ${meteredToolNames.length})`);

  // Any tool that says it costs a run must say so in its description too. A
  // model reads the description, not the flag.
  for (const t of TOOLS.filter((x) => x.metered)) {
    expect(/CONSUMES ONE RUN/.test(t.description),
      `${t.name} tells the model it consumes a run`);
  }
  for (const t of TOOLS.filter((x) => !x.metered)) {
    expect(!/CONSUMES ONE RUN/.test(t.description),
      `${t.name} does not falsely claim to consume a run`);
  }
}

group("the dangerous surfaces have no tool at all");
{
  const { TOOLS } = await import("../src/mcp/tools/index.js");
  const { CHAINS } = await import("../src/mcp/chains.js");
  const paths = Object.values(CHAINS).map((c) => c.path);

  // Absent, not scope-gated. A scope check is code that can be wrong; a route
  // with no adapter cannot be reached however wrong the scope logic gets.
  for (const forbidden of ["/api/keys", "/api/billing", "/api/account", "/api/org",
                           "/api/admin", "/api/checkout", "/api/auth", "/api/_test/seed"]) {
    expect(!paths.some((p) => p.startsWith(forbidden)),
      `no chain reaches ${forbidden}*`);
  }
  expect(!TOOLS.some((t) => /key|billing|invoice|member|invite|admin|checkout/i.test(t.name)),
    "no tool is even named after a credential, billing or membership operation");
}

group("enums copied into tools/ cannot drift from the handler's own list");
{
  // tools/ may not import a handler — that is the purity rule — so two enums
  // are duplicated there as literals. A duplicated literal is only safe while
  // something compares it, and this is that something. The failure it catches
  // is a value the API accepts that no assistant can name: the capability
  // exists, is documented, and is unreachable through the surface built to
  // reach it.
  const { ANALYZERS, RUN_SOURCES } = await import("../src/handlers/runs.js");
  const { TOOLS } = await import("../src/mcp/tools/index.js");
  const listRuns = TOOLS.find((t) => t.name === "algosize_list_runs");
  const props = (listRuns && listRuns.inputSchema && listRuns.inputSchema.properties) || {};

  const same = (a, b) => a.length === b.length && a.every((x) => b.includes(x));
  expect(same([...ANALYZERS], props.analyzer.enum),
    `the analyzer enum matches handlers/runs.js (tool: ${props.analyzer.enum.join(",")})`);
  expect(same([...RUN_SOURCES], props.source.enum),
    `the source enum matches handlers/runs.js (tool: ${props.source.enum.join(",")})`);
  expect(props.source.enum.includes("monitor"),
    "…and includes monitor, without which a scheduled audit is unaskable-for");
}

console.log("");
if (failures) {
  console.log(`\x1b[31m  ${failures} mcp-purity check(s) failed\x1b[0m`);
  process.exit(1);
}
console.log("\x1b[32m  all mcp-purity checks passed\x1b[0m");
