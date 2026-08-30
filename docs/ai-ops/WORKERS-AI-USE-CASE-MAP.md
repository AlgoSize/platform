# Workers AI use-case map

Which model class fits which Algosize job — mapped to the **real** call sites
(the four the audit found), not a generic model list. For each job: is an open
Workers AI model enough, or should Claude Code / Kimi K3 handle it, and must it
be metered.

The organizing principle: **Workers AI for bounded, low-stakes generation where
a small open model is good enough and latency/cost matter; a frontier model
(Kimi K3, Claude) for repository-aware, multi-file, correctness-sensitive work;
and no model at all for anything the platform vouches for.**

---

## The jobs, mapped

| Job | Call site | Best fit | Open model enough? | Meter | Sync/async |
| --- | --- | --- | --- | --- | --- |
| **Fix explanation** — 150-word prose on a proposed diff | `providers.js:223` | **Workers AI** (K2.6) | ✅ yes — bounded summarization of content already in hand | yes | sync |
| **Remediation risk summary** — <120 words | `providers.js:236` | **Workers AI** (K2.6) | ✅ yes — same shape | yes | sync |
| **Advisory fix prose+snippet** — `/api/fix`, one finding | `fixgen.js:98` | **Workers AI** (K2.6/K3) | 🟡 mostly — a single-finding remediation snippet; K3 via gateway if quality lags | yes | sync |
| **Structured fix proposal** — full file rewrite, validated | `providers.js:151`/`:164` | **Kimi K3 / Claude** | ❌ no — correctness-sensitive, the diff is validated and may open a PR | yes | sync (one retry) |
| **Optimizer refactor** — rewrite a slow function | `llm.js:270` | **Kimi K3 / Claude** | ❌ no — must preserve behavior while changing complexity | yes | async (nightly sweep) |
| **Multi-provider comparison** | `providers.js:293` | **several** (that's the point) | — runs every configured provider unranked | yes | sync |

---

## Jobs Algosize does NOT have yet — candidates, if added

These are *not* current call sites. Listed so a future "add AI here" decision
starts from the right model class, not a reflexive frontier-model call:

| Candidate job | Best fit | Why |
| --- | --- | --- |
| Finding classification / triage tagging | **Workers AI** (small text classifier / embeddings) | bounded label space, high volume, cheap; open model ideal |
| Semantic search over findings/reports | **Workers AI embeddings** (`@cf/baai/bge-*`) | embeddings are the textbook Workers AI fit; cheap, local, no frontier model |
| Repo summarization for a report intro | **Workers AI** (K2.6) | bounded, low-stakes prose |
| Support/assistant chat | **Workers AI** first-pass, escalate to frontier | cost-controlled tiering |

> **Verification boundary.** Specific Workers AI model slugs (e.g. an embeddings
> model id) were **not** verified against the current Cloudflare catalog this
> pass. Confirm the exact slug against current docs before wiring — the catalog
> changes. The *class* recommendation (embeddings vs. frontier) holds regardless.

---

## The never-LLM list — explicit and load-bearing

These must stay deterministic. Routing any of them through a model would break
the guarantee the platform sells.

| Job | Where | Why it stays deterministic |
| --- | --- | --- |
| **Vulnerability detection** | `analyzers/vuln.js`, `sast/` | authoritative findings must be reproducible and explainable by rule, not by a model's opinion |
| **Fix validation** | `fix/validate.js:48` — "no model calls" | the `passed_static` verdict is the trust anchor; a model grading a model is a third opinion, not ground truth |
| **Fix ranking / selection** | `compareAlternativeFixes` returns unranked | the validator scores safety by measurement; a human picks. An LLM judge would launder unverified confidence into a ranking |
| **Severity / confidence scoring** | rule registry | fixed, auditable mapping — not a model guess |

The rule, stated once: **a model may explain or draft; it may never be the thing
that decides whether code is safe.**

---

## Latency / cost posture

- **Workers AI (binding, keyless):** lowest latency and cost, no per-token bill
  on the binding path. Right default for the bounded-generation jobs above.
- **Kimi K3 (gateway):** better reasoning for correctness-sensitive rewrites;
  requires the gateway (Task A1) and metering (it is third-party, billed).
- **Claude (direct):** the correctness ceiling for multi-file/architecture-aware
  fixes; requires `ANTHROPIC_API_KEY` (Task A2) and is the most expensive —
  reserve for `fix_proposal` / `optimizer_refactor`, meter closely.

Every model-backed job in the current-jobs table is metered (§2 of
[AI-USAGE-METERING-PLAN.md](./AI-USAGE-METERING-PLAN.md)) — there is no
"free" AI job, because there is no unmetered spend.
