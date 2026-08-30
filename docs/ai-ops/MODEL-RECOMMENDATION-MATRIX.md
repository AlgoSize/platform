# Model recommendation matrix

The curated Algosize model shortlist — not a catalog dump. Generated from the
live registry `worker/src/ai/models.js`; prices from `worker/src/ai/pricing.js`
(Cloudflare Workers AI models page, relayed 2026-08). Regenerate this table from
the registry rather than editing it by hand.

Scores are 0–100, higher-is-better on every axis. **costScore** is anchored to
the sourced output-price ladder; **capability / coding / latency** are
engineering estimates (`scored: false`) — good to rank and graph, not a
published benchmark.

## Shortlist

| Model | Slug | cap | code | cost | lat | Task fit (family:tier) |
| --- | --- | --: | --: | --: | --: | --- |
| BGE-M3 embeddings | `@cf/baai/bge-m3` | 62 | 0 | 99 | 96 | embeddings:primary |
| Qwen3 embeddings 0.6b | `@cf/qwen/qwen3-embedding-0.6b` | 60 | 0 | 99 | 96 | embeddings:secondary |
| BGE reranker base | `@cf/baai/bge-reranker-base` | 55 | 0 | 100 | 94 | reranking:primary |
| Granite 4.0 H Micro | `@cf/ibm-granite/granite-4.0-h-micro` | 58 | 40 | 95 | 92 | summarization:primary · finding_explanation:primary · triage:primary · moderation/support:budget |
| GLM-4.7 Flash | `@cf/zai-org/glm-4.7-flash` | 68 | 52 | 74 | 84 | support_chat:primary · report_writing/finding_explanation/summarization:secondary |
| Qwen3 30B A3B fp8 | `@cf/qwen/qwen3-30b-a3b-fp8` | 78 | 66 | 78 | 66 | vuln_classification:primary · triage/fix_suggestion/report_writing:secondary |
| GPT-OSS 20B | `@cf/openai/gpt-oss-20b` | 76 | 62 | 82 | 70 | triage:primary · finding_explanation/vuln_classification:secondary |
| DeepSeek V4 Flash | `@cf/deepseek-ai/deepseek-v4-flash-0731` | 85 | 80 | 45 | 55 | fix_suggestion:primary · multifile_fix/repo_summarization:secondary |
| GLM-5.3 Flash | `@cf/zai-org/glm-5.3-flash` | 82 | 82 | 70 | 68 | fix_suggestion:primary · multifile_fix:secondary |
| GLM-5.3 | `@cf/zai-org/glm-5.3` | 92 | 92 | 12 | 45 | multifile_fix:primary · fix_suggestion:secondary |
| Kimi K2.7 Code | `@cf/moonshotai/kimi-k2.7-code` | 88 | 93 | 15 | 50 | multifile_fix:primary · fix_suggestion:primary |
| Gemma 4 26B | `@cf/google/gemma-4-26b-a4b-it` | 74 | 40 | 82 | 62 | visual_reasoning:primary |
| Kimi K2.6 (wired default) | `@cf/moonshotai/kimi-k2.6` | 70 | 58 | 90 | 85 | summarization/finding_explanation/triage:secondary |
| ~~Kimi K2.5~~ | `@cf/moonshotai/kimi-k2.5` | — | — | — | — | **DEPRECATED — never a default** |
| ~~BART-large-CNN~~ | `@cf/facebook/bart-large-cnn` | — | — | — | — | **DEPRECATED — never a default** |

## Default tiering (the cost ladder)

- **Retrieval:** `bge-m3` (or `qwen3-embedding-0.6b`) → `bge-reranker-base`
- **Cheap assistant:** `granite-4.0-h-micro`
- **Standard reasoning:** `qwen3-30b-a3b-fp8` or `gpt-oss-20b`
- **Premium remediation:** `glm-5.3-flash` → `glm-5.3` / `kimi-k2.7-code` for the
  hard jobs
- **Vision:** `gemma-4-26b-a4b-it`

`recommend("multifile_fix")` today ranks **Kimi K2.7 Code → GLM-5.3 → GLM-5.3
Flash**; `recommend(..., { budget: true })` reweights toward cost.

## Never-LLM (carried from the use-case map)

Vulnerability detection and fix **validation** (`fix/validate.js`) stay
deterministic. A model may explain or draft; it may never be the thing that
decides whether code is safe. `recommend()` covers generation tasks only — it
has no entry for "decide if this fix is correct."

## Deprecated policy

`kimi-k2.5`, `bart-large-cnn`, and any old llama/gemma/mistral entries are
`deprecated: true` in the registry: excluded from `recommend()` and from graph
datasets by default, refused for new pricing by `costOf`. Do not promote a
deprecated model to a default even if it still appears in the Cloudflare
catalog.


---

## The Model explorer (`#/models`)

The read-only view over this registry, under Workspace beside the Fix pipeline.
Three views over one dataset, all served by `GET /api/ai/models`:

| View | Query | What it answers |
| --- | --- | --- |
| Scatter | `?graph=cost_vs_capability \| latency_vs_quality \| cost_vs_autofix` | where a model sits on two axes at once |
| Fit matrix | `?graph=model_fit_by_task` | which model is rated for which job |
| Recommend | `?task=<family>` | the ranked list `recommend()` would return |

Plus `?includeDeprecated=1` (the Show-superseded toggle) and `?taskFamily=<id>`
(narrow a plot to models rated for one job). Unknown values are rejected by
name — `invalid_graph`, `invalid_task`, `invalid_task_family` — never silently
defaulted. Adding these filters is what gave the toggle a server side; it had
none, and `graphData` had supported them since it was written.

### Every axis is oriented so higher is better

Including cost, which plots **efficiency, not price**. That makes the top-right
corner the best corner on all three plots, so a reader learns the convention
once instead of per-plot. The speed plot's y axis is labelled *capability*
rather than *quality*, because capability is what it plots — there is no
separate quality score in this registry, and naming one would invent a
measurement the data does not contain.

### Three things the explorer must not soften

1. **The scores are estimates.** `capability`, `coding` and `latencyScore` are
   seeded engineering judgements, flagged `scored: false`. Only `costScore` is
   anchored to the sourced price ladder. The page says so in the tooltip and in
   the standing caveat; a 0–100 number with no such note reads as a benchmark.
2. **`avoid` ≠ `unrated`.** A pairing somebody looked at and rejected is a
   different fact from one nobody rated, and the matrix renders them as
   different marks (`✗` vs `·`). `graphData` used to return tier-or-`null` and
   collapse the two. `bestTierOf()` also refuses to colour an avoid-only model
   as though it had earned a tier.
3. **The prices are relayed.** `PRICE_PROVENANCE` in `ai/pricing.js` is the one
   place the date, source and caveat live, and the banner is rendered from it —
   so refreshing the prices refreshes the caveat instead of leaving stale copy
   behind. If a client receives no provenance at all, the page says the figures
   are *unsourced* rather than dropping the warning.

An empty recommendation is `empty: true`, not an absent key: nothing on the
shortlist scored well enough for that job, so it runs deterministically or not
at all. That is a deliberate blank, not a hole in the data.

### Cloudflare-side work: none

The explorer reads the in-repo registry through the already-deployed Worker —
no binding, no table, no migration, nothing to provision. The one thing that
would change what it shows is the **price reconciliation** already tracked as
Prompt 1 in [REPLIT-PROMPTS.md](./REPLIT-PROMPTS.md): that job is what would
let `PRICE_PROVENANCE.confirmedAgainstBill` flip to `true`, at which point the
banner stops saying "relayed, not confirmed" on its own.
