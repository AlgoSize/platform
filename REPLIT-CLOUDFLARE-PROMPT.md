# Replit prompt — Cloudflare tasks that need direct account access

Everything in this file needs the Cloudflare account and cannot be done from a
sandboxed agent. Paste the block below into Replit as a single prompt.

Context for whoever reads this later: this is **our own** infrastructure. The
product's "no cloud-account connector, no credential storage" rule is about
never holding a *customer's* cloud credentials — it says nothing about
operating our own account, which is what this file is for.

---

```
You have direct Cloudflare access for the Algosize account. Work through the
six tasks below in order. Several are VERIFY-ONLY — do not change anything
unless the check fails and the task says to fix it.

Repo: AlgoSize/platform, branch main.
All wrangler commands run from `worker/` and MUST pass `--config wrangler.toml`
explicitly. The repo root has a wrangler.jsonc that shadows it otherwise —
that shadowing caused a production incident on 2026-08-20 and the explicit
flag is the standing mitigation.

Report each task as PASS / FAIL / FIXED with the actual command output. Do not
summarise; paste what the commands printed. If something is ambiguous, stop
and say so rather than guessing.

────────────────────────────────────────────────────────────────────────
TASK 1 — Confirm the live Worker is actually running the current code
────────────────────────────────────────────────────────────────────────
GitHub Actions run #67 of worker.yml reported a successful deploy of commit
00ad83c. Confirm that from the outside rather than trusting the green tick.

  curl -s -o /dev/null -w "%{http_code}\n" https://algosize.com/api/ci/estimate-snippet
  curl -s -o /dev/null -w "%{http_code}\n" https://algosize.com/api/ci/architecture-snippet
  curl -s -o /dev/null -w "%{http_code}\n" https://algosize.com/api/scorecard
  curl -s -o /dev/null -w "%{http_code}\n" https://algosize.com/api/monitors/route

EXPECT: 401 on all four. 401 means the route exists and is refusing an
unauthenticated caller — which is the pass condition here.
A 404 means that route is NOT deployed; if you get one, run:

  cd worker && ./node_modules/.bin/wrangler deploy --config wrangler.toml --env production

────────────────────────────────────────────────────────────────────────
TASK 2 — Confirm the cron is hourly, not daily
────────────────────────────────────────────────────────────────────────
worker/wrangler.toml declares `crons = ["0 * * * *"]` in all three blocks.
This changed from "0 3 * * *" and it matters: the monitor time-of-day setting
is read against the cron tick, so on a daily cron a monitor asking for 14:00
never comes due.

  cd worker && ./node_modules/.bin/wrangler triggers list --config wrangler.toml --env production

If that subcommand is unavailable on the installed wrangler version, read it
from the dashboard instead: Workers & Pages → algosize → Settings → Triggers →
Cron Triggers.

EXPECT: exactly one cron, `0 * * * *`.
If it still reads `0 3 * * *`, the deploy did not apply triggers — redeploy as
in Task 1 and re-check.

Sanity note, so an hourly cron does not alarm anyone: it does NOT mean monitors
run hourly. isDue() holds each monitor to its own hour, and a monitor that
never chose one falls back to 03:00 UTC — the hour they all used before. The
extra ticks cost one D1 query each and enqueue nothing.

────────────────────────────────────────────────────────────────────────
TASK 3 — The dead-letter queue. MOST LIKELY TO BE A REAL PROBLEM.
────────────────────────────────────────────────────────────────────────
worker/wrangler.toml names `algosize-scans-dlq` as the dead_letter_queue for
both production and staging consumers (lines 117 and 337). I can find no
evidence in the repo that it was ever created, and nothing in the codebase
produces to or consumes from it.

If that queue does not exist, a monitor message that exhausts its 3 retries is
dropped with no record. That is silent data loss on the failure path.

  cd worker && ./node_modules/.bin/wrangler queues list --config wrangler.toml

EXPECT to see: algosize-scans, algosize-scans-staging, algosize-scans-dlq.

If algosize-scans-dlq is MISSING, create it:

  cd worker && ./node_modules/.bin/wrangler queues create algosize-scans-dlq --config wrangler.toml

Then redeploy so the consumer binding attaches to a queue that now exists:

  cd worker && ./node_modules/.bin/wrangler deploy --config wrangler.toml --env production

Also report whether the staging consumer points at the same DLQ (it does in
config) and whether you think that is right — a shared DLQ across environments
is defensible but worth a conscious decision, not an accident.

────────────────────────────────────────────────────────────────────────
TASK 4 — Secret inventory on production
────────────────────────────────────────────────────────────────────────
On 2026-08-20 all seven secrets on the `algosize` service were wiped repeatedly
by rogue Workers Builds triggers. Confirm the current state.

  cd worker && ./node_modules/.bin/wrangler secret list --config wrangler.toml --env production

Compare against what the code actually reads. REQUIRED — the Worker is broken
without these:

  JWT_SECRET                    auth; requireAuth throws before reading the cookie
  STRIPE_SECRET_KEY             billing
  STRIPE_WEBHOOK_SECRET         webhook signature verification
  STRIPE_PRICE_ID               checkout
  GOOGLE_SERVICE_ACCOUNT_JSON   transactional email via Workspace
  GOOGLE_CLIENT_ID              OAuth sign-in
  GOOGLE_CLIENT_SECRET          OAuth sign-in

OPTIONAL — features degrade gracefully when absent, so only report, do not add:

  SENTRY_DSN                    error reporting (console logging still works)
  OPENAI_API_KEY                refactor suggestions
  CLOUDFLARE_AI_TOKEN           Workers AI path
  CLOUDFLARE_ACCOUNT_ID         Workers AI path
  E2E_TEST_SECRET               e2e seeding only
  EMAIL_REPLY_TO                cosmetic

Report which required ones are MISSING. DO NOT invent or rotate any value —
just list what is and is not set.

────────────────────────────────────────────────────────────────────────
TASK 5 — Confirm no Workers Builds trigger exists on the API service
────────────────────────────────────────────────────────────────────────
This is the 2026-08-20 incident guard, documented at length in the header of
wrangler.jsonc. Two Workers Builds triggers were bound to the wrong service and
kept deploying the static site onto the API, wiping its secrets each time.
Any trigger reappearing here is a production-down risk.

  curl -s "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/builds/workers/$ALGOSIZE_SCRIPT_ID/triggers" \
    -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN"

EXPECT: "result": []

CRITICAL DETAIL: that endpoint takes the INTERNAL SCRIPT ID, not the name
"algosize". Querying by name returns an empty list whether or not triggers
exist, and several checks during the incident wrongly read as clean for exactly
this reason. Get the real id from the dashboard URL when viewing the Worker, or
from the Workers script list API.

If any trigger comes back, delete it and say so loudly.

────────────────────────────────────────────────────────────────────────
TASK 6 — Decision needed: enable Workers Logs on the API Worker
────────────────────────────────────────────────────────────────────────
Do not change anything for this one. Investigate and report back.

`observability = { enabled = true }` is set on the `algosize-site` Worker
(wrangler.jsonc) but NOT on the `algosize` API Worker (worker/wrangler.toml).
So the Worker that serves every API request has no queryable log retention;
only `wrangler tail` on a live stream, which nobody is watching at 3am.

Enabling it is one line in worker/wrangler.toml plus a redeploy. Before that
happens I want to know:

  a) current Workers Logs usage and included quota on this account's plan
  b) what retention we would get, and whether it is billable at our volume
  c) whether sampling should be set below 100%

Report those three and stop. Someone will decide.

────────────────────────────────────────────────────────────────────────
NOT A CLOUDFLARE TASK — but needed to finish something adjacent
────────────────────────────────────────────────────────────────────────
Two CI gates (algosize-estimate.yml, algosize-architecture.yml) are shipped and
running on every PR, but both currently take their skip path because the GitHub
repository secret ALGOSIZE_API_KEY is not set. Confirmed by reading the job
logs: "ALGOSIZE_API_KEY is not set — skipping the cost estimate."

That proves the gates decline cleanly. It does NOT prove they work.

To finish verifying: sign in at https://algosize.com/dashboard/#/account/keys,
create an API key, and add it as a GitHub repository secret named
ALGOSIZE_API_KEY under Settings → Secrets and variables → Actions on
AlgoSize/platform. The next PR then exercises the real path — POST, PR comment,
threshold check — and those jobs will take noticeably longer than their current
4–5 seconds.

This is a GitHub secret, not a Cloudflare one, and the key is minted by the
product itself. No Cloudflare access required.

────────────────────────────────────────────────────────────────────────
ALREADY DONE — do not redo these
────────────────────────────────────────────────────────────────────────
- D1 migrations 0015, 0016, 0017 are applied to production and were verified by
  reading the live schema (organisations has slack_webhook_url; monitors has
  last_status, last_attempt_at, last_error, run_at_hour, last_severity_json;
  notification_prefs, referral_codes, referrals and credit_events all exist).
- The Worker is deployed at commit 00ad83c via worker.yml run #67.
- Nothing in Tasks 1–5 should require a code change. If one seems to, stop and
  report rather than editing the repo — this prompt is for operating the
  account, not for changing the application.
```

---

## Open question this does not cover

Staging's D1 database id in `worker/wrangler.toml` is the placeholder
`00000000-0000-0000-0000-00000000stg1`, and its KV ids are likewise
placeholders. Either staging D1/KV were never provisioned, or they exist and
the config was never updated with the real ids.

I have not included this in the prompt because the right action depends on
something only you know: whether the staging environment is meant to be live.
If it is, staging needs its own D1, its own KV namespaces, its own queue, and
all three migrations — a much larger task than anything above. If staging is
effectively dormant, the placeholders are harmless and should be left alone.

Say which, and I will write that prompt separately.
