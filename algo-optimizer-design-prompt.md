# Claude Design Prompt — Algosize Algorithm Optimizer (automation-first)

## Context

Algosize is a dark-themed B2B audit product (dependency-vulnerability scanning, cloud
cost estimation, architecture analysis) whose dashboard is a single static page of
rounded card panels. The Algorithm Optimizer is one of its four analysis tools. Today
it is a single interactive panel: paste a JavaScript function and a JSON sample
input, press "Optimize →", and the Worker runs the function in an isolated sandbox
and returns —

- **Measured Big-O** — the function is re-run at three input sizes (n = 100 / 1,000 /
  10,000), the timings are fitted on a log-log scale, and the slope is bucketed into
  O(1), O(log n), O(n), O(n log n), O(n²), O(n³), an open-ended O(n^k), or "unknown"
  with a stated reason (e.g. every run was under the 0.1 ms noise floor, or a probe
  failed partway). The three (n, ms) points are returned and drawn as a chart.
- **Wall time and result size** of the single run on the user's own sample input,
  plus a **sample-output preview** truncated with an honest note past 100 KB.
- **An AI refactor suggestion** — advice text plus a rewritten function with a copy
  button. The provider can be off, and the UI says so plainly ("Refactor suggestion
  (AI disabled)") rather than pretending.

The optimizer's real power is its **automation**, which today lives on a different
screen and should become this page's spine:

- **One config file, three consumers.** `optimizer.config.json` at the customer's
  repo root lists self-contained functions to watch — each entry: `file`,
  `functionName`, an optional `sampleInput`, and a `baseline` complexity **ceiling**
  (both spellings accepted: `O(n^2)` and `O(n²)`). The interactive bench, the CI
  gate, and the nightly watch all read the same list by construction.
- **The per-PR CI gate.** The product generates a complete GitHub Actions workflow
  (`.github/workflows/algosize-optimizer.yml`) plus a starter config, served by an
  API endpoint with copy-ready snippets. On every pull request the workflow slices
  each configured function out of the PR's own checkout and re-measures it through
  the same API the bench uses — the grade CI gets and the grade the dashboard would
  give can never disagree. The build goes red **only** when a measured grade exceeds
  that entry's ceiling. A missing `ALGOSIZE_API_KEY` secret makes the workflow skip
  itself with a notice — never a red build; a missing file or function is a warning
  annotation, not a failure. It authenticates with the **same repository secret as
  the dependency-audit workflow**, so an audit customer has zero new setup.
- **The scheduled nightly watch.** A repo monitor with the optimizer analyzer
  enabled re-grades the same config's functions every night (capped at 12 entries,
  the cap reported when it bites) and emails **regressions only** — a grade moving
  to a worse bucket, or to "unknown". Improvements ride along in an email already
  being sent but never trigger one; the first run records grades silently as the
  baseline. A night the sandbox or GitHub is unreachable is skipped without moving
  the baseline — an outage never fakes an "everything regressed" morning.

Hard constraints the design must respect: functions must be **self-contained** (no
imports, no closures over file-level helpers — a real parser slices them, and this
limit must be stated in the UI, not discovered by failure); sample inputs must be a
JSON array or number for the probe to synthesize larger sizes; the free tier has a
monthly run quota (the dashboard already shows an upgrade banner at the limit).

Visual language: near-black background (`#0a0d14`) with a slightly lighter elevated
surface (`#11151e`) for cards, a cool grey-blue border (`#1e2532`), near-white text
(`#f1f3f6`) with a muted grey-blue secondary (`#8a93a3`), a teal accent (`#5eead4`)
as the primary interactive color, green (`#34d399`) for success/improvement, amber
(`#f59e0b`) for warnings, and rose/red reserved for regressions and failures.
Monospace type for code, grades, and numbers. Buttons are rounded with a solid teal
primary and a bordered ghost secondary; cards are rounded panels with a header/body
split; small pill badges carry states. There is no light mode — design dark-only.

---

## Prompt

Design the Algorithm Optimizer as a full page whose organizing idea is **measure
once, enforce forever**: the interactive bench is how a function gets its first
grade, and everything to the right of it turns that grade into standing automation —
a per-PR gate and a nightly watch driven by one committed config file. Use the
established dark theme, teal accent, rounded-card and pill-badge language; monospace
everywhere a grade, a timing, or code appears. Dark-only; do not design a light mode.

Structure the page as a left-to-right pipeline that reads as a story: **Measure →
Watchlist → Automations**, stacking to a single column on narrow viewports. The
page header carries the promise ("measured complexity, not guessed — enforced on
every pull request and every night") and the free-tier run meter where a quota
exists.

**1. The measure bench.** A code editor card for one JavaScript function with a
monospace textarea look, a sample-input field beneath it, and the Optimize action.
State the self-contained rule as a quiet inline hint ("one function, no imports or
outer variables — we run exactly what you paste"), keep the Load-sample chip, and
design the run states: idle, running (the sandbox is measuring at three sizes —
show which size it is on), and failed (the sandbox's reason verbatim, no
retry-theater).

**2. The verdict.** A completed run leads with a large Big-O grade badge — the
thing someone screenshots — flanked by wall-time and result-size stat tiles. Under
it, the timing curve: the three (n, ms) probe points on a log-x chart with the
fitted slope annotated ("slope ≈ 2.0 → O(n²)"). Design "unknown" with the same
prominence and its stated reason — an unmeasurable function is a first-class
outcome, not an error toast. Include the sample-output preview with its truncation
note. The verdict's closing action is the handoff that makes the page one system:
**"Watch this function"** — promoting it into the watchlist with its ceiling
pre-filled one bucket above the measured grade (the noise-safe default).

**3. The AI rewrite, with receipts.** Advice text plus the rewritten function in a
copyable code block — and the feature that makes it trustworthy: **"Measure the
rewrite"**, running the suggestion through the same sandbox and probe and showing
before / after side by side (two grade badges, two curves on one chart, the delta
called out: "O(n²) → O(n log n), 41× faster at n = 10,000"). If the rewrite
measures the same or worse, say so with equal prominence. Design the AI-disabled
state: the section stays, says suggestions are off, and everything measured above
it still stands.

**4. The watchlist — the config as the page's hub.** A card representing
`optimizer.config.json` as a live, editable list, visually positioned as the thing
the bench feeds and both automations consume (draw that relationship — a subtle
connective treatment from bench → list → the two automation cards, so the "one
list, three consumers" fact is legible in the layout itself, not just stated in
copy). Each entry is a row: function name, file path, its complexity **ceiling** (a
picker offering O(1) → O(n³), both spellings accepted), and its latest measured
grade as a pill — green under the ceiling, rose over it, grey "not yet measured".
Inline validation mirrors the parser's rules (missing file/functionName, a
non-array sample). The footer offers copy and download of the resulting JSON with
one sentence: "commit this at the repo root — the PR gate and the nightly watch
both read it." Show the 12-entry nightly cap inline when the list passes it.

**5. The PR gate — a full card, not a status chip.** This is the automation
centerpiece. Design three stacked states:

- **Not set up.** A compact three-step setup living right here (not on another
  screen): ① an API key, noting it is the **same `ALGOSIZE_API_KEY` secret the
  dependency audit uses** — if that is configured, step one shows as already done;
  ② commit the config (points at the watchlist card); ③ commit the generated
  workflow — filename shown, YAML in a copyable snippet block. State the safety
  posture as a feature: "until the secret exists the workflow skips itself with a
  notice — your builds never go red from setup."
- **Armed.** The workflow filename, the count of gated functions, and the ceilings
  they're held to — a quiet green "gating N functions on every pull request".
- **Firing.** The last gate results as a short feed: per PR, pass ("all under
  ceiling") in green or the failure verbatim in rose ("`sum` exceeded O(n) ceiling
  — measured O(n²)") with the PR reference; warnings (file or function not found)
  in amber, explicitly labeled as never failing the build. Flag the feed's
  persistence as a proposed addition where gate results are not yet stored
  server-side — design it against the shape of the workflow's real annotations.

**6. The nightly watch — the second automation card.** Three states: off (one
line — "the repo monitor re-grades this list every night and emails only
regressions" — with the route to enable it on the monitor); on and clean ("6
functions graded nightly · no regressions · baseline recorded <date>"); and the
regression state mirroring the alert email exactly: function name, from-grade →
to-grade, when, in rose. Improvements appear in green, explicitly labeled "never
triggers an email". Include the honest outage line for a skipped night: "last
night's run was skipped (GitHub throttled) — baselines unchanged."

**7. Grade history (new — design it, flag it).** A slim trend strip per watched
function: its grade over recent runs as a stepped line of buckets, so a regression
is a visible step up and a fix a step down, with gate failures and nightly alerts
as markers on the same strip. Mark this as a proposed addition — the product
stores baselines today, not per-run history.

Throughout: regressions are rose, improvements green, ceilings and grades always
monospace; the ceiling is always described as a **ceiling** ("stays under O(n)"),
never a target. Every empty, failed, or skipped state says what happened and what
to do next in one sentence. Never render an action the viewer can't take — if AI
suggestions are off, the quota is spent, or the gate has no key, show the honest
state instead of a dead button. The tone of every string matches the product's
voice: plain, specific, no exclamation marks, and never claiming a measurement or
an enforcement that isn't real.
