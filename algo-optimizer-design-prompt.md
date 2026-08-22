# Claude Design Prompt — Algosize Algorithm Optimizer

## Context

Algosize is a dark-themed B2B audit product (dependency-vulnerability scanning, cloud
cost estimation, architecture analysis) whose dashboard is a single static page of
rounded card panels. The Algorithm Optimizer is one of its four analysis tools, and
today it is a single panel: paste a JavaScript function and a JSON sample input, press
"Optimize →", and the Worker runs the function in an isolated sandbox and returns —

- **Measured Big-O** — the function is re-run at three input sizes (n = 100 / 1,000 /
  10,000), the timings are fitted on a log-log scale, and the slope is bucketed into
  O(1), O(log n), O(n), O(n log n), O(n²), O(n³), an open-ended O(n^k), or "unknown"
  with a stated reason (e.g. every run was under the 0.1 ms noise floor, or a probe
  failed partway). The three (n, ms) points are returned and drawn as a small inline
  SVG chart.
- **Wall time and result size** of the single run on the user's own sample input.
- **Sample-run output preview**, truncated with an honest note past 100 KB.
- **An AI refactor suggestion** — a paragraph of advice plus a rewritten function with
  a copy button. The provider can be off, and the UI says so plainly ("Refactor
  suggestion (AI disabled)") rather than pretending.

Around that panel the optimizer has grown two more surfaces that live elsewhere today:

- **A per-PR CI gate.** Customers commit `optimizer.config.json` at their repo root —
  each entry names one self-contained function (`file`, `functionName`, an optional
  `sampleInput`, and a `baseline` complexity **ceiling**). A generated GitHub Actions
  workflow re-measures each function through the same API on every pull request and
  goes red **only** when a measured grade exceeds its ceiling; a missing secret skips
  with a notice, a missing file or function is a warning, never a failure. Ceilings
  accept both spellings (`O(n^2)` and `O(n²)`).
- **A scheduled nightly watch.** A repo monitor with the optimizer analyzer enabled
  re-grades the same config's functions every night (capped at 12 entries, the cap
  reported when it bites) and emails **regressions only** — a grade moving to a worse
  bucket. Improvements ride along in an email already being sent but never trigger
  one; the first run records grades silently as the baseline.

Hard constraints the design must respect: functions must be **self-contained** (no
imports, no closures over file-level helpers — a real parser slices them, and this
limit should be stated in the UI, not discovered by failure); sample inputs must be a
JSON array or number for the probe to synthesize larger sizes; the free tier has a
monthly run quota (the dashboard already shows an upgrade banner at the limit).

Visual language: near-black background (`#0a0d14`) with a slightly lighter elevated
surface (`#11151e`) for cards, a cool grey-blue border (`#1e2532`), near-white text
(`#f1f3f6`) with a muted grey-blue secondary (`#8a93a3`), a teal accent (`#5eead4`)
as the primary interactive color, green (`#34d399`) for success/improvement, amber
(`#f59e0b`) for warnings, and a rose/red reserved for regressions and failures.
Monospace type for code, grades, and numbers. Buttons are rounded with a solid teal
primary and a bordered ghost secondary; cards are rounded panels with a header/body
split; small pill badges carry states. There is no light mode — design dark-only.

---

## Prompt

Design the Algorithm Optimizer as a full page — the tool graduating from one panel
into the product's performance workbench, pulling its three existing surfaces (the
interactive run, the CI gate, the nightly watch) into one coherent place. Use the
established dark theme, teal accent, rounded-card and pill-badge language; monospace
everywhere a grade, a timing, or code appears. Dark-only; do not design a light mode.

Lay the page out as a workbench, not a wizard: a primary "Measure" column and a
supporting "Keep it fast" column (stacking on narrow viewports), with the page header
carrying the tool's one-line promise — measured complexity, not guessed — and the
free-tier run meter where a quota exists.

**1. The measure bench (primary column).** A code editor card for one JavaScript
function with a monospace textarea look, a sample-input field beneath it, and the
Optimize action. State the self-contained rule right here as a quiet inline hint
("one function, no imports or outer variables — we run exactly what you paste"), and
show the two example chips that already exist (Load sample). Design the run states:
idle, running (the sandbox is measuring at three sizes — show which size it is on),
and failed (the sandbox rejected the function, with the reason verbatim and no
retry-theater).

**2. The verdict.** When a run completes, the result leads with a large Big-O grade
badge — the single thing someone screenshots — flanked by wall time and result size
stat tiles. Under it, the timing curve: the three (n, ms) probe points on a log-x
chart, drawn so a straight line reads as polynomial and the fitted slope is annotated
("slope ≈ 2.0 → O(n²)"). When the grade is "unknown", design that state with the same
prominence and the stated reason — an unmeasurable function is a first-class outcome,
not an error toast. Include the sample-output preview with its truncation note.

**3. The AI rewrite, with receipts.** The refactor suggestion renders as advice text
plus a rewritten function in a copyable code block — and add the one feature that
makes it trustworthy: a "Measure the rewrite" action that runs the suggestion through
the same sandbox and probe, then shows **before / after side by side** — two grade
badges, two curves on one chart, the delta called out ("O(n²) → O(n log n), 41× faster
at n = 10,000"). If the rewrite measures the same or worse, say so with equal
prominence — the honesty is the product. Design the AI-disabled state too: the
section stays, states that suggestions are off, and everything measured above it
still stands.

**4. The watchlist (supporting column).** A card representing `optimizer.config.json`
as a live list: each entry a row with function name, file path, its complexity
**ceiling** (a picker offering O(1) → O(n³), both spellings accepted), and its latest
measured grade as a pill — green when under the ceiling, rose when over, grey "not
yet measured". A "Add current function" action promotes whatever was just measured on
the bench into the list, pre-filling the ceiling one bucket above its measured grade
(the noise-safe default the docs recommend). The card's footer is a copy/download of
the resulting JSON, with the note that committing this one file at the repo root is
what both the CI gate and the nightly watch read — one list, three consumers. Show
the 12-entry nightly cap inline when the list passes it.

**5. The two guards.** Beneath the watchlist, two compact status cards:

- **Every pull request** — the CI gate. Three-step state: no key yet (links to where
  keys are minted, and says the workflow skips itself with a notice until the secret
  exists — never a red build), configured (shows the workflow filename and a copy
  action), and live (last gate result: passed, or "sum exceeded O(n) ceiling —
  measured O(n²)" with the PR reference).
- **Every night** — the scheduled watch. Off (a one-line pitch and a toggle that
  routes to the repo monitor), on and clean ("6 functions graded · no regressions"),
  and the regression state mirroring the alert email: function name, from-grade →
  to-grade, when. Improvements appear here in green but are explicitly labeled as
  never having triggered an email.

**6. Grade history (new — design it, flag it).** A slim trend strip per watched
function: its grade over the last N runs as a stepped line of buckets, so a
regression is a visible step up and a fix a step down. Mark this section in the
design as a proposed addition, since the product stores baselines today but not yet
a per-run history.

Throughout: regressions are rose, improvements green, ceilings and grades always
monospace, and every empty or failed state says what happened and what to do next in
one sentence. Never render an action the viewer can't take — if AI suggestions are
off or the quota is spent, show the honest state instead of a dead button. The tone
of every string matches the product's existing voice: plain, specific, no
exclamation marks, and never claiming a measurement that wasn't made.
