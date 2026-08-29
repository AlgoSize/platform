# AI-Visibility Audit — Part 1 (audit only)

Derived by reading this repository on `main` at `66b2be1`. Every claim below
cites the file that grounds it. Where something is absent, it says absent.
This is Part 1 of the three-part gated pipeline (audit → trace/graph plan →
design prompt). **It contains no plan and no design — those are Parts 2 and 3,
each gated on human review of the part before.**

Provenance caveat: the originating prompt file (`AI-VISIBILITY-AUDIT-PROMPT.md`)
was written in a different session and never landed in this repository. Its
description asked for four specific claims to be verified; only one survived
the session transfer verbatim. That one is verified below, together with every
other factual assertion the description made about this codebase.

---

## 1 · Claim verification

### Claim: "`mcp_tool_calls` logs every tool invocation" — TRUE, with two precise edges (one since closed)

The table exists (`worker/migrations/0019_mcp.sql:49-61`) and deliberately
stores **no arguments and no results** — the migration's own comment: *"no
args, no results — they contain customer code"*. Columns: `org_id`,
`tool_name`, `auth_method`, `scope_used`, `status`, `duration_ms`, `run_id`,
`error_code`, `created_at`. Indexed `(org_id, created_at)`.

Every write goes through `logToolCall` (`worker/src/mcp/telemetry.js:38-59`),
best-effort via `ctx.waitUntil` — a failed usage write never costs the caller
their run. The write sites in `worker/src/handlers/mcp.js` cover every outcome
of a `tools/call`:

| Path | Site | Status recorded |
| --- | --- | --- |
| Scope missing | `mcp.js:298` | `denied` / `insufficient_scope` |
| Paid-only tool, free org | `mcp.js:311` | `denied` / `plan_required` |
| Metered rate limit hit | `mcp.js:330` | `rate_limited` |
| Tool ran (ok, error, exception) | `mcp.js:362` | `ok` \| `error` \| `quota_exceeded` \| `rate_limited` |
| `resources/read` (same tool, resource path) | `mcp.js:429` | `ok` \| `error`, tool name prefixed `resource:` |

The two edges where "every" is not literally true:

1. **A call to a nonexistent tool name** returned an RPC error with no row
   (`mcp.js:292-294`). Failed probes for tools that don't exist were invisible
   to the usage table. **Closed:** such calls now write a row with
   `status: "denied"`, `error_code: "unknown_tool"`.
2. **`logToolCall` fails silently by design** (`telemetry.js:56-58` returns
   `false` on any D1 error) — availability of the analysis is prioritised over
   completeness of the log. Correct trade-off; worth knowing when reading the
   data as an audit trail rather than a usage counter.

Protocol methods that are not tool invocations (`initialize`, `tools/list`,
`prompts/*`, `completion/complete` — `mcp.js:240-269`) are not logged, which
matches the table's stated purpose.

### Claim (implied): the architecture tool is named `algosize_xray_architecture` — FALSE

No such identifier existed anywhere in `worker/src` or `mcp/` when this audit
was written. The real tool is **`algosize_analyze_architecture`**
(`worker/src/mcp/tools/analysis.js:226`).

**Resolved since:** rather than only correcting the documents, the gap was
closed in the product. `algosize_xray_architecture` is now an **alias** that
resolves to the same tool object (`worker/src/mcp/registry.js`), because the
architecture analyzer is marketed as the "X-ray" and a model that has read the
product's own pages reaches for that word — this audit caught a real session
doing exactly that and getting nothing. The alias shares the canonical tool's
scope and plan gating, is logged under the canonical name so usage never
splits one tool in two, and is never advertised in `tools/list` (a catalog
with two names for one tool reads as two tools). Unknown names that are not
aliases now get a "did you mean" naming the nearest single match, and no
suggestion at all when two tools tie — a wrong hint is worse than none.

### Claim: the repo root has two MCP-PLAN files that may have diverged — TRUE, and the divergence is resolved by reading them

They diverge by 576 diff lines, but they are not competing truths:

- `MCP-PLAN.md` — status **"built"**: describes what is actually in the tree,
  with §0 "Corrections to the earlier plan" recording where the original was
  wrong (lines 3-11, 18-48).
- `MCP-PLAN - Algosize server.md` — status **"plan, written before
  implementation"** (lines 3-5). It is the superseded original, kept verbatim.

Nothing needs reconciling; the second file is historical.

**Resolved since:** moved to `archive/MCP-PLAN-original-preimplementation.md`.
Its presence at the root, under a name one character different from the
as-built document, is what caused this confusion in the first place.

### Claim: the existing design prompt already specs an Activity feed and Tool catalog — TRUE

`mcp-claude-design-prompt.md:100` (Tool catalog), `:116-126` (Activity feed,
"a recent tool-call feed answering 'what did the assistant actually do'").
The visual system asserted by the other session is also real and already
tokenised: `--bg: #0a0d14` and `--accent: #5eead4` at
`site/assets/css/main.css:8,16`, matching `mcp-claude-design-prompt.md:37-39`.
Part 3, if it runs, extends this spec rather than duplicating it.

---

## 2 · What exists today (the AI-visibility inventory)

### 2.1 Tool-call telemetry, already rendered

- **Write path**: §1 above.
- **Read path**: `usageSummary` (`worker/src/mcp/telemetry.js:68-153`) —
  recent calls (capped 200), aggregate totals, busiest tool, error rate
  (`null` on zero data, deliberately not 0%), and a **dense 14-day daily
  series** (`DAILY_WINDOW_DAYS`, `telemetry.js:19`) where quiet days are
  explicit zeros.
- **Front end**: `site/assets/js/dash-mcp.js` renders the activity feed and a
  hand-rolled DOM sparkline (`dash-mcp.js:904`) from that series. No chart
  library involved.

### 2.2 Run provenance

`runs` carries two provenance dimensions, both queryable:

- `source`: `"ci"` | `"monitor"` | `"manual"` (NULL) — monitor sweeps file
  real runs via `persistSweepRuns` (`worker/src/monitors/run.js`), no quota.
- `credential_kind` / `credential_id`: `session` | `api_key` | `mcp_oauth`
  (`worker/migrations/0019_mcp.sql:64-66`, index `idx_runs_credential`).

`mcp_tool_calls.run_id` links a tool call to the run it produced
(`0019_mcp.sql:57`). **There is no identifier grouping the calls of one MCP
session or one assistant conversation** — `run_id` is the only correlation
key, and read-only calls have none.

### 2.3 Error observability — events, not traces

`worker/src/observability.js` is the entire error stack: structured JSON to
console (always) plus optional Sentry envelope POST when `SENTRY_DSN` is set,
hand-rolled to avoid the ~30 KB SDK (`observability.js:1-29`). It captures
**point events with stack traces**. There is:

- no span or trace model of any kind — `grep -riE "opentelemetry|traceparent|trace_id"`
  over `worker/src` finds nothing but incidental prose;
- no request-scoped correlation id propagated across the middleware chain;
- no timing of anything except `duration_ms` on tool calls
  (`handlers/mcp.js:347,360`).

Any "trace" capability would be built from zero — this is the central input
to Part 2's OTel-vs-flat-log question.

### 2.4 The Architecture X-ray — the in-house graph engine

`worker/src/analyzers/architecture.js` + `./architecture/{graph,rules,recommend,enrich}.js`.
Static analysis only, no network, no LLM (`architecture.js:4-8`); caps at 2000
files / 12 MB with explicit `coverage.filesSkipped` rather than silent
omission (`architecture.js:28-31`).

The graph model is already prepared for runtime enrichment
(`architecture/enrich.js`):

- nodes and edges carry `evidence` (file:line) and
  `confidence: "confirmed" | "unconfirmed"` (`enrich.js:174,182`);
- edges have stable identities via `edgeId` (`enrich.js:36-39`) — built for
  cross-capture drift ("this edge is new since last week");
- every edge carries `origin: "static"` (`enrich.js:191`) as a **placeholder**:
  the module's header says the runtime signals that would set
  `origin: "observed"` "land in Phase 2" — **unbuilt**. SPOF, blast radius and
  trust-boundary fields exist but are `null` = "not measured", never guessed.

Persistence and history already exist: `arch_snapshots`
(`worker/migrations/0018_arch_snapshots.sql`), store module
`worker/src/arch/snapshots.js`, read/diff endpoints in
`worker/src/handlers/arch_snapshots.js`. Snapshots are written from all three
entry points (manual, CI, monitor).

### 2.5 Front-end chart stack

Three rendering approaches, all first-party except one:

| Surface | Approach | Cite |
| --- | --- | --- |
| Architecture explorer | hand-rolled SVG (`createElementNS`), PNG export via serialize→canvas | `site/assets/js/dash-arch.js:82-97,509` |
| MCP usage sparkline | hand-rolled DOM bars | `site/assets/js/dash-mcp.js:904` |
| Cost panel | **Chart.js 4.4.4**, the only third-party chart lib — CDN with SRI sha384 pin | `site/dashboard.html:1250-1257` |

`site/vendor/` contains only the Ruby gem bundle for Jekyll — no vendored JS.

### 2.6 The audit-log split (deliberate, keep it)

`audit_log` (migration 0010) records **human** actions; `mcp_tool_calls`
records **assistant** actions. The separation is argued in
`telemetry.js:1-14`: hundreds of machine calls an hour would bury the invites
and key revocations. Any new trace/visibility feature must respect this split
rather than merging the streams.

---

## 3 · Constraints any Part-2 plan inherits

Binding rules already enforced in this tree:

1. **Never store tool arguments or results** — they are customer code
   (`0019_mcp.sql:48`, `telemetry.js:10-14`). A trace model that captures
   payloads is ruled out before feasibility is even discussed.
2. **Every SQL read filters `org_id` first** (`telemetry.js:64-67` states it;
   every query in that file does it).
3. **No new runtime deps in `worker/`** — the purity/no-SDK posture
   (`observability.js:17-24`, `scripts/test-mcp-purity.mjs`). An
   OpenTelemetry SDK in the Worker would break a standing rule; any span
   model would have to be hand-rolled the way the Sentry transport was.
4. **Third-party repo-graphing means shipping customer source to a new
   dependency** — the X-ray's whole posture is "no network at all"
   (`architecture.js:4-8`). Data-ownership analysis in Part 2 starts from the
   fact that an in-house engine with evidence/confidence/drift identity
   already exists (§2.4).

---

## 4 · Stale documentation flagged (not fixed here)

- `ARCHITECTURE-XRAY-PHASE-0.md` is pinned to `main` at `00ad83c` and says
  "17 migrations applied; 15 live tables" (§2 table). There are now 20
  migrations (`worker/migrations/`), MCP tables included. The doc is honest
  about its own commit pin, so this is staleness, not error — but a Part-2
  plan must not inherit its counts.
- The superseded MCP-PLAN original — now `archive/MCP-PLAN-original-preimplementation.md`, see §1.

---

## Hard stop

Part 1 ends here. No `TRACE-AND-GRAPH-PLAN.md` has been written and no design
work has been done. Part 2 (feasibility: OTel-style spans vs a flatter
tool-call log; third-party graphing vs extending the in-house X-ray) proceeds
only after this report is reviewed and approved.
