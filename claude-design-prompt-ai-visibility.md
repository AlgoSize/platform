# Claude Design Prompt — Algosize MCP Activity, grouped by working session

Part 3 of the AI-visibility pipeline. Grounded in `AUDIT-REPORT.md` and
`TRACE-AND-GRAPH-PLAN.md`, both on `main`; every field name and status value
below is read from the code those documents cite, not invented.

**This prompt extends one section of `mcp-claude-design-prompt.md` — Activity.
It does not restate that document.** The MCP Connections page, its setup card,
tool catalog, connected-clients list, consent screen, usage meter and security
block are already specified there and are not redesigned here. Read that file
first; this one changes what the Activity panel shows and nothing else.

**Deliberately out of scope**, because the approved build scope is items 1–3 of
`TRACE-AND-GRAPH-PLAN.md` §4:

- The architecture **drift view** (item 4). Not approved. Design nothing for it.
- **`origin: "observed"`** on graph edges (item 5). Not in scope. The runtime
  dimension of the architecture graph still renders as *not measured* wherever
  it appears, and no screen here implies otherwise.

---

## Context

Algosize is a dark-themed B2B engineering-audit product — dependency-vulnerability
scanning, cloud cost analysis and estimation, algorithm/Big-O optimization, and an
architecture X-ray — sold to organisations on seat-based plans. Every credential and
every analysis result belongs to the organisation, not the person who created it.

Algosize ships an MCP server, so AI coding assistants (Claude Code, Claude Desktop,
Claude.ai, Cursor) can run its analyzers as tools inside a conversation. The MCP
Connections page already has an **Activity** panel: a flat, reverse-chronological
feed of tool calls with a 14-day volume sparkline and a strip of summary figures.

**What is new for this design:** that feed is being grouped by *working session*.
Today a firm owner opening Activity sees an undifferentiated list of forty calls and
cannot tell whether that was one assistant working through one problem or four
assistants each doing something different. A session id already exists in the
protocol; it simply was never recorded next to the call. Migration 0021 adds it, and
the feed becomes a list of sessions, each containing its calls in order.

### The data, exactly as it will arrive

The panel is fed by one endpoint, `GET /api/mcp/usage`, backed by `usageSummary`
in `worker/src/mcp/telemetry.js`. Its shape today:

```jsonc
{
  "calls": [                       // capped at 200, newest first
    { "tool": "algosize_analyze_architecture",
      "authMethod": "mcp_oauth",   // "api_key" | "mcp_oauth" | "session"
      "status": "ok",              // see status values below
      "durationMs": 2140,          // may be null
      "runId": "run_9f2c…",        // null unless the call produced a run
      "errorCode": null,
      "at": 1756490000 }           // unix seconds
  ],
  "totals": {
    "calls": 128, "ok": 121, "quotaRefused": 2, "runsStarted": 14,
    "avgDurationMs": 830, "busiestTool": "algosize_analyze_vulnerabilities",
    "errorRate": 0.055             // null when there are zero calls
  },
  "daily": [ { "day": 1756425600, "calls": 9 } ],   // dense, exactly 14 entries
  "comparable": true,
  "since": 1753898000
}
```

`status` is one of `ok`, `error`, `quota_exceeded`, `rate_limited`, `denied`.
`errorCode` carries `insufficient_scope`, `plan_required`, `unknown_tool`, or an
analyzer error code. A resource read appears as a call whose `tool` is prefixed
`resource:`. Tool names are always `algosize_*` in monospace.

**The grouping key** is a new column, `session_ref` — a *truncated SHA-256 hash*
of the MCP session id, not the id itself and not a name. It is opaque by design:
grouping needs only equality. It is stable within one session and carries no
meaning a reader can decode. Treat it as an identity, never as a label to display
prominently.

### Four facts the design must be built on

1. **Every new call groups.** Every `tools/call` requires a live session — the
   server rejects any other method without one — so after migration 0021 no new
   row can be missing its `session_ref`. There is no "orphan call" state to design.

2. **Calls recorded before the migration cannot group, ever.** They have no
   session id to recover. This is the one ungrouped case: a finite, closed set of
   historical rows that gets older and eventually ages out of the 30-day window.
   It must read as *"recorded before session grouping existed"* — never as an
   "unknown session", which would look like a session whose identity was lost.

3. **A session's client name is not durable.** The client's self-reported name
   and version (`clientInfo` from `initialize`) live in a KV record that expires
   24 hours after the session ends, while the call rows are kept indefinitely. So
   a recent session can be labelled "Claude Code 2.1.4" and a three-week-old one
   cannot. The older group still knows its auth method, its tools, its outcomes
   and its time span. Design both, and make the difference legible without making
   the older one look broken.

4. **Zero is not zero.** `errorRate` is `null` when there are no calls, and the
   existing code is deliberate about this: rendering "0% errors" for a surface
   nobody has used is a lie. Anything derived per-session inherits the rule.

---

## Prompt

Redesign the **Activity** panel of the MCP Connections page so it reads as a list
of working sessions rather than a list of calls, and so a firm owner can answer
"what did this assistant actually do" as a narrative rather than by reconstructing
one from timestamps.

The hard problem is that a session is a real unit of work with an opaque name.
The design cannot title a group with anything meaningful in the general case — the
grouping key is a hash and the client name may be gone. What a group *does* carry
is: when it started and ended, how long it lasted, which credential it used, how
many calls it made, which tools, what the outcomes were, and which runs it
produced. The design's job is to make that legible as a story — "connected, listed
tools, analysed two repositories, read one report, hit the quota" — without
inventing a name or a purpose the data does not support.

Design the panel as a **list of session cards, newest first**, each collapsible
to a single summary row and expandable to its ordered calls. Consider carefully
what belongs in the collapsed row: it has to be scannable down a page of sessions
and still say enough that most readers never expand it. A session that ran clean
and a session where half the calls were denied must be distinguishable at a glance
without reading numbers, and without relying on colour alone.

Within an expanded session, the calls are in **chronological order** — this is the
one place in the product where oldest-first is right, because it is a narrative,
and the design should make that reversal feel intentional rather than like a bug.
Each call keeps what the existing flat feed shows: time, tool name in monospace,
outcome, duration, and a link through to its run or report where `runId` is set.

Design the **summary strip** above the list. It keeps its existing figures (calls
this month, runs consumed, error rate, busiest tool) and gains a session count.
Keep the 14-day volume sparkline — it is hand-rolled DOM, not a chart library, and
draws a dense series where quiet days are explicit zeros; do not replace it with
something that needs a dependency, and do not let it close up empty days.

Design the **historical boundary**: the point in the feed where sessions end and
pre-migration calls begin. This is a one-time seam in the data that will migrate
down the page and eventually vanish. It should be quiet, factual and unmistakable
— a reader must not think those calls failed to group because something is broken.

Design **filtering** that survives grouping. The existing spec calls for an
errors-only view; grouped, that has to answer "show me the sessions that had
errors" while keeping each session's clean calls visible for context, because a
denial reads differently depending on what came before it. Decide and show whether
filtering hides whole sessions or filters within them — and make the choice
evident in the interface rather than surprising.

Design the **denial and refusal treatments** inside a session, since these are what
the panel exists to surface:

- a call **refused for quota** (`quota_exceeded`) on a free-plan org, mid-session,
  with the calls that succeeded before it still visible above;
- a call **denied for scope** (`denied` / `insufficient_scope`) — the assistant
  asked for something its grant does not cover;
- a call **denied for plan** (`denied` / `plan_required`) — a paid-only tool from
  a free org;
- a call to a **tool that does not exist** (`denied` / `unknown_tool`) — newly
  recorded, and the reason it is worth recording: a host on a stale tool list, or
  something worth a second look. Several in one session is a pattern; design what
  that pattern looks like without crying wolf about one.

---

## Design requirements

- Dark theme only, using the exact tokens from `mcp-claude-design-prompt.md`:
  background `#0a0d14`, elevated `#11151e`, card `#131825`, border `#1e2532`,
  text `#f1f3f6` / `#8a93a3` / `#5b6373`, teal accent `#5eead4`, green `#34d399`,
  amber `#f59e0b`, red `#ef4444`. Radii 10/12/16px, 4px spacing base, system sans
  for prose and JetBrains Mono / SF Mono / Menlo for anything technical. No light
  mode.
- Fit the existing shell: the same panel header/body split — uppercase tag, title,
  one-line description, right-aligned actions — and the same pill badges and
  button pair. This must look like it was always part of the product.
- **Never display the raw `session_ref`.** It is a hash; showing all of it is
  noise. If the design needs a visible handle for a session, use a short prefix
  set in monospace and treated as an identifier, never as a title.
- **Never invent a session name.** No "Session 4", no "Morning work", no inferred
  purpose. When `clientInfo` is available, the client's own self-reported name and
  version is the label; when it is not, the group is identified by its time span
  and credential.
- Status must never depend on colour alone — every dot, badge and severity cue is
  paired with a text label or glyph, as the rest of the product already does.
- Monospace for tool names, identifiers, error codes and run ids. Sans-serif for
  every sentence a human reads.
- A metric with no data says so. `errorRate: null` renders as "no calls yet", not
  "0%", anywhere it appears — per-session included.
- Design responsive down to a narrow viewport: session cards stack, and the calls
  inside an expanded session degrade to stacked rows rather than scrolling
  horizontally.
- Accessibility: visible focus rings on every interactive element including the
  expand control on each session card; AA contrast on all text including muted
  secondary text on card surfaces; expand/collapse reachable and labelled for a
  screen reader, with the session's state announced rather than implied by a
  rotated chevron alone.
- No new chart or graph dependency. The one place a chart library is used in this
  product is the cost panel; this panel's visuals stay hand-rolled.

---

## Screens and states to produce

1. **Activity, grouped** — populated, several sessions, all collapsed, summary
   strip and sparkline above.
2. **One session expanded** — its calls in chronological order, mixed outcomes,
   at least one linking through to a run.
3. **A clean session and a troubled session side by side, both collapsed** — the
   at-a-glance distinction is the point of this screen.
4. **The historical boundary** — the last grouped session followed by the
   pre-migration calls and whatever marks the seam.
5. **A session with no durable client name** — older than the 24-hour window,
   identified by time span and credential, next to a recent one that has its name.
6. **Quota refusal mid-session** — free-plan org, successful calls above the
   refusal, and how the at-limit state reads inside a group.
7. **The three denial types in one session** — scope, plan, and unknown tool,
   distinguishable from each other and from an analyzer error.
8. **A session of repeated `unknown_tool` calls** — the pattern worth noticing.
9. **Errors-only filter applied** — showing the chosen filtering behaviour.
10. **Empty state** (MCP connected, nothing has called yet) and **loading
    skeleton** for the grouped layout.
11. **Narrow viewport** versions of screens 1 and 2.

---

## Hard stop

This prompt is the pipeline's last gated artifact. It designs the Activity panel
for approved scope items 1–3 and nothing else. No visuals, no components and no
code are generated from it until it is reviewed and approved.
