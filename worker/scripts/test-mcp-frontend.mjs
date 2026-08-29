// The #/mcp dashboard view.
//
// Static checks in the style of test-account-frontend.mjs: the route resolves,
// the module is loaded by the page, every class it builds at runtime has a
// rule, and — the one that actually matters — no code path can render a real
// secret.
//
// That last one is why this file exists at all. The page's whole job is to
// help someone paste a credential into a config file, which is precisely the
// context where a well-meaning "here is your key, ready to copy" would be
// added and nobody would notice it was wrong.
//
// Run with:  node scripts/test-mcp-frontend.mjs

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SITE = join(__dirname, "..", "..", "site");

const read = (p) => readFileSync(join(SITE, p), "utf8");
const js     = read("assets/js/dash-mcp.js");
const router = read("assets/js/dash-router.js");
const html   = read("dashboard.html");
const css    = read("assets/css/main.css");
const workspace = read("assets/js/dash-workspace.js");

let failures = 0;
const ok   = (m) => console.log(`  \x1b[32m✓\x1b[0m ${m}`);
const fail = (m) => { console.log(`  \x1b[31m✗\x1b[0m ${m}`); failures++; };
const expect = (c, l) => (c ? ok(l) : fail(l));
const group  = (n) => console.log(`\n\x1b[1m${n}\x1b[0m\n`);

group("the view is reachable");
{
  expect(/id="view-mcp"/.test(html), "dashboard.html has the #/mcp view container");
  expect(/id="mcp-body"/.test(html), "…with a body the module renders into");
  expect(/dash-mcp\.js/.test(html), "…and the page loads dash-mcp.js");
  expect(/"mcp"/.test(router) && /h === "#\/mcp"/.test(router), "the router parses #/mcp");
  expect(/route\.view === "mcp"\s*&&\s*window\.DashMcp/.test(router),
    "…and dispatches to DashMcp.load()");
  expect(/UNDER_WORKSPACE = \[[^\]]*"mcp"/.test(router),
    "…and marks Workspace current while it is open, so neither tab reads as \"you are nowhere\"");
  expect(/route: "#\/mcp"/.test(workspace), "a Workspace card leads here");
  // The brief is explicit that this must not become a third top-level tab.
  expect(!/data-view="mcp"/.test(html),
    "it is NOT a third entry in the tab strip — it is reached from a Workspace card");
}

group("no secret can be rendered");
{
  // The config blocks must use a placeholder. A literal key in a snippet is
  // the failure this page would make most easily and hide best.
  expect(/\$\{ALGOSIZE_API_KEY\}|\$ALGOSIZE_API_KEY/.test(js),
    "config blocks reference the key as an environment variable");
  expect(!/ask_live_[A-Za-z0-9]/.test(js),
    "no literal key value appears anywhere in the module");
  // /api/keys returns prefixes, never key material — but the module must not
  // be reaching for a `.key` or `.secret` field even hopefully.
  expect(!/\bk\.key\b|\bkey\.secret\b|\.plaintext\b/.test(js),
    "the key picker reads no field that could hold key material");
  expect(/k\.prefix/.test(js), "…it renders the stored prefix instead");
  expect(/Create one in Team|Team → API keys/.test(js),
    "key creation links to Team → API keys rather than being duplicated here");
  expect(!/innerHTML/.test(js), "the module never touches innerHTML");
}

group("the catalog comes from the server, not a hard-coded copy");
{
  expect(/\/api\/mcp\/manifest/.test(js),
    "the tool list is fetched from /api/mcp/manifest");
  // A hard-coded catalog would drift the moment a tool ships. The only
  // algosize_ names allowed here are none.
  const toolNames = js.match(/algosize_[a-z_]+/g) || [];
  expect(toolNames.length === 0,
    `no tool is named in the front end (found ${toolNames.join(", ") || "none"})`);
  expect(/state\.manifest\.groups|manifest\.groups/.test(js),
    "…and it renders the server's own grouping");
}

group("states that are easy to render dishonestly");
{
  expect(/errorRate == null/.test(js),
    "a null error rate renders as \"no calls yet\", never as a reassuring 0%");
  expect(/mcp-conn-off/.test(js) && /revoked/.test(js),
    "revoked clients stay listed as history rather than disappearing");
  expect(/does not appear here/.test(js),
    "…and the empty state explains that API-key connections are not OAuth grants");
  expect(/Loading/.test(js), "each panel has a loading state");
  expect(/could not be (read|loaded)/i.test(js),
    "…and a failure state distinct from an empty one");
}

group("consequential actions");
{
  expect(/mcp-confirm/.test(js), "revoke is confirmed rather than immediate");
  expect(/stops being able to reach this organisation/.test(js),
    "…and the confirmation names what will break, not just \"are you sure\"");
  expect(/Keep it/.test(js), "…with a way out that is not the destructive one");
  expect(/btn-danger/.test(js), "…and the destructive button is weighted as such");
}

group("copying");
{
  expect(/Copied/.test(js), "copy has an explicit copied state — a silent copy reads as broken");
  expect(/execCommand\("copy"\)/.test(js),
    "…with a fallback for contexts where the async clipboard is unavailable");
}

group("every runtime-built class has a rule");
{
  // The module builds class names in JS, so the stylesheet cannot be checked
  // by reading the HTML alone — the same gap that let a whole Account section
  // ship unstyled once.
  const applied = [...new Set(
    (js.match(/class: "([^"]+)"/g) || [])
      .map((m) => m.replace(/class: "|"/g, ""))
      .flatMap((s) => s.split(/\s+/))
      .filter(Boolean)
      .filter((c) => c.startsWith("mcp-")))];
  const styled = new Set((css.match(/\.[a-zA-Z0-9_-]+/g) || []).map((s) => s.slice(1)));
  // Built by concatenation, so they never appear as a whole literal.
  // "mcp-badge-" is a bare prefix the legend concatenates a name onto, so it
  // is never a class by itself and has no rule of its own.
  const prefixes = ["mcp-badge-"];
  const dynamic = ["mcp-dot-on", "mcp-dot-off", "mcp-badge-metered", "mcp-badge-read",
                   "mcp-badge-public", "mcp-badge-destructive", "mcp-badge-plan",
                   "mcp-client-on", "mcp-key-on", "mcp-conn-off", "mcp-copied"];
  const unstyled = applied.concat(dynamic)
    .filter((c) => !styled.has(c) && prefixes.indexOf(c) === -1);
  expect(unstyled.length === 0,
    `every mcp-* class has a rule${unstyled.length ? " — unstyled: " + unstyled.join(", ") : ` (${applied.length + dynamic.length} checked)`}`);
}

group("responsive");
{
  expect(/\.mcp-clients \{ grid-template-columns: 1fr; \}/.test(css),
    "the client picker collapses to one column on a narrow viewport");
  expect(/\.mcp-pre[^}]*overflow-x: auto/s.test(css),
    "config blocks scroll inside themselves rather than widening the page");
}

console.log("");
if (failures) {
  console.log(`\x1b[31m  ${failures} mcp-frontend test(s) failed\x1b[0m`);
  process.exit(1);
}
console.log("\x1b[32m  all mcp-frontend tests passed\x1b[0m");
