# Claude Design Prompt — Monitors & CI: What Runs Without You

## Context

Algosize is a dark-themed B2B audit product whose dashboard is collapsing into
two tabs: **Workspace** (what you ran) and **Monitors & CI** (what runs without
you). This brief redesigns the second tab.

### What the page is today

Three stacked panels:

1. **Scheduled scans** — one row per monitored repo+branch: repo name, branch,
   schedule (daily or weekly, both at 03:00 UTC, not configurable), a status
   badge from the last audit (known-advisory count, or "baseline pending"),
   delta chips for what the last sweep found new, per-analyzer toggle chips
   (the audit always on; Architecture X-ray, cost estimate and optimizer
   opt-in, each with a one-number summary), pause/resume and remove. A usage
   meter against the plan's monitor limit, and a create form (repo URL, branch,
   schedule, analyzer picker).
2. **Audit every pull request** — a permanently-expanded three-step wizard
   (create an API key → add the `ALGOSIZE_API_KEY` secret → commit the
   workflow) plus a single status row that checks whether *any* CI run has
   ever arrived.
3. **Gate complexity regressions** — a second permanently-expanded three-step
   wizard for the optimizer workflow (`optimizer.config.json` + workflow file).

The nightly machinery behind it: a 03:00 UTC cron enqueues one job per due
monitor; each job re-runs the enabled analyzers against committed repository
files only (no cloud credentials, ever), diffs against stored baselines, and
emails **only what is new**. Baselines survive transient failures — a night
GitHub throttles the fetch is skipped without moving them, so an outage never
fakes an "everything is new" morning.

### What is verifiably missing (each checked against the shipped code)

1. **Findings are email-only.** The sweep does not write into the runs feed and
   the dashboard stores only one summary number per analyzer. If you delete the
   alert email, there is no way to see what a monitor found. The stored
   baselines (the full known-advisory set, architecture finding keys,
   per-provider totals, per-function grades) exist server-side but are
   inspectable nowhere.
2. **Two pieces of alert routing are configured but dead.** Account offers a
   "Monitor alerts" notification preference and a Slack webhook field — and the
   sweep consults neither. Every alert goes to the org's billing owner's email,
   regardless of what anyone configured. This is a wiring gap, not a feature
   request: the settings exist, the send site ignores them.
3. **A misconfigured monitor is indistinguishable from a new one.** When the
   audit fails permanently (repo has no supported lockfile, URL went stale),
   the run is not recorded — so the row shows "baseline pending" forever, the
   same badge a healthy monitor shows on day one. Skipped nights (upstream
   throttled) are likewise not persisted, so a monitor that hasn't actually
   run in a week looks identical to one that ran clean last night.
4. **No "run now."** Creating a monitor means waiting until 03:00 UTC to learn
   whether it works. There is no on-demand sweep of one monitor.
5. **The wizards never stand down.** Once CI is connected, both three-step
   wizards keep occupying the full page as if setup never happened. The one
   status row only answers "has any CI run ever arrived," not per-repo health
   or recent results.
6. **CI activity is invisible here.** Recent CI runs exist in the system (the
   Workspace feed filters to them) but the tab that owns CI shows none of
   them, and the optimizer gate's per-PR results are not stored server-side at
   all (a known, flagged gap).
7. **Schedule is one-size:** daily or weekly, both at 03:00 UTC. No
   time-of-day choice.

Also true and worth surfacing rather than fixing: uniqueness is per
repo **and branch**, so watching `main` and `develop` of the same repo as two
monitors already works — the flat list just hides the relationship.

### Visual language

Near-black `#0a0d14`, card surface `#11151e`, border `#1e2532`, text
`#f1f3f6`, secondary `#8a93a3`, teal accent `#5eead4`, green `#34d399`
(healthy/clean), amber `#f59e0b` (stale, skipped, provisional), rose
`#f3c4c4`/`#b15a5a` (failing, misconfigured, regressed). Monospace for repos,
grades, money, commit SHAs; tabular figures where numbers align. Rounded
panels with header/body split, pill badges, solid teal primary buttons,
bordered ghost secondaries. Dark-only — no light mode.

---

## Prompt

Redesign the Monitors & CI tab around one sentence: **this page is the product
working while you don't, and it must prove it.** Today it is a setup page that
happens to list monitors; make it an operations page where setup is a one-time
errand that then gets out of the way. Use the established dark theme, teal
accent, rounded-card and pill-badge language; monospace for every repo, grade,
SHA and dollar figure. Dark-only.

**1. Health, not just existence.** Rebuild the monitor row around an explicit
health state, because "we watched last night and found nothing" and "we have
not actually watched for a week" are different facts that currently share a
badge. Five states, each with its own treatment:

- **healthy** — last sweep completed; badge shows the standing result and the
  delta, as today;
- **baseline pending** — created, first sweep not yet run; visibly a waiting
  state, with the time until the next sweep;
- **misconfigured** — the sweep ran and failed for a reason retrying won't fix
  (no supported lockfile, repo gone). Rose, the reason verbatim, and the one
  action that fixes it. This state must be impossible to confuse with
  "pending";
- **stale** — last night was skipped (upstream throttled). Amber; show the
  previous result marked as of its date, plus "baselines unchanged" so a skip
  never reads as a regression;
- **paused** — as today, muted.

Group rows by repository so two watched branches of the same repo read as one
service with two lines, not two strangers.

**2. The monitor drill-in — findings without the email.** Each row opens a
detail view (inline expansion or side panel — choose and commit) showing what
the product currently knows about that repo: the full known-advisory set the
audit is diffing against, the architecture findings behind the count, the
per-provider monthly totals, the per-function grades against their ceilings —
every one of these is already stored as the diff baseline and rendered
nowhere. Add a **sweep timeline** — the last N nights, each with its outcome
(clean / N new / skipped / failed) — and mark the timeline **proposed**: the
product stores the current baseline, not per-night history, so this strip
needs new storage while the baseline inspection needs none. From the detail
view: pause, remove, edit analyzers, and **Run now**.

**3. Run now.** A button on every monitor (row and detail) that triggers one
immediate sweep, with a running state and the result landing in place. Its
first-class use is validating a monitor you just created — design the
create-form success state to offer it ("first scheduled run is tonight at
03:00 UTC — or run it now"). Mark it as a small backend addition (a
manual-trigger endpoint on the existing queue), not fiction.

**4. Alert routing — wire what exists, show where alerts go.** A routing card
on the page stating, per channel, exactly where the next alert will be
delivered: the email recipients (honoring the "Monitor alerts" notification
preference that Account already offers) and the Slack webhook (which Account
already stores). Both settings currently exist but are ignored by the send
site — design the fixed state, where this card reflects reality, and the
unconfigured state, which links to the Account sections that already exist
rather than duplicating their forms here. Include a "send a test alert"
affordance per channel. Never show a channel as active that will not actually
receive the next alert — the card's honesty is its entire value.

**5. Schedules with a time.** Keep daily/weekly, add a time-of-day picker
(shown in the user's timezone, stored in UTC, with the UTC time visible so
distributed teams aren't surprised). The default stays 03:00 UTC. This is
deliberately modest — do not design cron strings.

**6. CI: status first, setup on demand.** Collapse the two wizards into
compact per-workflow status cards — dependency audit gate, optimizer gate, and
the estimator gate (specified as new in the companion tools brief; include its
card here in the not-yet-configured state). Each card leads with its live
state: not set up → one line and a "Set up" expander that reveals the existing
three steps; configured → the workflow filename, what it gates on
(`fail_on` threshold, Big-O ceilings, budget ceiling), and its last result.
Below the cards, a **recent CI runs** strip fed by the runs the system already
records — repo, commit, verdict, when — replacing the single "has any CI run
ever arrived" row with actual recency. Per-PR optimizer gate results remain
unstored server-side; where the strip would show them, mark that slice
proposed rather than inventing rows.

**7. The page header.** Lead with the operational truth: how many repos under
watch, when the next sweep fires, when the last one completed, and how many
alerts went out this week. If nothing is watched yet, the header becomes the
pitch — one sentence on what a monitor is and the create form front and
center.

Throughout: "never ran" is never rendered as zero, "not watched" as neither,
and a skipped night is never rendered as a result; every failure state names
its reason and its fix in one sentence; setup UI appears only while there is
something to set up; never render an action the viewer cannot take, and never
show a channel, schedule or gate as active unless it truly is. Plain, specific
copy — no exclamation marks, and no claim the machinery does not back.
