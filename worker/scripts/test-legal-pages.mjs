// The legal pages and the code that backs them.
//
// A privacy policy is a set of testable claims. Where a sentence in
// privacy.md promises a behavior the code implements — GPC honored, AI
// output labeled, exports self-service, secrets refused — this suite pins
// the sentence AND the implementation, so neither can drift without the
// other noticing. Prose-only sections (governing law, indemnity) are not
// tested; behavior is.
//
// Run with:  node scripts/test-legal-pages.mjs

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SITE = join(__dirname, "..", "..", "site");

const privacy   = readFileSync(join(SITE, "privacy.md"), "utf8");
const terms     = readFileSync(join(SITE, "terms.md"), "utf8");
const analytics = readFileSync(join(SITE, "assets", "js", "analytics.js"), "utf8");
const layout    = readFileSync(join(SITE, "_layouts", "default.html"), "utf8");
const index     = readFileSync(join(SITE, "index.html"), "utf8");
const footer    = readFileSync(join(SITE, "_includes", "footer.html"), "utf8");
const dashJs    = readFileSync(join(SITE, "assets", "js", "dashboard.js"), "utf8");
const acctJs    = readFileSync(join(SITE, "assets", "js", "dash-account.js"), "utf8");
const css       = readFileSync(join(SITE, "assets", "css", "main.css"), "utf8");
const pageview  = readFileSync(join(__dirname, "..", "src", "handlers", "pageview.js"), "utf8");
const estimate  = readFileSync(join(__dirname, "..", "src", "handlers", "estimate.js"), "utf8");

let failures = 0;
const ok   = (msg) => console.log(`  \x1b[32m✓\x1b[0m ${msg}`);
const fail = (msg) => { console.log(`  \x1b[31m✗\x1b[0m ${msg}`); failures++; };
const expect = (cond, label) => (cond ? ok(label) : fail(label));
const group  = (name) => console.log(`\n\x1b[1m${name}\x1b[0m\n`);

// ===========================================================================
group("the pages exist, are linked, and are accepted at signup");
// ===========================================================================
{
  expect(/permalink: \/privacy\//.test(privacy) && /permalink: \/terms\//.test(terms),
    "both pages publish at their permalinks");
  expect(/\/privacy\//.test(footer) && /\/terms\//.test(footer),
    "the site footer links both");
  expect(/By creating an account you agree to our/.test(index),
    "signup carries the acceptance line linking Terms and Privacy");
}

// ===========================================================================
group("every named regime has a real section");
// ===========================================================================
{
  expect(/GDPR \/ UK GDPR/.test(privacy) && /Articles 15–21/.test(privacy),
    "GDPR: legal-bases table and Art. 15–21 rights");
  expect(/CCPA\/CPRA/.test(privacy) && /do not sell personal information/i.test(privacy) &&
         /Global Privacy Control/.test(privacy),
    "US state laws: CCPA/CPRA with no-sale statement and GPC recognition");
  expect(/Appeals.*Virginia/.test(privacy),
    "US state laws: the appeal process the Virginia-style statutes require");
  expect(/LGPD/.test(privacy) && /encarregado/.test(privacy) && /ANPD/.test(privacy),
    "Brazil: LGPD with Art. 18 rights, encarregado, and ANPD");
  expect(/PIPL/.test(privacy) && /separate consent/.test(privacy) &&
         /outside the People's Republic of China/.test(privacy),
    "China: PIPL cross-border transfer with separate-consent language");
  expect(/EU AI Act/.test(privacy) && /Article 50/.test(privacy),
    "EU AI Act: an Article 50 transparency section");
  expect(/KVKK/.test(privacy), "Turkey's KVKK section is retained");
  expect(/Standard Contractual Clauses/.test(privacy),
    "international transfers name their safeguard");
  expect(/Article 33/.test(privacy) && /72 hours/.test(privacy),
    "the GDPR breach-notification commitment is stated");
}

// ===========================================================================
group("claims about the product are true of the product");
// ===========================================================================
{
  // Passwordless: the policy must not claim password storage — the old
  // boilerplate did, and the product has no password anywhere.
  expect(!/salted hash/.test(privacy) && /passwordless|We never ask for, receive, or store a password/i.test(privacy),
    "the policy says passwordless and never claims password storage");

  // Self-service rights name the REAL buttons.
  expect(/Export account data/.test(privacy) && /"Export account data"/.test(acctJs),
    "the access/portability route names the button that actually exists");
  expect(/Delete organisation/.test(privacy) && /"Delete organisation"/.test(acctJs),
    "the erasure route names the real delete flow");

  // The estimator claims: in-memory processing, secret refusal.
  expect(/processed \*\*in memory\*\*/.test(privacy) || /processed in memory/.test(privacy),
    "the policy claims estimator input is not stored…");
  expect(!/recordRun|INSERT INTO runs/.test(estimate),
    "…and the estimate handler indeed stores nothing");
  expect(/refused/.test(privacy) && /secrets_detected/.test(estimate),
    "the credential-refusal claim matches the handler's secret detection");

  // Committed-files-only monitoring, no cloud credentials.
  expect(/committed files only/i.test(privacy) && /never connect to your cloud accounts/i.test(privacy),
    "the two product invariants lead the policy");
  expect(/No cloud-account access/.test(terms) && /Estimates are not bills/.test(terms),
    "and the terms carry them as product rules, not marketing");

  // No training on Customer Content — stated in both documents.
  expect(/not.*train/i.test(privacy) && /No AI training/.test(terms),
    "the no-training commitment appears in both documents");
}

// ===========================================================================
group("GPC / DNT: the promise and the gates move together");
// ===========================================================================
{
  expect(/Global Privacy Control and Do Not Track/.test(privacy) &&
         /disable analytics events for your visit entirely/.test(privacy),
    "the policy promises full GPC/DNT opt-out");
  expect(/globalPrivacyControl/.test(analytics) && /privacyOptOut/.test(analytics),
    "analytics.js gates custom events on GPC/DNT");
  expect(/globalPrivacyControl/.test(layout) && /dnt === "1"/.test(layout),
    "the layout refuses to inject the Plausible tracker for opted-out browsers");
  expect(/Sec-GPC/.test(pageview) && /DNT/.test(pageview),
    "the noscript pixel honors Sec-GPC/DNT server-side");
  expect(/algosize_session/.test(privacy) && /algosize_ref/.test(privacy),
    "the cookie inventory names exactly the two cookies the product sets");
}

// ===========================================================================
group("EU AI Act Art. 50: labeled where shown, not only in the policy");
// ===========================================================================
{
  expect(/ai-disclosure/.test(dashJs) && /AI-generated — a suggestion for your review/.test(dashJs),
    "AI output carries an AI-generated label at the moment it renders");
  expect(/\.ai-disclosure/.test(css), "and the label is styled, not a bare unformatted line");
  expect(/labeled as AI-generated, at the moment they are shown/.test(privacy),
    "the policy's labeling claim matches that implementation");
  expect(/Refactor suggestion \(AI disabled\)/.test(dashJs),
    "the disabled state stays honest in the UI");
  expect(/not a high-risk system within the meaning of Annex III/.test(privacy),
    "the risk classification is stated");
  expect(/## 9\. AI Features/.test(terms) && /Article 50/.test(terms),
    "the terms carry a matching AI-features clause");
}

// ---------- summary ----------
console.log("");
if (failures === 0) {
  console.log("\x1b[32m  all legal-page tests passed\x1b[0m\n");
  process.exit(0);
} else {
  console.log(`\x1b[31m  ${failures} legal-page test(s) failed\x1b[0m\n`);
  process.exit(1);
}
