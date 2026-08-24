# Claude Design Prompt — Algosize Workspace (one hub, two tabs)

## Context

Algosize is a dark-themed B2B audit product for software teams. Its dashboard is
a single static page (vanilla JS, hash-routed, no framework) whose header has
grown a tab per tool — Workspace · Optimizer · Estimator · Monitors & CI · Team —
plus a signed-in cluster of email, quota pill, plan pill, billing button,
Account, Admin and Sign out. That is too many top-level destinations for five
tools, and two of the tabs are outright redundant: **Team duplicates the Account
area**, which already contains Team, API Keys and Branding sections.

**This redesign collapses the header to exactly two tabs — WORKSPACE and
MONITORS & CI — and makes the Workspace the hub every tool is reached from.**
Account (with Team inside it) stays where it is, in the signed-in cluster, not
in the tab strip.

### The five tools that must live in the Workspace

Each is real and shipped. What each takes and returns:

1. **Cloud cost analyzer** — upload an AWS Cost & Usage Report CSV. Returns top
   spenders and the three biggest savings wins. Reads *past* spend.
2. **Infrastructure Cost Estimator** — paste a Docker Compose file, Kubernetes
   manifest, Terraform plan JSON, or hand-entered resources. Prices the
   configuration *forward* across five providers (AWS, DigitalOcean, Hetzner,
   Akamai/Linode, Vultr), cheapest first, each with an asymmetric range built
   only from named assumptions, a confidence level, an itemised ledger, and a
   catalog-verification state. A provider that could not price the workload
   sorts last — never as $0. Never connects to a cloud account; input is
   scanned for credentials and refused if one is found.
3. **Vulnerability scanner** — paste a public GitHub repo URL. Pulls its
   lockfiles and looks up known CVEs against OSV.dev. Its runs open as a
   client-ready, shareable report.
4. **Architecture X-ray** — upload manifests and configs (docker-compose,
   wrangler.toml, package.json, source entry points). Builds a service graph
   and scores it through speed, cost and security lenses; every finding cites
   the file and line it came from. Its runs re-open as an interactive map.
5. **Algorithm Optimizer** — paste one self-contained JavaScript function plus a
   sample input. Runs it in an isolated sandbox, probes it at n = 100 / 1,000 /
   10,000, fits the timings on a log-log scale, and reports a measured Big-O
   grade (or "unknown" with a stated reason). Optionally returns an AI refactor
   suggestion, which can itself be measured through the same sandbox for a
   before/after comparison.

### Recent runs — the feed that must surface on the Workspace

One feed holds CI and dashboard runs together, because they answer the same
question. Each row carries: the analyzer (cost / vuln / algo / arch / estimate),
a "CI" badge when it came from a pipeline, a headline result, the repo and short
commit SHA for CI rows, a relative timestamp, and per-analyzer actions —
vulnerability runs open "View report", architecture runs open "View map", manual
runs offer "Re-run" (disabled with a stated reason when the input was too large
to keep, e.g. a CUR upload) and a CSV export. The feed filters All / CI / Manual
server-side. History is kept 90 days.

### The two automations that stay on Monitors & CI

Scheduled repo monitors (which can run the vulnerability audit, the X-ray, the
cost estimate and the optimizer nightly, emailing only what is new) and the
generated CI workflows. These are *not* moving to the Workspace — the second tab
is exactly this.

### Merging the two Algorithm Optimizer designs

Two prior design versions exist and differ in three respects. Merge them:

- **Take v2's pipeline strip** — ① the bench measures → ② `optimizer.config.json`
  → ③ the gate and the watch enforce, with the line "one committed file, three
  consumers by construction."
- **Take v1's CI-gate granularity** — four states (no key / configured / passed /
  failed) rather than v2's three, because "passed" and "failed" are the two
  outcomes a reader actually scans for.
- **Take v2's nightly-watch honesty** — four states including **skipped** ("last
  night's run was skipped, GitHub throttled — baselines unchanged"), which v1
  lacks and which is the state that keeps an outage from reading as a
  regression.

Everything else the two share stays: bench states (idle / running with per-probe
progress / graded / unmeasurable / rejected), the large grade badge, the log-log
timing curve with the fitted slope annotated, the watchlist as an editable
`optimizer.config.json` with ceiling pickers and invalid-entry errors, the
measure-the-rewrite before/after, and grade history flagged as proposed.

### Visual language

Near-black background (`#0a0d14`), elevated card surface (`#11151e`), cool
grey-blue border (`#1e2532`), near-white text (`#f1f3f6`), muted grey-blue
secondary (`#8a93a3`), teal accent (`#5eead4`), green (`#34d399`) for
success/improvement, amber (`#f59e0b`) for warnings and provisional states,
rose (`#f3c4c4` / `#b15a5a`) for regressions and failures. Monospace for code,
grades, money and identifiers; tabular figures wherever numbers align. Rounded
panels with a header/body split, pill badges, solid teal primary buttons and
bordered ghost secondaries. Dark-only — there is no light mode.

---

## Prompt

Redesign the Algosize Workspace as the single hub the whole product is operated
from. The header keeps exactly **two** tabs — **Workspace** and **Monitors &
CI** — and nothing else moves into the tab strip; Account (which already
contains Team, API Keys and Branding) stays in the signed-in cluster on the
right with the quota and plan pills. Use the established dark theme, teal
accent, rounded-card and pill-badge language; monospace for every grade,
timing, dollar amount and identifier. Dark-only.

The organizing idea is **hub and spoke**: the Workspace shows every tool and
what each has recently produced; clicking a tool opens its own focused screen
where the real work and tweaking happens. The Workspace answers "what is the
state of my code?" at a glance; the focused screens answer "let me work on
this one thing."

**1. The header.** Two tabs, the brand, and the signed-in cluster. Design it so
it reads as deliberate at every width — the previous version had five tabs that
could not share a row with the actions cluster and wrapped into a ragged clump.
Show the two-tab strip in its resting state and its narrow state.

**2. The pulse row.** Directly under the page header, a compact strip of the
few numbers that describe the account right now — drawn from the runs feed and
the monitors, not invented: runs in the last 7 days, open vulnerability
findings across monitored repos, current cheapest monthly estimate, functions
held under a complexity ceiling, repos under watch. Each is a link into the
tool or filter that explains it. Keep this to one quiet row; it is orientation,
not a dashboard of its own.

**3. The tool grid — five cards, equal citizens.** One card per tool: Cloud
cost analyzer, Infrastructure Cost Estimator, Vulnerability scanner,
Architecture X-ray, Algorithm Optimizer. Every card carries (a) the tool's name
and one line of what it answers, (b) the single most useful thing it has
produced most recently — last grade, cheapest estimate, open finding count,
last map, top savings win — rendered in the tool's own idiom rather than as
generic text, (c) a primary action that starts a run *inline where the input is
small enough to justify it* (a repo URL, a pasted function), and (d) an "Open"
affordance into the focused screen. Design the empty state of each card — never
run yet — so it says what the tool needs, not just that it is empty. Make the
cards visually distinguishable at a glance (the analyzer's own accent treatment
or glyph), because scanning five identical rectangles is how a hub fails.

**4. Recent runs, on the Workspace.** The full feed lives here — All / CI /
Manual filter, one row per run with the analyzer tag, the CI badge and
repo · commit where applicable, the headline result, relative time, and the
per-analyzer actions (View report for vulnerability audits, View map for
architecture runs, Re-run for manual ones — disabled with its stated reason
when the input was not retained — and CSV export). This is the page's centre of
gravity below the tool grid: results first, and the tool cards above are how
you make more of them. Show the feed dense enough that ten runs are legible
without scrolling on a laptop.

**5. The focused screens (spokes).** Each tool opens its own screen, reached
from its card and from any run row, with a clear way back to the Workspace —
design that return path explicitly (a breadcrumb or back affordance, not a
browser-back gamble). Show at least these three in the canvas:

- **Algorithm Optimizer** — the merged v1+v2 design described in the context:
  pipeline strip, bench with its five states, the grade verdict with the
  log-log curve and annotated slope, the AI rewrite with measure-the-rewrite
  before/after (better, worse and same-class outcomes all given equal
  prominence), the `optimizer.config.json` watchlist with ceiling pickers, the
  four-state CI gate (no key / configured / passed / failed), the four-state
  nightly watch (off / clean / regressed / **skipped**), and grade history
  marked proposed.
- **Infrastructure Cost Estimator** — input bench with the five input types,
  the five-provider verdict strip cheapest-first with asymmetric ranges and
  confidence pills, the amber unverified-catalog banner, the itemised ledger
  summing visibly to the total beside the named assumptions, the verbatim "not
  a bill" line, and the credential-refusal state.
- **Architecture X-ray** — the service graph with its speed/cost/security
  lenses and findings that cite file and line.

Sketch the Vulnerability scanner and Cloud cost analyzer screens at lower
fidelity — enough to show they follow the same spoke pattern.

**6. Monitors & CI, the second tab.** Show it briefly for completeness: repos
under watch with their enabled analyzers, and the CI workflow setup. Nothing
from the Workspace duplicates here and nothing from here duplicates there —
make the division legible in the design: **the Workspace is what you ran, the
Monitors tab is what runs without you.**

Throughout: results and grades in monospace; regressions rose, improvements
green, provisional or excluded amber; "never ran" is never rendered as zero;
every empty, failed, refused and skipped state says what happened and what to
do next in one sentence; never render an action the viewer cannot take. The
copy is plain, specific, no exclamation marks, and never claims a measurement
that was not made.
