# AI Visibility — Part 2: feasibility and plan

Gated on `AUDIT-REPORT.md` (Part 1, merged in #63). Every fact below is from
that audit or cited fresh here. This is a plan and a recommendation, not an
implementation: **no code has been written and none will be until this is
approved.**

Two questions were put to this part:

1. Is a full OpenTelemetry-style span model warranted, or is a flatter
   tool-call log the right shape for this system?
2. Does adopting a third-party repo-graphing tool make sense, or should the
   in-house `algosize_analyze_architecture` X-ray be extended?

Short answers: **flat log, extended in place** and **extend the X-ray**. Both
recommendations are argued below, including what would change my mind. There
is also a third finding neither question anticipated, in §3 — the graph half
is blocked on a product decision from `ARCHITECTURE-XRAY-PHASE-0.md` §7.2 that
was never made, and no amount of engineering here can substitute for it.

---

## 1 · Tracing: spans versus a flat log

### 1.1 What a span model would have to be built out of

There is nothing to adopt. Per the audit (§2.3), `worker/src/observability.js`
captures point events only: structured JSON to console plus optional Sentry
envelopes. No spans, no trace ids, no request-scoped correlation, and a
repo-wide search for `opentelemetry|traceparent|trace_id` finds nothing.

An OTel span model would therefore mean writing, by hand:

- context propagation through the middleware chain (rate limit → quota →
  handler), since `AsyncLocalStorage` is not the idiom this codebase uses;
- a span exporter — the OTLP protobuf/HTTP encoder, batching, retry;
- a collector or vendor endpoint to receive it, which is a new external
  dependency in the request path.

Rule 3 in the audit's constraints is **no new runtime deps in `worker/`**,
enforced by `scripts/test-mcp-purity.mjs` and argued in `observability.js:17-24`
(the Sentry SDK was rejected at ~30 KB against the 1 MB compressed Worker
limit). The OTel JS SDK is considerably larger than the Sentry one. So the
choice is not "adopt OTel" versus "roll our own" — it is "roll our own OTel"
versus "extend what already works".

### 1.2 What a span model would actually buy

Spans earn their complexity when a request fans out across services and the
question is *where* the time went among many hops. Measured against this
system:

| What spans are for | This system |
| --- | --- |
| Multi-service latency attribution | One Worker, one D1, one KV, one R2. The sandbox Worker is the only hop, and it is invoked for `algo` analysis alone. |
| Finding the slow hop | Already recorded: `duration_ms` per tool call (`handlers/mcp.js:347,360`). |
| Correlating a failure to its request | Already recorded: `error_code` + `status`, plus a Sentry event with a stack. |
| Grouping one conversation's work | **Missing.** This is the real gap. |

Only the fourth row is unserved. The audit found it precisely: `run_id` is the
sole correlation key in `mcp_tool_calls`, and read-only calls have none, so
nothing groups the calls an assistant made in one working session. That is a
missing **column**, not a missing tracing system.

### 1.3 Recommendation: extend the flat log

**Adopt the flat model. Add correlation, not spans.**

The proposed change is small and additive:

**Migration 0021 — `mcp_tool_calls.session_ref TEXT`, plus
`idx_mcp_tool_calls_session (org_id, session_ref, created_at)`.**

The value written is a **truncated SHA-256 of the MCP session id**, not the id
itself. Reasoning: the session id is bookkeeping rather than a credential
(`worker/src/mcp/session.js:1-12` — leaking one would let an attacker resume a
conversation's *settings* and nothing else), but the KV record expires after 24
hours (`session.js:21-25`) while a D1 row is kept indefinitely. Storing the raw
id would leave a resumable-looking identifier in a table that outlives the
thing it identifies, for no gain: grouping needs only equality, which a hash
preserves.

The plumbing is already in place — `sessionId` is destructured into the
dispatch context (`handlers/mcp.js:149`) and `callTool` receives that same `cx`
(`mcp.js:287`), so every one of the five `logToolCall` sites can pass it with
no new data flow.

**Stronger than this section first stated, and it matters downstream:** every
method except `initialize` is refused without a live session, enforced once at
`handlers/mcp.js:216-221` before the method switch. Since all five log sites
sit inside `callTool` and `readResource`, which are reachable only past that
check, **no row written after 0021 can have a null `session_ref`**. There is no
"stateless call" case to handle. The only ungrouped rows are the ones written
before the migration, which is a finite, closed set that ages out of the
30-day window — one honesty state to design, not two.

**Also in scope, from the audit's §1 edges:**

- Log calls to **nonexistent tool names** (`mcp.js:292-294` currently returns
  early with no row). Repeated probes for tools that do not exist are a signal
  worth having — a host on a stale tool list, or something worse. One
  `logToolCall` with `status: "denied"`, `error_code: "unknown_tool"`. The
  tool name is model-supplied text, so it is stored as-is only because
  `tool_name` is already free text; it is never interpolated anywhere.
- Leave `logToolCall`'s silent-failure behaviour exactly as it is
  (`telemetry.js:56-58`). It is the correct trade — a usage row must never
  cost a customer their analysis — and the audit records it so readers of the
  data know it is a usage counter, not a legal audit trail.

**Explicitly out of scope:** timing sub-phases inside a tool call (dispatch vs
handler vs analyzer). That is where a span model would start to pay, and it
pays nothing until a tool is slow enough for someone to ask which part. Revisit
if `avg_ms` on a tool ever crosses a threshold worth investigating.

**What would change this recommendation:** a second network hop in the request
path (a real fan-out), or multi-Worker request chains. Neither exists today.

### 1.4 What the extended log makes possible

With `session_ref`, `usageSummary` (`telemetry.js:68`) can group the activity
feed by working session instead of listing calls flat — "this assistant
connected, listed tools, analysed two repos, and read one report" as one unit.
That is the visibility the original request was reaching for, and it is one
column and one `GROUP BY` away rather than a tracing subsystem away.

---

## 2 · Graphing: third-party versus extending the X-ray

### 2.1 The data-ownership argument decides this before feasibility does

Using a third-party repo-graphing service means **sending customer source code
to a new vendor**. The X-ray's stated posture is the exact opposite:
*"Static analysis only. No LLM calls, no requests to the infrastructure being
analyzed, no network at all"* (`worker/src/analyzers/architecture.js:4-8`).

That is not an implementation detail that could be relaxed quietly. It is the
promise the scheduled analyzers are allowed to run under, and the platform
enforces adjacent versions of it in tests — `test-ci-gates.mjs` denies fourteen
named credential mechanisms by name (`ARCHITECTURE-XRAY-PHASE-0.md` §7.2).
Adding a vendor would also touch the Privacy Policy's account of what data
leaves the system.

**Recommendation: no third-party graphing tool.** Not because the in-house
engine is better in the abstract, but because the cost is a product promise and
the benefit is small — see §2.2.

### 2.2 How much of the graph already exists

More than the framing assumed. Per the audit §2.4 and re-verified here:

| Capability | State |
| --- | --- |
| Parse repo → nodes, edges, clusters | Built (`architecture/graph.js`) |
| Findings under speed/cost/security lenses | Built, 16 rules (`architecture/rules.js`) |
| Per-fact `evidence` (file:line) | Built (`enrich.js:199-201`) |
| `confidence: confirmed \| unconfirmed` | Built (`enrich.js:174,182`) |
| Stable edge identity for drift | Built (`edgeId`, `enrich.js:36-39`) |
| Versioned snapshots, gzipped, org-scoped | Built (migration 0018) |
| Snapshot list / read / **diff** endpoints | Built (`handlers/arch_snapshots.js:3-5`) |
| Honest bounds (`coverage.filesSkipped`, `reduced` flag) | Built |
| `origin: "observed"` on edges | **Not built — and blocked, see §3** |
| Rendering the history that exists | **Not built** — Phase 1 shipped reads with nothing that draws them |

A third-party tool would replace nine built rows to deliver the tenth, and
would not deliver the tenth either: no repo-graphing vendor can tell you which
declared edges are actually exercised at runtime in *the customer's* system.

### 2.3 Recommendation: extend, and the highest-value extension is rendering

The cheapest real win in the graph half is not new analysis — it is drawing
the history that is already being collected. `handlers/arch_snapshots.js:7-10`
says so plainly: *"Phase 1 ships the reads and nothing that renders them."*
Snapshots have been accumulating from all three entry points (manual, CI,
monitor) with a resolved `prev_snapshot_id` chain and a working `diffGraphs`
(`arch/snapshots.js:262`).

So the graph deliverable to design is **drift**: "what changed in this
architecture since last week / since this PR", built on endpoints that exist.
The renderer would extend `site/assets/js/dash-arch.js`, which already
hand-rolls SVG with a PNG export path (`dash-arch.js:82-97,509`) — no chart
dependency needed, consistent with the one place Chart.js is used being the
cost panel alone (`dashboard.html:1250-1257`).

Two honesty requirements the existing code already sets and a drift view must
carry through: `reduced: 1` snapshots have lost their evidence arrays and the
reader **must** be told (migration 0018's comment says a snapshot that silently
loses its file:line citations breaks the X-ray's core promise); and a dangling
`prev_snapshot_id` must render as "the comparison point is no longer
available", never as a silent re-point at a much older graph.

---

## 3 · The blocker neither question anticipated

`enrich.js:13-18` says the runtime signals that would set `origin: "observed"`
"land in Phase 2". `ARCHITECTURE-XRAY-PHASE-0.md` §7.2 then established that
this conflicts with a product invariant and laid out three options. That
decision has now been made — see §3.1. The options as posed:

- **(a) Self-only runtime signals** — runtime data for Algosize's own
  infrastructure with Algosize's own credentials; customer graphs stay
  static-only.
- **(b) Customer-supplied telemetry, pushed not pulled** — the CI gate posts
  what the customer's pipeline already has; no credential is ever stored.
- **(c) Break the invariant deliberately** — build a cloud-account connector,
  store scoped per-customer tokens, and update the promise, the Privacy Policy
  and the tests to match.

The Phase-0 recommendation was **(b), plus (a) for dogfooding**. I concur, and
I want to be explicit about why this belongs in front of you rather than inside
an implementation: option (c) is a change to what the product promises about
customer data, and no architecture feature should make that call as a side
effect.

Note that §1's tracing work does **not** unblock this. The tool-call log
records what *Algosize's* assistants did, never what the customer's system did
— they are different subjects, and conflating them would produce exactly the
false certification the discipline below prevents.

### 3.1 · Decision: all three, and what each one costs

**Answered: (a), (b) and (c) are all approved.** Recorded here because §7.2 has
been open since Phase 0 and the answer is a product decision, not an
implementation one.

Sequencing follows from what each option requires, not from preference:

| | Option | Blocked on |
| --- | --- | --- |
| 1st | **(b)** customer-pushed CI telemetry | nothing — no credential is ever held |
| 2nd | **(a)** self-only signals, our own infrastructure | nothing — our credentials, our systems |
| 3rd | **(c)** cloud-account connector, scoped per-customer tokens | the two changes below, **before** any code |

(b) and (a) can be built whenever they are scheduled. **(c) cannot start until
two things outside the architecture feature are done**, and naming them is the
point of recording the decision rather than absorbing it:

1. **The Privacy Policy's account of what data leaves the system changes.**
   Storing a scoped customer cloud token means the product holds a credential
   to a customer's infrastructure. The policy currently describes a system that
   holds none.
2. **`test-ci-gates.mjs` stops being a promise and becomes a lie unless it is
   rewritten deliberately.** It denies fourteen credential mechanisms *by name*
   — `configure-aws-credentials`, `azure/login`, `id-token: write`, `KUBECONFIG`
   among them. That test is the enforcement of the invariant (c) breaks. It must
   be rewritten as an explicit, narrowed rule — not deleted, not loosened by a
   diff that happens to make a build pass.

Until (c) has both, and until any of the three is actually built, **`origin`
stays `"static"` on every edge and every surface renders the runtime dimension
as "not measured" — never as "unused", never as "fine".** That is what the
`null`-means-not-measured discipline in `enrich.js:12-18` protects: the
difference between a feature honest about its limits and one that quietly
certifies an architecture nobody checked.

**This decision unblocks item 5; it does not schedule it.** Item 5 is not in
the approved build scope (§4), and nothing in it is designed by Part 3.

---

## 4 · Proposed scope, in order

Each item is independently shippable.

**Approved for build: items 1-3 — now shipped.** Item 4 was not approved and
is not designed by Part 3. Item 5 is unblocked by the §3.1 decision but is not
in scope.

Built as specified, with one addition the audit's §1 findings implied but this
plan did not list: `algosize_xray_architecture` resolves as an alias to
`algosize_analyze_architecture`, since the audit caught a live session calling
the marketed name and getting nothing. Aliases are never advertised and are
logged under the canonical name.

| # | Item | Size | Depends on |
| --- | --- | --- | --- |
| 1 | ~~Migration 0021: `session_ref` + index; pass session id (hashed) at all five `logToolCall` sites~~ **shipped** | S | — |
| 2 | ~~Log unknown-tool-name calls (`mcp.js:292`)~~ **shipped** | XS | — |
| 3 | ~~`usageSummary` groups the activity feed by session~~ **shipped**, with the dashboard panel | S | 1 |
| 4 | Drift view: render `GET /api/arch/diff` in `dash-arch.js`, with `reduced` and dangling-`prev` honesty states | M | — |
| 5 | `origin: "observed"` | — | **§3 decision (a/b/c) — do not start** |

Tests, per this repo's standing discipline: every new guard verified by
breaking the code and watching it fail. For item 1 that means asserting calls
from two different sessions do not group together — a test that passes with the
column always-null is vacuous, which this repo has been bitten by twice.

---

## Hard stop

Part 2 ends here. No `claude-design-prompt-ai-visibility.md` has been written
and no code has changed. Part 3 (generating the design prompt) proceeds only
after this plan is reviewed and approved — and per the pipeline's own rule,
it must design only what is approved here. If item 4 is approved and items 1-3
are not, the design prompt covers drift and nothing else. Item 5 is not
designable at all until §3 is answered.
