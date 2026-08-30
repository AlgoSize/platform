# Cloudflare / Replit operator tasks

Five things this session could not do from a code checkout, because each needs
Cloudflare account access. Everything else found today was fixed in code.

Ordered by what is actually blocking a feature. Task 0 and Task 1 each stop
something working today; 2 and 3 are gaps you would feel later; 4 is optional.

**A note on how to read this file.** Every claim below was verified against
this repository in the session that wrote it, and the file paths and line
references are real. What is NOT verified is the live Cloudflare state — that
is exactly what Task 1 asks you to check, because no code checkout can see it.
Where I am inferring rather than asserting, it says so.

---

## Task 0 — Apply migrations `0023` and `0024` to production D1

**Why this matters:** without it the Service scorecard's new **Cloud spend**
column reads "first run pending" forever, however many nightly sweeps succeed,
and the Architecture column's zero goes back to being a number nobody can
check. Nothing errors — the sweep writes the figures, the UPDATE silently has
nowhere to put them. That is the same shape as every other bug in this
session: an omission that nothing throws on.

Nothing in `.github/workflows/` runs `d1 execute` or `migrations apply`, on
purpose — a schema change lands when a human decides, not when a merge
happens. So this is yours to run.

The migration is additive and non-destructive. Two nullable columns on an
existing table; no data rewritten, no column dropped, no downtime window:

```sql
-- 0023
ALTER TABLE monitors ADD COLUMN last_cost_json TEXT;
ALTER TABLE monitors ADD COLUMN last_arch_scope_json TEXT;
-- 0024
ALTER TABLE monitors ADD COLUMN last_source_json TEXT;
```

**0024 is the one that matters most.** Without it the nightly sweep scans your
source, has nowhere to store the result, and the scorecard keeps grading the
dependency list alone — so a repository with no vulnerable packages and a
critical SQL injection in its own code renders a top grade. The scan runs, the
finding exists, and the column that would show it stays empty. Nothing errors.

```bash
cd worker
./node_modules/.bin/wrangler d1 execute algosize \
  --file=migrations/0023_scorecard_evidence.sql \
  --remote --env production --config wrangler.toml
./node_modules/.bin/wrangler d1 execute algosize \
  --file=migrations/0024_monitor_source_findings.sql \
  --remote --env production --config wrangler.toml
```

`--config wrangler.toml` is not optional even where it looks redundant: the
repo root has a `wrangler.jsonc` that shadows it, and that shadowing caused a
production incident on 2026-08-20.

**Then verify from outside, not from the command's exit code.** Open
`https://algosize.com/api/admin/schema-check` signed in as an admin and expect
`0023` applied (checks: `monitors.last_cost_json`, `monitors.last_arch_scope_json`)
and `0024` applied (check: `monitors.last_source_json`), `ok:true`, and 24
migrations total.

If it reports NOT applied, say so and stop — do not re-run more than once. A
repeated `ALTER TABLE` on a column that already exists is an error, not an
idempotent no-op, and the second failure would look exactly like the first
never landing.

**What to expect afterwards, so nothing reads as a bug.** Nothing backfills.
The scorecard's **Code** column reads "first run pending" on every existing
monitor until its next nightly sweep — that is correct, not a defect: a
repository whose code was never stored is not a repository whose code is clean.

Both columns stay NULL until each monitor's next sweep, and NULL renders as
"first run pending" / the old architecture wording — never as a zero. Cloud
spend additionally needs a `cur` path in that repository's
`algosize.budget.json` pointing at a committed cost export; without one the
cell says so and names the file to change. This repository's own
`algosize.budget.json` has `"cur": null`, so AlgoSize/platform will keep
reading "not measured" there until you point it at an export — which is
correct, not a defect.

---

## Task 1 — Is `algosize-sandbox` actually bound as `SANDBOX` in production?

**Why this matters:** the nightly optimizer sweep cannot grade a single
function without it. The monitor stays on FIRST RUN PENDING forever, no
baseline is ever recorded, and no regression email can ever fire.

**What the symptom was.** The sweep reported, per entry:

```
Every entry in optimizer.config.json was skipped.
 - bigo-mean    — Code generation from strings disallowed for this context
 - llm-formatMs — Code generation from strings disallowed for this context
```

That sentence is V8's. It is the Cloudflare Workers isolate refusing to compile
any submitted code, which it does unconditionally. `runInSandbox`
(`worker/src/handlers/analyze.js`) falls back to an in-process runner when
`env.SANDBOX` is absent, and that runner uses `new Function`. Under Node — the
Replit server, the CI entrypoint, the test suite — that works. Inside a
deployed Worker it can never work. So reaching that fallback in production
means the binding was not there.

**What I could verify from the checkout, and what I could not.**

Verified:

- `worker/wrangler.toml` declares the binding under `[[env.production.services]]`
  — `binding = "SANDBOX"`, `service = "algosize-sandbox"`.
- `worker-sandbox/wrangler.toml` names that service, `algosize-sandbox`.
- `.github/workflows/worker.yml` deploys the sandbox **first**, with a comment
  stating that deploying the main Worker against a non-existent sandbox fails
  the bind step.
- Deploys have been succeeding (run #81 and every one before it).

Not verifiable from here: whether the live production Worker actually carries
the binding right now. Those four facts together suggest it should — which is
precisely why it is worth checking rather than assuming, because the observed
behaviour says otherwise.

One plausible explanation, offered as a hypothesis and not a finding: the
Workers Builds incident recorded in `wrangler.jsonc` overwrote the `algosize`
script and wiped its secrets. If a sweep ran during or shortly after that
window, it would have run against a Worker with no bindings. If that is what
happened, the binding is fine now and the monitor is simply showing a stale
result.

**Run this:**

```bash
cd worker
# 1. Does the sandbox service exist and is it deployed?
./node_modules/.bin/wrangler deployments list --config ../worker-sandbox/wrangler.toml --env production

# 2. Does the production API Worker resolve the binding? A dry-run prints the
#    full binding table without touching the live script.
./node_modules/.bin/wrangler deploy --dry-run --config wrangler.toml --env production
```

The second command must list `env.SANDBOX (algosize-sandbox)` as a `Worker`
binding. It did when I ran it here, against this checkout.

**Then confirm it end to end**, which is the only check that actually settles
it — trigger a manual sweep of the monitored repo from the dashboard and read
the optimizer panel:

- Grades appear → the binding is live and the old message was stale.
- *"The measurement sandbox is not configured on this deployment"* → the
  binding is genuinely missing; redeploy the sandbox, then the API Worker.
- *"The measurement sandbox is unreachable right now"* → bound but the service
  is failing; check the sandbox Worker's own logs.

Those three sentences are new as of this session. Before it, all three
situations printed V8's message once per entry and blamed
`optimizer.config.json`.

---

## Task 2 — Set `SENTRY_DSN`, or decide not to

**Where you saw it:** Admin → settings → *"Error reporting · NOT CONFIGURED ·
exceptions are logged to the console only · SENTRY_DSN"*.

That panel is telling the truth. `worker/src/observability.js` only sends to
Sentry when `env.SENTRY_DSN` is set; otherwise `captureException` logs to the
console and nothing is retained. Workers logs are not durable, so today a
production exception is effectively unobserved once it scrolls away.

This is not hypothetical for you: the sandbox misconfiguration in Task 1 is
exactly the class of thing that would have been captured, and instead it
surfaced as a confusing message in a monitor panel days later.

```bash
cd worker
./node_modules/.bin/wrangler secret put SENTRY_DSN --config wrangler.toml --env production
# paste the DSN from the Sentry project, then re-check Admin → settings
```

If you would rather not run Sentry, that is a legitimate choice — but make it
explicit, because "NOT CONFIGURED" in an admin panel reads as an oversight
rather than a decision.

---

## Task 3 — Staging is pointed at placeholder resources

`worker/wrangler.toml` still carries placeholders for every staging binding:

| Binding | Current value |
| --- | --- |
| D1 `DB` | `00000000-0000-0000-0000-00000000stg1` |
| KV `SESSIONS` | `0000000000000000000000000000stg1` |
| KV `USERS` | `0000000000000000000000000000stg2` |

None of those are real Cloudflare resources, so `wrangler deploy --env staging`
has nothing usable behind it. There is no working staging environment, which
means every change this session — and every change before it — was verified by
tests and then merged straight to production.

```bash
cd worker
./node_modules/.bin/wrangler d1 create algosize-staging --config wrangler.toml
./node_modules/.bin/wrangler kv namespace create SESSIONS --config wrangler.toml --env staging
./node_modules/.bin/wrangler kv namespace create USERS    --config wrangler.toml --env staging
```

Paste the three printed ids over the placeholders above, commit, push.
`DEPLOY.md` §7.1 documents the same sequence.

---

## Task 4 — `GITHUB_TOKEN` (optional)

Two analyzers discover files through the GitHub git-tree API:
`discoverArchFiles` in `worker/src/monitors/analyzers.js` and
`discoverLockfiles` in `worker/src/handlers/analyze.js`. Both send the token
when `env.GITHUB_TOKEN` is set and fall back to unauthenticated requests when
it is not.

Unauthenticated means a low rate limit shared across every Algosize user, so
under load a scan can fail with "GitHub is rate-limiting our requests". Setting
a token gives those two analyzers their own quota. Nothing is broken without
it.

```bash
cd worker
./node_modules/.bin/wrangler secret put GITHUB_TOKEN --config wrangler.toml --env production
# a fine-grained token with public read access is sufficient
```

---

## Closed since this file was first written

**The Cloud cost analyzer can now be scheduled.** It used to be the only
analyzer with no nightly half, because its only input was an interactive CUR
upload. It now reads the `cur` path out of `algosize.budget.json` on the same
schedule as the others, files a run, and — with Task 0 applied — keeps a
standing figure the scorecard grades in its own **Cloud spend** column.

That column is deliberately separate from **Infra cost**, which was previously
labelled just "Cost". They answer different questions and one word for both was
misleading: Infra cost prices a committed compose file against published list
rates for infrastructure that may never be provisioned, while Cloud spend reads
an export of what you were actually billed.
