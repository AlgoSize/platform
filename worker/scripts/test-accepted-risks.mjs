// What an accepted risk can and cannot do.
//
// Every assertion here is an OVERCLAIM VECTOR. This is the only mechanism in
// the product that can move a number a report reads, so the tests are written
// against the ways it could be turned into a way of making the scanner lie:
// accepting a leaked credential, accepting forever, accepting a whole rule
// across a repository, accepting something and having it silently vanish.
//
// Run with:  node scripts/test-accepted-risks.mjs

import {
  applyAcceptedRisks, acceptanceSummary, isAcceptableCategory,
  NEVER_ACCEPTABLE, MAX_ACCEPTANCE_SECONDS,
} from "../src/risk/accept.js";
import { AUDIT_ACTIONS } from "../src/audit.js";
import { repoKeyFor, normaliseRepo } from "../src/repo-key.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = join(__dirname, "..", "src");

let failures = 0;
const ok = (m) => console.log(`  \x1b[32m✓\x1b[0m ${m}`);
const fail = (m) => { console.log(`  \x1b[31m✗\x1b[0m ${m}`); failures++; };
const expect = (cond, label) => (cond ? ok(label) : fail(label));
const group = (name) => console.log(`\n\x1b[1m${name}\x1b[0m\n`);

const NOW = 1_800_000_000;
const DAY = 86400;
const REPO = "acme/api";

const finding = (over = {}) => ({
  id: "VS-0001",
  ruleId: "sast.code-injection.eval",
  category: "injection",
  severity: "high",
  path: "src/sandbox.js",
  line: 12,
  fingerprint: "aaaaaaaabbbbbbbb",
  ...over,
});

const acceptance = (over = {}) => ({
  id: "ar_1",
  orgId: "org_1",
  repoKey: REPO,
  ruleId: "sast.code-injection.eval",
  path: "src/sandbox.js",
  fingerprint: "aaaaaaaabbbbbbbb",
  category: "injection",
  severity: "high",
  rationale: "It is the sandbox. Defense layers 3 and 4 bound it.",
  ownerEmail: "owner@acme.test",
  documentUrl: null,
  acceptedBy: "owner@acme.test",
  acceptedAt: NOW - DAY,
  expiresAt: NOW + 90 * DAY,
  ...over,
});

const apply = (findings, acceptances, over = {}) =>
  applyAcceptedRisks(findings, acceptances, { repoKey: REPO, now: NOW, ...over });

// ===========================================================================
group("a credential is never a risk you accept");
// ===========================================================================
{
  expect(NEVER_ACCEPTABLE.includes("secrets"), "`secrets` is on the ban list");
  expect(NEVER_ACCEPTABLE.includes("dependency"), "`dependency` is on the ban list");
  expect(isAcceptableCategory("injection"),
    "…and `injection` is not — a blanket ban on the severe would just get the scanner deleted");

  // The bypass test. The API refuses these, so this hands the matcher a row
  // the API would never have written — an import, a future code path, a
  // hand-edited database.
  //
  // Delete the isAcceptableCategory re-check inside applyAcceptedRisks and
  // THIS assertion goes red while an API-level test stays green. That is the
  // whole reason the check exists in two places.
  for (const category of NEVER_ACCEPTABLE) {
    const f = finding({ category, ruleId: `sast.${category}.x` });
    const [out] = apply([f], [acceptance({ category, ruleId: f.ruleId })]);
    expect(out.accepted !== true,
      `a row hand-written with category "${category}" still cannot take effect`);
  }
}

// ===========================================================================
group("every acceptance expires, and expiry is decided on read");
// ===========================================================================
{
  const [live] = apply([finding()], [acceptance()]);
  expect(live.accepted === true && live.acceptance.state === "accepted",
    "an in-date acceptance covers its finding");

  const [lapsed] = apply([finding()], [acceptance({ expiresAt: NOW - 1 })]);
  expect(lapsed.accepted === false && lapsed.acceptance.state === "expired",
    "one second past its expiry, the finding is open again");
  expect(lapsed.severity === "high",
    "…at its full severity, not a quieter one");
  expect(lapsed.acceptance.ownerEmail === "owner@acme.test",
    "…and it still names who let it lapse. Stronger than silence.");

  // The property that makes expiry unbypassable: nothing is read from storage
  // to decide it. Same row, two different clocks, two different answers.
  const row = acceptance({ expiresAt: NOW + 10 });
  expect(apply([finding()], [row])[0].accepted === true &&
         apply([finding()], [row], { now: NOW + 11 })[0].accepted === false,
    "the same stored row is live or lapsed depending only on the clock");

  expect(MAX_ACCEPTANCE_SECONDS === 365 * DAY,
    "an acceptance may run at most a year — longer is perpetual wearing a date");
}

// ===========================================================================
group("the key is neither too loose nor too tight");
// ===========================================================================
{
  const a = acceptance();

  expect(apply([finding({ path: "src/other.js" })], [a])[0].accepted !== true,
    "a different file is not covered — this is not a rule-wide waiver");
  expect(apply([finding()], [a], { repoKey: "acme/other" })[0].accepted !== true,
    "a different repository is not covered");
  expect(apply([finding({ ruleId: "sast.command-injection.exec-call" })], [a])[0].accepted !== true,
    "a different rule is not covered");
  expect(apply([finding()], [a], { repoKey: null })[0].accepted !== true,
    "and a scan with no repository at all is covered by nothing");

  // The fingerprint is not line-keyed, on purpose (see schema.js). An
  // acceptance has to survive the code moving down the file, or it would be
  // re-signed after every unrelated commit and re-signing becomes reflexive.
  expect(apply([finding({ line: 900 })], [a])[0].accepted === true,
    "the same finding further down the file is still covered");

  // The loose half of the key GRANTS NOTHING. It only produces a sentence.
  const [drift] = apply([finding({ fingerprint: "ccccccccdddddddd" })], [a]);
  expect(drift.accepted === false && drift.acceptance.state === "drifted",
    "same rule and file, changed code: DRIFTED, and open");
  expect(drift.acceptance.ownerEmail === "owner@acme.test" && drift.acceptance.expiresOn,
    "…carrying who signed the old one, so the reader can re-confirm rather than guess");

  // This is the assertion that catches someone "helpfully" loosening the match.
  const sum = acceptanceSummary(apply([finding({ fingerprint: "ccccccccdddddddd" })], [a]));
  expect(sum.open.bySeverity.high === 1 && sum.accepted.total === 0,
    "a drifted finding counts as OPEN, not as accepted");
}

// ===========================================================================
group("an acceptance covers a finding that got quieter, never one that got louder");
// ===========================================================================
{
  const signedMedium = acceptance({ severity: "medium" });
  expect(apply([finding({ severity: "high" })], [signedMedium])[0].accepted === false,
    "signed at medium, now high: not covered");
  expect(apply([finding({ severity: "low" })], [acceptance({ severity: "high" })])[0].accepted === true,
    "signed at high, now low: still covered");
}

// ===========================================================================
group("nothing ever vanishes");
// ===========================================================================
{
  const findings = [
    finding(),
    finding({ fingerprint: "1111111122222222", line: 40 }),
    finding({ ruleId: "sast.command-injection.exec-call", fingerprint: "3333333344444444", severity: "medium" }),
    finding({ category: "secrets", ruleId: "secrets.generic.assigned-literal", fingerprint: "5555555566666666" }),
  ];
  const out = apply(findings, [acceptance()]);
  expect(out.length === findings.length, "the output has exactly as many findings as the input");
  expect(out.every((f, i) => f.fingerprint === findings[i].fingerprint),
    "…in the same order, with the same identities");

  const sum = acceptanceSummary(out);
  const totalHigh = out.filter((f) => f.severity === "high").length;
  expect(sum.open.bySeverity.high + sum.accepted.bySeverity.high === totalHigh,
    `open + accepted === found, for every severity (${sum.open.bySeverity.high} + ${sum.accepted.bySeverity.high} === ${totalHigh})`);
  expect(sum.accepted.total === 1 && sum.open.total === 3,
    "one accepted, three open — arithmetic that cannot be fudged");
}

// ===========================================================================
group("the repository key is one definition, shared");
// ===========================================================================
{
  expect(normaliseRepo("https://github.com/AlgoSize/Platform.git") === "algosize/platform",
    "a clone URL and a bare slug normalise to the same key");
  expect(repoKeyFor("AlgoSize/Platform") === "algosize/platform", "…from either side");
  expect(repoKeyFor("") === null && repoKeyFor("not a repo") === null,
    "and anything that is not repo-shaped is null, so no acceptance can attach to it");
}

// ===========================================================================
group("the frozen constants are registered");
// ===========================================================================
{
  // Every one of these fails invisibly if it is missed: an unregistered
  // migration means the read path silently reports everything as open, and an
  // unregistered audit action means the one mechanism that can move a number
  // leaves no trace.
  expect(typeof AUDIT_ACTIONS.RISK_ACCEPTED === "string" &&
         typeof AUDIT_ACTIONS.RISK_ACCEPTANCE_REVOKED === "string",
    "both audit actions exist in the frozen AUDIT_ACTIONS map");

  const admin = readFileSync(join(SRC, "handlers", "admin.js"), "utf8");
  expect(/id: "0029"/.test(admin) && /accepted_risks/.test(admin),
    "migration 0029 is registered in the MIGRATIONS manifest");
  expect(/table: "accepted_risks", column: "expires_at"/.test(admin),
    "…and the manifest checks the column that makes expiry possible");

  const index = readFileSync(join(SRC, "index.js"), "utf8");
  for (const route of [
    'router.get(   "/api/accepted-risks"',
    'router.post(  "/api/accepted-risks"',
    'router.post(  "/api/accepted-risks/:id/revoke"',
  ]) {
    expect(index.includes(route), `${route.trim()} … is wired`);
  }

  // The gate rule, pinned as text because it is a rule about future edits.
  const schema = readFileSync(join(SRC, "analyzers", "sast", "schema.js"), "utf8");
  expect(/read `open\.bySeverity`, never/.test(schema),
    "schema.js states that anything gating reads open.bySeverity, never bySeverity");

  const evidence = readFileSync(join(SRC, "compliance", "evidence.js"), "utf8");
  expect(/!f\.accepted/.test(evidence),
    "the PW.5.1 collector counts OPEN critical/high, not every critical/high");
  expect(/acceptedHigh/.test(evidence) && /ownerEmail/.test(evidence),
    "…and names every accepted one, with its owner, in the rationale it publishes");
}

// ===========================================================================
group("an accepted finding is suppressed in SARIF, never absent");
// ===========================================================================
{
  const { toSarif } = await import("../src/analyzers/sarif.js");

  const base = {
    ...finding(),
    title: "Request data reaches dynamic code evaluation",
    recommendation: "Remove the dynamic evaluation.",
    confidence: "high", module: "ast-analyzer", cwe: ["CWE-95"],
  };
  const [acceptedF] = apply([base], [acceptance()]);
  const [expiredF]  = apply([base], [acceptance({ expiresAt: NOW - 1 })]);

  const sarifOf = (f) => toSarif({ source: { findings: [f] }, advisories: [] });
  const resultOf = (doc) => doc.runs[0].results[0];

  const a = resultOf(sarifOf(acceptedF));
  expect(Array.isArray(a.suppressions) && a.suppressions.length === 1,
    "an accepted finding carries a SARIF suppression");
  expect(a.suppressions[0].justification === acceptedF.acceptance.rationale,
    "…with the written reason as its justification, so the Security tab shows why");
  expect(a.suppressions[0].properties.owner === "owner@acme.test",
    "…and the accountable owner");
  expect(a.level === "error",
    "…while the level is untouched: accepting a risk does not make it less severe");
  expect(a.partialFingerprints.algosizeFinding === base.fingerprint,
    "…and the fingerprint is unchanged, so GitHub keeps one alert rather than opening a second");
  expect(!/\.accepted$/.test(a.ruleId),
    "…and no suffixed rule id is minted, which would fork the alert history");

  const e = resultOf(sarifOf(expiredF));
  expect(!e.suppressions,
    "an EXPIRED acceptance emits no suppression — the finding is open again");

  const plain = resultOf(sarifOf(base));
  expect(!plain.suppressions, "and a finding nobody signed for carries none");
}

// ===========================================================================
group("the dashboard shows what is open AND what was signed for");
// ===========================================================================
{
  const SITE = join(__dirname, "..", "..", "site");
  const dash = readFileSync(join(SITE, "assets", "js", "dashboard.js"), "utf8");
  const css = readFileSync(join(SITE, "assets", "css", "main.css"), "utf8");

  // The stat row must read the OPEN count. Reading `summary.bySeverity` there
  // would show the total and call it open.
  expect(/summary\.open && src\.summary\.open\.bySeverity/.test(dash),
    "the severity cards read summary.open.bySeverity");

  // The pairing. "0 open" without "1 accepted" beside it is the lie this
  // feature must not become, so both come out of the same block — a future
  // edit cannot drop one and keep the other without noticing.
  // The pairing, checked by PROXIMITY rather than by a quoted literal: the
  // accepted card must be built in the same run of code as the severity cards,
  // close enough that an edit removing one cannot plausibly miss the other.
  // Anchored on the open-count read, because `result-stats-4` appears in
  // several renderers and the first one is not this one.
  const openAt = dash.indexOf("src.summary.open.bySeverity");
  const statsAt = dash.indexOf("result-stats result-stats-4", openAt);
  const acceptedAt = dash.indexOf("sast-stat-accepted", openAt);
  expect(openAt > 0 && statsAt > openAt && acceptedAt > statsAt && acceptedAt - statsAt < 600,
    "…and the accepted card is emitted beside the severity cards, not in a branch of its own");

  // A credential is not acceptable, and the UI says why rather than silently
  // omitting the button and leaving the reader to wonder.
  expect(/f\.category === "secrets" \|\| f\.category === "dependency"/.test(dash),
    "no accept affordance is offered for a secret or a dependency advisory");
  expect(/rotated\./.test(dash) && /upgraded\./.test(dash),
    "…and each refusal says what to do instead");

  // Drifted and expired are OPEN findings, and the card must not read as calm.
  // The class is composed at runtime ("sast-accept-" + state), so the check is
  // that each state is a named case with its own words and its own style —
  // not that a literal class string appears in the source.
  expect(/"sast-accept sast-accept-" \+ state/.test(dash),
    "the acceptance panel takes its class from the state");
  for (const state of ["drifted", "expired"]) {
    expect(new RegExp(`${state}:\\s*"`).test(dash),
      `the ${state} state has a label of its own, not a shared one`);
    expect(css.includes(`.sast-accept-${state}`), `…and its own style`);
  }
  expect(/counted as open/.test(dash),
    "both say in words that the finding is still counted as open");

  // Every class the renderer emits has a rule behind it.
  const emitted = [...dash.matchAll(/class: "(sast-accept[a-z-]*)"/g)].map((m) => m[1]);
  const unstyled = [...new Set(emitted)].filter((c) => !css.includes("." + c));
  expect(unstyled.length === 0,
    "every acceptance class is styled" + (unstyled.length ? ` — ${unstyled.join(", ")}` : ""));
}

// ===========================================================================
console.log();
if (failures === 0) {
  console.log("\x1b[32m  all accepted-risk tests passed\x1b[0m\n");
  process.exit(0);
} else {
  console.log(`\x1b[31m  ${failures} accepted-risk test(s) failed\x1b[0m\n`);
  process.exit(1);
}
