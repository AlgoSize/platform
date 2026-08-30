# Cloudflare + AI best-fit roadmap

The sequenced plan that ties the other five documents together. Ordered so that
each phase is independently valuable and nothing depends on a control-plane fact
that has not been confirmed.

Read first: [CLOUDFLARE-CAPABILITIES-AUDIT.md](./CLOUDFLARE-CAPABILITIES-AUDIT.md)
(what exists) and [CLOUDFLARE-IMPLEMENTATION-MATRIX.md](./CLOUDFLARE-IMPLEMENTATION-MATRIX.md)
(where each change can be made).

---

## Guiding constraints

- **Repo-only work first.** Everything that needs no Cloudflare access is
  lower-risk and can ship as ordinary PRs while operator access is arranged.
- **No plan rests on an unconfirmed capability.** The AI-Gateway feature set is
  `unclear` until Task A4; the authoritative meter is therefore Algosize-owned
  D1, and the gateway is additive.
- **Deterministic core is untouchable.** Scanning and validation stay LLM-free.

---

## Phase 0 — Measure before you spend (repo-only)

The meter comes first, because you cannot manage spend you do not record, and
today nothing is recorded (audit §4).

1. Instrument `llmChat` + `chatAnthropic` to carry back the `usage`/`model` the
   providers already return and the code currently discards
   (`llm.js:219`, `providers.js:187`).
2. Add the `ai_usage` D1 migration + org-scoped write path
   ([AI-USAGE-METERING-PLAN.md](./AI-USAGE-METERING-PLAN.md) §7), written from
   the two entrypoints, `feature` enum from the four real call sites.
3. Per-model price table + `estimated_cost_usd` (null when tokens are null).

**Value at end of phase:** every AI call is attributable to an org, a user, and
a feature, with an estimated cost — with zero Cloudflare access required.

---

## Phase 1 — Enforce a budget (repo-only)

4. Per-org (optional per-user) monthly AI budget, enforced reserve→run→settle
   like `quota.js`, reusing the `USAGE` Durable Object for atomicity.
5. Threshold rows + alerts through the existing `quotaWarning` path.
6. **Degrade, not crash:** over budget, AI features return `ai_budget_exceeded`;
   deterministic scanners keep running.
7. Surface per-org AI usage in the admin panel and `/api/me`.

**Value:** AI spend is bounded and visible before any new model is switched on.

---

## Phase 2 — Unlock the better model (repo + Replit)

Only now bring in the gateway, because Phase 0's meter will immediately measure
whatever it costs.

8. **Task A1** — create an AI Gateway, set `AI_GATEWAY_ID`. This flips
   `resolveModel` to **Kimi K3** and lights up Cloudflare-native analytics.
9. Attach request metadata (`org`, `user`, `feature`, `scan_id`, `fix_task_id`)
   so gateway analytics slice the way the D1 meter does.
10. **Task A4** — confirm the gateway's rate-limit / spend / metadata feature
    set against current Cloudflare docs. Record the answers in the metering
    plan; only then consider moving any enforcement edge-ward.

**Value:** better fixes on the correctness-sensitive jobs
([WORKERS-AI-USE-CASE-MAP.md](./WORKERS-AI-USE-CASE-MAP.md)), measured from the
first request.

---

## Phase 3 — Second opinions (repo + Replit, optional)

11. **Task A2 / A3** — set `ANTHROPIC_API_KEY` (and `OPENAI_API_KEY` if not
    already set) to make `claude`/`openai` selectable and enable
    `compareAlternativeFixes` to run a real cross-provider comparison — still
    ranked by the deterministic validator, never by a model.

**Value:** provider diversity for high-stakes fixes, with the validator as the
arbiter.

---

## Phase 4 — Right-size each job (repo-only, ongoing)

12. Route the bounded jobs (fix explanation, risk summary) to the cheap Workers
    AI binding and reserve K3/Claude for `fix_proposal` / `optimizer_refactor`,
    per the model map. The meter from Phase 0 tells you whether the split is
    saving money — decisions become measured, not asserted.

---

## Dependency graph

```
Phase 0 (meter) ─────────────┐
   │                         │
   ▼                         ▼
Phase 1 (budget)      Phase 2 (gateway/K3) ── needs Task A1, A4
                             │
                             ▼
                      Phase 3 (Claude/OpenAI) ── needs Task A2/A3
                             │
                             ▼
                      Phase 4 (right-size) ── needs Phase 0's numbers
```

Phase 0 gates everything else, and Phase 0 needs no Cloudflare access — so work
can start immediately and the operator tasks (A1–A4) slot in when access is
available, without blocking the measurement that makes the rest safe.

---

## Open questions for the operator (carried from Task A4)

- Does the account already have an AI Gateway? (avoid a duplicate)
- Does AI Gateway support per-user spend caps and the metadata dimensions the
  plan wants? — determines whether any enforcement moves edge-ward or stays in
  Algosize's D1 meter.
- Is `OPENAI_API_KEY` already set? (it is in the required-secrets block; the
  others are not)

Until these are answered, everything in Phases 0–1 proceeds and the answers only
affect Phases 2–3.
