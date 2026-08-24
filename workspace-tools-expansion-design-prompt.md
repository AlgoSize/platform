# Claude Design Prompt — Nine Proposed Tools, Merged Into the Workspace

## Read this first: the triage

Nine tools were proposed. **Zero of them should become new pages.** Two already
ship, two cannot be built as described without breaking a product invariant, and
the remaining five are lenses or modes on tools that already exist. The whole
point of this brief is that the Workspace absorbs them without growing a tenth
destination.

| # | Proposed | Verdict |
|---|---|---|
| 1 | Service Catalog / Scorecard | **Build — the only genuinely new surface.** But as a *section of the Workspace*, not a page: the data already exists per monitored repo. |
| 2 | CI/CD Gate Plugin | **Already ships.** Ignore, except one real gap (below). |
| 3 | Dependency Freshness & EOL | **Merge** as a lens on the Vulnerability scanner. |
| 4 | Secrets & Credential Scanner | **Merge** as a lens. The detection engine already exists — it is simply not offered as a scan. |
| 5 | License & Supply-Chain Risk | **Merge** as a lens on the Vulnerability scanner. |
| 6 | Attack Surface Mapper | **Merge** as a lens on Architecture X-ray — and re-scope it (below). |
| 7 | Right-Sizing Recommender | **Merge** into Cloud cost analyzer — and re-scope it (below). |
| 8 | Multi-Cloud Migration Simulator | **Merge** as a mode of the Infrastructure Cost Estimator. |
| 9 | Complexity Regression Tracker | **Already ships in full.** Ignore entirely. |

### What already ships (do not design these)

- **The CI/CD gate plugin (#2) exists.** The product generates a GitHub Actions
  audit workflow with a `fail_on` severity threshold (fail on `high` means high
  *and worse*), an `arch_fail_on` opt-in for architecture findings, and a
  separate optimizer workflow that fails a build only when a measured Big-O
  grade exceeds that function's declared ceiling. All of them skip themselves
  with a notice rather than going red when the API key is absent. **The one real
  gap: the Cost Estimator has no CI gate** — design that, and only that, as new.
- **The Algorithm Complexity Regression Tracker (#9) exists in full.** It is
  exactly the optimizer's CI gate plus the nightly monitor pass: functions are
  named in `optimizer.config.json`, each with a ceiling; the gate blocks a PR on
  regression past the ceiling, and the nightly sweep emails regressions only —
  improvements ride along but never trigger. Designing this again would ship a
  duplicate of a shipped feature.

### What must be re-scoped to stay honest

Two proposals assume data this product deliberately cannot obtain. The invariant
is absolute and is written into the Terms and Privacy Policy: **Algosize never
connects to a cloud account and never stores a credential.** Design the
achievable version and label the gap rather than implying reach the product does
not have.

- **Attack Surface Mapper (#6)** was proposed as mapping "a deployed
  environment." The product cannot reach a deployed environment. What it *can*
  do — from exactly the manifests the X-ray already ingests — is derive the
  **declared** external surface: published port mappings in Compose, `EXPOSE` in
  Dockerfiles, Kubernetes Services of type LoadBalancer/NodePort and Ingress
  rules, and `wrangler.toml` routes. That is "what this configuration says is
  reachable," which is genuinely useful and genuinely different from the
  internal dependency graph. It is **not** "what is actually reachable from the
  internet," and the design must say so in the surface itself, not in a
  footnote. Do not design an active scanner, a port prober, or anything that
  touches a live host.
- **Right-Sizing Recommender (#7)** requires CPU/memory utilization over time.
  The Cost & Usage Report the analyzer parses carries product code, usage type,
  unblended cost, line-item type and pricing term — **no utilization, no
  instance type, no CloudWatch series.** So the recommender cannot be computed
  from what the product has today. Design it as **bring-your-own-metrics**: a
  second, optional upload (a utilization export the user already has) that is
  joined to the CUR groups by resource, with an explicit empty state explaining
  what to export and from where. Every recommendation states which of the two
  inputs it rests on. Never infer utilization from cost.

### What each merged lens actually has to work with

- The vulnerability scanner already fetches lockfiles for four ecosystems and
  parses them to `{ name, version }` per package: npm (`package-lock.json`,
  `yarn.lock`), PyPI (`requirements.txt`), RubyGems (`Gemfile.lock`), Go
  (`go.sum`). **Freshness/EOL (#3) and license/supply-chain (#5) need exactly
  this and nothing more** — the same fetch, the same parse, three different
  questions asked of the same package list. That is why they are lenses and not
  tools.
- A real secrets engine already exists: a pattern catalog where each entry
  carries a type, a severity, a regex and a specific remediation sentence
  (rotate this AWS key, revoke this GitHub PAT at this URL, and so on). Today it
  runs **defensively** — it refuses estimator input that contains a credential.
  **Secrets scanning (#4) is a surfacing problem, not a detection problem.**

## Context — the product these merge into

Algosize is a dark-themed B2B audit product. The dashboard is being redesigned
(see the companion Workspace brief) into **two tabs — Workspace and Monitors &
CI** — with the Workspace as a hub: a tool grid over the recent-runs feed, where
each tool card opens a focused screen for deeper work. Account (holding Team,
API Keys and Branding) sits in the signed-in cluster, not the tab strip.

The five existing tools: **Cloud cost analyzer** (AWS CUR upload, past spend),
**Infrastructure Cost Estimator** (config priced forward across five providers,
cheapest first, asymmetric ranges from named assumptions, never a cloud
connection), **Vulnerability scanner** (public repo URL → lockfiles → OSV.dev
CVEs → shareable report), **Architecture X-ray** (manifests → service graph
scored through speed/cost/security lenses, every finding citing file and line),
**Algorithm Optimizer** (sandboxed function → measured Big-O at n = 100/1,000/
10,000, optional AI rewrite that can itself be measured).

Scheduled monitors already re-run the audit, the X-ray, the cost estimate and
the optimizer per repo on a nightly schedule, storing a per-analyzer baseline
for each: the advisory set, the architecture finding keys, per-provider monthly
totals, and per-function Big-O grades. **Those four baselines are the scorecard's
data source — the scorecard is a rendering of what monitors already know, not a
new pipeline.**

Visual language: near-black `#0a0d14`, card surface `#11151e`, border `#1e2532`,
text `#f1f3f6`, secondary `#8a93a3`, teal accent `#5eead4`, green `#34d399` for
good/improved, amber `#f59e0b` for warnings and provisional states, rose
`#f3c4c4`/`#b15a5a` for failures and regressions. Monospace for grades, money and
identifiers; tabular figures where numbers align. Dark-only.

---

## Prompt

Design the additions below **into the existing Workspace hub and its five tool
screens**. The hard constraint: when you are finished the product still has two
tabs, five tool screens, and one Workspace. Nothing here earns a sixth screen.
Use the established dark theme, teal accent, rounded panels and pill badges;
monospace for every grade, dollar amount and identifier. Dark-only.

**1. The Service Scorecard — a Workspace section, not a page.** Between the
pulse row and the tool grid, a table with one row per monitored repository and
one column per grade: **security**, **cost**, **complexity**, **architecture**.
Each cell is a grade rendered in that analyzer's own idiom — a severity-weighted
letter or count for security, a monthly figure for cost, the worst Big-O against
its ceiling for complexity, a finding count for architecture — plus a compact
trend mark showing which way it moved since the previous nightly run. Every cell
links into the tool screen filtered to that repo, so the scorecard is the index
and the tool screens are the detail.

Three states must be designed with equal care, because the honest ones are what
make the table trustworthy:
- a repo where an analyzer is **switched off** — not a blank, not a zero, but
  "not watched" with the affordance to enable it;
- a repo where the analyzer is on but **has never completed a run** — "first run
  pending," visibly different from a clean result;
- a repo where last night's run was **skipped** (upstream throttled) — showing
  the previous grade, marked stale, with the reason.

Sort and filter by any column. Design the empty state: no monitors yet, one
sentence on what a monitor is and the route to create one. Keep the table dense
— a team with fifteen services should see all fifteen without scrolling.

**2. Vulnerability scanner — three lenses over one fetch.** The scanner screen
gains a lens switcher over the same scanned repo: **CVEs** (today's behavior),
**Freshness & EOL**, **Licenses & supply chain**, and **Secrets**. The lens
switcher must make clear that all four read the same lockfile fetch — one scan,
four questions — rather than implying four separate runs.

- **Freshness & EOL**: per package, current version against latest, how far
  behind, last release date, and an end-of-life or unmaintained flag. Rank by
  risk, not alphabetically. Distinguish "behind but maintained" from "abandoned"
  — they need different responses and must not share a colour.
- **Licenses & supply chain**: per package, its licence with copyleft conflicts
  called out against a project licence the user states, plus supply-chain
  signals (typosquat-shaped names, ownership changes, packages that vanished).
  Where a signal is heuristic, say so on the row.
- **Secrets**: findings from the existing pattern catalog, each carrying its
  severity, its type, the file and line, and **the specific remediation sentence
  the catalog already stores** ("rotate this AWS access key," "revoke this PAT
  at this URL"). Two rules: never render the secret value itself, only enough
  context to locate it; and design the "found nothing" state so it reads as a
  scan result, not as an absence of the feature.

**3. Architecture X-ray — the Attack Surface lens.** A fourth lens beside speed,
cost and security: **exposure**. Render the declared external surface derived
from the same manifests — published ports, `EXPOSE` directives, LoadBalancer and
NodePort Services, Ingress rules, Worker routes — as an outside-in view: what a
stranger on the internet could address, and which internal service each entry
point lands on. Every entry cites its file and line, like every other X-ray
finding.

The scoping honesty is a design element, not a disclaimer: the header of this
lens states plainly that this is **what the committed configuration declares**,
not a live probe, and that anything provisioned outside these files is invisible
to it. Design the case where the manifests declare no external surface at all —
which is a finding ("nothing in these files is reachable"), not an empty state.

**4. Cloud cost analyzer — the Right-Sizing pane.** Add a second, optional
upload beside the CUR: a utilization export the user brings themselves. Design
three states:
- **CUR only** (the common case): the pane explains that right-sizing needs
  utilization data the CUR does not contain, names the export to fetch and where
  from, and — importantly — still shows what the CUR alone *can* support, so the
  pane is never merely a locked door.
- **Both uploaded**: recommendations joining provisioned capacity to observed
  utilization, each stating the saving, the confidence, and which input it rests
  on. A recommendation derived from one input must be visually distinct from one
  derived from both.
- **Mismatched inputs**: the two files cover different periods or different
  resources — say which, and what to re-export.

Never infer utilization from spend.

**5. Infrastructure Cost Estimator — the Migration mode.** A mode switch on the
estimator screen: **Steady state** (today) and **Migration**. Migration takes
the same priced configuration and adds the one-time costs of moving from a named
current provider to a target: data egress out, plus user-entered estimates for
re-architecture effort and downtime risk.

The design's whole job here is keeping two kinds of number visibly apart.
Egress is *computed* from list prices. Re-architecture and downtime are *typed
in by the user* — they are assumptions, not measurements, and must never sit in
the same visual register as a priced line item. Show the break-even: how many
months of steady-state saving repay the one-time cost, and design the case where
it never breaks even as a first-class result. Carry the existing "not a bill"
line into this mode unchanged.

**6. The Estimator's CI gate — the one genuinely missing gate.** On the
estimator screen beside its nightly-watch card, a gate card matching the audit
and optimizer gates already shipped: a generated workflow that prices the pull
request's changed configuration and annotates the PR with the delta ("this PR
moves the DigitalOcean estimate $42.00 → $48.20/mo"), optionally failing past a
monthly budget ceiling the user sets. Match the established posture exactly: a
missing API key **skips with a notice, never a red build**; the ceiling is
compared against the honest end of the range, not the point estimate. Design its
three states — no budget set (annotate only), annotating, gating at a ceiling.

**7. Do not design.** No screen for the CI/CD gate plugin as a whole (the audit
and optimizer gates ship, and the estimator gate is section 6). No screen for
complexity-regression tracking (it ships as the optimizer's gate and nightly
watch). If a proposed capability turns out to be a subset of something already
on the canvas, show it in place and label it as existing rather than drawing it
twice.

Throughout: "never ran" is never rendered as zero, and "not watched" is never
rendered as either; heuristic signals say they are heuristic; user-entered
assumptions never look like measurements; every empty, skipped, refused and
partial state says what happened and what to do next in one sentence; never
render an action the viewer cannot take. Plain, specific copy — no exclamation
marks, and no claim of reach the product does not have.
