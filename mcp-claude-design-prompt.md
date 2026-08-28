# Claude Design Prompt — Algosize MCP Connections

## Context

Algosize is a dark-themed B2B engineering-audit product: dependency-vulnerability
scanning, cloud cost analysis and infrastructure cost estimation, algorithm/Big-O
optimization, and an architecture X-ray, sold on seat-based plans (Solo, Practice,
Firm) billed through Stripe. Auth is magic-link email or Google OAuth only — there is
no password anywhere in the product. Accounts are organisations with an
owner/admin/member role model and a single subscription; every credential and every
analysis result belongs to the organisation, not to the person who created it.

The product surface is one hash-routed dashboard. A flat tab strip holds two entries —
Workspace and Monitors & CI — while the individual analyzer benches (Scanner, Cost,
Architecture, Optimizer, Estimator) are reached from tool cards on the Workspace, and
Team and Account sit in the top bar. Existing panels use a header/body split: a small
uppercase tag, a title, a one-line description, and right-aligned actions.

Machine access exists today as organisation-scoped API keys, shown in Team → API Keys.
A key looks like `ask_live_` followed by random characters, is displayed exactly once
at creation, and is afterwards only identifiable by a 16-character prefix, its name,
its creation date, and its last-used timestamp. Free-plan orgs get 5 analysis runs per
month; paid plans are unmetered.

**What is new for this design:** Algosize is shipping a Model Context Protocol (MCP)
server, so AI coding assistants — Claude Code, Claude Desktop, Claude.ai, Cursor —
can run Algosize's analyzers and read its results as tools inside a conversation.
There are two ways to connect. A **remote** endpoint at `https://algosize.com/api/mcp`
authenticated either with an existing `ask_live_` API key or, for hosts that require
it, an OAuth grant the user approves in a consent screen. And a **local bridge**, an
`npx @algosize/mcp` command configured in a client's JSON config file with the API key
in an environment variable. Roughly twenty tools are exposed, grouped as Analysis
(metered — each call consumes a run), Runs & Reports, Posture, and Monitors. Some
tools are gated to higher plans. One tool, "share run report", mints a publicly
reachable link. There is no MCP UI in the product today; nothing here exists yet.

Visual language: near-black background (`#0a0d14`), elevated surfaces `#11151e` and
card surface `#131825`, cool grey-blue border `#1e2532`, near-white text `#f1f3f6`
with muted secondary `#8a93a3` and dim tertiary `#5b6373`, teal accent `#5eead4` as
the primary interactive colour, green `#34d399` for positive/success, amber `#f59e0b`
for warnings, red `#ef4444` for danger. Radii 10/12/16px, 4px spacing base, a
system sans for prose and a monospace stack (JetBrains Mono / SF Mono / Menlo) for
anything technical. Buttons are a solid teal primary and a bordered ghost secondary.
Small rounded pill badges are used throughout. There is no light mode.

---

## Prompt

Design a complete **MCP Connections** area for the Algosize dashboard: the page where
someone connects their AI coding assistant to Algosize, sees what it can do, manages
which clients have access, and watches what those clients actually did. It lives at
its own dashboard route reached from a Workspace tool card and from Team, and should
read as a peer of the analyzer benches — part of the working area, not buried in
settings. Use the established dark theme, teal accent, rounded panel, and monospace-
for-technical-content language. Do not design a light mode.

The hard problem to solve here is that this page has two very different readers, and
the design has to serve both without a mode switch. One is a developer who wants a
command to paste into a terminal and nothing else. The other is a firm owner who has
to satisfy themselves that connecting an AI assistant to their client audit data is
safe, reversible, and auditable. Lead with the first. Make the second reader's
answers reachable in one scroll, never hidden behind a tab they wouldn't think to
open.

Structure the page as follows.

**Connection status header.** A single unambiguous statement of whether this
organisation has a live MCP connection, and if so how many clients are connected and
when one of them last called a tool. Show the remote endpoint URL as a copyable
monospace value with a copy affordance and its copied confirmation state. Include
the current protocol/server version as a quiet monospace detail, not a headline. When
nothing is connected, this header becomes the empty state that starts setup.

**Connect flow — a three-step setup card.** Step one: choose a client. Design a
horizontal row of selectable client cards — Claude Code, Claude Desktop, Claude.ai,
Cursor, Other — each with room for a logo mark, and a clear selected state. Step two:
choose credential. Two options presented as a segmented choice: use an existing API
key, or approve an OAuth connection. When "existing API key" is chosen, show the
org's keys as a compact selectable list (name, monospace prefix, last used) with a
"create a new key" action that goes to Team → API Keys rather than duplicating the
creation flow — and design the state where the org has no keys yet. Step three: the
config. A monospace code block with syntax-highlighted JSON or a shell command,
switching content based on the client chosen in step one, with a prominent copy
button, an OS/shell selector where relevant, and the secret rendered as a `${ENV_VAR}`
placeholder rather than a real value. Below it, a live "test connection" control with
its idle, testing, succeeded, and failed states — the failed state must show what to
check, not just a red X.

Because Claude.ai's remote connector path differs, design the **OAuth consent screen**
as a separate full-page surface: it is reached from outside the dashboard shell after
sign-in. It names the requesting client, states plainly which organisation the grant
will be scoped to (with an explicit organisation picker when the person belongs to
more than one — this must be impossible to get wrong by accident), lists the
permission scopes in human language rather than scope strings, notes what the grant
does *not* allow (it cannot manage billing, members, or API keys), and offers Approve
and Cancel with Cancel given equal visual weight. Design its success and denied
outcomes.

**Tool catalog.** The twenty-ish exposed tools, grouped under the four categories,
rendered so a reader can scan the whole surface without expanding anything: tool
name in monospace, a one-line plain-language description, and badges for the
properties that matter — metered (consumes a run), read-only, plan-gated, and
"creates a public link" for the share tool. Design the group headers, the badge set as
a legible legend, and the expanded state of a single tool showing its parameters and a
short example. Include a search/filter affordance and a way to hide tools the current
plan does not include versus showing them locked with an upgrade path — design the
locked treatment.

**Connected clients.** A list of every client with standing access: client name, how
it authenticated (API key with its prefix, or OAuth grant), the person who approved
it if applicable, when it connected, when it was last active, and a revoke action.
Design the revoke confirmation, the revoked/expired row treatment, and the empty
state. Revoked entries remain visible as history rather than disappearing.

**Activity.** A recent tool-call feed answering "what did the assistant actually do":
timestamp, client, tool, outcome, duration, and a link through to the resulting run
or report where one exists. Include a compact volume-over-time visual and a small
strip of summary figures (calls this month, runs consumed, error rate, busiest tool).
Design the loading skeleton, the empty state, and a filtered-to-errors state.

**Usage and limits.** For a free-plan org, make the interaction between MCP and the
5-runs-per-month allowance explicit and visible before the person burns the allowance
from a chat window: a meter, the count, and what happens at zero. Design the
at-limit state, including how a tool call that was refused for quota appears in the
activity feed.

**Security posture.** A short, calm, factual block a firm owner can read in thirty
seconds: credentials are organisation-scoped, keys and tokens are stored hashed and
shown once, every tool call is logged and appears in the audit log, access is
revocable instantly, and MCP access cannot reach billing, members, or credential
management. This is reassurance, not marketing — no illustrations, no badges, no
trust seals.

---

## Design requirements

- Dark theme only, using the exact tokens listed in the Context section.
- Never render a real secret. Every code block, key row, and token display uses a
  prefix, a mask, or an environment-variable placeholder. Design the one-time
  "this is the only time you will see this" moment only if you place it here at all —
  and if you do, make it visually unmistakable and non-dismissible by accident.
- Monospace for endpoints, tool names, key prefixes, config blocks, and identifiers.
  Sans-serif for every sentence a human reads. Do not set descriptions in monospace.
- Copy affordances need an explicit copied state; a silent copy reads as broken.
- Status must never depend on colour alone — pair every dot, badge, and severity cue
  with a text label or glyph. The existing product does this deliberately.
- Destructive and consequential actions (revoke a client, share a report publicly) get
  visual weight proportional to their consequence, and revoke needs a confirmation
  that names what will break.
- Design responsive down to a narrow viewport: the setup card's three steps must
  stack, the tool catalog must reflow to one column, and the activity table must
  degrade to stacked rows rather than scrolling horizontally.
- Fit the existing dashboard shell: same top bar, same panel header/body split with
  uppercase tag + title + description + right-aligned actions, same pill badges, same
  button pair. This should look like it was always part of the product.
- Accessibility: visible focus rings on every interactive element including the copy
  buttons and client cards, AA contrast on all text including muted secondary text on
  card surfaces, and code blocks that remain selectable.

---

## Screens and states to produce

1. MCP Connections — empty state, nothing connected, setup card open on step one.
2. MCP Connections — connected, fully populated: status header, catalog, clients,
   activity, usage, security block.
3. Setup card — each of the three steps in its selected/active state, plus the
   client-specific config block for Claude Code and for Claude Desktop.
4. Setup card — no API keys yet, and the test-connection failed state.
5. OAuth consent screen — single organisation, and the multi-organisation picker
   variant, plus approved and denied outcomes.
6. Tool catalog — collapsed full grid, one tool expanded, search filtered, and a
   plan-locked tool.
7. Connected clients — populated list, revoke confirmation, and a revoked row.
8. Activity — populated feed with the volume visual, loading skeleton, empty state,
   and errors-only filter.
9. Free-plan usage meter — healthy, near-limit warning, and at-limit refusal.
10. Narrow-viewport versions of screens 2, 3, and 8.
11. The Workspace tool card that leads here, in context alongside the existing
    analyzer cards.

---

## Explicit constraints

- No password fields, no 2FA setup, no email/password login anywhere — Algosize has
  neither.
- Do not design an API-key creation flow here; keys are created in Team → API Keys and
  this page links to it.
- Do not design billing, plan-switching, or invoice UI; a plan-gated tool links to
  the existing pricing anchor and stops there.
- Do not invent tool names or capabilities beyond the four categories described
  (Analysis, Runs & Reports, Posture, Monitors) — if you need filler rows, derive
  them from the analyzers named in the Context.
- No light mode, no marketing hero, no illustration-led empty states, no emoji.
- Do not add a third entry to the dashboard tab strip; this page is reached from a
  Workspace tool card and from Team.
