# Claude Design Prompt — Algosize MCP Connections

**Status of the thing being designed: it is already built and working.** This
is a redesign brief for three shipped surfaces, not a greenfield one. Everything
described below exists, is tested, and is behind a feature flag awaiting
rollout. Design against the real data shapes and the real states listed here —
where this brief names a state, that state genuinely occurs and something has
to be drawn for it.

---

## Context

Algosize is a dark-themed B2B engineering-audit product: dependency-vulnerability
scanning, cloud cost analysis, infrastructure cost estimation, algorithm/Big-O
optimization, and an architecture X-ray. Sold on seat-based plans through
Stripe. Auth is magic-link email or Google OAuth only — **there is no password
anywhere in the product**, so never draw one.

Accounts are **organisations** with owner/admin/member roles and a single
subscription. Every credential and every analysis result belongs to the
organisation, not to the person who created it. Free-plan orgs get 5 analysis
runs per month; paid plans are unmetered.

The product surface is one hash-routed dashboard. A flat two-tab strip holds
**Workspace** and **Monitors & CI**; the analyzer benches (Scanner, Cost,
Architecture, Optimizer, Estimator) are reached from tool cards on the
Workspace, and Account sits in the top bar. Panels use a header/body split:
small uppercase tag, title, one-line description, right-aligned actions.

### What MCP is, in this product

Algosize ships a Model Context Protocol server, so AI coding assistants —
Claude Code, Claude Desktop, Claude.ai, Cursor — can run the analyzers as tools
inside a conversation. Two ways to connect:

- **Remote**: `https://algosize.com/api/mcp`, authenticated either with an
  existing `ask_live_…` API key or, for hosts that require it, an OAuth grant
  the user approves on a consent screen.
- **Local bridge**: `npx @algosize/mcp` configured in a client's JSON config
  with the key in an environment variable.

---

## The three surfaces to design

1. **MCP Connections** — a dashboard page at `#/mcp`, reached from a Workspace
   tool card and from Team. Not a third tab.
2. **The OAuth consent screen** — a standalone full-page surface outside the
   dashboard shell, reached mid-flow from another application.
3. **The admin adoption panel** — a section inside the internal admin console's
   Automation view. Different audience, different visual system (see §3).

---

## 1 · MCP Connections (`#/mcp`)

### The hard problem

This page has two readers and must serve both **without a mode switch**.

One is a developer who wants a command to paste into a terminal and nothing
else. The other is a firm owner who has to satisfy themselves that connecting
an AI assistant to their clients' audit data is safe, reversible and auditable.

Lead with the first. Make the second reader's answers reachable in one scroll,
never behind a tab they wouldn't think to open.

### Sections, in order

**Connection status.** Whether this organisation has a live connection, how
many clients, and when one last called a tool. The endpoint URL as a copyable
monospace value with an explicit copied state. Server and protocol version as a
quiet monospace detail, never a headline. When nothing is connected this header
*is* the empty state that starts setup.

**Setup card — three steps.**

- *Step 1, choose a client*: a selectable row of Claude Code, Claude Desktop,
  Claude.ai, Cursor, Other. Each needs room for a logo mark and a clear
  selected state. They differ in kind, and the kind matters: Claude Code takes
  a **shell command**, Desktop and Cursor take a **JSON config file**,
  Claude.ai and Other take a **remote endpoint** plus an approval screen.
- *Step 2, choose a credential*: two options. Use an existing API key, or
  approve an OAuth connection. For the key path, show the org's keys as a
  compact selectable list — name, monospace prefix, last used. Design the state
  where **the org has no keys yet**: it links to Team → API keys and does not
  duplicate the creation flow.
- *Step 3, the config*: a monospace block whose content changes with the client
  chosen in step 1. Prominent copy button. **The secret is always a
  `${ENV_VAR}` placeholder, never a value.** Below it, a "test connection"
  control with idle / testing / succeeded / failed states — the failed state
  must say what to check, not just show a red X.

**Tool catalog.** 22 tools in four groups, scannable without expanding
anything: monospace name, one-line plain-language description, and badges.
Design the group headers, the badge set as a legible legend, one tool expanded
showing its parameters, a search/filter affordance, and the plan-locked
treatment.

The real catalog, with the badges each row carries:

| Group | Tools | Badges present |
|---|---|---|
| **Analysis** (7) | `algosize_analyze_vulnerabilities`, `algosize_analyze_cost`, `algosize_analyze_complexity`, `algosize_analyze_architecture`, `algosize_estimate_infrastructure` | **metered** on all five |
| | `algosize_list_cost_providers` | read-only |
| | `algosize_generate_fix` | none — it is free but not read-only |
| **Runs & Reports** (4) | `algosize_list_runs`, `algosize_get_run`, `algosize_get_run_report` | read-only |
| | `algosize_share_run` | **public link** |
| **Posture** (5) | `algosize_get_scorecard`, `algosize_list_arch_snapshots`, `algosize_diff_architecture`, `algosize_get_ci_snippet`, `algosize_whoami` | read-only |
| **Monitors** (6) | `algosize_list_monitors`, `algosize_get_monitor_result` | read-only |
| | `algosize_create_monitor`, `algosize_update_monitor`, `algosize_run_monitor_now` | none |
| | `algosize_delete_monitor` | **destructive** |

Note the asymmetry, and design for it rather than flattening it: **badges are
sparse.** Most rows carry one badge or none. `algosize_generate_fix` carries
none at all — it is neither metered nor read-only — and a design that assumes
every row has a badge will render that row as broken. Do not invent a "free"
badge to fill the gap; absence is the correct signal.

`algosize_share_run` is the only tool that reaches outside the tenant. It mints
a link anyone holding it can open. Give it visual weight proportional to that.

**Connected clients.** Every client with standing access: name, how it
authenticated, who approved it, when it connected, when it was last active, and
a revoke action. Design the revoke confirmation — it must **name what will
break** ("the assistant's Algosize tools disappear mid-conversation"), not ask
"are you sure". Design the revoked-row treatment: revoked entries **stay
listed as history** and must remain legible, not greyed into unreadability.

Design the empty state carefully, because it is easy to get wrong: an org can
have a working API-key connection and *zero* rows here, since API-key
connections are not OAuth grants. The empty state has to say so rather than
reading as "nothing is connected".

**Activity.** A recent tool-call feed: timestamp, tool, outcome, duration, and
a link through to the resulting run where one exists. A compact volume-over-time
visual and a small strip of summary figures — calls this month, runs consumed,
error rate, busiest tool. Design the loading skeleton, the empty state, and an
errors-only filtered state.

Outcomes are a closed set and each needs its own treatment: `ok`,
`quota_exceeded`, `rate_limited`, `denied`, `error`. Note that
**`quota_exceeded` is not an error** in the ordinary sense — it means the
account ran out of runs, which is a billing state, and drawing it in the same
red as a failure sends the reader to the wrong place.

**Usage and limits.** For a free-plan org, make the interaction between MCP and
the 5-runs-per-month allowance visible *before* someone burns it from a chat
window. A meter, the count, and what happens at zero. Design the at-limit state
and how a quota-refused call appears in the activity feed.

**Security posture.** A short, calm, factual block a firm owner reads in thirty
seconds. No illustrations, no badges, no trust seals — reassurance, not
marketing. The six facts:

- Credentials are organisation-scoped, not personal; a member leaving does not
  orphan a connection.
- Keys and tokens are stored as a SHA-256 hash and shown in full exactly once,
  at creation.
- Every tool call is recorded with its tool, outcome and duration. **Arguments
  and results are never stored** — a tool argument is the customer's source
  code.
- Access is revocable immediately.
- An MCP connection **cannot** create API keys, change billing, add or remove
  members, or reach admin settings.
- Runs made through a connection appear in run history labelled with the
  credential that made them.

### States that are easy to draw dishonestly

These are the ones to get right; each is a place where the obvious rendering
tells the reader something false.

- **A null error rate is not 0%.** With zero calls there is no error rate. "0%"
  on an unused surface reads as a health signal nobody earned. Draw "no calls
  yet".
- **Loading, empty and failed are three states, not two.** Every panel needs
  all three, visually distinct.
- **An empty tool list has two causes** — the key never arrived, or MCP is not
  enabled for the org — and they need different messages.
- **Never render a real secret.** Every code block, key row and token display
  uses a prefix, a mask, or an env-var placeholder.

---

## 2 · The OAuth consent screen

A **standalone full-page surface**, not inside the dashboard shell. It is
reached mid-flow from another application, frequently in a popup or a
restricted webview, and it is currently server-rendered with **no JavaScript
and no external assets** — a page that depended on the dashboard bundle would
fail in exactly the contexts where connectors get approved. Design within that
constraint: inline styles only, no web fonts, no icon library, no images.

It must:

- Name the requesting client.
- State plainly which **organisation** the grant will be scoped to. When the
  person belongs to more than one, an explicit picker — this must be impossible
  to get wrong by accident, because a grant silently bound to the wrong org is
  a data-leak class bug. With exactly one org, show a plain statement rather
  than a single-option dropdown that invites a meaningless click.
- List the permission scopes **in human language, never as scope strings**.
  There are three: read your analysis history and results; run analyses, each
  of which counts against your monthly allowance; create, change and delete
  monitors and shareable report links.
- State what the grant does **not** allow: it cannot manage billing, members,
  or API keys.
- Offer Approve and Cancel with **Cancel given equal visual weight**.

Design its approved and denied outcomes, and the **sign-in state**: when the
person is not signed in, the page explains that and offers a way back into the
same request, so the flow resumes rather than restarting.

---

## 3 · Admin adoption panel

Internal, for Algosize staff. It lives inside the existing admin console's
Automation view, which uses its **own darker, denser visual system** (`adm-*`
classes, tabular numerics, tighter spacing) — not the customer dashboard's. Match
that, not §1.

It answers three operator questions: is anyone using this, is it working, is it
costing customers runs they didn't expect.

Figures: calls, orgs calling, runs consumed, refused for quota, error rate,
average duration, orgs with a grant, live tokens — all over a stated 30-day
window. Plus a top-tools list with per-tool call and failure counts, and a
calls-per-day series.

Two states look identical in a stat grid and mean opposite things, so both must
be explicit in the design:

- **Enabled vs. disabled** is separate from the call count. "Off" and "on but
  nobody has used it" both show zero calls, and only one is a product problem.
- **A null error rate**, again: null over zero calls, never 0%.

It is **aggregate only** — no organisation is ever named here. Do not design a
per-customer table; that view is the account drawer.

---

## Visual language

Dark theme only. These are the product's actual tokens — use them exactly:

| Role | Value |
|---|---|
| Background | `#0a0d14` |
| Elevated surface | `#11151e` |
| Card surface | `#131825` |
| Border | `#1e2532` |
| Border (soft) | `#161b27` |
| Text | `#f1f3f6` |
| Text muted | `#8a93a3` |
| Text dim | `#5b6373` |
| Accent (primary interactive) | `#5eead4` |
| Positive | `#34d399` |
| Warning | `#f59e0b` |
| Danger | `#ef4444` |

Radii 10 / 12 / 16px. Spacing on a 4px base. System sans for prose; a monospace
stack (JetBrains Mono / SF Mono / Menlo) for endpoints, tool names, key
prefixes, config blocks and identifiers. Buttons are a solid teal primary and a
bordered ghost secondary. Small rounded pill badges throughout. **There is no
light mode.**

---

## Requirements

- **Never render a real secret**, in any screen, in any state.
- **Monospace for machine strings, sans-serif for sentences.** Descriptions are
  prose and are never set in monospace.
- **Status must never depend on colour alone.** Every dot, badge and severity
  cue is paired with a word or a glyph. The product does this deliberately and
  consistently; a design that breaks it will not ship.
- Copy affordances need an explicit copied state — a silent copy reads as
  broken.
- Destructive and consequential actions get weight proportional to their
  consequence. Revoke needs a confirmation that names what will break.
- **Responsive to a narrow viewport**: the setup card's three steps stack, the
  client picker becomes one column, the catalog reflows to one column, and the
  activity table degrades to stacked rows rather than scrolling sideways. Wide
  content — config blocks especially — scrolls inside its own container so the
  page body never scrolls horizontally.
- **Accessibility**: visible focus rings on every interactive element including
  copy buttons and client cards; AA contrast on all text including muted
  secondary text on card surfaces; code blocks remain selectable.
- Fit the existing shell: same top bar, same panel header/body split, same pill
  badges, same button pair. This should look like it was always part of the
  product.

---

## Screens to produce

1. MCP Connections — empty, nothing connected, setup card on step one.
2. MCP Connections — fully populated: status, catalog, clients, activity,
   usage, security.
3. Setup card — each step in its active state, plus the config block for Claude
   Code (shell) and for Claude Desktop (JSON).
4. Setup card — the no-API-keys-yet state, and test-connection failed.
5. OAuth consent — single organisation, and the multi-organisation picker; plus
   approved, denied, and not-signed-in.
6. Tool catalog — full grid collapsed, one tool expanded, search filtered, and a
   plan-locked tool.
7. Connected clients — populated, revoke confirmation, a revoked row, and the
   empty state that explains API-key connections do not appear there.
8. Activity — populated with the volume visual, loading skeleton, empty, and
   errors-only.
9. Free-plan usage meter — healthy, near-limit, at-limit refusal.
10. Admin adoption panel — populated, and the disabled/zero-calls state.
11. Narrow-viewport versions of 2, 3 and 8.
12. The Workspace tool card that leads here, in context beside the analyzer
    cards.

---

## Explicit constraints

- No password fields, no 2FA setup, no email/password login — Algosize has
  none of these.
- Do not design an API-key creation flow here. Keys are created in Team → API
  keys; this page links there.
- Do not design billing, plan-switching or invoice UI. A plan-gated tool links
  to the pricing anchor and stops.
- **Do not invent tool names.** The 22 above are the complete, current set.
- Do not add a third entry to the dashboard tab strip.
- No light mode, no marketing hero, no illustration-led empty states, no emoji.
