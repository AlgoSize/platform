# AI graphs data plan

Graph-ready datasets for the model explorer, served from the registry
(`worker/src/ai/models.js` → `graphData()`). All axes are normalized
higher-is-better, so every scatter reads the same way: **top-right is best**.

## The four graphs

| # | Graph | `kind` | x | y | Reads |
| --- | --- | --- | --- | --- | --- |
| 1 | Cost vs Capability | `cost_vs_capability` | costScore (cheaper →) | capability | pick a model per task |
| 2 | Latency vs Quality | `latency_vs_quality` | latencyScore (faster →) | capability | operational defaults |
| 3 | Cost vs Autofix suitability | `cost_vs_autofix` | costScore (cheaper →) | **coding** | which models can draft code safely |
| 4 | Model Fit by Task Family | `model_fit_by_task` | — | — | a family × model tier heatmap |

Graph 3's y-axis is deliberately the **coding** score, not general capability —
"can this model be trusted to touch code" is a different question from "is it
smart", and conflating them is how a cheap-but-non-coding model looks safe for
autofix.

## Shape

Scatter kinds return:

```json
{ "kind": "cost_vs_capability",
  "x": { "key": "costScore", "label": "Cheaper →" },
  "y": { "key": "capability", "label": "More capable →" },
  "points": [ { "model": "...", "label": "...", "x": 45, "y": 85,
                "deprecated": false, "scored": false,
                "p50Ms": 2000, "contextWindow": 128000 } ] }
```

`model_fit_by_task` returns `{ kind, families[], rows: [{ model, label,
deprecated, fit: { family: tier|null } }] }` for the heatmap.

## Filters

`graphData(kind, filter)` accepts `{ taskFamily, provider, includeDeprecated }`.
Deprecated models are **excluded by default** and only returned with
`includeDeprecated: true` — the same discipline `recommend()` uses. The `scored`
flag on every point lets the UI badge estimated scores honestly rather than
implying benchmark precision.

## The current positions (from the live registry)

Cost vs Capability, roughly:

- **bottom-right (cheap, capable-enough):** `bge-*`, `granite`, `kimi-k2.6`
- **mid:** `glm-4.7-flash`, `qwen3-30b`, `gpt-oss-20b`, `glm-5.3-flash`, `gemma-4`
- **top-left (dear, top capability):** `glm-5.3`, `kimi-k2.7-code`, `deepseek-v4-flash`

The premium coding models sit top-**left** on cost-vs-capability (expensive) but
top-**right** on cost-vs-autofix relative to non-coders, which is exactly the
selection tension the two graphs exist to show.

## Serving it

The selectors are pure and tested; the HTTP surface is a thin follow-up:

- `GET /api/ai/models/graph?kind=cost_vs_capability&taskFamily=…` → `graphData(...)`
- `GET /api/ai/models/recommend?task=multifile_fix&budget=1` → `recommend(...)`
- `GET /api/admin/ai/usage?...` → `aggregate.js` rollups over `ai_usage`

All org-scoped, `org_id` filtered first. The datasets themselves need no new
data — they are computed from the registry — so the graphs can ship ahead of the
usage table filling up. Usage-driven panels (cost trend, top expensive, budget
vs limit) come online as `ai_usage` accumulates rows.

## Tests

`scripts/test-ai-metering.mjs` covers dataset shape, the default-exclude of
deprecated models, `includeDeprecated`, the autofix y-axis being `coding`, the
family × model matrix, and that an unknown `kind` throws rather than returning
junk.
