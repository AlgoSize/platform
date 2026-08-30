# Multi-model fix pipeline

A relay, not a single call. Findings flow through five stages, each on the
cheapest model that can do that stage's job, so the platform never routes every
finding through one expensive model.

```
Stage 1  deterministic detection   SAST + regex + manifest   (no LLM)
Stage 2  fast triage / FP filter    triage.js                 cheap model
Stage 3  deep validation (+vote)     deepvalidate.js           reasoning model(s)
Stage 4  fix generation             orchestrate.js            coding model
Stage 5  cross-model verification    verify.js                 a DIFFERENT model
```

## Why five stages

Deterministic SAST is tuned for **recall** — it flags everything that matches a
pattern or a taint shape, which means a real share of its hits are false
positives. Routing every one of those straight to a flagship coding model is
slow and expensive, and asking one model to both find and fix and check its own
work removes the independent second opinion that catches its mistakes. The
relay splits the work so each decision is made by a model suited to it, and the
fix is checked by a model that did not write it.

> **Claims discipline.** The research this design draws on reports large
> false-positive reductions from hybrid SAST+LLM pipelines and from combining
> diverse models. Those figures are **not** reproduced as product claims
> anywhere in this codebase or its copy — they motivated the architecture, they
> are not measured results of *this* implementation, and several of the cited
> sources could not be independently verified from this environment. The
> pipeline is built to be sound on its own terms (every stage measured, every
> unmeasured result flagged), not to hit a borrowed statistic.

## Model routing — never a hardcoded slug

Every stage picks its model through `src/ai/routing.js`, in order:

1. **`model_routing_config`** (D1, migration 0026) — an operator override for a
   `(stage, cwe_family, file_language, complexity)` key, versioned by an
   effective window so a routing change is a new row, never a mutation. Ships
   **empty**: with no rows, every stage falls back to (2).
2. **the recommendation engine** — `recommend(taskFamily)` from
   `src/ai/models.js`, the curated, priced shortlist. The code default and the
   only source of truth for which models exist.

So routing never names a model of its own — it maps a stage to a task family
and defers to `recommend()`.

### The model remap

The architecture brief named models that are **not** in our priced Cloudflare
Workers AI registry (deepseek-r1, qwq-32b, gpt-oss-120b, qwen2.5-coder,
llama-3.3-70b, …). Routing through `recommend()` remaps each stage onto models
we actually price and can bill — inventing an unpriced slug would meter as
unpriced (null cost, never $0), which the metering layer refuses to hide.

| Stage | Task family | Routed models (best-first) |
| --- | --- | --- |
| 2 Triage | `triage` | `gpt-oss-20b`, `granite-4.0-h-micro`, `qwen3-30b` |
| 3 Validate | `vuln_classification` | `qwen3-30b`, `gpt-oss-20b`, `deepseek-v4-flash` |
| 3 Ensemble (critical) | `vuln_classification` | the three above, as three distinct voters |
| 4 Fix (multi-file) | `multifile_fix` | `kimi-k2.7-code`, `glm-5.3`, `glm-5.3-flash` |
| 4 Fix (single-file) | `fix_suggestion` | `kimi-k2.7-code`, `deepseek-v4-flash`, `glm-5.3-flash` |
| 5 Verify | `vuln_classification` **minus the fixer** | best remaining reasoning model |
| Retrieval | `embeddings` / `reranking` | `bge-m3`, `bge-reranker-base` |

## The stages

### Stage 2 — triage (`src/fix/triage.js`)
A cheap model reads each finding plus ~30 lines of surrounding code and returns
`tp` / `fp` / `escalate`. A `fp` **suppresses** the finding from the fix funnel
— it does not delete it or mark the code clean. Two guards:
- **FP confidence floor (0.7).** An under-confident `fp` is forced to
  `escalate`. A cheap model unsure a finding is fake is exactly the one a human
  should see; suppressing a real vulnerability on a low-confidence hunch is the
  fix-side version of rendering unmeasured code as clean.
- **Fail safe.** An unparseable reply is `escalate`, never a silent `fp` — the
  filter never fails open and drops a real finding.

### Stage 3 — deep validation + ensemble (`src/fix/deepvalidate.js`)
Survivors get a reasoning model, the full function, the taint path, and
framework context, and are judged for **exploitability**, taint path, and
severity. For **critical** findings this is an ensemble: three distinct models
vote independently, and
- a majority (default 2/3) "exploitable" → **proceed** to a fix,
- a split vote → **escalate** to a human (never resolved to the cheaper
  answer),
- unanimous "not exploitable" → **drop**,
- no usable verdict → **unmeasured** (not "safe").

A model's verdict is an opinion that routes a finding; it is never persisted as
the durable truth of whether the code is vulnerable.

### Stage 4 — fix generation (`src/fix/orchestrate.js`, existing)
Reuses the merged fix orchestrator (task → provider → static validation → one
constrained retry). The pipeline routes its coding model by scoping
`WORKERS_AI_MODEL` for that call — the same override `llmChat` already honours —
so the orchestrator's provider selection is unchanged. Prior fixes retrieved by
the support layer are handed in as context when available.

### Stage 5 — cross-model verification (`src/fix/verify.js`)
A model **different from the fixer** reviews the patch against the original
finding and code: does it remove the issue without introducing a new one? This
runs *alongside* the deterministic static validation (parse + full re-scan +
blast radius) the orchestrator already does — measured ground truth is
authoritative, and a static-validation **failure** sends the fix to a human no
matter what a verifier would say. The verifier-≠-fixer rule is a hard
invariant: if routing can only offer the fixer's own model back, verification
returns `escalate` (`no_distinct_verifier`) rather than self-reviewing. A
rejected fix earns up to two more fix attempts with the reviewer's issues folded
in; still rejected → a human.

## Outcomes

Every finding ends on exactly one outcome (`src/fix/pipeline.js`):

| Outcome | Meaning |
| --- | --- |
| `fix_ready` | passed static validation **and** cross-model verification — the only "done" |
| `needs_human` | reached a stage that needs a person (split vote, rejected/failed fix, unmeasured) |
| `fix_queued` | validated, but fix deferred by the budget funnel |
| `suppressed_fp` | triage confidently judged it a false positive |
| `not_exploitable` | validation / ensemble found it not exploitable |
| `budget_blocked` | over budget: detected only, surfaced "pending AI analysis" |
| `ineligible` | cannot become a fix task (dependency advisory, file too large) |
| `error` | a stage failed in a way that is not a verdict |

## Running it — `POST /api/pipeline/run`

Until this endpoint landed, `runFullPipeline` had **no caller**: the orchestrator
was fully built and fully tested, but nothing in the Worker ever invoked it, so
`waiting_for_agent` was an outcome no finding could actually reach and the Fix
Pipeline page could configure a pipeline it had no way to start.

Two input modes, mirroring `POST /api/fix/propose`:

```jsonc
// A stored scan: the Worker refetches only the files the findings name.
{ "runId": "run_…", "config": { "triage": "@cf/…", "fix": "@cf/…" }, "routeToMcp": ["fix"] }

// The caller holds the source (MCP client with a checkout, the CLI, a test).
{ "findings": [ … ], "files": [ { "path": "…", "content": "…" } ], "config": { … } }
```

- **The config is validated before any model is called.** A configuration the
  dashboard would reject inline is rejected here too (`422`, with the same
  per-stage `errors` array), so an invalid pipeline costs nothing and cannot be
  smuggled past the UI by posting directly.
- **Routing the fix stage means no source is fetched at all.** The run stops at
  validation and parks, so there is no patch to generate and nothing to read.
- **Caps are reported, not hidden.** `coverage.capped` says when only the first
  N findings were run; a run that examined 50 of 300 and reported three
  fix-ready findings would otherwise read as a clean sweep.
- The result is attached to the scan run under `result.pipeline`, which is what
  lets `GET /api/fix/handoff` return the parked set rather than the raw scan.

### The handoff hands over what the funnel parked

`GET /api/fix/handoff` reports its `selection`:

| `selection` | Meaning |
| --- | --- |
| `parked` | the pipeline ran; these findings passed triage **and** validation and are waiting for an agent |
| `all_findings` | no pipeline result on this run — this is the raw scan, untriaged |

The distinction matters because handing an agent a raw scan and calling it a
handoff sends it exactly the false-positive noise the first three stages exist
to remove, on the customer's own tokens.

The generated prompt carries the MCP connection command for the chosen agent
(Claude Code, Kimi, or a generic MCP host) and names `ASK_LIVE_KEY` **as a
variable only** — the server holds no plaintext key and none is ever rendered,
logged, or copied.

## The cost funnel is a blend, not a sum

`estimatePipelineCost` prices each stage at **its own share of the findings**:

| Stage | Share | Why |
| --- | --- | --- |
| S1 detect | 100% | deterministic rules, $0 — no model |
| S2 triage | 100% | cheap enough to see everything |
| S3 validate | ~15% | only what survives triage |
| S4 fix | ~10% | only what validation confirms |
| S5 verify | ~10% | one per patch |

Charging every stage at full volume quotes **roughly 4× the real cost**, because
the coding model — by far the most expensive — sees about a tenth of what
detection produces. Each `perStage` row therefore reports both figures:
`algosizePricePerRun` (what one finding costs *if* it reaches that stage) and
`algosizePrice` (that figure at the stage's share, which is what sums to the
total).

**An unpriced stage has no total, not a smaller one.** If any selected model has
no published rate, `perFinding.algosizePrice` is `null` with `partial: true` and
`unpricedStages` naming the culprit — and the page renders the word *partial*.
This is deliberately stricter than the admin rollups, which show a labelled
lower bound: an operator reading a dashboard can act on "at least $X", but a
customer-facing **price** cannot be a number we are unable to stand behind.

## Routing S4 parks S5 with it

`expandRouting` applies the coupling in one place, consumed by the estimate, the
validator and the orchestrator alike. The agent that writes a patch in its own
checkout is the only party holding it, so an "S4 routed, S5 in-house" pipeline
would be verifying a patch it never received.

Two consequences:

1. Both stages bill $0 Workers AI.
2. The **S5 ≠ S4** rule is not enforced on them. It exists to stop a fix being
   graded by its own author *inside Algosize*; when the agent runs both there is
   no in-house grader to conflict with, and rejecting there would teach someone
   to clear a field to get past an error about nothing.

The **verdict** is still Algosize's either way: a patch handed back through
`algosize_record_patch` goes through the same static validation as an in-house
one. What moves to the agent is the model work, not the judgement.

## Budget funnel

The pipeline gates on the **customer-billed** spend (`algosize_price`, incl. the
25% platform margin — see [WORKERS-AI-METERING-PLAN.md](./WORKERS-AI-METERING-PLAN.md)),
passed in from the `ai_usage` rollup:

- **under 80%** → run all five stages.
- **80–100%** → run detection → validation (validation is a safety stage and
  always runs), but **queue** fix generation/verification. Findings return
  `fix_queued`.
- **at/over 100%** → detection only. Findings return `budget_blocked`, surfaced
  **without** AI enrichment and flagged "pending AI analysis — budget limit
  reached." Never silently dropped.

Every stage call is metered through `recordAiUsage` with its own `feature_name`
(`fix_triage`, `fix_validate`, `fix_ensemble`, `fix_proposal`, `fix_verify`), so
the funnel's cost is measured the same way as everything else — including the
Stage-4 fix call, which now carries its real token usage rather than recording a
fix as $0.

## Support layer — retrieval (`src/ai/retrieval.js`)

Runs **parallel** to the pipeline, never in its critical path. Embeds findings
with `bge-m3` into a Cloudflare **Vectorize** index and, at fix time, retrieves
and reranks the closest prior fixes as context for Stage 4. It stores only a
**source-free descriptor** (ruleId, category, fingerprint, hashes) — never file
content — matching the fix platform's standing rule. It is **best-effort**:
Vectorize is a binding an operator must provision, and every function degrades
to `{ available: false }` when it is absent. A fix generated without prior art
is a normal fix, not a failure.

## What runs where

| Piece | Where | Access |
| --- | --- | --- |
| Stages 2/3/5, routing, pipeline, budget funnel | repo | none |
| Stage 4 (reuses merged orchestrator) | repo | none |
| `POST /api/pipeline/run`, the estimate, the handoff | repo | none |
| `AI_BUDGET_USD` (optional; unset = tracked, not capped) | operator | Worker var |
| `model_routing_config` overrides | operator (D1) | SQL |
| **Vectorize index** for retrieval | operator / Replit | Cloudflare binding |
| AI Gateway (routing/observability for the calls) | operator / Replit | Cloudflare |

The Vectorize and AI Gateway provisioning are Cloudflare-access jobs — see
[REPLIT-PROMPTS.md](./REPLIT-PROMPTS.md).
