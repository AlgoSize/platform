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

---

## 2. Worker → `wrangler deploy`

The Worker source lives in `worker/`. It binds two KV namespaces and reads
four secrets. You'll create the KV namespaces, paste their IDs into
`wrangler.toml`, then deploy.

### 2.1 Authenticate wrangler

```bash
cd worker
./node_modules/.bin/wrangler login
# Browser pops; accept. Picks the active Cloudflare account automatically.
# If you have multiple accounts:
./node_modules/.bin/wrangler whoami            # confirm the right account
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
wrangler kv namespace create SESSIONS --env production
wrangler kv namespace create USERS    --env production
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
./node_modules/.bin/wrangler d1 create algosize
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
./node_modules/.bin/wrangler d1 execute algosize \
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

Then dump the records to a SQL file and apply:

```bash
node scripts/migrate-kv-to-d1.mjs \
  --env production \
  --users-namespace-id <USERS-id from above> \
  --runs-namespace-id  <RUNS-id from above>
# wrote migrate-kv-to-d1.sql: N users, M runs

./node_modules/.bin/wrangler d1 execute algosize \
  --file=migrate-kv-to-d1.sql --env production --remote
```

If you never deployed Task #17 (no RUNS data exists), pass
`--skip-runs` instead of `--runs-namespace-id`.

The script uses `INSERT OR IGNORE` keyed on the primary key, so re-
running is safe — duplicates become no-ops. The KV `email:`/`cust:`
index keys and the per-user `runs:<userId>` index are intentionally NOT
copied (D1's UNIQUE constraints + `idx_runs_user_created` replace them).

#### 2.5.5 Verify

```bash
./node_modules/.bin/wrangler d1 execute algosize --env production --remote \
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
./node_modules/.bin/wrangler kv namespace delete --binding RUNS --env production
```

Leave `USERS` KV in place — it still holds the monthly quota counters
(`quota:<userId>:<YYYY-MM>`).

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
./node_modules/.bin/wrangler deploy --env production
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
./node_modules/.bin/wrangler secret put JWT_SECRET            --env production

# Stripe SECRET key — must start with `sk_test_` (testing) or `sk_live_`
# (production). Do NOT paste the publishable key (`pk_test_...` /
# `pk_live_...`) — the Worker will get 401s from api.stripe.com on every
# call. Swap test→live in §6.
./node_modules/.bin/wrangler secret put STRIPE_SECRET_KEY     --env production

# Stripe webhook signing secret (whsec_...). You'll get this in §5.
# Set it AFTER you create the webhook endpoint.
./node_modules/.bin/wrangler secret put STRIPE_WEBHOOK_SECRET --env production

# Stripe Price ID for the monthly subscription plan (price_...).
# Create the product/price in §6.1 first if you don't have one yet.
./node_modules/.bin/wrangler secret put STRIPE_PRICE_ID       --env production
```

Verify each secret is set (values are not printed — only names):

```bash
./node_modules/.bin/wrangler secret list --env production
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

## Appendix A — secret/binding reference

For grep'ability, here is the exhaustive list the operator must
provision:

| Name                    | Type    | Where consumed                                    |
|-------------------------|---------|---------------------------------------------------|
| `JWT_SECRET`            | secret  | `worker/src/auth.js` — signs & verifies session JWTs |
| `STRIPE_SECRET_KEY`     | secret  | `worker/src/stripe.js` — Bearer auth on `api.stripe.com` (used by checkout AND `/api/billing/portal`) |
| `STRIPE_WEBHOOK_SECRET` | secret  | `worker/src/handlers/webhook.js` — HMAC verify   |
| `STRIPE_PRICE_ID`       | secret  | `worker/src/stripe.js` — `line_items[0][price]`  |
| `SITE_ORIGIN`           | var     | `worker/src/cors.js`, `handlers/checkout.js` — CORS allow + redirect targets |
| `COOKIE_NAME`           | var     | `worker/src/auth.js` — session cookie name (`algosize_session`) |
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
