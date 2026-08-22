# Claude Design Prompt — Algosize Infrastructure Cost Estimator (automation-first)

## Context

Algosize is a dark-themed B2B audit product (dependency-vulnerability scanning,
algorithm optimization, architecture analysis) whose dashboard is a single static
page of rounded card panels. The Infrastructure Cost Estimator exists today as a
**fully built API with no dedicated page** — this design gives it one. Do not
confuse it with the dashboard's existing "Cost analyzer" panel, which reads an AWS
Cost & Usage Report CSV of *past* spend; the estimator prices a *proposed or
current configuration* forward. The two answer opposite questions and the page
should say so.

What the engine does on demand, all of which the design must surface:

- **Five input types**: a Docker Compose file, a Kubernetes manifest, a Terraform
  plan JSON, a hand-built manual spec, and a pre-normalized spec — Compose is the
  flagship. Adapters emit honest warnings the UI must carry: a compose file
  describes containers, not volumes/databases/egress; a service with no CPU/memory
  limits is **unsupported, never free**; legacy v2 limit spellings are read but
  called out.
- **Five providers priced side by side**: AWS, DigitalOcean, Hetzner,
  Akamai/Linode, Vultr — cheapest first, with one hard rule: a provider that could
  not price the workload sorts last regardless of its total, because "$0 because we
  know nothing" must never win a comparison.
- **Per-provider detail**: an integer micro-USD monthly total; a **range that is
  asymmetric by construction** — it widens only where a named assumption widens it
  (utilization band, unknown egress priced at zero with a stated ceiling on the
  upper bound, stale-catalog band, minimum billable duration); a derived
  **confidence** level; itemized line items; the full **assumption list, each with
  a cause and a sentence**; unsupported resources listed by name; and the pricing
  catalog's version, last-verified date, and source URL.
- **The honesty layer, which is the product**: every response carries the
  disclaimer verbatim — "This is an estimate calculated from the configuration you
  provided, using published list prices. It is not a bill, a quote, or a
  prediction of your actual invoice." — and the pricing catalog carries a
  `verificationStatus` that is currently **unverified**: prices were seeded and no
  human has confirmed them against the providers' published pages yet. When
  unverified, every estimate wears that banner; do not soften it.
- **The trust boundary**: there is **no cloud-account connector and no credential
  storage** — the estimator never connects to AWS or anyone else. Input is pasted
  or uploaded text, size-capped, and scanned for secrets at the boundary (a
  compose file containing what looks like a credential is refused with a pointer,
  not stored). This is a selling point; give it a visible line on the page.
- **Options**: restrict to chosen providers, supply monthly egress GiB, set a
  duration (default one month).

The estimator's **automation** exists today as a scheduled monitor and should
become this page's second half rather than a footnote:

- **The nightly re-price.** A repo monitor with the estimate analyzer enabled
  fetches the repository's **committed** compose file every night — the same
  no-credentials rule: only committed text is read — prices it through the same
  sanitizing engine, and compares per-provider monthly totals against the stored
  baseline. Any total moving, or a provider appearing/disappearing, triggers the
  alert email ("estimated cost changed"), with the first successful run sending a
  baseline estimate showing every provider's total. A repo with no compose file
  records that fact honestly ("we looked, nothing to price") instead of failing
  nightly; a night GitHub throttles the fetch is skipped without moving the
  baseline, so an outage never fakes a cost change.

Visual language: near-black background (`#0a0d14`) with a slightly lighter
elevated surface (`#11151e`) for cards, a cool grey-blue border (`#1e2532`),
near-white text (`#f1f3f6`) with a muted grey-blue secondary (`#8a93a3`), a teal
accent (`#5eead4`) as the primary interactive color, green (`#34d399`) for
success, amber (`#f59e0b`) for warnings and unverified states, rose/red reserved
for refusals and cost increases. Monospace for money, file contents, and
identifiers; tabular figures wherever dollar amounts line up. Rounded cards with
header/body split, pill badges, solid teal primary buttons and bordered ghost
secondaries. Dark-only — no light mode.

---

## Prompt

Design the Infrastructure Cost Estimator as a full page whose organizing idea is
**price it once, watch it forever**: the interactive bench answers "what would
this cost", and the automation half turns that into a standing answer — the
committed compose file re-priced every night, with every movement reported. The
page's character is **honest accounting** — every dollar traceable to a line
item, every widening of the range traceable to a named assumption — in the
product's established dark theme with teal accents and monospace numerals.
Dark-only; do not design a light mode.

Structure the page as two halves that read as one pipeline — **Price it now** and
**Keep it priced** — side by side on wide viewports, stacked on narrow ones, with
a visible connective thread: the same compose file flows from the paste area to
the nightly watch.

**1. Input bench.** A card headed by an input-type selector (Compose · Kubernetes
· Terraform plan · Manual · Normalized) — Compose first and default. File-shaped
types get a large monospace paste area with drag-drop; Manual gets a small
repeatable resource form (CPU, memory, count). Below, an options row: provider
checkboxes (all five on by default), an egress GiB field whose empty state says
"unknown — priced at zero with a stated ceiling", and a duration control
defaulting to one month. State the trust boundary in a quiet single line: "Nothing
here connects to a cloud account. We price the text you paste — credentials are
refused, never stored." Design the refusal state: a pasted file that trips the
secret scan is rejected in rose with the reason and where it was found, nothing
retained.

**2. The verdict strip.** One card per provider, cheapest first and visually
crowned (teal ring, "cheapest" pill): provider name, the monthly total in large
tabular monospace, the range beneath it rendered **asymmetrically** — a bar with
the point estimate off-center within its band, because the band is built from
one-sided assumptions and a symmetric whisker would be a lie — and a confidence
pill (high / medium / low). A provider that could not price the workload renders
last as a distinct "could not price" card listing what it lacked — never $0,
never hidden.

**3. The unverified banner.** While the pricing catalog is unverified, an amber
band sits directly above the verdict strip: "Prices are seeded from provider
sites but not yet human-verified — treat every number here as provisional." Each
provider card also carries its catalog version, last-verified date, and source
link. Design the verified state too (band gone, a quiet per-card "verified
<date>" line) — but the unverified state is the launch state and gets the design
attention.

**4. Where the money is.** Selecting a provider expands the ledger: line items in
a monospace table (resource, quantity, unit price, monthly cost) summing visibly
to the total — the sum line is the anchor of the page. Beside it, the
**assumptions panel**: every assumption as a row with its cause as a small tag
(`unknown_egress`, `utilization_assumption`, `stale_pricing_catalog`,
`bundled_plan_allocation`, `minimum_billable_duration`…), its sentence verbatim,
and — where it widens the range — the widening it contributes, so the gap between
point and bound is fully accounted for. Unsupported resources get amber rows:
named, explained, explicitly *excluded from the total* rather than silently
zeroed. Adapter warnings render in the same system. The full "not a bill"
disclaimer appears verbatim beneath the verdict strip in secondary text — on the
page, not behind a link.

**5. The nightly watch — the automation half, a full card.** The bench's closing
action is the handoff: **"Watch this repo's compose file"**. Design the watch
card in four states:

- **Off.** One sentence — "a repo monitor can price your committed compose file
  every night and email you only when a provider's total moves" — with the route
  to enable it, and the trust line repeated: committed file only, no cloud
  account, no credentials.
- **Baseline pending.** Watching, first nightly run not yet complete: "first
  price within a day — the baseline email lists every provider's total."
- **Watching, steady.** The live summary: repo name, "cheapest: DigitalOcean
  $12.34/mo", every provider's last total in a compact monospace row, last priced
  when. A quiet green "no change since <date>".
- **Moved.** The state mirroring the alert email: per provider, from → to in
  tabular monospace ("$12.34 → $18.72"), increases in rose, decreases in green,
  providers appearing or disappearing called out, and the timestamp. Include the
  two honest edge states: "no compose file found at the repo root — we looked,
  there is nothing to price" (a fact, not an error), and a skipped night ("GitHub
  throttled the fetch — baseline unchanged").

**6. The PR cost gate (new — design it, flag it).** A card proposing the
estimator's equivalent of the optimizer's CI gate: a workflow that prices the
PR's changed compose file and annotates the pull request with the delta
("this PR moves the DigitalOcean estimate $12.34 → $18.72/mo"), optionally
failing past a named monthly budget ceiling. Design its states (no budget set /
annotating only / gating at a ceiling) — and mark the whole card as a proposed
addition, since no estimator CI workflow exists yet. Reuse the audit and
optimizer gates' established posture in the copy: a missing key skips with a
notice, never a red build.

**7. Cost history (new — design it, flag it).** A trend strip per provider on
the watched repo: nightly totals as a stepped line with change-points marked,
so a config change's cost impact is a visible step. Flag as proposed — the
product stores the current baseline, not a per-night history.

Throughout: money is always monospace with tabular figures and always carries
its period ("/mo"); ranges are never symmetric decorations; amber is reserved
for "provisional or excluded", rose for "refused or costlier", green for
"cheapest or cheaper". Every empty, failed, refused, and skipped state says what
happened and what to do next in one sentence. Never render an action the viewer
can't take. No number appears anywhere without a path to how it was computed,
and nothing on the page ever claims to be a bill.
