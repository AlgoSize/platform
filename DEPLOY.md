# Algosize — Deployment Handoff

End-to-end runbook for shipping Algosize to production from a fresh laptop.
Everything below runs **outside Replit** — your local shell talks to GitHub,
Cloudflare, and Stripe directly.

Read top-to-bottom once, then walk it. Each step has copy-pasteable commands
and lists every value you'll need to substitute (`<like-this>`).

---

## 0. Inventory — what you'll provision

| Thing                              | Where it lives                     | How it's created            |
|------------------------------------|------------------------------------|-----------------------------|
| `algosize.com` apex domain         | Your DNS registrar                  | A/AAAA records → GH Pages   |
| `api.algosize.com` (or route)      | Cloudflare DNS                      | CNAME + Worker route        |
| GitHub Pages site                  | `gh-actions → site/_site → Pages`   | Existing workflow (§1)      |
| Cloudflare Worker `algosize`       | Cloudflare account                  | `wrangler deploy` (§2)      |
| KV namespace `SESSIONS`            | Cloudflare KV                       | `wrangler kv namespace create` |
| KV namespace `USERS` (quota only)  | Cloudflare KV                       | `wrangler kv namespace create` |
| D1 database `algosize`             | Cloudflare D1                       | `wrangler d1 create` (§2.5) |
| 4 Worker secrets                   | Cloudflare (per-env)                | `wrangler secret put` (§3)  |
| Google Workspace service account   | Google Cloud + Workspace admin      | manual (§3.6) — DWD on `gmail.send` |
| SPF / DKIM / DMARC TXT records     | Your DNS registrar                  | manual (§4.4) — needed for inbox delivery |
| Stripe product + recurring price   | Stripe dashboard                    | manual (§5–§6)              |
| Stripe webhook → Worker            | Stripe dashboard                    | manual (§5)                 |

You'll need accounts for: **GitHub** (admin on this repo), **Cloudflare**
(any plan), **Stripe** (test + live mode access), and DNS access to
`algosize.com`.

Local prerequisites:

```bash
# Node 20+, npm
node -v       # v20.x

# Install the repo's Worker dependencies — wrangler ships in here.
# You MUST run this on a fresh clone before any `wrangler` command below
# will resolve.
cd worker && npm ci && cd -

# (Optional) install wrangler globally if you'd rather type `wrangler ...`
# instead of `./node_modules/.bin/wrangler ...`:
npm i -g wrangler@^3.78.0

# Stripe CLI (only needed for §5 webhook testing & §6 verification).
# macOS:   brew install stripe/stripe-cli/stripe
# Linux:   see https://stripe.com/docs/stripe-cli (apt/yum/binary tarball)
# Windows: scoop install stripe   (or download from the URL above)

# Ruby 3.2 + bundler (only if you want to build the site locally; CI does it for prod)
ruby -v       # ruby 3.2.x
gem install bundler
```

---

## 1. Site → GitHub Pages with custom domain `algosize.com`

The Jekyll source lives in `site/`. A GitHub Actions workflow
(`.github/workflows/jekyll.yml`) already builds and deploys it on every push
to `main` that touches `site/**`. You need to (a) flip the Pages source to
"GitHub Actions" once, (b) add the custom domain, (c) point DNS at it.

### 1.1 Enable GitHub Actions as the Pages source (one-time)

In a browser:

1. Open the repo on GitHub → **Settings → Pages**.
2. Under **Build and deployment → Source**, choose **GitHub Actions**.
   (Do NOT select "Deploy from a branch" — the workflow handles publishing.)
3. Leave the **Custom domain** field empty for now; you'll fill it in §1.3
   after DNS propagates.

### 1.2 Confirm the workflow runs and uploads the site

```bash
git push origin main      # or push any change under site/**
```

Then on GitHub: **Actions → Build and deploy Jekyll site** → confirm the
latest run is green and the `deploy` job shows a `page_url` like
`https://<your-org>.github.io/<repo>/`. Open that URL — you should see the
landing page.

> The workflow builds with `--config _config.yml,_config.production.yml`,
> which sets `api_base: ""` so the browser sends API calls same-origin (the
> Worker will be mapped under `algosize.com/api/*` in §4).

### 1.3 Custom domain

Both `CNAME` files in this repo already contain `algosize.com`:

```
$ cat CNAME site/CNAME
algosize.com
algosize.com
```

The one inside `site/` is what GitHub Pages reads; the root copy is a
safety net. Don't delete either.

In **Settings → Pages → Custom domain**, type `algosize.com` and click
**Save**. GitHub will write the domain back to `site/CNAME` on its own next
build, which is fine — the value is the same.

Tick **Enforce HTTPS** as soon as it becomes available (it appears once
GitHub provisions the cert, ~5–15 min after DNS is correct).

### 1.4 DNS for `algosize.com` → GitHub Pages

At your DNS registrar, set apex `A`/`AAAA` records to GitHub's Pages IPs
(current, verify at https://docs.github.com/pages/custom-domain):

```
@   A    185.199.108.153
@   A    185.199.109.153
@   A    185.199.110.153
@   A    185.199.111.153
@   AAAA 2606:50c0:8000::153
@   AAAA 2606:50c0:8001::153
@   AAAA 2606:50c0:8002::153
@   AAAA 2606:50c0:8003::153
```

If you also want `www.algosize.com` to redirect to apex, add:

```
www CNAME <your-org>.github.io.
```

Verify DNS:

```bash
dig +short algosize.com
# expect the four 185.199.*.153 IPs
curl -I https://algosize.com
# expect HTTP/2 200 served by GitHub.com
```

> Prefer serving the site from Cloudflare Workers instead of GitHub Pages —
> one hosting provider instead of two? See §9, once §2–§4 have the Worker
> and DNS in place.

---

## 2. Worker → `wrangler deploy`

The Worker source lives in `worker/`. It binds two KV namespaces and reads
four secrets. You'll create the KV namespaces, paste their IDs into
`wrangler.toml`, then deploy.

### 2.0 Wrangler config resolution — pin it

Every wrangler command in this repo passes `--config wrangler.toml`
explicitly, and the CI workflows do the same. That is deliberate, not
noise.

Wrangler searches for its config by walking **up** the directory tree, so a
`wrangler.json` / `wrangler.jsonc` at the repo root wins over
`worker/wrangler.toml` even when wrangler is invoked from inside `worker/`.
Cloudflare's autoconfig bot opens exactly that PR (see PR #3), and the
consequences are not subtle:

- `wrangler dev` boots a Worker with **no bindings** — no KV, no D1, no
  vars — so every `/api/*` route 404s and the Playwright suite fails with a
  timeout that points nowhere near the cause.
- `wrangler deploy` from `worker/` uploads that root config's Worker
  instead. Both configs are named `algosize`, so **the static-asset Worker
  replaces the live API Worker** on the same name.

Verify which config wrangler picked before any real deploy:

```bash
cd worker
./node_modules/.bin/wrangler deploy --config wrangler.toml --dry-run --outdir /tmp/wo
# expect: "Your worker has access to the following bindings:" listing
#         SESSIONS, USERS, DB, SANDBOX. If it says "No bindings found",
#         wrangler loaded the wrong file.
```

`tests/e2e/tests/00-worker-health.spec.js` asserts this in CI: it fails
fast with an explicit message if the Worker answering on :8787 is not the
API Worker.

### 2.1 Authenticate wrangler

```bash
cd worker
./node_modules/.bin/wrangler login --config wrangler.toml
# Browser pops; accept. Picks the active Cloudflare account automatically.
# If you have multiple accounts:
./node_modules/.bin/wrangler whoami --config wrangler.toml # confirm the right account
export CLOUDFLARE_ACCOUNT_ID=<id from whoami>  # if you need to pin one
```

> Throughout the rest of this doc, `wrangler` means
> `./node_modules/.bin/wrangler` (run from `worker/`). Drop the prefix if
> you installed wrangler globally.

### 2.2 Create the two production KV namespaces

> Task #25 moved user records and run history from KV into Cloudflare D1.
> KV now holds only **session JWTs + Stripe-event dedup** (`SESSIONS`) and
> **per-user monthly quota counters** (`USERS`, key shape
> `quota:<userId>:<YYYY-MM>`). The D1 database is created in §2.5 below.
> If you provisioned a `RUNS` namespace from an older revision of this
> doc, you can leave it in place for now and delete it after §2.5.6
> succeeds — the Worker no longer reads or writes it.

```bash
wrangler kv namespace create SESSIONS --config wrangler.toml --env production
wrangler kv namespace create USERS    --config wrangler.toml --env production
```

Each command prints something like:

```
🌀 Creating namespace with title "algosize-SESSIONS-production"
✨ Success! Add the following to your configuration file:
[[kv_namespaces]]
binding = "SESSIONS"
id = "abcd1234ef5678..."
```

**Copy each `id` value.**

### 2.3 Wire the namespace IDs into `wrangler.toml`

Open `worker/wrangler.toml` and replace the two production-env IDs:

```toml
[[env.production.kv_namespaces]]
binding = "SESSIONS"
id      = "<paste SESSIONS id from §2.2>"

[[env.production.kv_namespaces]]
binding = "USERS"
id      = "<paste USERS id from §2.2>"
```

> The repo currently ships placeholder-looking IDs left over from earlier
> dev work — overwrite both. Do **not** reuse the top-level `[[kv_namespaces]]`
> IDs (those are for `wrangler dev`'s remote-mode preview, separate from
> production). The D1 `database_id` is wired up in §2.5 below.

### 2.4 Set `SITE_ORIGIN` to the production hostname

`SITE_ORIGIN` is what the Worker uses for CORS allow-list, cookie scope,
and Stripe redirect URLs. It must match the hostname users actually load
the site from (apex `algosize.com`, no trailing slash).

The repo currently ships with `SITE_ORIGIN = "https://algosize.com"` in
the `[env.production.vars]` block of `worker/wrangler.toml` — leave it
alone if you're shipping to that domain. If you're shipping under a
different host (e.g. `www.algosize.com`), edit:

```toml
[env.production.vars]
SITE_ORIGIN = "https://www.algosize.com"   # whatever your apex/www is
COOKIE_NAME = "algosize_session"           # leave as-is
```

> **Important:** The Worker's CORS layer matches `SITE_ORIGIN` **exactly**
> (`worker/src/cors.js` does `origin === env.SITE_ORIGIN`). It doesn't
> normalize protocol, host, or trailing slashes. Get this string right or
> the dashboard's `fetch` calls will all fail with CORS errors in the
> browser console.

### 2.5 Create the D1 database, apply schema, migrate KV data

User records and run history live in Cloudflare D1 (Task #25). On a fresh
account this section is a one-time bootstrap. If you're re-deploying an
existing account where these were already provisioned, skip to §2.6.

#### 2.5.1 Create the database

```bash
cd worker
./node_modules/.bin/wrangler d1 create algosize --config wrangler.toml
```

This prints something like:

```
✅ Successfully created DB 'algosize' in region WEUR
[[d1_databases]]
binding       = "DB"
database_name = "algosize"
database_id   = "1234abcd-…-deadbeef"
```

**Copy the `database_id`.**

#### 2.5.2 Wire the database id into `wrangler.toml`

Open `worker/wrangler.toml`, find the `[[env.production.d1_databases]]`
block (`binding = "DB"`, `database_name = "algosize"`), and replace
`database_id = "00000000-0000-0000-0000-000000000000"` with the real
UUID from §2.5.1. **Do this BEFORE applying the schema** — `wrangler d1
execute` reads the binding from `wrangler.toml`.

#### 2.5.3 Apply the schema

```bash
cd worker
./node_modules/.bin/wrangler d1 execute algosize --config wrangler.toml \
  --file=migrations/0001_init.sql --env production --remote
```

Confirms the `users` and `runs` tables + their indexes were created. Re-
runs are safe — every statement uses `IF NOT EXISTS`.

#### 2.5.4 (Optional) Migrate existing KV data

If this is a brand-new deploy with zero users yet, **skip this step**.
Otherwise, dump the old KV records to a SQL file and apply it:

First, find the namespace IDs for the OLD `USERS` and `RUNS` KV
namespaces — the migration script reads from KV directly, and Task #25
already removed the `RUNS` binding from `wrangler.toml`, so we hand it
the raw namespace id instead:

```bash
cd worker
./node_modules/.bin/wrangler kv namespace list
# Find the rows whose `title` contains `algosize-USERS-production` and
# `algosize-RUNS-production`. Copy each `id`.
```

Then dump the records, apply them to D1, and emit a diff report in one
shot via `--apply`:

```bash
node scripts/migrate-kv-to-d1.mjs \
  --env production \
  --users-namespace-id <USERS-id from above> \
  --runs-namespace-id  <RUNS-id from above> \
  --apply algosize
# wrote migrate-kv-to-d1.sql: N users, M runs
# applying migrate-kv-to-d1.sql to D1 database 'algosize' (env=production) …
# ===== diff report =====
#   users  source=N  target=N  delta=+0
#   runs   source=M  target=M  delta=+0
#   skipped (bad JSON / missing keys): 0
# OK — no missing rows in D1
```

Exit code 2 means D1 has FEWER rows than the source dump — investigate
before retrying. Re-runs of `--apply` are safe (the script uses
`INSERT OR IGNORE` keyed on the primary key); the diff report will
just show `target ≥ source` because previously-applied rows are still
there.

If you never deployed Task #17 (no RUNS data exists), pass
`--skip-runs` instead of `--runs-namespace-id`.

If you'd rather inspect the SQL before applying, omit `--apply` —
the script writes `migrate-kv-to-d1.sql` and prints the manual
`wrangler d1 execute` command to run.

The KV `email:`/`cust:` index keys and the per-user `runs:<userId>`
index are intentionally NOT copied (D1's UNIQUE constraints +
`idx_runs_user_created` replace them).

#### 2.5.5 Verify

```bash
./node_modules/.bin/wrangler d1 execute algosize --config wrangler.toml --env production --remote \
  --command="SELECT COUNT(*) AS users FROM users; SELECT COUNT(*) AS runs FROM runs;"
```

Numbers should match what `wrangler kv key list --binding USERS --env production`
showed for `user:*` keys (and `RUNS` for `run:*` keys, if you migrated runs).

#### 2.5.6 Retention follow-up

Pre-#25, run records had a hard 90-day KV TTL — blobs physically vanished
after 90 days. Post-#25, D1 keeps every row indefinitely; the dashboard
only HIDES rows older than 90 days via a `created_at >` filter at read
time. That means D1 storage grows monotonically until a cleanup job is
added.

Action items for whoever takes this to GA:

1. Schedule a Cloudflare Cron Trigger that runs daily and executes
   `DELETE FROM runs WHERE created_at < (strftime('%s','now') - 90*86400) * 1000`
   against the `algosize` D1 binding. Wrangler config: add
   `[triggers] crons = ["0 3 * * *"]` and a `scheduled` handler in
   `worker/src/index.js`.
2. Confirm the privacy policy text matches: "We retain run history for
   90 days." If you removed the TTL but kept that wording, you're now
   out of compliance until step 1 ships.

#### 2.5.7 (Optional) Tear down the old `RUNS` KV namespace

Once §2.5.5 looks right and the Worker has been deployed (§2.6), the
old `RUNS` KV namespace is unreferenced. Delete it from
`worker/wrangler.toml` if anything references it, then:

```bash
./node_modules/.bin/wrangler kv namespace delete --config wrangler.toml --binding RUNS --env production
```

Leave `USERS` KV in place — it still holds the monthly quota counters
(`quota:<userId>:<YYYY-MM>`).

#### 2.5.8 Create the reports R2 bucket (Task #P-6)

The HTML report a customer hands to their own client is rendered once and
stored in R2, keyed `reports/<orgId>/<runId>.html`. Create the bucket once
per environment before the next deploy:

```bash
./node_modules/.bin/wrangler r2 bucket create algosize-reports --config wrangler.toml
./node_modules/.bin/wrangler r2 bucket create algosize-reports-staging --config wrangler.toml
```

The `REPORTS` binding is already declared in `wrangler.toml` for the default,
production and staging environments.

**This one is not deploy-blocking.** Every read and write goes through
`src/reports/store.js`, which no-ops when the binding is absent, and the
report route falls back to rendering on demand — same bytes, one render per
request instead of per run. So a deploy without the bucket works; it is just
slower for anyone opening a shared link. Create it when convenient, not
urgently.

Objects are written with `cache-control: private, max-age=31536000, immutable`
and are never rewritten: a report describes one run at one instant, and a
document a customer has already forwarded must not silently change under them.
Deleting everything for one customer is a prefix delete on `reports/<orgId>/`.

#### 2.5.9 Apply migration 0008 (white-label branding)

Adds two nullable columns to `organisations` for the top-tier white-label
report branding:

```bash
./node_modules/.bin/wrangler d1 execute algosize --config wrangler.toml --env production --remote \
  --file=worker/migrations/0008_org_branding.sql
```

Whether an org may USE those columns is resolved at render time from the live
entitlement and price id — the columns are storage, not permission — so a
lapsed Firm subscription stops white-labelling on its next report without
anyone clearing the row.

#### 2.5.10 Apply the remaining migrations (0009 – 0014)

Everything from 0009 onward is applied as a block. Sections 2.5.3 and 2.5.9
each documented a single migration, which does not scale — the authority on
what a database is missing is `GET /api/admin/schema-check`, not this list.

```bash
cd worker
for f in migrations/0009_*.sql migrations/001*.sql; do
  echo "--- $f"
  ./node_modules/.bin/wrangler d1 execute algosize --config wrangler.toml \
    --env production --remote --file="$f"
done
```

Every statement is `CREATE TABLE IF NOT EXISTS` or a single `ALTER TABLE …
ADD COLUMN`, so re-running the block is safe except for the two `ALTER`
statements (0011 and, on an older database, 0009), which fail with
`duplicate column name` on a second run. That failure is the correct outcome
and can be ignored.

What each one is for:

| Migration | Adds | Without it |
| --- | --- | --- |
| `0009_monitor_delta` | `monitors.last_delta_json` | The dashboard cannot show what a sweep found new |
| `0010_audit_log` | `audit_log` | Nothing records who revoked what; the admin panel's audit page is empty |
| `0011_user_auth_method` | `users.auth_method` | Support cannot tell whether an account uses Google or email links |
| `0012_webhook_deliveries` | `webhook_deliveries` | A failing Stripe webhook leaves no trace outside the Stripe dashboard |
| `0013_email_sends` | `email_sends` | An unconfigured mailer keeps no-opping silently — the failure mode that hid the magic-link outage |
| `0014_feature_flags` | `feature_flags` | Every flag resolves to off (the module fails closed), so nothing gated ever ships |

The Worker does **not** fail without these. Each write path swallows its own
error so a missing table can never break the action it was describing — which
means a skipped migration shows up as an admin panel that is quietly, wrongly
empty rather than as an outage. Confirm with:

```bash
curl -s -H "Cookie: <admin session>" https://algosize.com/api/admin/schema-check | jq .pending
```

An empty array is the only acceptable answer. `worker/scripts/verify-production.mjs`
checks the same thing as part of the post-deploy sweep.

### 2.6 Deploy

> **CI handles this on every push (Task #24).** Once
> `.github/workflows/worker.yml` is wired up and the two GitHub repo
> secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` are set
> (see §2.6 below), every push to `main` that touches `worker/**`,
> `worker-sandbox/**`, `shared/**`, or the workflow file itself runs
> the full 14-suite test matrix and then deploys both Workers (sandbox
> first, then main) in dependency order. The manual `wrangler deploy`
> commands below are the **first-time-ever bootstrap** path (before CI
> can authenticate) and the **emergency rollback** path (see Appendix
> B). On a healthy repo, you should not need to run them by hand.

```bash
cd worker
./node_modules/.bin/wrangler deploy --config wrangler.toml --env production
```

You should see:

```
Total Upload: ~30 KiB
Uploaded algosize (X.XX sec)
Published algosize (X.XX sec)
  https://algosize.<your-account>.workers.dev
```

Smoke-test the deployed Worker (still on its `*.workers.dev` URL — DNS
mapping comes in §4):

```bash
curl -i https://algosize.<your-account>.workers.dev/api/me
# expect: HTTP/2 501 with {"error":"not_implemented", ...}
```

(That endpoint is a stub; a 501 proves the Worker is live and routing.)

---

### 2.7 Wire CI auto-deploy (Task #24)

The workflow at `.github/workflows/worker.yml` runs the worker test
suite (`npm test` in `worker/`) and, if it passes, deploys both Workers
(sandbox first, then main) to the right environment based on the
branch: `main` → `--env production`, `staging` → `--env staging`. A
failed test blocks the deploy — see the `deploy: needs: test`
dependency. Manual `workflow_dispatch` runs let you pick the target
environment from the GitHub Actions UI.

You need to provision two **GitHub repo secrets** in
**Settings → Secrets and variables → Actions → New repository secret**:

1. **`CLOUDFLARE_API_TOKEN`** — a scoped Cloudflare API token.
   - Go to <https://dash.cloudflare.com/profile/api-tokens> →
     **Create Token** → use the **Edit Cloudflare Workers** template.
   - Under **Account Resources**, restrict to the account that hosts
     `algosize`.
   - Under **Zone Resources**, restrict to `algosize.com` (needed for
     the route binding on `algosize.com/api/*` and
     `staging.algosize.com/api/*`).
   - Optionally narrow further to just the four workers (`algosize`,
     `algosize-sandbox`, `algosize-staging`, `algosize-sandbox-staging`)
     under **Worker Scripts**.
   - Required permissions on this token: **Workers Scripts:Edit**,
     **Workers KV Storage:Edit**, **Workers Routes:Edit**, **Account
     Settings:Read**, **Zone:Read**.
   - Click **Create Token** and copy the value (you only see it once).

2. **`CLOUDFLARE_ACCOUNT_ID`** — visible in the Cloudflare dashboard
   URL (`/<accountId>/...`) or on any Worker's **Settings → API**
   page. This one is not a secret in the cryptographic sense
   (account ids are not authentication material), but storing it as a
   secret keeps it out of the workflow logs.

Verify in GitHub: **Settings → Secrets and variables → Actions →
Repository secrets** should show both names. Push a no-op commit that
touches `worker/` (e.g. update a comment) to trigger the workflow and
watch the green check land in **Actions**.

> If the workflow fails at the **Verify Cloudflare credentials are
> set** step, the secrets aren't wired up yet — fix that and re-run.
> If it fails at the **Deploy worker-sandbox** step with `Unauthorized`,
> the token's resource scope is too narrow — recreate it with the
> permissions listed above.

> The CI workflow does a few extra things on top of plain `wrangler
> deploy` that the manual path in §2.5 doesn't: it deploys
> `worker-sandbox` first (since the main Worker's service binding
> requires it), runs a retry-aware post-deploy smoke test against
> `/api/me` to catch route-binding regressions, and routes by branch
> (`main` → production, `staging` → staging). These are CI-only
> safety nets — local/manual `wrangler deploy --env production` from
> §2.5 remains a single-Worker, single-shot command and is the
> canonical way to deploy in an emergency. If you ever change the
> stub status code returned by `/api/me`, also update the smoke-test
> assertion in `.github/workflows/worker.yml`.

---

## 3. Cloudflare secrets

The Worker reads four secrets at runtime. Set each one separately;
`wrangler secret put` opens an interactive prompt for the value (so the
secret never appears on your shell history).

```bash
cd worker

# 32+ random bytes; HMAC-SHA-256 key for session JWTs.
# Generate one with:
#   macOS/Linux: openssl rand -hex 32
#   Windows:     [convert]::ToHexString((1..32 | %{[byte](Get-Random -Max 256)}))
# Paste the value at the prompt.
./node_modules/.bin/wrangler secret put JWT_SECRET            --config wrangler.toml --env production

# Stripe SECRET key — must start with `sk_test_` (testing) or `sk_live_`
# (production). Do NOT paste the publishable key (`pk_test_...` /
# `pk_live_...`) — the Worker will get 401s from api.stripe.com on every
# call. Swap test→live in §6.
./node_modules/.bin/wrangler secret put STRIPE_SECRET_KEY     --config wrangler.toml --env production

# Stripe webhook signing secret (whsec_...). You'll get this in §5.
# Set it AFTER you create the webhook endpoint.
./node_modules/.bin/wrangler secret put STRIPE_WEBHOOK_SECRET --config wrangler.toml --env production

# Stripe Price ID for the monthly subscription plan (price_...).
# Create the product/price in §6.1 first if you don't have one yet.
./node_modules/.bin/wrangler secret put STRIPE_PRICE_ID       --config wrangler.toml --env production
```

Verify each secret is set (values are not printed — only names):

```bash
./node_modules/.bin/wrangler secret list --config wrangler.toml --env production
# expect all four names: JWT_SECRET, STRIPE_SECRET_KEY,
# STRIPE_WEBHOOK_SECRET, STRIPE_PRICE_ID
```

> Re-running `wrangler secret put` overwrites the existing value. To delete
> a secret, use `wrangler secret delete <NAME> --env production`.

### 3.1 Per-IP rate limiting (Task #21) — what to expect

The Worker enforces per-IP rate limits on the public-facing endpoints
using counters stored under `rl:<ip>:<endpoint>:<minute>` keys in the
**existing `SESSIONS` KV** namespace (no new binding to provision).
Cloudflare populates `CF-Connecting-IP` automatically — no config.

| Endpoint(s)            | Limit (per IP, per minute) | Bucket key |
|------------------------|----------------------------|------------|
| `POST /api/checkout`   | 10                         | `checkout` |
| `POST /api/signup`     | 10                         | `signup`   |
| `POST /api/analyze/*`  | 30 *(shared across cost/vuln/algo)* | `analyze` |

Over-limit responses look like:

```http
HTTP/1.1 429 Too Many Requests
Retry-After: 23
Content-Type: application/json

{"error":"rate_limited","retryAfterSec":23}
```

Counters carry a 2-minute TTL (one extra window of slack so a counter
read at the boundary never 404s). To inspect or reset a hot IP:

```bash
# How many counter rows exist right now?
./node_modules/.bin/wrangler kv key list --binding SESSIONS --env production \
  --prefix "rl:" | jq length

# Free a specific IP's checkout bucket immediately
./node_modules/.bin/wrangler kv key list --binding SESSIONS --env production \
  --prefix "rl:1.2.3.4:checkout:" | jq -r '.[].name' | \
  xargs -I {} ./node_modules/.bin/wrangler kv key delete --binding SESSIONS \
    --env production "{}"
```

> Note: KV is non-atomic, so under a true burst of concurrent requests
> the counter can under-count (a few extra requests slip through). This
> is acceptable for abuse mitigation — for truly hard guarantees we'd
> move counters to a Durable Object (out of scope here).

### 3.5 Error tracking + structured logs (Task #22) — Sentry

The Worker captures every uncaught exception, every webhook signature
failure, every analyzer 500, and every KV / handler error to **two
sinks** simultaneously:

1. **Always-on**: structured single-line JSON to `console.error` /
   `console.log` — visible in `wrangler tail` and any log shipper that
   reads stdout. No setup required.
2. **Optional**: a POST to a [Sentry](https://sentry.io) project
   envelope endpoint when the `SENTRY_DSN` secret is set. Includes
   parsed stack frames, request URL/method (querystring stripped for
   PII safety), authenticated user id, Stripe event id (for webhook
   errors), and a `release` tag pulled from `RELEASE_TAG`. Network IO
   rides on `ctx.waitUntil` so it never delays a response.

Sentry's free Developer plan currently includes 5,000 errors/month.
The original Task #22 acceptance criteria mentioned a ~10k/month
budget; the chosen approach satisfies it via two compounding mechanisms:
(a) the always-on structured-JSON console sink absorbs 100% of events
at zero cost regardless of Sentry quota, and (b) follow-up task #41
adds per-fingerprint sampling for upstream-outage spikes (e.g. OSV
being down for 30 minutes) so a single incident can't burn through the
Sentry quota — typical month-on-month volume for sub-1k DAU stays
comfortably under 5k. If volume ever pushes past that even with
sampling, Axiom is a viable swap target: only the transport in
`worker/src/observability.js` would change; call sites are
transport-agnostic.

#### Setting it up

1. Create a free Sentry account, then a new project of type
   "JavaScript / Cloudflare Workers". Sentry will display the DSN in
   the form `https://<key>@<host>.ingest.sentry.io/<projectId>`.
2. Add it as a Worker secret:
   ```bash
   cd worker
   ./node_modules/.bin/wrangler secret put SENTRY_DSN     --env production
   # (paste the DSN at the prompt — never commit it)
   ./node_modules/.bin/wrangler secret put RELEASE_TAG    --env production
   # (suggested value: the git short SHA from your last deploy, e.g. "abc123d")
   ```
3. Verify both names appear in `wrangler secret list --env production`.
4. To smoke-test, deploy and hit any endpoint that intentionally errors
   (the easiest: POST a malformed event to `/api/stripe/webhook` —
   the signature failure is captured at "warning" level and shows up
   in Sentry within ~30s).

#### What gets captured

| Site                                    | Level     | Tags                                                          |
|-----------------------------------------|-----------|---------------------------------------------------------------|
| Top-level uncaught exception            | `error`   | `source: "worker_top_level"`                                  |
| Webhook signature failure               | `warning` | `source: "webhook", reason: "bad_signature", verdict_reason`  |
| Webhook handler exception (KV / parse)  | `error`   | `source: "webhook", event_type, stripe_event_id`              |
| Webhook missing `STRIPE_WEBHOOK_SECRET` | `fatal`   | `source: "webhook", reason: "missing_secret"`                 |
| Analyzer engine throw (cost / vuln / algo) | `error` | `source: "analyzer", analyzer: "<label>"`                     |
| GitHub lockfile fetch failure           | `error`   | `source: "analyzer", subpath: "lockfile_fetch", upstream: "github.com", reason` |
| OSV.dev upstream failure                | `error`   | `source: "analyzer", subpath: "osv", upstream: "osv.dev"`     |

#### What is NEVER sent

Cookies, the `Authorization` header, the request body, raw email
addresses, or anything from the querystring — only the URL pathname,
method, `User-Agent`, `CF-Connecting-IP` (already public), and
`CF-Ray`. Authenticated user id is sent as `user.id` (it's already
opaque — JWT subject — not the email).

#### Cost when SENTRY_DSN is unset

Zero. The transport short-circuits before the DSN parse if the secret
is missing; only the structured-JSON console line is emitted.

### 3.6 Transactional email via Google Workspace (Task #56)

The Worker sends a welcome email after every successful free-tier
signup, and exposes a single `sendTransactional({to, subject, text,
html})` helper any future handler (low-quota warning, magic-link, etc.)
can call. Failures NEVER block the user response — the send rides on
`ctx.waitUntil` and any error is captured to Sentry via the §3.5 pipe.

#### Why Gmail API and not SMTP relay?

Cloudflare Workers can only do HTTP/HTTPS — there's no raw TCP socket,
so `smtp-relay.gmail.com:587` is **not** reachable from the Worker
runtime. The Gmail API over HTTPS is the only Google Workspace
transport that works from a Worker. We pay for that with a one-time
service-account + domain-wide-delegation setup; in exchange there is
no SMTP password to rotate, the credential is scoped to a single OAuth
scope (`gmail.send`), and revocation is one click in the Workspace
admin console.

#### One-time provisioning

Done once per Workspace tenant. You need **Workspace Super Admin** for
steps 4–5 and **Google Cloud project Owner** for steps 1–3.

1. **Create / pick a Google Cloud project.** Visit
   <https://console.cloud.google.com/projectcreate>. Any project on the
   same Google account as the Workspace tenant works — there's no
   billing requirement for the Gmail API send quota we use.
2. **Enable the Gmail API** for that project at
   <https://console.cloud.google.com/apis/library/gmail.googleapis.com>
   → click **Enable**.
3. **Create a service account.**
   - <https://console.cloud.google.com/iam-admin/serviceaccounts> →
     **Create service account**.
   - Name: `algosize-mailer`. No project-level IAM roles needed.
   - After creation, open the account → **Keys → Add key → Create new
     key → JSON**. The browser downloads `algosize-mailer-XXXX.json` —
     this is the secret the Worker needs. **Treat it like a password.**
   - On the same page, copy the **Unique ID** (a 21-digit number) —
     you need it in step 4.
4. **Grant domain-wide delegation** (Workspace admin console).
   - <https://admin.google.com> → **Security → Access and data control
     → API controls → Manage Domain-Wide Delegation**.
   - **Add new** → Client ID = the Unique ID from step 3 → OAuth
     scopes = `https://www.googleapis.com/auth/gmail.send` (one scope,
     comma-separated if you ever add more).
   - Save. Propagation is usually < 5 minutes but can take up to 24h
     for a brand-new Workspace tenant.
5. **Create the impersonation mailbox.** This is the actual user
   inbox the service account speaks AS. The Worker default is
   `noreply@algosize.com` (production) and `noreply-staging@algosize.com`
   (staging). Workspace admin → **Users → Add new user** for each.
   You don't have to log into them — they just need to exist.
6. **Push the service-account JSON as a Worker secret.** The whole
   JSON file goes in as one value:
   ```bash
   cd worker
   ./node_modules/.bin/wrangler secret put GOOGLE_SERVICE_ACCOUNT_JSON --env production
   # When prompted, paste the ENTIRE contents of the .json file from
   # step 3 (including the {…} braces) and press Enter then Ctrl-D.
   # Wrangler accepts multi-line input here.
   ```
   The non-secret companions (`EMAIL_FROM`, `EMAIL_DELEGATED_USER`,
   optional `EMAIL_REPLY_TO`) are already declared in
   `worker/wrangler.toml` under `[env.production.vars]`. Edit there
   if you want a different sender display name or impersonation
   mailbox.
7. **Repeat for staging** with `--env staging` and the staging mailbox
   (`noreply-staging@algosize.com`). The same service-account JSON
   works for both environments — DWD is per-tenant, not per-env.

#### Verify

```bash
# After deploying, sign up with a fresh address against the live API:
curl -i -X POST https://algosize.com/api/signup \
  -H "content-type: application/json" \
  -d '{"email":"you+algosize-test@gmail.com"}'
# expect HTTP/2 201 with the dashboard redirect payload.

# Within ~30s, the welcome email lands in the test inbox. Confirm:
#   - From: noreply@algosize.com (display: "Algosize")
#   - Subject contains "Welcome to Algosize"
#   - Both plain-text and HTML render
#   - Gmail's "Show original" panel shows
#       SPF:   PASS  (google.com)
#       DKIM:  PASS  (algosize.com)
#       DMARC: PASS
# If any of those say "neutral" or "fail", check §4.4 below.
```

If the worker logs show `google_email_not_configured`, the secret
or one of the vars is missing. If they show
`google_token_exchange_failed status=401 unauthorized_client`,
domain-wide delegation didn't take — re-check the Unique ID in
step 4 and wait 5 more minutes.

#### Rotation

Service-account keys don't expire by default, but rotate at least
yearly and immediately on staff turnover or any suspected compromise.

```bash
# 1. In the Cloud Console: Service accounts → algosize-mailer → Keys →
#    Add key → Create new key → JSON. Download the new file. Do NOT
#    delete the old key yet.
# 2. Push the new JSON as the Worker secret (overwrites the old value):
cd worker
./node_modules/.bin/wrangler secret put GOOGLE_SERVICE_ACCOUNT_JSON --env production
# 3. Re-deploy so the running Worker picks up the new secret:
./node_modules/.bin/wrangler deploy --env production
# 4. Smoke-test: trigger a fresh signup and confirm the welcome
#    email lands.
# 5. ONLY THEN delete the old key from the Cloud Console (Keys tab →
#    trash icon next to the old key id). The Worker's in-memory token
#    cache is per-isolate and lives ≤ 50 min, so old isolates may use
#    the previous key briefly — leaving the old key valid for a few
#    minutes after step 3 prevents a window of failed sends during
#    the rollover.
```

To revoke entirely (e.g. taking the Worker offline): delete the key
in step 5 *before* deleting the secret, so any still-running isolate
fails closed (caught by `captureException`) rather than silently
sending from a stale cache.

#### Local dev

`sendTransactional` treats a missing `GOOGLE_SERVICE_ACCOUNT_JSON`
or missing `EMAIL_FROM` as `{sent: false, reason: "not_configured"}`
and emits a single warn-level log line — no Sentry spam. Local
`wrangler dev` therefore Just Works without Workspace setup. To
exercise the real send path locally, paste the JSON into
`worker/.dev.vars` (gitignored — see `.dev.vars.example`).

### 3.7 Google sign-in (OAuth 2.0)

The landing page offers two ways in: a magic link, and **Sign in with
Google**. The Google button is a plain link to `/api/auth/google/start`,
and that endpoint redirects straight back to `/?auth=google_not_configured`
— rendering *"Google sign-in isn't set up yet. Use the email link option
for now."* — unless **both** of these are set on the environment:

| Name | Secret? | Notes |
|---|---|---|
| `GOOGLE_CLIENT_ID` | yes (by convention) | Not actually confidential — it appears in the consent-screen URL every user sees. Stored as a secret only so it sits alongside its partner rather than in `wrangler.toml`. |
| `GOOGLE_CLIENT_SECRET` | **yes** | Genuinely confidential. Never commit it. |

This is **separate from §3.6**. That one is a Workspace *service account*
for sending mail as `noreply@`; this is an *OAuth client* for signing
users in. Different credential, different console page, different failure
mode — do not reuse one for the other.

#### One-time provisioning

1. **Pick the Google Cloud project.** Reuse the §3.6 project or make a
   new one — either is fine, they are independent.
2. **Configure the OAuth consent screen** at
   <https://console.cloud.google.com/apis/credentials/consent>.
   - User type **External** (unless every user will be on your Workspace
     tenant, which for a commercial product they will not be).
   - App name, support email, developer contact. Scopes: the defaults
     (`openid`, `email`, `profile`) are exactly what the handler
     requests — do not add more.
   - **Publish the app.** While it is in *Testing*, only accounts you
     explicitly add as test users can sign in; everyone else gets
     `access_denied`, which surfaces as `/?auth=google_access_denied`.
     This is the single most common reason Google sign-in "works for me
     but not for customers."
3. **Create the OAuth client** at
   <https://console.cloud.google.com/apis/credentials> →
   **Create credentials → OAuth client ID** → Application type
   **Web application**.
   - **Authorised redirect URIs** — add exactly:
     ```
     https://algosize.com/api/auth/google/callback
     ```
     This is built in code as `${SITE_ORIGIN}/api/auth/google/callback`,
     so it must match `SITE_ORIGIN` for the environment **character for
     character**: scheme, host, no trailing slash. A mismatch fails at
     Google's end with `redirect_uri_mismatch` before your Worker is
     ever reached, so nothing appears in `wrangler tail`.
   - Add the staging URI too if staging should support Google sign-in:
     `https://staging.algosize.com/api/auth/google/callback`. One client
     can hold several redirect URIs.
4. **Push both values as Worker secrets:**
   ```bash
   cd worker
   ./node_modules/.bin/wrangler secret put GOOGLE_CLIENT_ID     --config wrangler.toml --env production
   ./node_modules/.bin/wrangler secret put GOOGLE_CLIENT_SECRET --config wrangler.toml --env production
   ```
   Repeat with `--env staging` if you added the staging redirect URI.

#### Verify

```bash
# Unconfigured → 302 back to the site with the banner code.
# Configured   → 302 to accounts.google.com.
curl -s -o /dev/null -D - https://algosize.com/api/auth/google/start \
  | grep -i '^location:'
```

`location: https://accounts.google.com/o/oauth2/v2/auth?...` means it is
working. `location: https://algosize.com/?auth=google_not_configured`
means one or both secrets are still missing.

#### The `?auth=` codes, and what each one means

Every failure path redirects to the site with a code that
`site/assets/js/auth-banner.js` renders as a banner. When a user reports
that sign-in failed, the code in their URL bar identifies the cause:

| Code | Cause |
|---|---|
| `google_not_configured` | One or both secrets missing on this environment. |
| `google_access_denied` | User declined consent — **or** the consent screen is still in *Testing* and they are not a listed test user (step 2). |
| `expired_or_invalid` | CSRF state missing or already redeemed. State lives 10 min in `SESSIONS` KV and is single-use, so this is usually a stale tab or a double-click on the callback. |
| `google_token_failed` | Code-for-token exchange rejected. Almost always a wrong `GOOGLE_CLIENT_SECRET` or a `redirect_uri` that does not match the registered one. |
| `email_not_verified` | Google reports `email_verified: false`. Refused deliberately — an unverified address must never mint a session. |
| `google_no_email` | The profile carried no email; the `email` scope was not granted. |

#### Local dev

Leave both unset and the button degrades to the banner above — magic-link
still works, so `wrangler dev` needs no Google setup. To exercise the real
flow locally, put both values in `worker/.dev.vars` and register
`http://localhost:8787/api/auth/google/callback` as an additional
redirect URI on the same client.

---

## 4. DNS — point `algosize.com/api/*` at the Worker

The site is on GitHub Pages (apex). The Worker needs to serve only
`/api/*` on the same hostname so the browser stays same-origin (no CORS
preflights, cookies just work). The clean way is a Cloudflare **Worker
Route** on a domain proxied through Cloudflare.

### 4.1 Add `algosize.com` to Cloudflare

1. Cloudflare dashboard → **Add a site** → enter `algosize.com` → pick
   the Free plan.
2. Cloudflare scans your existing DNS. Confirm the four GitHub Pages
   A/AAAA records from §1.4 are imported. Set their **Proxy status** to
   **Proxied** (orange cloud) — this is what lets a Worker route
   intercept requests.
3. Cloudflare gives you two nameservers (e.g. `xxx.ns.cloudflare.com`).
   Update them at your registrar. Wait for activation (Cloudflare emails
   you when it's done — usually < 1 hour).

### 4.2 Add the Worker route

Once `algosize.com` is **Active** in Cloudflare:

```bash
cd worker
./node_modules/.bin/wrangler deployments list --env production   # sanity check
```

In `worker/wrangler.toml`, add a `routes` line to the existing
`[env.production]` block. The block currently looks like:

```toml
[env.production]
name = "algosize"
```

Change it to:

```toml
[env.production]
name   = "algosize"
routes = [
  { pattern = "algosize.com/api/*", zone_name = "algosize.com" },
]
```

> Make sure `routes` lands under `[env.production]` — **not** under
> `[env.production.vars]` (which comes a few lines below) and **not**
> at the top of the file. The TOML scope matters; a misplaced `routes =`
> will silently bind to the default env, not production.

Re-deploy:

```bash
./node_modules/.bin/wrangler deploy --env production
```

Verify the route is bound:

```bash
curl -i https://algosize.com/api/me
# expect HTTP/2 501 from the Worker (same response as §2.5)
```

If you get a GitHub Pages 404 instead, the route didn't take — check
**Cloudflare dashboard → Workers & Pages → algosize → Triggers → Routes**.

### 4.3 (Alternative) Subdomain instead of route

If you'd rather serve the API from `api.algosize.com` instead of
`/api/*` on the apex, change `wrangler.toml` to:

```toml
routes = [
  { pattern = "api.algosize.com/*", zone_name = "algosize.com", custom_domain = true },
]
```

You'll then need to:
- Update `site/_config.production.yml` → `api_base: "https://api.algosize.com"`
- Update `[env.production.vars] SITE_ORIGIN` to whichever hostname the
  user *loads the site from* (still `https://algosize.com`).
- Re-enable CORS for that origin (it's already wired — `worker/src/cors.js`
  echoes `env.SITE_ORIGIN`).

The default route-on-apex path (§4.2) is simpler — use it unless you have
a reason to split the API onto its own subdomain.

### 4.4 DNS — SPF, DKIM, DMARC for Workspace mail (Task #56)

The Worker sends transactional mail through Google Workspace (§3.6).
Without the three records below, Gmail/Apple/Outlook will mark the
welcome email as **"unverified sender"** and route a large fraction
of it to spam. Add them at your DNS registrar (NOT at Cloudflare —
the apex is on GitHub Pages and you don't need Cloudflare DNS for
Workspace mail; see §4.1 if you've already migrated).

#### SPF — authorize Google to send as algosize.com

Add a TXT record at the apex:

```
@   TXT   "v=spf1 include:_spf.google.com ~all"
```

If you already have an SPF record (e.g. from a previous mail provider
or marketing tool), **merge** rather than add a second — only one SPF
record per domain is allowed by RFC 7208. The `include:` mechanism
chains, e.g.:

```
@   TXT   "v=spf1 include:_spf.google.com include:mail.zendesk.com ~all"
```

`~all` (soft-fail) is what Workspace's own setup wizard recommends
during rollout — flip to `-all` (hard-fail) once you've verified
no other system sends as `@algosize.com`.

#### DKIM — sign outbound mail with a Workspace key

Workspace generates the DKIM key for you, but you must publish the
public half at the registrar. In Workspace admin:

1. <https://admin.google.com> → **Apps → Google Workspace → Gmail →
   Authenticate email**.
2. Pick the `algosize.com` domain → **Generate new record** → choose
   **2048-bit** key length and selector prefix `google` (default).
3. Workspace shows a TXT record. Copy the `Hostname` and `Value`.
4. At your registrar, publish:
   ```
   google._domainkey.algosize.com   TXT   "v=DKIM1; k=rsa; p=<long-public-key-from-Workspace>"
   ```
   The value is ~400 chars. Most registrars need it split into
   255-char strings concatenated, like
   `"v=DKIM1; k=rsa; p=ABC..." "...XYZ"` — your registrar's UI
   handles this if you paste the whole value.
5. Back in Workspace admin, click **Start authentication**. Status
   flips to **Authenticating email** (~5–60 min) then **Authenticated**.

#### DMARC — tell receivers what to do with unauthenticated mail

Add a TXT record at `_dmarc.algosize.com`:

```
_dmarc   TXT   "v=DMARC1; p=none; rua=mailto:dmarc@algosize.com; pct=100; adkim=s; aspf=s"
```

Start with `p=none` for ≥ 7 days so you can collect aggregate reports
to `dmarc@algosize.com` (create that mailbox in Workspace first) and
catch any misaligned senders. Once reports show 100% pass, tighten:

```
# After 7 days of clean reports:
_dmarc   TXT   "v=DMARC1; p=quarantine; rua=mailto:dmarc@algosize.com; pct=100; adkim=s; aspf=s"

# After another 7 days at quarantine:
_dmarc   TXT   "v=DMARC1; p=reject; rua=mailto:dmarc@algosize.com; pct=100; adkim=s; aspf=s"
```

`adkim=s` and `aspf=s` are strict alignment — only exact-domain matches
pass. Required for the algosize.com brand to actually appear as a
trusted sender in Gmail's BIMI-style sender preview.

#### Verify

```bash
dig +short TXT algosize.com | grep spf1
# expect: "v=spf1 include:_spf.google.com ~all"

dig +short TXT google._domainkey.algosize.com
# expect: "v=DKIM1; k=rsa; p=..."

dig +short TXT _dmarc.algosize.com
# expect: "v=DMARC1; p=none; rua=mailto:dmarc@algosize.com; ..."
```

Belt-and-braces deliverability check: <https://www.mail-tester.com>
gives a free 10/10 score test — sign up to algosize, forward the
welcome email to the test address it gives you, click "Then check
your score". Fix anything < 9/10 before announcing.

---

## 5. Stripe webhook → Worker → back to Cloudflare

The Worker at `/api/stripe/webhook` handles two events:
`checkout.session.completed` (creates the user + sets the session cookie)
and `customer.subscription.deleted` (flips the user to inactive). Both
require a valid Stripe signature, verified with `STRIPE_WEBHOOK_SECRET`.

### 5.1 Create the webhook endpoint in Stripe

In **Stripe dashboard → Developers → Webhooks → Add endpoint**:

- **Endpoint URL:** `https://algosize.com/api/stripe/webhook`
- **Description:** `Algosize Worker — production`
- **Events to send** (just these two — pick "Select events"):
  - `checkout.session.completed`
  - `customer.subscription.deleted`
- Click **Add endpoint**.

On the new endpoint's page, click **Reveal signing secret** (top right).
Copy the value — it starts with `whsec_…`.

### 5.2 Push the signing secret into Cloudflare

```bash
cd worker
./node_modules/.bin/wrangler secret put STRIPE_WEBHOOK_SECRET --env production
# paste the whsec_... value at the prompt
```

(If you set this in §3 with a placeholder, re-running `secret put`
overwrites it.)

### 5.3 Verify the webhook with the Stripe CLI

```bash
stripe trigger checkout.session.completed
# → Stripe sends a synthetic event to your real endpoint.
```

Then in Cloudflare → **Workers & Pages → algosize → Logs** (or
`wrangler tail --env production`):

```bash
cd worker
./node_modules/.bin/wrangler tail --env production
# expect a 200 line for POST /api/stripe/webhook
```

In the Stripe dashboard, the endpoint's **Recent events** table should
show the trigger with **Succeeded** and HTTP `200`.

### 5.4 Idempotency (Task #20) — what to expect in logs

Stripe is **at-least-once delivery**: the same `event.id` may arrive
twice (network blips, our 5xx responses retried, or rare duplicates
from Stripe's side). The Worker dedups on `event.id` using keys named
`stripeEvent:<id>` in the **existing `SESSIONS` KV** namespace (no new
binding to provision) with a **7-day TTL** — comfortably longer than
Stripe's documented retry window of ~3 days.

Behavior to look for in `wrangler tail`:

| Scenario | Response | Notes |
|---|---|---|
| First delivery of an event | `200 {received:true, handled:"<type>"}` | Dedup row written **after** the handler succeeds. |
| Replay of the same event id | `200 {received:true, deduped:true, type:"<type>"}` | USERS KV is **not** touched. |
| Handler error (KV blip etc.) | `500 {error:"handler_failed"}` | Dedup row **not** written; Stripe retries; the next attempt actually does the work. |
| Bad signature | `400 {error:"invalid_signature"}` | Rejected before dedup — bogus event ids cannot pollute the table. |

To audit replay activity manually:

```bash
# How many dedup rows are live right now?
./node_modules/.bin/wrangler kv key list --binding SESSIONS --env production \
  --prefix "stripeEvent:" | jq length

# Has a specific event id already been processed?
./node_modules/.bin/wrangler kv key get --binding SESSIONS --env production \
  "stripeEvent:evt_1Ab2Cd3Ef4Gh5Ij6"
```

If you ever need to **force re-processing** of a specific event (e.g.
the handler logic changed and you want Stripe to re-deliver against
the new code), delete that key and replay the event from the Stripe
dashboard:

```bash
./node_modules/.bin/wrangler kv key delete --binding SESSIONS --env production \
  "stripeEvent:<eventId>"
```

---

## 6. Swap Stripe test keys for live keys

You've been deploying with `sk_test_…` and `price_…` from a test product.
Going live is just three secret swaps + one toggle in Stripe.

### 6.1 Create the product + price in **live mode**

In Stripe dashboard, top-left toggle: **Test mode → Live mode**.

1. **Products → Add product** → name it (e.g. "Algosize Pro"),
   description, pricing (e.g. $49/mo recurring).
2. Save. Open the product. Copy the **Price ID** (starts with
   `price_…` — *not* the product ID `prod_…`).

### 6.2 Re-create the webhook in live mode

Live mode and test mode have **separate** webhook endpoints — the test-mode
one you made in §5 won't fire on live charges. Repeat §5.1 with the live
toggle on:

- Same URL: `https://algosize.com/api/stripe/webhook`
- Same two events.
- Reveal and copy the new live `whsec_…`.

### 6.3 Push the live values into Cloudflare

```bash
cd worker

# Live secret API key (Developers → API keys → Live mode → Reveal live key)
./node_modules/.bin/wrangler secret put STRIPE_SECRET_KEY     --env production   # sk_live_...

# Live price ID from §6.1
./node_modules/.bin/wrangler secret put STRIPE_PRICE_ID       --env production   # price_...

# Live webhook signing secret from §6.2
./node_modules/.bin/wrangler secret put STRIPE_WEBHOOK_SECRET --env production   # whsec_...

# Re-deploy is NOT needed — secrets take effect on next invocation.
# But you can force a fresh worker version if you want to bust caches:
./node_modules/.bin/wrangler deploy --env production
```

### 6.4 Final smoke test (real money — use a real card)

Walk `TESTING.md` against `https://algosize.com`. The Stripe step now
charges a real card; either start with a $1 test product or use Stripe's
"refund" button immediately after the test purchase.

### 6.4 Free-tier quota (Task #19) — KV layout & ops

Free signups (`POST /api/signup`) write to the same `USERS` namespace
already provisioned in §2.2 — no new binding to create. Each free
analyzer call increments a per-user, per-month counter:

| Key shape                          | Value      | TTL      |
|------------------------------------|------------|----------|
| `user:<userId>`                    | JSON `{plan: "free"\|"paid", ...}` | none |
| `email:<lowercased-email>`         | `<userId>` | none     |
| `cust:<stripeCustomerId>`          | `<userId>` | none (paid only) |
| `quota:<userId>:<YYYY-MM>`         | integer count, e.g. `"3"` | **35 days** |

The 35-day TTL outlives the longest possible month so a counter still
being read on the 1st of the next month never 404s. Calendar reset is
automatic — the next month's key just doesn't exist yet, so reads
return 0.

Free users get **5 successful runs per calendar month, in UTC**, shared
across the cost / vuln / algo analyzers. Paid users (any user with
`plan: "paid"` — set automatically by checkout / webhook) bypass the
counter entirely. Validation errors (400) and sandbox crashes (500) do
NOT consume quota: the wrapper only increments after a 200.

Operator levers:

- **Reset a user's quota:** `wrangler kv key delete --binding USERS
  --env production "quota:<userId>:$(date -u +%Y-%m)"`.
- **Read current count:** `wrangler kv key get --binding USERS --env
  production "quota:<userId>:$(date -u +%Y-%m)"`.
- **Promote a free user to paid manually** (e.g. comp account): edit
  the `user:<userId>` JSON value, set `plan: "paid"`, write back. The
  next analyzer call sees the new plan via `getUserById`.

Marketing copy lives in `site/index.html` (pricing section, two-card
grid: Starter / Pro). The free-tier signup form posts JSON
`{email}` to `/api/signup` and follows the `redirectUrl` to
`/dashboard/`. The dashboard header shows the live counter (`X / 5`
for free, `Unlimited` for paid) hydrated from `/api/me`.

### 6.5 Enable the Stripe Customer Portal (one-time, per environment)

The dashboard's **Manage billing** button (Task #18) opens Stripe's
hosted Customer Portal so users can update their card, download invoices,
or cancel without emailing support. Stripe requires the portal to be
*configured* before it'll mint sessions — otherwise the Worker call
returns `400 portal_failed` and the user sees an alert.

Repeat this step **once per Stripe mode you ship in** (test mode for
staging, live mode for production):

1. In the Stripe dashboard, top-left toggle: pick the mode you're
   configuring (test or live).
2. Go to **Settings → Billing → Customer Portal**:
   - Test mode: <https://dashboard.stripe.com/test/settings/billing/portal>
   - Live mode: <https://dashboard.stripe.com/settings/billing/portal>
3. Set **Business information**: business name (e.g. "Algosize"),
   privacy + terms URLs (`https://algosize.com/privacy`,
   `https://algosize.com/terms` if you have them).
4. **Functionality** — enable at minimum:
   - **Invoice history** (download past invoices)
   - **Customer update** → allow updating payment method
   - **Subscription cancellation** → cancel immediately or at period end
     (your call; immediate is the cleanest for a $X/mo SaaS)
5. **Products** → add the Algosize Pro price you created in §6.1 so the
   portal knows which plan the user is on.
6. Click **Save**. The portal is now ready — no Worker redeploy needed
   (no new secret was created; it reuses `STRIPE_SECRET_KEY`).

To verify: sign in to the dashboard, click **Manage billing**, you
should land on `billing.stripe.com/p/session/...` with your business
name in the header. The "Return to Algosize" link goes back to
`/dashboard/`. Cancellations from inside the portal trigger the
`customer.subscription.deleted` webhook (already wired by Task #4),
which flips `subStatus` to `inactive` — the dashboard reflects this on
the next page load via `/api/me`.

---

## 7. Staging environment (Task #23)

A parallel `staging` Cloudflare environment lets you exercise risky changes
— a new analyzer engine, a KV → D1 migration, a new Stripe webhook event
— end-to-end against **Stripe test mode** before they hit live customers.
This section mirrors §2–§5 with `--env staging` everywhere.

The staging Worker lives at `https://staging.algosize.com/api/*`. Its
config is already declared in `worker/wrangler.toml` under `[env.staging]`
and `worker-sandbox/wrangler.toml` under `[env.staging]` — the only thing
you have to do operationally is create the resources and wire in the IDs
+ secrets.

> Initially staging serves the prod Jekyll build via DNS — there is no
> separate `_config.staging.yml`. Splitting the static build out (so
> staging can preview design changes too) is out of scope here; until
> then, hitting `https://staging.algosize.com/dashboard/` lets you
> exercise the dashboard against the staging Worker's KV + Stripe test
> mode while the markup itself is whatever's in production.

### 7.1 Create the staging KV namespaces and D1 database

```bash
cd worker
./node_modules/.bin/wrangler kv namespace create SESSIONS --env staging
./node_modules/.bin/wrangler kv namespace create USERS    --env staging
./node_modules/.bin/wrangler d1 create algosize-staging
```

The `kv namespace create` commands each print an `id = "…"` line and
the `d1 create` command prints a `database_id = "…"` UUID. **These ids
are different from the production ids** — that's the whole point. Don't
reuse prod ids.

### 7.2 Wire the namespace IDs and D1 database id into `wrangler.toml`

Open `worker/wrangler.toml`, find the two `[[env.staging.kv_namespaces]]`
blocks (sentinel ids `…stg1` / `…stg2`) and the
`[[env.staging.d1_databases]]` block (sentinel `…00000000stg1`), and
replace each placeholder with the real value from §7.1.

Then apply the schema to the staging database:

```bash
./node_modules/.bin/wrangler d1 execute algosize-staging \
  --file=migrations/0001_init.sql --env staging --remote
```

Sanity-check: `wrangler deploy --env staging --dry-run` should report
two KV bindings, one D1 binding, and zero placeholder warnings.

### 7.3 Set the staging Worker secrets

Set the same six names as production, **but with Stripe TEST-mode values**
and a separate Sentry project DSN (so staging noise doesn't pollute the
prod Sentry project).

```bash
cd worker
./node_modules/.bin/wrangler secret put JWT_SECRET            --env staging
# fresh 32+ byte hex — do NOT reuse the prod JWT_SECRET (compromised
# staging keys would let an attacker mint prod sessions otherwise).

./node_modules/.bin/wrangler secret put STRIPE_SECRET_KEY     --env staging
# Stripe → top-left → Test mode → Developers → API keys → Reveal sk_test_…

./node_modules/.bin/wrangler secret put STRIPE_WEBHOOK_SECRET --env staging
# whsec_… from the staging webhook endpoint you'll create in §7.5 — set
# this AFTER §7.5, then re-run the deploy.

./node_modules/.bin/wrangler secret put STRIPE_PRICE_ID       --env staging
# A test-mode price_… (Stripe → Test mode → Products → create or reuse
# the test version of the Algosize Pro price).

./node_modules/.bin/wrangler secret put OPENAI_API_KEY        --env staging
# Optional. Reusing the prod key is fine — OpenAI charges per call, not
# per environment.

./node_modules/.bin/wrangler secret put SENTRY_DSN            --env staging
# Optional. Recommended: create a SEPARATE Sentry project ("algosize-
# staging") so staging error noise doesn't burn the prod 5k/mo quota.

./node_modules/.bin/wrangler secret put RELEASE_TAG           --env staging
# Same convention as prod (git short SHA).
```

Verify:

```bash
./node_modules/.bin/wrangler secret list --env staging
# expect: JWT_SECRET, STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET,
# STRIPE_PRICE_ID, plus optionally OPENAI_API_KEY, SENTRY_DSN, RELEASE_TAG.
```

### 7.4 Deploy the staging Worker (and its sandbox sibling)

The sandbox must ship before the main Worker — the main Worker's
`SANDBOX` service binding fails to bind otherwise.

```bash
cd worker-sandbox
./node_modules/.bin/wrangler deploy --env staging
# → Published algosize-sandbox-staging

cd ../worker
./node_modules/.bin/wrangler deploy --env staging
# → Published algosize-staging
#   https://algosize-staging.<your-account>.workers.dev
```

Smoke-test on the `*.workers.dev` URL (DNS comes next):

```bash
curl -i https://algosize-staging.<your-account>.workers.dev/api/me
# expect: HTTP/2 501 with {"error":"not_implemented", ...}
```

### 7.5 DNS + Worker route for `staging.algosize.com`

In **Cloudflare dashboard → DNS → Records** for the `algosize.com` zone:

1. Add a CNAME record: **Name** `staging`, **Target** `<your-gh-pages-target>`
   (the same target the apex points at — typically `<user>.github.io`).
2. **Proxy status: Proxied** (orange cloud) — the Worker route only fires
   on proxied hostnames.

The route binding is already declared in `wrangler.toml`:

```toml
[env.staging]
routes = [
  { pattern = "staging.algosize.com/api/*", zone_name = "algosize.com" },
]
```

So a re-deploy is enough to bind it:

```bash
cd worker
./node_modules/.bin/wrangler deploy --env staging
```

Verify the route is bound to the staging Worker (not prod):

```bash
curl -i https://staging.algosize.com/api/me
# expect HTTP/2 501 from the Worker
```

If you get a GitHub Pages 404 instead, the route didn't take — check
**Cloudflare dashboard → Workers & Pages → algosize-staging → Triggers
→ Routes**.

### 7.6 Stripe test-mode webhook for staging

In **Stripe dashboard → top-left toggle → Test mode → Developers →
Webhooks → Add endpoint**:

- **Endpoint URL:** `https://staging.algosize.com/api/stripe/webhook`
- **Description:** `Algosize Worker — staging`
- **Events to send:**
  - `checkout.session.completed`
  - `customer.subscription.deleted`
- Click **Add endpoint**, then **Reveal signing secret** and feed the
  `whsec_…` into `STRIPE_WEBHOOK_SECRET` per §7.3 (re-run that one
  `wrangler secret put` if you skipped it earlier), then re-deploy.

Don't forget to **also enable the Stripe Customer Portal in test mode**
(per §6.5 instructions, but flip the dashboard toggle to Test mode first
and use the test-mode portal URL). Otherwise the staging dashboard's
"Manage billing" button returns `400 portal_failed`.

### 7.7 Final staging smoke test

End-to-end checkout against Stripe test mode:

```bash
# 1. From the staging frontend, click "Get Algosize Pro" → Stripe Checkout.
# 2. Use card 4242 4242 4242 4242 with any future expiry + any CVC.
# 3. After redirect back to /dashboard/, you should be logged in and see
#    "Pro" in the plan badge.
# 4. Click "Manage billing" → Stripe portal opens (test mode banner
#    visible). Cancel the subscription.
# 5. Reload the dashboard — plan badge should flip to "Free" within
#    a second or two (the customer.subscription.deleted webhook fires
#    against the staging Worker, which updates USERS_STAGING).
```

If all four steps pass, staging mirrors production end-to-end and you
can land risky changes here first.

> **Future**: Task #24 (worker auto-deploy via GitHub Actions) will wire
> a `staging` branch to auto-deploy `--env staging` on push. Until then,
> staging deploys are manual via the commands in §7.4.

---

## 8. Verify the deployment (run this last)

Everything above provisions something. This step checks that the
provisioning actually took, against the live deployment, over HTTPS —
no Cloudflare dashboard access required.

```bash
cd worker
SITE_ORIGIN=https://algosize.com \
ADMIN_SESSION_COOKIE='<paste the algosize_session cookie value>' \
  npm run verify:production
```

Exit code is `0` when nothing failed, `1` otherwise, so this is safe to
gate a release on.

### 8.1 Getting the admin session cookie

The script's most valuable checks need an authenticated admin session.
"Admin" here means an email listed in the `ADMIN_EMAILS` var (§3) —
being signed in is not enough.

1. Sign in to <https://algosize.com/dashboard/> with an admin email.
2. Open devtools → Application → Cookies → `https://algosize.com`.
3. Copy the **value** of the `algosize_session` cookie.

Either the bare token or the full `algosize_session=<token>` pair works.
The cookie is a live session — treat it like a password, and don't paste
it into a shared terminal history or a CI log.

Without it the run still works, but the schema and authenticated-read
checks are **skipped**. The summary distinguishes skipped from passed for
exactly this reason: a skip is not evidence of health.

### 8.2 What it checks, and what each check proves

| Group | Requests | Proves |
|---|---|---|
| Reachability | one `GET` to an unrouted path, expecting the Worker's own `{"error":"not_found"}` | `SITE_ORIGIN` reaches **this Worker**, not something in front of it. A failure here stops the run. |
| Stripe account | `GET /api/admin/stripe-check` | The Customer Portal default configuration and the webhook endpoint both exist in the mode the deployed key belongs to. See §8.4. |
| Schema | `GET /api/admin/schema-check` | Every migration `0001`–`0008` is applied, checked per table **and per column**. The authoritative migration check. |
| Routes deployed | `GET /api/me`, `/api/org`, `/api/monitors`, `/api/keys`, `/api/ci/snippet` with **no** cookie | Each route is registered and reachable in the deployed bundle. A `404` means the deploy predates the route; a `500` means the Worker throws before auth; a `200` means the endpoint is not gated at all. |
| Handlers reach D1 | The same endpoints **with** the admin session | The handlers run and their tables exist. This is the group where a `500` really does mean a missing table. |
| Billing | `POST /api/checkout {plan:"solo"}` | The Solo tier price resolves and Stripe accepts it. |

> **The unauthenticated group does not test the database.** `requireAuth`
> returns `401` before any handler runs, so a database missing every
> table still passes it cleanly. That group verifies routing; the schema
> and authenticated groups verify data. This is why the admin cookie is
> worth providing.

Two results are reported as **skipped rather than failed**, because in
both cases the deployment is behaving correctly:

- **`503 plan_not_available`** on checkout — `STRIPE_PRICE_SOLO_MONTHLY`
  is not set. The endpoint refusing to fall back to some other price is
  the intended behaviour (§3); a buyer must never be charged an amount
  they didn't click. Set the secret if you meant to sell that tier.
- **No admin cookie** — see §8.1.

`POST /api/checkout` creates a **real Stripe Checkout Session** when a
price is configured. Nothing is charged and unused sessions expire on
their own, but they do appear in the Stripe dashboard, and the endpoint
is rate-limited to 10/min — a `429` is reported as a skip, so just rerun
in a minute.

### 8.3 When a check fails

| Failure | Fix |
|---|---|
| `origin reachable — HTTP 403 from something in front of the Worker` | Cloudflare Access on the hostname, a WAF rule, or an egress proxy between you and Cloudflare is answering instead of the Worker. Nothing after it can run. Check from a network that reaches the origin directly, or allowlist the host. |
| `origin reachable — expected the Worker's 404 JSON` | `SITE_ORIGIN` is probably pointing at the static site rather than the `/api/*` route (§4). |
| `migrations applied — pending: 0012, 0013` | Apply them (§2.5.10): `wrangler d1 execute algosize --env production --remote --file=migrations/<file>.sql`. The script prints the exact missing table/column under each pending migration. A pending migration from 0010 onward does **not** produce errors anywhere — the write paths swallow their own failures so a missing table cannot break the action it describes — so this endpoint is the only thing that will tell you. |
| `404 — route not registered` | The deployed bundle is older than the code. Redeploy (§2.6). |
| `HTTP 500 — likely a missing table` | A migration for that handler's table is missing. The script names which one. |
| `401 — session cookie rejected` | The session expired or was revoked. Sign in again and re-copy it. |
| `403 — email is not in ADMIN_EMAILS` | The cookie is valid but the account isn't an admin on this deployment. Add the email to `ADMIN_EMAILS` (§3) and redeploy. |
| `200 without credentials` | An authentication hole — an endpoint behind `requireAuth` answered anonymously. Stop and investigate before announcing the deploy. |

Run it against staging too, with `SITE_ORIGIN` pointing at the staging
hostname (§7). Staging having the same schema as production is the whole
point of having a staging environment.

### 8.4 Stripe account configuration (`GET /api/admin/stripe-check`)

Two things the billing code depends on live in the **Stripe dashboard**, not
in this repo. Neither is a secret or a `wrangler.toml` entry, so nothing in
CI can see them, and both fail only once a real customer arrives:

| Missing | Symptom |
|---|---|
| Customer Portal default configuration | Every "Manage billing" click 400s — `POST /billing_portal/sessions` returns *"No configuration provided"*. Fails for your **first paying customer**, not in any test. |
| Webhook endpoint for this deployment | Checkout still works and the customer **is charged**, but renewals, cancellations and `payment_failed` dunning never arrive. Entitlement silently drifts from Stripe: a cancelled subscriber keeps access indefinitely. |

The endpoint checks both and is included in the §8 run. Standalone:

```bash
curl -s https://algosize.com/api/admin/stripe-check \
  -H "Cookie: algosize_session=<token>" | jq
```

**`mode` is part of the answer, not decoration.** Stripe's live and test modes
are separate worlds with separate portal configurations, webhook endpoints and
prices. A green result in test mode says *nothing* about live. The mode is read
from the key prefix (`sk_live_` / `sk_test_`, and the `rk_` restricted
equivalents), so it is reported even when Stripe rejects the key.

The webhook check goes further than "does an endpoint exist": it also verifies
the endpoint is `enabled` and subscribed to **every** event `handlers/webhook.js`
acts on. An endpoint that exists and looks healthy in the dashboard but is
missing `customer.subscription.deleted` breaks cancellations silently, which is
precisely the class of failure this check is for. Missing events are listed in
`checks.webhookEndpoint.missingEvents`.

Fixes are in the response's `fix` fields, mode-correct (test-mode dashboard
URLs carry `/test/`). A 500 with `error: "stripe_unreachable"` means the key
itself is wrong, revoked, or a restricted key without read access to billing
settings — a broken deployment rather than a failed check, the same distinction
§8.2's schema group draws.

### 8.5 Verifying the customer-facing CI integration

`.github/workflows/algosize-audit.yml` in this repo is not just an example —
it's the same file `GET /api/ci/snippet` generates for a customer, committed
here so this repo is its own first customer. Verifying `POST /api/ci/runs`
end-to-end means watching this workflow actually run, not just reading its
YAML.

1. Create an API key on the [Team screen](https://algosize.com/dashboard/#/team)
   (owner/admin only — the key authenticates as the org, not a person).
2. Add it as a repository secret named `ALGOSIZE_API_KEY`
   (Settings → Secrets and variables → Actions). The workflow reads exactly
   that name and skips itself with a `::notice`, never a red build, if it's
   absent — so this step is safe to defer.
3. Open any PR. The workflow fires on `pull_request`, collects
   `worker/package-lock.json` and `worker-sandbox/package-lock.json` (the
   only lockfiles this repo has), and posts them to `/api/ci/runs`.

A working run leaves three traces, each proving a different part of the
path: a sticky PR comment (proves the workflow → API round-trip and
`persistRun` succeeded), a SARIF upload on the repo's Security tab (proves
`GET /api/runs/:id/report?format=sarif` — a route no browser session ever
exercises), and a new row in the dashboard's runs feed under **Monitors → CI**
(proves the API-key auth path in `worker/src/auth.js` end-to-end, not just
the cookie path every other dashboard click uses).

---

## 9. Move algosize.com off GitHub Pages onto the site Worker

Everything in §1 still works — this section is optional, and nothing here
is required for the product to function. It exists because running the site
on GitHub Pages and the API on Cloudflare Workers means two hosting
providers, two deploy pipelines, and (as of the admin-panel PR) a real
incident where a third, half-configured pipeline — Cloudflare's own
"Workers Builds" git integration — uploaded a static-site build as a
*version* on the API Worker's service. Nothing was ever routed from it, but
it was one accidental promotion away from replacing the live API with the
marketing site. That trigger has been deleted. This section replaces it
with something safer: a GitHub Actions workflow that deploys the site the
same way `worker.yml` deploys the API, and a plan for actually serving
`algosize.com` from it instead of from GitHub Pages.

Do this in order. Each stage is checked before moving to the next, and
production (§9.3) is not touched until §9.2 has been verified on a hostname
nobody's customers are looking at.

### 9.1 Confirm the site Worker deploys on its own

`.github/workflows/site-worker.yml` deploys `algosize-site` (root
`wrangler.jsonc`) on every push to `main` that touches `site/**` or that
file — same shape as `worker.yml`, same two repo secrets
(`CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`), no new secrets to create.

```bash
git push origin main      # or push any change under site/**
```

**Actions → Build and deploy site Worker** should go green. Then:

```bash
cd worker
./node_modules/.bin/wrangler deployments list --name algosize-site
```

confirms a current deployment exists. `algosize-site` has no `routes` in
`wrangler.jsonc`, so `workers_dev` defaults on
(`deployToWorkersDev = config.workers_dev ?? routes.length === 0`) and the
site is already live at its `workers.dev` URL — visible in the deploy job's
log, or:

```bash
./node_modules/.bin/wrangler deployments list --name algosize-site --json \
  | jq -r '.[0].url // empty'
```

Open it. You should see the same landing page GitHub Pages serves. **The
dashboard and admin panel will not fully work yet** — their JS calls
same-origin `/api/*`, and nothing proxies API calls to that `workers.dev`
host. That's expected at this stage; §9.2 fixes it by testing under a
hostname that already has an API route.

### 9.2 Prove it end-to-end on `staging.algosize.com` first

`staging.algosize.com/api/*` already routes to the staging Worker (§7).
The staging catch-all route is **already checked into `wrangler.jsonc`** —
same mechanism the API Worker's own `algosize.com/api/*` route uses (§4.2):
a `routes` entry, applied by `wrangler deploy`, no dashboard click. It lets
you test the full site + API + Stripe-test-mode flow on a hostname with
zero production traffic, before algosize.com is touched at all. (More
specific patterns win, so it coexists with the existing
`staging.algosize.com/api/*` route without conflict — API calls still reach
the staging Worker.)

It goes live on the next `site-worker.yml` run — i.e. the next push to
`main` touching `site/**` or `wrangler.jsonc`. If you need it live sooner,
from the repo root (same invocation `site-worker.yml` uses):

```bash
worker/node_modules/.bin/wrangler deploy --config wrangler.jsonc
```

Verify:

```bash
curl -sI https://staging.algosize.com/ | head -1
# expect HTTP/2 200, served by the Worker (not GitHub Pages — the Pages
# custom domain is only algosize.com, so a Pages response here would mean
# the route didn't take)

curl -sI https://staging.algosize.com/api/me
# expect the same 401 the staging Worker always returns unauthenticated
```

Then in a browser: sign in against staging, open `/dashboard/` and `/admin/`
(with an address in staging's `ADMIN_EMAILS`), click around. Confirm
requests in dev tools are same-origin (`staging.algosize.com/api/...`, no
CORS preflights) and that Stripe actions hit test mode. This is the
rehearsal — anything wrong here is wrong on production too, and costs
nothing to fix while it's only staging.

Leaving this route in place afterward is fine (it's genuinely useful — it's
what makes staging's site match what's about to go on production) or remove
it once you've moved on; either is safe.

### 9.3 Cut production over

Once §9.2 is confirmed working: add a THIRD `routes` entry to the root
`wrangler.jsonc`, alongside the staging one —

```jsonc
"routes": [
  { "pattern": "staging.algosize.com/*", "zone_name": "algosize.com" },
  { "pattern": "algosize.com/*", "zone_name": "algosize.com" }
],
```

— as its own commit, on its own, reviewed as the deliberate "go live" change
it is. (`test-wrangler-config.mjs` asserts this entry is absent until you
add it, specifically so it can't land as a side effect of an unrelated site
change.) Push to `main`; `site-worker.yml` deploys it.

The moment this route exists, Cloudflare stops falling through to the
proxied GitHub Pages origin for anything that isn't `/api/*` — routed
requests are handled entirely at the edge and never reach origin, so this
takes effect on that push, without a DNS change. `algosize.com/api/*`
continues to win over the new catch-all for its own requests, same
specificity rule as staging.

Verify immediately:

```bash
curl -sI https://algosize.com/ | head -1
curl -s https://algosize.com/ | grep -o '<title>[^<]*' | head -1
curl -sI https://algosize.com/api/me      # unauthenticated — expect 401
curl -sI https://algosize.com/dashboard/
curl -sI https://algosize.com/nonexistent-page   # expect 404, real 404.html body
```

Then check the product actually works from a browser: sign in, dashboard,
`/admin/`. Nothing about auth, sessions, or cookies changes in this cutover
— same hostname, same-origin API calls exactly as before — so a working
staging rehearsal in §9.2 is a strong signal this will be uneventful.

**Rollback, if anything looks wrong:** revert the commit that added the
`algosize.com/*` entry (or delete that one line) and push — the reverse of
how it went live. Fastest path if you don't want to wait for a full CI run:
`worker/node_modules/.bin/wrangler deploy --config wrangler.jsonc` from the
repo root, same as §9.2's manual command, run against the reverted config.
GitHub Pages has been serving unmodified the entire time — nothing in
§9.1–9.3 touches it — so removing the route is a complete revert either way,
just gated on how fast you can get the reverted config deployed.

### 9.4 Retire GitHub Pages

Only after §9.3 has been live and quiet for a while. Skipping straight here
from §9.3 removes your rollback path.

1. Repo → **Settings → Pages** → change **Source** away from "GitHub
   Actions" (or delete the custom domain) to stop Pages serving anything.
2. Delete or disable `.github/workflows/jekyll.yml` — nothing depends on
   it once Pages is off. (Leaving it enabled but pointed at a disabled Pages
   site is harmless, just a wasted Actions run per push, if you'd rather
   retire it in a separate diff someone reviews.)
3. Remove the root `CNAME` and `site/CNAME` files — both exist only for
   GitHub Pages' domain verification.
4. Optional DNS hygiene: the apex A/AAAA records from §1.4 point at GitHub
   Pages' IPs, but Workers Routes intercept before origin is ever consulted,
   so they're now inert rather than wrong. Cloudflare's own guidance for a
   domain fully served by Workers is a placeholder record, still proxied —
   e.g. `@  A  192.0.2.1` (TEST-NET-1; never a real destination, harmless
   as a proxied placeholder) — in place of the four GitHub Pages IPs. Not
   required; the site works either way once the Route exists.
5. §4.4's SPF/DKIM/DMARC records are for Workspace mail and are unrelated
   to any of this — leave them as they are.

---

## Appendix A — secret/binding reference

For grep'ability, here is the exhaustive list the operator must
provision:

| Name                    | Type    | Where consumed                                    |
|-------------------------|---------|---------------------------------------------------|
| `JWT_SECRET`            | secret  | `worker/src/auth.js` — signs & verifies session JWTs |
| `STRIPE_SECRET_KEY`     | secret  | `worker/src/stripe.js` — Bearer auth on `api.stripe.com` (used by checkout AND `/api/billing/portal`) |
| `STRIPE_WEBHOOK_SECRET` | secret  | `worker/src/handlers/webhook.js` — HMAC verify   |
| `STRIPE_PRICE_ID`       | secret  | `worker/src/stripe.js` — `line_items[0][price]`  |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | secret | `worker/src/email/google.js` — Workspace service-account JSON for Gmail-API send (Task #56). Optional — when unset, sendTransactional no-ops. |
| `GOOGLE_CLIENT_ID`      | secret  | `worker/src/handlers/auth_google.js` — OAuth client for "Sign in with Google" (§3.7). Optional — when unset the button redirects to `/?auth=google_not_configured` and magic-link still works. **Not** the same credential as `GOOGLE_SERVICE_ACCOUNT_JSON`. |
| `GOOGLE_CLIENT_SECRET`  | secret  | `worker/src/handlers/auth_google.js` — partner of the above; genuinely confidential. Both must be set or Google sign-in stays off. |
| `SITE_ORIGIN`           | var     | `worker/src/cors.js`, `handlers/checkout.js` — CORS allow + redirect targets |
| `COOKIE_NAME`           | var     | `worker/src/auth.js` — session cookie name (`algosize_session`) |
| `EMAIL_FROM`            | var     | `worker/src/email/transactional.js` — From: header on transactional mail (Task #56) |
| `EMAIL_DELEGATED_USER`  | var     | `worker/src/email/google.js` — Workspace mailbox the service account impersonates via DWD |
| `EMAIL_REPLY_TO`        | var     | `worker/src/email/transactional.js` — optional Reply-To override; defaults to EMAIL_FROM |
| `SESSIONS` (KV)         | binding | `worker/src/auth.js` — JWT TTL store              |
| `USERS` (KV)            | binding | `worker/src/handlers/_users.js` — subscriber records, free-tier quota counters (`quota:<userId>:<YYYY-MM>`, 35d TTL) |

## Appendix B — rollback

To roll the Worker back to the previous version:

```bash
cd worker
./node_modules/.bin/wrangler deployments list --env production
./node_modules/.bin/wrangler rollback <deployment-id> --env production
```

To roll the site back, redeploy a previous commit:

```bash
git revert <bad-sha>
git push origin main          # GH Actions builds + deploys the revert
```

## Appendix C — what's NOT in scope here

- CI/CD pipelines beyond the existing `.github/workflows/jekyll.yml`.
- Worker preview deployments (`wrangler deploy` without `--env production`
  ships to the default env, which uses the local-dev `vars` block — don't
  do this against a live customer-facing domain).
- Multi-region failover, rate limiting, observability beyond `wrangler tail`.
