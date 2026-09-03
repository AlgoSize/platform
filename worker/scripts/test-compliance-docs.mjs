// The compliance pack and the code that backs it.
//
// Same principle as test-legal-pages.mjs: a policy document is a set of
// testable claims. Where a sentence in site/compliance/ describes a behaviour
// the code implements, this suite pins the sentence AND the implementation, so
// neither can drift without the other noticing.
//
// It also does something the legal suite does not, because a compliance pack
// fails differently. A privacy policy goes wrong by promising something the
// code stopped doing. A compliance pack goes wrong by CLAIMING A CONTROL THAT
// DOES NOT EXIST — and the claim is prose, so nothing else in the build would
// ever catch it. The last two groups are therefore negative: they assert that
// the published pages do not claim controls we do not have, and do not leak
// internals that should not be public.
//
// Run with:  node scripts/test-compliance-docs.mjs

import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { FRAMEWORKS, CATALOG_VERSION } from "../src/compliance/catalog.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..");
const PACK = join(ROOT, "site", "compliance");
const WORKFLOWS = join(ROOT, ".github", "workflows");

const read = (...p) => readFileSync(join(...p), "utf8");
const pack = (f) => read(PACK, f);

const files = readdirSync(PACK).filter((f) => f.endsWith(".md"));
const index = pack("README.md");
const ssdfMap = pack("SSDF-mapping.md");
const craMap = pack("CRA-mapping.md");
const allPages = files.map((f) => pack(f)).join("\n");

let failures = 0;
const ok = (m) => console.log(`  \x1b[32m✓\x1b[0m ${m}`);
const fail = (m) => { console.log(`  \x1b[31m✗\x1b[0m ${m}`); failures++; };
const expect = (cond, label) => (cond ? ok(label) : fail(label));
const group = (name) => console.log(`\n\x1b[1m${name}\x1b[0m\n`);

// ===========================================================================
group("the mapping tables cannot drift from the product's own catalog");
// ===========================================================================
{
  // The pack must not claim coverage the product would not claim for a
  // customer in the same position. The catalog is the single source of truth
  // for that word, so every row is checked against it rather than against the
  // prose that happens to be in the table.
  const LABEL = { automated: "automated", attested: "attested", not_covered: "not covered" };

  for (const [fwId, doc, name] of [["ssdf-1.1", ssdfMap, "SSDF"],
                                   ["cra-annex1-ii", craMap, "CRA"]]) {
    const fw = FRAMEWORKS.find((f) => f.id === fwId);
    const missing = [];
    const wrong = [];
    for (const c of fw.controls) {
      const row = doc.split("\n").find((l) => l.startsWith(`| **${c.id}**`));
      if (!row) { missing.push(c.id); continue; }
      if (!row.includes(`\`${LABEL[c.coverage]}\``)) wrong.push(c.id);
    }
    expect(missing.length === 0,
      `${name}: every control in the catalog appears in the table` +
      (missing.length ? ` — missing ${missing.join(", ")}` : ""));
    expect(wrong.length === 0,
      `${name}: every row's coverage word matches the catalog` +
      (wrong.length ? ` — wrong on ${wrong.join(", ")}` : ""));
    expect(doc.includes(String(fw.controls.length)),
      `${name}: the table states its own control count (${fw.controls.length})`);

    // The per-coverage summary, derived from the catalog rather than trusted.
    //
    // The per-row coverage words above cannot drift, because each is read from
    // the catalog. The SUMMARY table underneath them was a different story: it
    // hardcodes "automated | 12", "attested | 6", and nothing checked it.
    // Reclassifying one control left those numbers stale and every test green,
    // which is the exact shape of failure this suite exists to catch — a
    // document quietly describing a product that has moved.
    const counts = {};
    for (const c of fw.controls) counts[c.coverage] = (counts[c.coverage] || 0) + 1;
    const stale = [];
    for (const [coverage, n] of Object.entries(counts)) {
      const row = new RegExp(`\\|\\s*\`${LABEL[coverage]}\`\\s*\\|\\s*(\\d+)\\s*\\|`);
      const m = doc.match(row);
      if (!m) continue;             // a table without a summary is allowed
      if (Number(m[1]) !== n) stale.push(`${LABEL[coverage]}: says ${m[1]}, catalog has ${n}`);
    }
    expect(stale.length === 0,
      `${name}: the coverage summary matches the catalog` +
      (stale.length ? ` — ${stale.join("; ")}` : ""));
  }

  // A catalog bump changes what the product asserts, so it has to force a doc
  // review rather than silently leaving these tables describing an old version.
  expect(ssdfMap.includes(CATALOG_VERSION) && craMap.includes(CATALOG_VERSION) &&
         index.includes(CATALOG_VERSION),
    `both mappings and the index record catalog version ${CATALOG_VERSION}`);

  // A not-covered control without its reason is the failure this whole pack
  // exists to avoid: a reader assumes the worst about the subject.
  const notCovered = FRAMEWORKS.flatMap((f) => f.controls)
    .filter((c) => c.coverage === "not_covered");
  const reasonless = notCovered.filter((c) => {
    const doc = c.id.startsWith("II.") ? craMap : ssdfMap;
    const row = doc.split("\n").find((l) => l.startsWith(`| **${c.id}**`)) || "";
    return c.why && !row.includes(c.why.slice(0, 40));
  });
  expect(reasonless.length === 0,
    "every not-covered row carries the catalog's own reason, quoted rather than paraphrased" +
    (reasonless.length ? ` — missing on ${reasonless.map((c) => c.id).join(", ")}` : ""));
}

// ===========================================================================
group("the index and the files agree");
// ===========================================================================
{
  const docs = files.filter((f) => f !== "README.md");
  const unlisted = docs.filter((f) => {
    const slug = f.replace(/\.md$/, "").toLowerCase();
    return !index.includes(`/security/compliance/${slug}/`);
  });
  expect(unlisted.length === 0,
    "every document is linked from the index" +
    (unlisted.length ? ` — ${unlisted.join(", ")}` : ""));

  const slugs = new Set(docs.map((f) => f.replace(/\.md$/, "").toLowerCase()));
  const dangling = [...index.matchAll(/\/security\/compliance\/([a-z0-9-]+)\//g)]
    .map((m) => m[1]).filter((s) => s && !slugs.has(s));
  expect(dangling.length === 0,
    "every link in the index resolves to a document that exists" +
    (dangling.length ? ` — ${[...new Set(dangling)].join(", ")}` : ""));

  const noFrontMatter = files.filter((f) => !pack(f).startsWith("---\nlayout: page"));
  expect(noFrontMatter.length === 0,
    "every page carries Jekyll front matter so it actually publishes" +
    (noFrontMatter.length ? ` — ${noFrontMatter.join(", ")}` : ""));

  const noPermalink = files.filter((f) => !/permalink: \/security\/compliance\//.test(pack(f)));
  expect(noPermalink.length === 0, "and a /security/compliance/ permalink");

  const noRoadmap = files.filter((f) =>
    !["README.md", "SSDF-mapping.md", "CRA-mapping.md"].includes(f) &&
    !pack(f).includes("## Roadmap"));
  expect(noRoadmap.length === 0,
    "every policy document states its own gaps under Roadmap" +
    (noRoadmap.length ? ` — missing in ${noRoadmap.join(", ")}` : ""));
}

// ===========================================================================
group("claims about CI are pinned to the workflows that implement them");
// ===========================================================================
{
  const audit = read(WORKFLOWS, "algosize-audit.yml");
  const arch = read(WORKFLOWS, "algosize-architecture.yml");
  const worker = read(WORKFLOWS, "worker.yml");

  // PO-03 and PW-07 both say the dependency gate fails the build on high.
  expect(/"fail_on"\s*:\s*"high"/.test(audit) && /exit 1/.test(audit),
    "the dependency gate really does fail the build on a high-severity advisory");

  // The same documents say the architecture gate only comments. If someone
  // later makes it blocking, the doc becomes understated rather than wrong —
  // but it still has to be updated, so pin it.
  expect(/arch_fail_on"?\s*:?\s*"none"/.test(arch) || /"arch_fail_on": "none"/.test(arch),
    "the architecture gate really is configured not to fail the build");

  // PW-06 and PS-01 say a red suite cannot deploy, and that bindings are
  // checked before the deploy rather than after.
  expect(/needs:\s*test/.test(worker),
    "the deploy job really does depend on the test job");
  // Anchored on the actual run step. The first literal "wrangler deploy" in
  // this file is inside a header comment, and comparing against a comment is
  // how a test like this passes while asserting nothing.
  const bindingsAt = worker.indexOf("scripts/check-bindings.mjs");
  const deployAt = worker.indexOf("wrangler deploy --config");
  expect(bindingsAt > -1 && deployAt > -1 && bindingsAt < deployAt,
    "the binding check really does run before wrangler deploy, not after");

  // PO-05 says separation is per-binding. Assert the resources actually differ
  // rather than sharing a namespace with a prefix.
  const toml = read(ROOT, "worker", "wrangler.toml");
  // Anchored to line starts. A comment near the top of the file names both
  // sections, and slicing on the bare strings cut a 21-character window out of
  // that comment rather than the environments — a test that then compared two
  // undefined values and reported them different.
  const at = (re) => { const m = toml.match(re); return m ? m.index : -1; };
  const prodAt = at(/^\[env\.production\]/m);
  const stgAt = at(/^\[env\.staging\]/m);
  const prod = toml.slice(prodAt, stgAt);
  const stg = toml.slice(stgAt);
  const d1 = (s) => (s.match(/database_name\s*=\s*"([^"]+)"/) || [])[1];
  const r2 = (s) => (s.match(/bucket_name\s*=\s*"([^"]+)"/) || [])[1];
  expect(prodAt > -1 && stgAt > prodAt, "both environment sections are present");
  expect(d1(prod) && d1(stg) && d1(prod) !== d1(stg),
    "production and staging really do use different databases");
  expect(r2(prod) && r2(stg) && r2(prod) !== r2(stg),
    "and different object-storage buckets");
}

// ===========================================================================
group("claims about the product are pinned to the code");
// ===========================================================================
{
  // PW-09 says API keys are stored hashed with only a display prefix.
  const keys = read(ROOT, "worker", "src", "handlers", "_api_keys.js");
  expect(/sha256/i.test(keys) && /key_hash/.test(keys),
    "API keys really are stored as a hash, not plaintext");

  // PW-06 says the session secret has an enforced minimum and the algorithm is
  // pinned. Both are load-bearing and both are one deletion away from gone.
  const auth = read(ROOT, "worker", "src", "auth.js");
  expect(/MIN_JWT_SECRET_LEN\s*=\s*32/.test(auth),
    "the 32-byte minimum session secret really is enforced");
  expect(/header\.alg\s*!==/.test(auth),
    "the JWT algorithm really is pinned in the header check");

  // PW-06 says CORS allows exactly one origin. A wildcard here with
  // credentials enabled would be a serious defect AND make the doc a lie.
  const cors = read(ROOT, "worker", "src", "cors.js");
  expect(/origin === env\.SITE_ORIGIN/.test(cors) && !cors.includes('"*"'),
    "CORS really does allow exactly one origin rather than a wildcard");

  // PO-04 and RV-02 rest on the compliance resolver only ever weakening a
  // verdict. That property is what makes the pack's own coverage claims safe.
  const resolve = read(ROOT, "worker", "src", "compliance", "resolve.js");
  expect(/CAN ONLY DOWNGRADE/.test(resolve),
    "the compliance resolver really is downgrade-only");
}

// ===========================================================================
group("the pack claims no control this organisation does not have");
// ===========================================================================
{
  // This is the group that keeps the pack honest after everyone who wrote it
  // has moved on.
  //
  // The first version of this banned these words outright, and failed — on the
  // pack's own honest denials. "No multi-factor authentication" contains
  // "multi-factor"; "no Dependabot, no Renovate" contains both. A word ban
  // cannot tell a claim from its denial, and would have pushed the pack towards
  // saying LESS about its gaps to stay green, which is the exact opposite of
  // what this suite is for.
  //
  // So the rule is scoped to the sentence: each term below may appear only in a
  // sentence that also negates it. Mention a control we do not have, and you
  // must be denying it.
  const NEGATORS = /\b(no|not|never|without|lack|absent|neither|nor|cannot|does not|do not|has not|have not|is not|are not)\b/i;
  const CONTROLS_WE_LACK = [
    "multi-factor", "two-factor", "MFA", "gitleaks", "trufflehog",
    "Dependabot", "Renovate", "SOC 2", "ISO 27001", "certified",
    "penetration test", "bug bounty", "dynamic application security testing",
  ];
  // Two things have to happen before this can be split into sentences.
  //
  // 1. UNWRAP. These files are hard-wrapped at ~76 characters, so a sentence
  //    routinely spans several lines. Splitting on newlines cut "…and no
  //    gitleaks/trufflehog step" in half and flagged the half without the "no".
  // 2. EXCLUDE THE APPENDIX. The index ends with a section about when a reader
  //    needs a pack like this at all, and it necessarily says things like
  //    "prospects ask for SOC 2 or ISO 27001". That is a statement about the
  //    reader's situation, not a claim about Algosize. The claim about Algosize
  //    — that it holds neither — is made earlier in the same file, and is
  //    checked like everything else.
  const APPENDIX = "## When these artifacts are needed";
  const assertions = files.map((f) => {
    const text = pack(f);
    const cut = text.indexOf(APPENDIX);
    return cut === -1 ? text : text.slice(0, cut);
  }).join("\n\n");

  const sentences = assertions
    .replace(/\n{2,}/g, "\u0000")      // remember paragraph breaks
    .replace(/\n/g, " ")               // unwrap the rest
    .replace(/\u0000/g, ". ")
    .split(/(?<=[.!?])\s+|\s*\|\s*/)
    .map((x) => x.trim())
    .filter(Boolean);

  const affirmed = [];
  for (const term of CONTROLS_WE_LACK) {
    const re = new RegExp(`\\b${term.replace(/ /g, "[ -]")}\\b`, "i");
    for (const sent of sentences) {
      if (!re.test(sent)) continue;
      if (NEGATORS.test(sent)) continue;
      affirmed.push(`${term} — "${sent.slice(0, 70)}…"`);
      break;
    }
  }
  expect(affirmed.length === 0,
    "every mention of a control we do not have sits in a sentence that denies it" +
    (affirmed.length ? `\n      ${affirmed.join("\n      ")}` : ""));

  // The inverse: the biggest gaps must be stated, not merely not-overclaimed.
  // Silence about a missing control is its own kind of overclaim.
  const stated = [
    [/no multi-factor authentication/i, "the absence of MFA"],
    [/hidden at 90 days, not deleted|are not deleted|not yet in service/i,
     "that run retention is a read cutoff rather than a deletion"],
    [/do not generate an SBOM for our own repository/i,
     "that we do not run our own SBOM generator on ourselves"],
    [/no dynamic application security testing/i, "the absence of dynamic testing"],
    [/no published security advisories/i, "the absence of published advisories"],
    [/holds no SOC 2 report/i, "that there is no SOC 2 report"],
  ];
  const unstated = stated.filter(([re]) => !re.test(allPages)).map(([, n]) => n);
  expect(unstated.length === 0,
    "and every headline gap is stated rather than left to be inferred" +
    (unstated.length ? ` — missing: ${unstated.join(", ")}` : ""));
}

// ===========================================================================
group("the published pack leaks no internals");
// ===========================================================================
{
  // Publishing the pack means every page is public. Infrastructure identifiers
  // and the admin allowlist must not ride along.
  const toml = read(ROOT, "worker", "wrangler.toml");
  const adminEmails = (toml.match(/ADMIN_EMAILS\s*=\s*"([^"]+)"/) || [])[1] || "";
  const leakedAdmins = adminEmails.split(",").map((e) => e.trim()).filter(Boolean)
    .filter((e) => allPages.includes(e));
  expect(leakedAdmins.length === 0,
    "no admin allowlist address appears on a published page" +
    (leakedAdmins.length ? ` — ${leakedAdmins.join(", ")}` : ""));

  const ids = [...toml.matchAll(/(?:database_id|id)\s*=\s*"([0-9a-f]{16,}|[0-9a-f-]{30,})"/g)]
    .map((m) => m[1]);
  const leakedIds = ids.filter((v) => allPages.includes(v));
  expect(leakedIds.length === 0,
    "no database or namespace identifier appears on a published page" +
    (leakedIds.length ? ` — ${leakedIds.join(", ")}` : ""));

  // The internal roadmap is the one file that must NOT be under site/.
  expect(!files.includes("ROADMAP-internal.md"),
    "the internal roadmap is not in the published directory");

  // And the pack must tell readers the internal list exists, rather than
  // quietly omitting it — an undisclosed omission is the dishonest version.
  expect(/tracked internally rather than published/i.test(index) &&
         /under NDA/i.test(index),
    "the index discloses that some weaknesses are held back, and how to ask for them");
}

// ===========================================================================
console.log();
if (failures === 0) {
  console.log("\x1b[32m  all compliance-doc tests passed\x1b[0m\n");
  process.exit(0);
} else {
  console.log(`\x1b[31m  ${failures} compliance-doc test(s) failed\x1b[0m\n`);
  process.exit(1);
}
