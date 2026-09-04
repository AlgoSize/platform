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
  // A hard-coded catalog would drift the moment a tool ships. Exactly one
  // algosize_ name is allowed: the probe the connection test calls, which is
  // not a listing but a specific call, and which the module checks against
  // the fetched manifest before offering the button.
  const named = [...new Set(js.match(/algosize_[a-z_]+/g) || [])];
  expect(named.length === 0 || (named.length === 1 && named[0] === "algosize_whoami"),
    `no catalog is duplicated in the front end (found ${named.join(", ") || "none"})`);
  if (named.length === 1) {
    expect(/var PROBE_TOOL = "algosize_whoami";/.test(js),
      "…the one allowed name is a single named constant, not scattered literals");
    expect((js.match(/"algosize_whoami"/g) || []).length === 1,
      "…written exactly once");
    expect(/function probeAvailable\(/.test(js) && /=== false/.test(js) &&
           /t\.name === PROBE_TOOL/.test(js),
      "…and checked against the manifest, so a rename disables the test rather than " +
      "firing a call the server will reject");
  }
  expect(/state\.manifest\.groups|manifest\.groups/.test(js),
    "…and it renders the server's own grouping");
}

group("the badge legend is complete and speaks one vocabulary");
{
  // A legend covering some of the badges is worse than none: the reader
  // learns it is complete, then meets an unexplained one on a row.
  expect(/var BADGES = \[/.test(js),
    "badges come from one table, read by both the legend and the rows");
  const keys = [...new Set((js.match(/key: "([a-z]+)"/g) || []).map((m) => m.slice(6, -1)))];
  const used = [...new Set((js.match(/badgeChip\("([a-z]+)"\)/g) || []).map((m) => m.slice(11, -2)))];
  expect(used.length > 0 && used.every((k) => keys.includes(k)),
    `every badge a row can show is in the legend table (rows use: ${used.join(", ")})`);
  expect(keys.length === used.length,
    "…and the legend explains no badge that no row can show");
  expect(!/mcp-badge-[a-z]+" }, "/.test(js),
    "…so no chip label is written a second time next to its class");
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

group("every request uses the verb its route is registered for");
{
  // This page was dead on every load for every user, and neither cause could
  // be seen from the browser: the panels rendered their honest "could not
  // read" strings, which is exactly what they should do when a read fails,
  // so the page looked like a backend outage rather than a client bug.
  //
  // Cause 1. `callApi(path, body, method)` DEFAULTS TO POST. All four reads
  // omitted the method, and all four routes are registered GET-only. The
  // /api/keys one was the worst of them: that path is registered for BOTH
  // verbs (index.js), so the POST reached the key-CREATION handler and was
  // stopped only by its `request.json()` throwing on the absent body.
  const index = readFileSync(join(__dirname, "..", "src", "index.js"), "utf8");
  for (const path of ["/api/mcp/manifest", "/api/mcp/clients", "/api/mcp/usage", "/api/keys"]) {
    const call = new RegExp(
      "callApi\\(\"" + path.replace(/\//g, "\\/") + "\"([^)]*)\\)");
    const m = js.match(call);
    expect(Boolean(m) && /,\s*"GET"\s*$/.test(m[1]),
      `the ${path} read names GET explicitly — callApi defaults to POST`);
  }
  expect(/router\.delete\(\s*"\/api\/mcp\/clients\/:id"/.test(index),
    "the revoke route is registered DELETE-only…");
  expect(/callApi\("\/api\/mcp\/clients\/" \+ encodeURIComponent\(c\.clientId\), null, "DELETE"\)/.test(js),
    "…so revoke passes DELETE as the METHOD, not as the body");
  // The specific shape of the old bug: an options object in the body slot is
  // silently JSON-encoded and sent, and the verb stays POST.
  expect(!/callApi\([^)]*\{\s*method:/.test(js),
    "no call passes a { method } object where callApi expects a body");
}

group("responses are read in the shape the handler sends");
{
  // Cause 2, independent of cause 1 and equally fatal. None of these four
  // handlers wraps its reply — each returns its object directly, and callApi
  // already throws on a non-2xx. Testing `r.ok` on a body with no `ok` field
  // is false for a SUCCESSFUL read, so every panel took its error branch even
  // when the request went through.
  expect(!/r && r\.ok \? r\.data/.test(js),
    "no read unwraps an {ok, data} envelope that no handler on this surface produces");
  expect(!/r\.data\./.test(js),
    "…and nothing reads through a `.data` that is never there");
  expect(/callApi\("\/api\/mcp\/clients", null, "GET"\)[\s\S]{0,120}r\.connections/.test(js),
    "the clients read takes `connections` from the top level of the reply");
  expect(/callApi\("\/api\/keys", null, "GET"\)[\s\S]{0,400}r\.keys/.test(js),
    "the keys read takes `keys` from the top level of the reply");
  // The one endpoint on this page that DOES send {ok:true}. Asymmetric on
  // purpose, and the asymmetry is the reason the envelope check above is
  // scoped to the reads.
  expect(/if \(r && r\.ok\) \{ fetchAll\(\); return; \}/.test(js),
    "revoke still reads the `ok` its own handler really sends");
}

group("an unreadable list is never rendered as an empty one");
{
  // The keys read used to collapse EVERY failure — 403, 500, offline — to [],
  // and the empty branch then stated "This organisation has no API keys yet"
  // to an org whose keys simply could not be read. The reader's next move is
  // to go and mint a duplicate credential.
  expect(!/\.catch\(function \(\) \{ state\.keys = \[\]/.test(js),
    "a failed key read does not become an empty key list");
  expect(/state\.keys = \{ error: true \}/.test(js),
    "…it becomes an explicit error state");
  // Order matters: the error branch has to come first, or the length check
  // on the sentinel object falls through to the empty copy.
  const picker = js.slice(js.indexOf("function keyPicker"));
  expect(picker.indexOf("state.keys.error") > -1
    && picker.indexOf("state.keys.error") < picker.indexOf("no API keys yet"),
    "…checked BEFORE the empty state, not after it");
  expect(/it is not saying you have none/.test(js),
    "…and the copy says the list is unread, not that the answer is zero");
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
                   "mcp-client-on", "mcp-key-on", "mcp-conn-off", "mcp-copied",
                   // Built by concatenation in the quota, test and volume
                   // panels, so the literal scan above cannot see them.
                   "mcp-quota-seg", "mcp-quota-seg-on", "mcp-quota-seg-low",
                   "mcp-quota-seg-out", "mcp-quota-note", "mcp-quota-warn",
                   "mcp-test-state", "mcp-test-idle", "mcp-test-ok", "mcp-test-fail",
                   "mcp-spark-bar", "mcp-spark-zero"];
  const unstyled = applied.concat(dynamic)
    .filter((c) => !styled.has(c) && prefixes.indexOf(c) === -1);
  expect(unstyled.length === 0,
    `every mcp-* class has a rule${unstyled.length ? " — unstyled: " + unstyled.join(", ") : ` (${applied.length + dynamic.length} checked)`}`);
}

group("the connection test claims only what it proves");
{
  // The test speaks over the reader's dashboard session. It cannot see the
  // key their client will send — that value only exists in the client's
  // environment. A green result that implied otherwise would send someone
  // debugging the wrong half of a two-part problem.
  expect(/credentials: "include"/.test(js),
    "the test authenticates as the dashboard session, not as a pasted key");
  expect(!/ask_live_/.test(js), "…so no key value is read, sent, or shown");
  // Split across a string concatenation in the source, so match the halves.
  expect(/does not check the/.test(js) && /key your client will send/.test(js),
    "…and a PASSING result says out loud what it did not check");
  expect(/not enabled for this organisation/.test(js),
    "a 404 is reported as \"not enabled\", not as a generic failure");
  expect(/read-only and unmetered|read-only\" \+|read-only/.test(js),
    "…and the idle state says the test costs nothing, so nobody avoids it");
}

group("the allowance panel");
{
  // A paid plan has no monthly run ceiling. Drawing an empty meter for one
  // would invent a limit the customer does not have.
  expect(/me\.plan !== "free" \|\| me\.monthlyRunsLimit == null/.test(js),
    "a paid plan is not given a meter it does not have");
  expect(/core\.me/.test(js),
    "the number comes from the same /api/me the header already read — two fetches could disagree on screen");
  expect(/refuse before running/.test(js),
    "at zero, it says a refused call consumes nothing");
  expect(/mcp-quota-warn/.test(js) && /accent-warm/.test(css),
    "…and being out of runs is amber, not red — it is a limit met, not a fault");
  expect(/aria-label": used \+ " of "/.test(js),
    "the meter carries its value in text, not in colour alone");
}

group("call volume");
{
  expect(/state\.usage\.daily/.test(js), "the series comes from the server, not from the capped call list");
  expect(/mcp-spark-zero/.test(js),
    "a day with no calls is drawn — an empty column and a missing one look identical");
  expect(/aria-label[\s\S]{0,220}No calls on any of the last/.test(js),
    "…and the chart has a text description for a reader who cannot see it");
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
