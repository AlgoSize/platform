# Fix orchestration

Turning findings into validated, reviewable fixes — and letting other agents
do the same through MCP.

The scanner half of the platform is documented in
[SECURITY-SCANNING.md](SECURITY-SCANNING.md). This document covers what
happens **after** a finding exists.

---

## The pipeline

```
finding ─▶ eligibility ─▶ FixTask ─▶ agent provider ─▶ FixProposal
                                          │
                    ┌─────────────────────┘
                    ▼
             static validation ─▶ verdict + patch + blast radius
                    │
                    └─▶ AgentExecutionRecord (hashes only) ─▶ audit log
```

Every stage is a separate module, and each is testable on its own:

| Subsystem | File | Responsibility |
| --- | --- | --- |
| Schemas + prioritization | `worker/src/fix/schemas.js` | Versioned contracts; triage scoring |
| Diff + blast radius | `worker/src/fix/diff.js` | Unified patch from ground truth |
| Agent providers | `worker/src/fix/providers.js` | Transport to Kimi / Claude / OpenAI |
| Orchestrator | `worker/src/fix/orchestrate.js` | Eligibility, context packets, retry |
| Validation | `worker/src/fix/validate.js` | Static checks, re-scan, refusals |

Repository profiling, language detection, scanning, normalization and SARIF
export already existed; this work extended them rather than duplicating them.

---

## Data model

All versioned, all tagged on the object itself (`schema: "algosize.…/1"`).

| Schema | Produced by |
| --- | --- |
| `RepositoryProfile`, `ScanPlan` | `sast/profile.js` |
| `Finding` | `sast/schema.js` |
| `FixTask` | `fix/orchestrate.js` |
| `FixProposal` | `fix/schemas.js` (from a provider reply) |
| `ValidationResult` | `fix/validate.js` |
| `RemediationAction` | `fix/schemas.js` |
| `AgentExecutionRecord` | `fix/orchestrate.js` → audit log |

Bump the major version when a reader of the old shape would **misread** the
new one. Additive optional fields do not bump it.

### Proposals are not persisted

A `FixProposal` contains the customer's source and a model's rewrite of it.
The platform's standing rule — *paths and identities only, never fetched file
contents* — applies here exactly as it does to scans.

What **is** durable is the `AgentExecutionRecord`: who asked, which finding,
which provider and model, content **hashes**, the verdict, and the blast
radius. Enough to audit every action; nothing that copies source into a
database. This is asserted in the test suite, not merely intended.

---

## Prioritization

Severity alone cannot answer *"which of these four highs first?"* The score is
a documented heuristic, and every term is explainable to the person reading
the queue:

```
score = severity × confidence × categoryPrior × taintEvidence
```

- **confidence** matters as much as severity: a low-confidence critical sorts
  below a high-confidence high, because chasing likely-real issues beats
  chasing scary maybes.
- **category prior** encodes exploitability — a reachable injection or a live
  credential outranks a weak hash in dead code.
- **taint evidence** boosts a finding with a traced source→sink path, which is
  evidence a line match cannot have.

`priorityOf()` returns the score **and its terms**, so a UI can answer "why is
this first?" without re-deriving anything.

---

## Agent providers

An adapter knows how to reach one vendor and ask it for structured output. It
does not know what a finding is worth, whether a proposal is safe, or what
happens next.

> **The test for whether logic belongs in an adapter:** would it change if the
> platform swapped every rule pack tomorrow? If no, it is transport. If yes,
> it belongs in the orchestrator.

| Provider | Transport | Credentials |
| --- | --- | --- |
| `kimi` | Workers AI leg of `llmChat` (K3 via AI Gateway, else K2.6) | **keyless** on a deployed Worker |
| `claude` | Anthropic Messages API | `ANTHROPIC_API_KEY` |
| `openai` | OpenAI leg of `llmChat` | `OPENAI_API_KEY` |

Adapters pin their vendor by handing `llmChat` an env containing only that
vendor's credentials — so retries, timeouts, gateway routing and reply
extraction exist exactly once, in `analyzers/llm.js`.

Each implements `createFixProposal`, `retryFixWithConstraints`, `explainFix`,
`summarizeRisk`; `compareAlternativeFixes()` runs several and returns each
result **as it came back, unranked** — the validator scores safety and a human
picks. An LLM judging LLM output would add a third opinion, not ground truth.

### Claude Code is a client, not a provider

The `claude` adapter is the Anthropic **API**. Claude Code connects from the
other side, as an **MCP client** of the tools below, applying patches to its
own local checkout. A Worker has no checkout for it to apply anything to.

### The output contract

One JSON object: `{ explanation, files: [{path, content}], riskNotes }`.

**Full file content, never a diff.** A model-authored diff mis-anchors
silently; a full file either is or is not what the model meant, and the
platform computes its own diff from ground truth.

---

## Validation

A Worker cannot execute the customer's code. Pretending otherwise is how a fix
platform ships regressions with a green badge on them.

**Checks that run:**

| Check | What it proves |
| --- | --- |
| `structural` | Something changed, and only files the task offered |
| `parse` | Changed JavaScript still parses (acorn) |
| `target_removed` | The finding's fingerprint is gone **and** the same-rule count dropped |
| `no_new_severe` | Re-scan introduced nothing at high/critical |
| `blast_radius` | The change is small enough to review as a security patch |

**Checks that do not, and say so on every result:** `tests`, `build`,
`linters`.

The verdict vocabulary is `passed_static` or `failed`. **There is no bare
"passed"** — tests and builds run where code runs, exactly as the optimizer
gate measures in the customer's runner and labels it `measuredBy: "ci_runner"`.

`target_removed` deliberately requires *both* the fingerprint gone *and* a
lower same-rule count: a re-spelled version of the same bug gets a new
fingerprint, and only the count catches it.

---

## Surfaces

| Surface | Entry point |
| --- | --- |
| API | `POST /api/fix/propose`, `POST /api/fix/validate`, `GET /api/fix/rule`, `POST /api/import/sarif` |
| MCP | `algosize_propose_code_fix`, `algosize_validate_fix`, `algosize_explain_finding` |
| CLI | `worker/scripts/algosize.mjs` |
| Dashboard | "Generate validated fix" on any source finding |

### The MCP division of labour

- **The agent owns the checkout** — files, git history, branch, credentials.
- **The platform owns judgement** — it scans, fingerprints, proposes, and
  validates *any* fix with the same engine that found the problem.

`algosize_validate_fix` closes the loop: an agent edits its own files, then
asks the scanner whether the bug is actually gone. Symmetric validation is the
point — a fix is judged by what it does to the code, not by who wrote it.

**There is no `apply_patch`, `create_branch` or `create_pr` tool.** The Worker
holds no repository write credential (an API key that could push code is a far
larger secret than any it currently keeps), and a tool that cannot do the thing
should not exist. Applying belongs to whoever holds the checkout: the CLI, a CI
job, or the MCP client.

### CLI

```bash
export ALGOSIZE_API_KEY=ask_live_…

node scripts/algosize.mjs profile-repo https://github.com/o/r
node scripts/algosize.mjs scan        https://github.com/o/r
node scripts/algosize.mjs generate-fix --finding f.json --file src/app.js
node scripts/algosize.mjs apply-fix fix-fixt_….json --branch fix/sqli
```

`apply-fix` refuses a proposal that did not pass validation, refuses to write
outside the working directory, and does **not** push — it prints what to do
next and leaves the commit and PR to you.

---

## SARIF interop

**Export** (pre-existing): findings → SARIF → GitHub code scanning.

**Import** (new): any scanner's SARIF → normalized findings, so external
results flow through the same grouping, prioritization and fix pipeline.

- Severity from `security-severity` when present, else `level`. A bare `error`
  maps to **high, never critical** — three levels cannot express critical, and
  inventing it would overclaim on every imported error.
- Rule ids namespaced `sarif.<tool>.<id>`, with the original preserved in
  `evidence.importedRuleId` — the mapping back that interop requires.
- Confidence capped at **medium**: we vouch for the mapping, not the finding.
- Unreadable results are skipped and **counted**, never silently dropped.

Imports are a view, not a stored run — filing another tool's verdict in the
runs feed would let it masquerade as one of ours.

---

## Safety

- **Nothing is auto-applied.** The pipeline ends at a validated proposal.
- A proposal touching a file the task did not offer is **refused outright**,
  not trimmed — a model writing outside its brief has misunderstood the brief.
- Exactly **one** constrained retry. A model that misses twice with the failure
  spelled out is telling you the finding needs a human.
- Blast radius is recorded on every proposal and bounded.
- Every execution writes an audit row — **including failures**. "Who asked an
  agent to rewrite what" must not depend on the agent doing well.
- Files over 48 KB are ineligible. A model rewriting a file it cannot fully see
  is how fixes delete code they never read.

---

## Limitations

- **Single-file fixes.** A task carries the one file the finding names.
  Cross-file refactors are out of scope for now.
- **Single-hunk diffs.** Exact for contiguous edits — which security fixes
  overwhelmingly are — and merely coarser, never wrong, for scattered ones. The
  output labels itself `granularity: "single-hunk"`.
- **JavaScript parse checking only**, matching the AST tier. Other languages
  get every check except `parse`.
- **No test execution**, by construction. Named on every result.
- **Batch remediation is not built.** The pieces exist (prioritized queue,
  per-finding pipeline) but campaign flows — select N, track progress, one
  branch — are future work.

## Next steps

1. Batch/campaign remediation over the prioritized queue.
2. Multi-file fix tasks, once cross-file taint exists to justify them.
3. A CI mode that proposes fixes on a PR and posts them as review suggestions.
4. Provider adapters for OpenAI-Codex-style and internal agent runtimes — the
   contract is already vendor-neutral.
