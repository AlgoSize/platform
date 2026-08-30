# Security scanning

The Vulnerability scanner answers two different questions, and the difference
matters more than it looks:

| | Question | Input | Output |
| --- | --- | --- | --- |
| **Dependency audit** | Are the packages you install known-bad? | lockfiles | advisories from OSV.dev |
| **Source scan (SAST)** | Is the code you wrote exploitable? | source files | findings with CWE/OWASP mappings |

A clean dependency audit says nothing about the second question. Most of a
team's own vulnerabilities are in code they wrote, and until this release the
product graded a repository entirely on somebody else's packages.

Both run from one call: `POST /api/analyze/vuln { "repoUrl": … }`.

---

## What is scanned

### Categories

| Category | Rules cover |
| --- | --- |
| `injection` | SQL, NoSQL operator injection, OS command, dynamic code evaluation, server-side template injection, XXE |
| `xss` | HTML sinks (`innerHTML`, `document.write`, `dangerouslySetInnerHTML`), reflected responses |
| `traversal` | request-derived filesystem paths |
| `ssrf` | server-side requests to caller-supplied URLs |
| `redirect` | unvalidated redirect targets |
| `deserialization` | `pickle`, unsafe `yaml.load`, PHP `unserialize`, Ruby `Marshal.load` |
| `secrets` | AWS keys, GitHub PATs, Stripe live keys, Slack tokens, PEM private keys, database URIs with inline credentials, credential-shaped assignments |
| `auth` | JWT verification bypass, session-cookie flags, state-changing routes with no visible guard |
| `access-control` | IDOR-shaped lookups, missing tenant scoping |
| `crypto` | broken hashes, fast digests used on passwords, DES/RC4/ECB, predictable randomness, disabled TLS verification |
| `data-exposure` | credentials reaching logs, cleartext `http://` endpoints |
| `configuration` | wildcard CORS with credentials, origin reflection, disabled security middleware, debug mode, unrestricted uploads |
| `supply-chain` | `curl … \| sh`, Dockerfile `ADD` from a URL |
| `dependency` | known-vulnerable packages (from the OSV audit, normalized into the same schema) |

### Languages

| Language | Pattern engine | AST + taint |
| --- | --- | --- |
| JavaScript (`.js` `.mjs` `.cjs`) | ✅ | ✅ |
| TypeScript / JSX / TSX | ✅ | ❌ — acorn cannot parse type annotations |
| Python, Ruby, Go, PHP, Java | ✅ | ❌ |
| Shell, Dockerfile, YAML, `.env` | ✅ | ❌ |

A file the AST engine cannot parse is still covered by the pattern engine, and
the response says so: `coverage.astUnparseable` lists them and the dashboard
labels them "pattern-only". **A file that could not be read is never reported
as clean.**

---

## The finding schema

```json
{
  "id": "VS-0001",
  "ruleId": "sast.sql-injection.tainted-query",
  "title": "Request data reaches a SQL query",
  "severity": "critical",
  "confidence": "high",
  "cwe": ["CWE-89"],
  "owasp": ["A03:2021-Injection"],
  "category": "injection",
  "language": "javascript",
  "module": "ast-analyzer",
  "path": "src/routes/users.js",
  "line": 42,
  "column": 15,
  "snippet": "db.query(\"SELECT * FROM users WHERE id = \" + id)",
  "evidence": {
    "source": "req.params.id",
    "sink": "db.query",
    "pattern": "taint-flow"
  },
  "recommendation": "Pass the value as a bind parameter …",
  "fingerprint": "3f2a1c04d9b7e615"
}
```

`severity`, `type`, `path`, `line`, `snippet` and `recommendation` are the
fields this endpoint has always returned. Everything else is additive, so a
stored run or an older client keeps working unchanged.

### Severity and confidence

Severity is how bad it is if real. Confidence is how sure we are it is real.
They are separate axes on purpose — a critical finding at low confidence is a
different piece of work from a medium at high confidence.

| Confidence | Means | Example |
| --- | --- | --- |
| `high` | The match **is** the defect; no benign reading exists. | a PEM private key; a proven taint flow into `exec` |
| `medium` | Nearly always the defect, but a benign spelling exists. | a SQL template literal interpolating a constant |
| `low` | A structural hint that needs human eyes. | a route with no *visible* auth guard |

A rule that would need `low` confidence to avoid false positives, and whose
finding would not be worth reading even when true, is not shipped at all.

### Fingerprints

Sixteen hex characters, derived from the rule id, the file path and the
**masked** snippet — deliberately **not** the line number. Inserting a comment
at the top of a file must not re-identify every finding below it, or a
"new findings" diff reports the whole file as new after a whitespace commit.
Two identical findings in one file are separated by an occurrence counter.

Fingerprints are never computed from unmasked secret material.

### Deduplication

The two engines overlap on purpose. `exec("ls " + req.query.dir)` is caught by
the pattern table *and* by the taint tracker — both are correct detection and
one row is correct reporting. Rules describing the same defect share a
registry `group`; within a group, findings at the same file and line collapse
to the strongest claim (severity, then confidence, then the AST engine, which
carries a source→sink path the pattern match cannot).

Secrets rules deliberately have **no** group: two different leaked credentials
on one line are two rotations, not one finding.

---

## Architecture

```
handlers/analyze.js         orchestrator: discovery, soft-fail, response
  analyzers/vuln.js         pattern engine (8 detectors + rule table)
    analyzers/secrets.js    credential formats, masking, redaction
    analyzers/sast/ast.js   acorn AST + lightweight taint tracking
    analyzers/sast/registry.js  rule metadata: CWE, OWASP, severity, confidence
    analyzers/sast/schema.js    normalize, fingerprint, dedupe, summarize
  analyzers/sarif.js        SARIF 2.1.0 for GitHub's Security tab
```

Detection logic and rule metadata are deliberately separate files. The
detectors decide *whether* a line is a finding; the registry decides what it
*means*. Without that split the two engines would drift on what CWE the same
defect maps to.

### Adding a rule

1. Add the detection to `analyzers/vuln.js` (`CODE_PATTERNS`) or
   `analyzers/sast/ast.js` (`SINKS`).
2. Add a registry entry in `analyzers/sast/registry.js` with every field —
   the test suite fails on a missing CWE, OWASP tag, or remediation shorter
   than 40 characters.
3. Add the **benign** spelling to `scripts/fixtures/sast/safe/app.js`. This is
   not optional: a rule that fires on its own documented fix gets suppressed
   wholesale, taking its true positives with it.
4. Add the vulnerable spelling to `scripts/fixtures/sast/vulnerable/app.js`.

`scripts/test-sast.mjs` derives its coverage check from what the engines
actually emit, so a detector with no registry entry fails the build rather
than shipping a finding with no remediation.

---

## Reading results

The dashboard renders source findings in their own section, never merged into
the advisory table. "A package you install has a CVE" and "a line you wrote
builds SQL from a request parameter" are different work, owned by different
people, on different timescales — one is an upgrade, the other is a code
change. Filters cover severity, category and confidence, and findings group by
file so a reviewer fixes one file at a time.

Findings also reach **GitHub's Security tab** via SARIF, with CWE and OWASP
tags as filter chips and our line-independent fingerprints so GitHub tracks a
finding across edits instead of reopening it on every commit.

---

## Limitations

Stated plainly, because a user who believes a scan is complete reads a clean
result far more strongly than it deserves.

**Taint tracking is intraprocedural.** A tainted value passed into another
function is not followed across that boundary. There is no alias analysis, so
`const o = {v: req.query.x}; sink(o.v)` is missed. Loops and branches are
walked once, not to a fixed point.

**Sanitizers are an explicit list.** A custom validator does not clear taint
and can produce a false positive. The list is short on purpose: guessing more
of them would clear taint that is still live, turning a missed finding into a
confidently clean one.

**TypeScript gets pattern coverage only.** Every taint-confirmed rule is
JavaScript-only until the parser is swapped.

**Concatenated credentials are not detected.** `"AKIA" + "..."` is not a string
literal. This is why the vulnerable fixture's secrets are not counted in its
own scan.

**Scans are bounded.** 120 files, 200 KB per file, 3 MB total, `node_modules`
/ `vendor` / `dist` / `fixtures` skipped. When the cap bites, `coverage.truncated`
says so.

**Every limitation above except the sanitizer gap is a false negative** — the
direction a security tool can afford to be wrong in. The pattern engine still
covers files the AST engine skips, so a miss degrades to the old behaviour
rather than to silence.

---

## Language auto-detection

Every repository scan begins by profiling the repository: what languages are
in it, which frameworks, which manifests, how deeply each part can be
analysed, and what will not be covered.

### Why it exists

Coverage used to be one regex of thirteen extensions in `handlers/analyze.js`.
A Rust, C#, Kotlin, Swift, Solidity or Terraform repository matched none of
them, was fetched as **zero files**, and was reported:

> No files in a language this scanner reads were found in the repository.

Which reads as *there is nothing here to scan*. It was never true — eleven
rules in the registry are tagged `languages: ["*"]` (hardcoded private keys,
cloud credentials, weak crypto, `curl | sh`) and fire on any text. The rules
existed and the files were never fetched.

The profiler now **derives** the fetch filter from the language registry, so
adding a language there is the whole of adding support: its files start being
fetched, the language-agnostic rules start firing, and the summary names it.

### Support tiers

A tier is a claim about analysis that exists **today**, not a roadmap entry.

| Tier | Name | What you get | Languages |
| --- | --- | --- | --- |
| 1 | deep semantic | Values followed from request to sink; a finding names its source | JavaScript |
| 2 | parser/AST | Parsed to a syntax tree, no dataflow | *(none yet)* |
| 3 | generic pattern | Lines matched against known-dangerous shapes | TypeScript, Python, Ruby, Go, Java, Kotlin, Scala, C#, PHP, Rust, Swift, C/C++, Objective-C, Dart, Elixir, Perl, Lua, Solidity, Shell, HTML/templates, SQL |
| 4 | dependency/config | Not read as code; secrets, config mistakes and dependencies still checked | YAML, JSON, TOML, XML, Terraform, Docker, Properties, `.env`, Gradle |

**Tier 2 is deliberately empty.** TypeScript sits at tier 3 rather than 2
because acorn treats a type annotation as a syntax error — the pattern engine
is genuinely all that runs on it. Promoting it because a TS parser is on the
roadmap would make the coverage summary a promise instead of a description.

### Analyzer routing

The tier selects the code analyzers; two decisions are made separately.

- **Secrets is unconditional.** A credential is a credential in a language
  nobody can parse.
- **Dependency analysis follows the lockfile, not the language.** It is routed
  only where `analyzers/lockfile.js` can actually parse the manifest —
  `package-lock.json`, `yarn.lock`, `requirements.txt`, `Gemfile.lock`,
  `go.sum`. `Cargo.lock`, `composer.lock`, `pnpm-lock.yaml` and `pom.xml` are
  **detected and reported as unaudited**. Routing dependency analysis wherever
  a manifest exists would put an empty result in the report, and an empty
  dependency result reads as a clean dependency tree.

### Framework detection

Signals are weighted, and every detection carries the evidence that produced
it: `dependency` and `configFile` are worth 3, `markerFile` 2, `directory` 1.
Thresholds are 3 = high, 2 = medium, 1 = low.

One cap sits on top of the arithmetic: **a detection built only from directory
names never rises above low confidence**, however many match. Two weight-1
folders would otherwise sum to "medium", which is how a static site with
`pages/` and `app/` gets announced as Next.js — sending a reviewer hunting for
`getServerSideProps` in a project that has never had any.

Detected: Next.js, React, Vue, Nuxt, Angular, Svelte/SvelteKit, Remix,
Express, NestJS, Fastify, Django, Flask, FastAPI, Rails, Sinatra, Spring/Spring
Boot, Gin, Echo, Fiber, `net/http`, Laravel, Symfony, ASP.NET Core.

### Ignore rules

Configurable per call; `DEFAULT_IGNORED_DIRS` covers vendored code
(`node_modules`, `vendor`, `site-packages`), build output (`dist`, `build`,
`.next`, `target`, `coverage`) and our own deliberately-vulnerable
`fixtures/`. The engine returns **which rule** matched, so the summary reports
`node_modules: 4,102 files` rather than an opaque total — a reader who thinks
the scan missed something needs to see what swallowed it.

### Where to get it

| Surface | How |
| --- | --- |
| Inside a scan | `source.profile` and `source.profileSummary` on `POST /api/analyze/vuln` with a `repoUrl` |
| Standalone | `POST /api/analyze/profile` — `{ repoUrl }`. Free and unmetered: one tree listing, no file reads |
| MCP | `algosize_profile_repository` |
| Dashboard | The coverage strip above source findings, with a per-language tier stripe |

There is no CLI in this product, so there is no `scanner detect-languages`
command; the API and MCP tool are the equivalents.

`POST /api/analyze/profile` is deliberately unmetered. Its whole purpose is to
answer *"would a scan even cover my repository?"* before you pay for one, and
metering that question is how a scanner earns a reputation for being useless
on languages it never said it could not read.

### Example

```json
{
  "repositoryProfile": {
    "languages": [
      { "name": "JavaScript", "fileCount": 12, "extensions": [".js"],
        "supportTier": 1, "supportTierLabel": "deep semantic scan",
        "analyzers": ["taint", "pattern", "secrets", "dependency"],
        "evidence": ["next.config.js", "src/lib/db.js"] },
      { "name": "Rust", "fileCount": 2, "extensions": [".rs"],
        "supportTier": 3, "supportTierLabel": "generic pattern scan",
        "analyzers": ["pattern", "secrets"],
        "evidence": ["services/worker/src/main.rs"] }
    ],
    "frameworks": [
      { "name": "Next.js", "language": "javascript", "confidence": "high",
        "evidence": ["dependency: next", "file: next.config.js"] }
    ],
    "scanPlan": {
      "selectedAnalyzers": ["dependency", "pattern", "secrets", "taint"],
      "dependencyAudit": { "available": true, "from": ["package-lock.json"] },
      "gaps": [
        { "kind": "dependency_manifest_unsupported",
          "detail": "Found cargo.lock, which the dependency audit cannot parse. Those packages are not checked against advisories." }
      ]
    }
  },
  "summary": "Detected JavaScript and Rust. JavaScript gets deep semantic scan — values are followed from request to sink…"
}
```

### Limitations

- **Detection is path-first.** Content is sampled only from manifests the scan
  already fetched, so a language embedded in an unusual extension is missed.
  This is a deliberate performance trade: profiling 5,000 paths takes ~30ms.
- **Generated lockfiles are recognised but not downloaded.** Detection from a
  path is free; fetching `package-lock.json` would spend the scan's 120-file
  and 3 MB budgets on machine-written JSON.
- **A tier-3 language gets no dataflow.** Findings that depend on following a
  value across statements are not reported for anything but JavaScript.
- **Framework detection is a heuristic.** It reports confidence and evidence
  rather than certainty, and a low-confidence detection should be read as
  "this is worth checking", not as a fact.

## Scheduled scanning

A monitor's nightly sweep runs the source scan on every pass, stores what it
found (`migrations/0024`), and diffs it against the previous night.

| | |
| --- | --- |
| **Scorecard** | Two columns, not one. **Dependencies** grades the advisory list; **Code** grades source findings by worst severity. |
| **Alerts** | Only findings that are *new since the last sweep*. The first scan of a repository is a baseline and never mails. |
| **Email contents** | Rule, file and line. Never the matched snippet — see below. |
| **Unreadable source** | Recorded as a skip, rendered "not measured". Never an empty finding list. |

Those two columns were one column called "Security" until it became possible
for the grid to be confidently wrong: a repository with no vulnerable packages
and a critical SQL injection in its own code graded **A · 0**. The scan had
run. The finding existed. It was simply not wired to a cell, and the cell that
did exist described only the half that looked good.

**Why the email omits snippets.** Every other surface shows the matched line,
because the reader asked to see it. An alert email is broadcast to every
subscribed member and retained in their mailboxes indefinitely. The scanner
masks credentials in snippets, but "masked" is a weaker guarantee than "never
sent", and `path:line` is enough to act on.

**Baseline truncation.** A baseline stores at most 500 fingerprints. If a scan
exceeds that, the baseline is marked truncated and the *next* sweep
re-baselines rather than diffing — because the fingerprints the cap dropped
are absent from the stored set, and diffing against it would report them all
as new findings tonight on a codebase where nothing changed.

## Roadmap

1. **TypeScript AST coverage.** The largest single gap, and the one that would
   move TypeScript from tier 3 to tier 1; needs a TS-aware parser inside the
   Worker's bundle budget.
2. **Interprocedural taint.** Build a call graph and follow tainted arguments
   into callees — the change that would move several `medium` rules to `high`.
3. **Framework-aware authorization.** Model the router's middleware chain so
   `missing_auth_guard` and `missing_ownership_check` can move above `low`.
4. **Suppression comments.** `// algosize-ignore-next-line <ruleId> — reason`,
   with the reason required and surfaced in the report, so suppressions stay
   auditable rather than invisible.
5. **CI gate for source findings.** The nightly sweep now grades code (see
   below); the PR gate still comments on dependencies and architecture only.
