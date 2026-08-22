# Claude Design Prompt — Algosize Infrastructure Cost Estimator

## Context

Algosize is a dark-themed B2B audit product (dependency-vulnerability scanning,
algorithm optimization, architecture analysis) whose dashboard is a single static
page of rounded card panels. The Infrastructure Cost Estimator exists today as a
**fully built API with no dedicated page** — this design gives it one. Do not confuse
it with the dashboard's existing "Cost analyzer" panel, which reads an AWS Cost &
Usage Report CSV of *past* spend; the estimator prices a *proposed or current
configuration* forward. The two answer opposite questions and the page should say so.

What the engine actually does, all of which the design must surface:

- **Five input types**: a Docker Compose file, a Kubernetes manifest, a Terraform
  plan JSON, a hand-built manual spec, and a pre-normalized spec. Compose is the
  flagship path. Adapters emit honest warnings the UI must carry: a compose file
  describes containers, not volumes/databases/egress ("compose_has_no_
  infrastructure"); a service with no CPU/memory limits is **unsupported, never
  free**; legacy v2 limit spellings are read but called out.
- **Five providers priced side by side**: AWS, DigitalOcean, Hetzner, Akamai/Linode,
  Vultr — results sorted cheapest first, with one hard rule: a provider that could
  not price the workload sorts last regardless of its total, because "$0 because we
  know nothing" must never win a comparison.
- **Per-provider detail**: an integer micro-USD monthly total; a **range that is
  asymmetric by construction** — it only widens where a named assumption widens it
  (utilization band, unknown egress priced at zero with a stated ceiling on the
  upper bound, stale-catalog band, minimum billable duration); a derived
  **confidence** level; itemized line items; the full **assumption list, each with a
  cause and a sentence**; unsupported resources listed by name; and the pricing
  catalog's version, last-verified date, and source URL.
- **The honesty layer, which is the product**: every response carries the disclaimer
  verbatim — "This is an estimate calculated from the configuration you provided,
  using published list prices. It is not a bill, a quote, or a prediction of your
  actual invoice." — and the pricing catalog carries a `verificationStatus` that is
  currently **unverified**: prices were seeded and no human has confirmed them
  against the providers' published pages yet. When unverified, every estimate must
  wear that banner; the design must include it and must not soften it.
- **The trust boundary**: there is **no cloud-account connector and no credential
  storage** — the estimator never connects to AWS or anyone else. Input is pasted or
  uploaded text, size-capped, and scanned for secrets at the boundary (a compose
  file containing what looks like a credential is refused with a pointer, not
  stored). This is a selling point; give it a visible line on the page.
- **Options**: restrict to chosen providers, supply monthly egress GiB, set a
  duration (default one month).
- **A scheduled companion**: a repo monitor with the estimate analyzer enabled prices
  the repository's **committed** compose file nightly and emails when any provider's
  total moves — same engine, same no-credentials rule.

Visual language: near-black background (`#0a0d14`) with a slightly lighter elevated
surface (`#11151e`) for cards, a cool grey-blue border (`#1e2532`), near-white text
(`#f1f3f6`) with a muted grey-blue secondary (`#8a93a3`), a teal accent (`#5eead4`)
as the primary interactive color, green (`#34d399`) for success, amber (`#f59e0b`)
for warnings and unverified states, rose/red reserved for refusals and regressions.
Monospace for money, file contents, and identifiers; tabular figures wherever
dollar amounts line up. Rounded cards with header/body split, pill badges, solid
teal primary buttons and bordered ghost secondaries. Dark-only — no light mode.

---

## Prompt

Design the Infrastructure Cost Estimator as a full page: paste what you run, see
what five clouds would charge for it, and understand exactly how much of that number
is assumption. The page's character is **honest accounting** — every dollar
traceable to a line item, every widening of the range traceable to a named
assumption — rendered in the product's established dark theme with teal accents and
monospace numerals. Dark-only; do not design a light mode.

**1. Input bench.** A card headed by an input-type selector (Compose · Kubernetes ·
Terraform plan · Manual · Normalized) — Compose first and default. For file-shaped
types: a large paste area with drag-drop and a monospace look; for Manual: a small
repeatable resource form (CPU, memory, count). Below the input, an options row:
provider checkboxes with all five on by default, an egress GiB field whose empty
state says "unknown — priced at zero with a stated ceiling", and a duration control
defaulting to one month. State the trust boundary in a quiet single line under the
bench: "Nothing here connects to a cloud account. We price the text you paste —
credentials are refused, never stored." Design the refusal state: a pasted file that
trips the secret scan is rejected with the reason and where it was found, in rose,
with nothing retained.

**2. The verdict strip.** Results lead with the five providers as a horizontal
comparison — one card per provider, cheapest first and visually crowned (teal ring,
"cheapest" pill), each carrying: provider name, the monthly total in large tabular
monospace, the range beneath it (rendered asymmetrically — a bar showing the point
estimate off-center within its band, because the band is built from one-sided
assumptions and a symmetric whisker would be a lie), and a confidence pill (high /
medium / low). A provider that could not price the workload renders last as a
distinct "could not price" card listing what it lacked — never $0, never hidden.

**3. The unverified banner.** While the pricing catalog is unverified, an amber
band sits directly above the verdict strip: "Prices are seeded from provider sites
but not yet human-verified — treat every number here as provisional." with each
provider card also carrying its catalog version, last-verified date, and a source
link. Design the verified state too (the band gone, a quiet per-card "verified
<date>" line) — but the unverified state is the launch state and gets the design
attention.

**4. Where the money is.** Selecting a provider expands the ledger: line items in a
monospace table (resource, quantity, unit price, monthly cost) summing visibly to
the total — the sum line is the anchor of the whole page. Beside it, the
**assumptions panel**: every assumption as a row with its cause as a small tag
(`unknown_egress`, `utilization_assumption`, `stale_pricing_catalog`,
`bundled_plan_allocation`, `minimum_billable_duration`…), its sentence verbatim, and
— where it widens the range — the widening it contributes, so the gap between point
and bound is fully accounted for. Unsupported resources get their own amber rows:
named, explained, and explicitly *excluded from the total* rather than silently
zeroed. Adapter warnings (compose has no infrastructure; a service without limits
is unsupported, never free) render in the same system.

**5. The disclaimer, always.** The full "not a bill" sentence appears verbatim
beneath the verdict strip in secondary text — unmissable but not shouting. It is
not a footnote link; it is on the page.

**6. Watch it nightly (supporting card).** A compact card connecting to the
scheduled companion: off (one line — "a repo monitor can price your committed
compose file every night and email you when a provider's total moves" — with a
route to Monitors), and on ("watching o/repo — cheapest: DigitalOcean $12.34/mo ·
last priced 3h ago", plus the last change if one was alerted: "$12.34 → $18.72 when
memory doubled"). Same no-credentials line applies and is repeated here.

**7. Compare-two states (new — design it, flag it).** A side-by-side of two
estimates — before/after editing the input — with per-provider deltas in green/rose.
Mark this as a proposed addition; the engine returns deterministic, comparable
results but the product does not yet store estimate history.

Throughout: money is always monospace with tabular figures and always carries its
period ("/mo"); ranges are never symmetric decorations; amber is reserved for
"provisional or excluded", rose for "refused or worse", green for "cheapest or
improved". Every empty, failed, and refused state says what happened and what to do
next in one sentence. Never render an action the viewer can't take. No number
appears anywhere without a path to how it was computed.
