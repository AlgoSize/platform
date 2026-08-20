# Deploying account management

Everything in the account area works from the code once **one** thing has
happened: migration `0015` has been applied to the production D1 database.
Everything else on this page is optional and can be done later without
breaking anything.

The steps are split by whether they need Cloudflare console/API access, since
that is the access this session does not have.

---

## 1. Required — apply migration 0015

**Needs Cloudflare access.** Nothing else in this feature works until it is
done, and the failure is not subtle: `/api/account` returns 500 and the
settings page renders an error.

```bash
cd worker
npx wrangler d1 execute algosize \
  --file=migrations/0015_account_management.sql \
  --remote --config wrangler.toml
```

It is not idempotent — SQLite has no `ADD COLUMN IF NOT EXISTS`, so a second
run errors on the first `ALTER`. That is the intended behaviour; it means a
re-run tells you it already applied rather than half-applying again.

Verify from outside the Cloudflare account, with an admin session:

```
GET /api/admin/schema-check
```

`0015 account_management` should report `applied: true`. That endpoint checks
a column added by the migration's **first** statement and tables created by its
**last**, so a migration that died partway through reports as missing rather
than as applied.

### Replit prompt

> In the AlgoSize/platform Replit workspace, apply the new D1 migration to
> **production** and confirm it landed.
>
> 1. `cd worker`
> 2. Run:
>    `npx wrangler d1 execute algosize --file=migrations/0015_account_management.sql --remote --config wrangler.toml`
> 3. Paste the full output, including any error.
> 4. Then confirm the schema from the API rather than from the CLI — sign in as
>    an admin and `GET https://algosize.com/api/admin/schema-check`. Report the
>    entry whose `migration` is `0015`. I need `applied: true` and an empty
>    `missing` array for it.
> 5. If step 2 errors with "duplicate column name", the migration was already
>    applied — say so and go straight to step 4 rather than retrying.
>
> Do not run any other migration, and do not run this against staging unless I
> ask separately.

---

## 2. Recommended — check the Stripe webhook subscribes to `invoice.paid`

**Stripe dashboard, not Cloudflare.**

Referral credit is issued from the `invoice.paid` webhook, on the referred
organisation's first payment. The handler for that event already existed
before this change (it is what clears `past_due`), so if billing has ever
worked correctly the subscription is already there — but referrals silently
never pay out if it is not, and "silently" is the problem.

The endpoint must be subscribed to `invoice.paid` at
`https://algosize.com/api/stripe/webhook`.

`GET /api/admin/stripe-check` reports the webhook endpoint's configuration
without needing the dashboard.

---

## 3. Optional — a prettier referral link

Referral links are currently `algosize.com/api/r/<code>`. The `/api/*` prefix
is there because that is the only path the API Worker owns —
`algosize.com/*` belongs to the marketing site's Worker (`algosize-site`).

If you want `algosize.com/r/<code>`, add a route for `algosize.com/r/*` to the
**`algosize`** Worker. It is more specific than `algosize.com/*`, so
specificity wins and the marketing site is unaffected.

Then change one line — `REFERRAL_PATH` in `worker/src/referrals.js` — from
`/api/r/` to `/r/`. Links already shared keep working either way, because the
old route is not removed.

### Replit prompt

> In the Cloudflare dashboard for the algosize.com zone, add a Worker route
> `algosize.com/r/*` pointing at the **`algosize`** Worker (the API one, not
> `algosize-site`).
>
> Before you add it, list the existing routes on the zone and paste them, so we
> can both see that `algosize.com/api/*` → `algosize` and `algosize.com/*` →
> `algosize-site` are unchanged.
>
> After adding it, verify:
> - `curl -sI https://algosize.com/r/does-not-exist` should 302 to
>   `https://algosize.com/` (the API Worker's referral handler — an unknown
>   code still sends a stranger to the site rather than a 404).
> - `curl -sI https://algosize.com/` should still return the marketing site.
> - `curl -s https://algosize.com/api/me` should still return 401 JSON.
>
> Paste all three results. If the marketing site or `/api/me` changed
> behaviour at all, remove the route immediately and tell me.

---

## 4. Optional — make custom report domains actually serve

**Needs Cloudflare access, and this is the big one.**

Today the feature is complete and honest but half-live:

- A Firm customer enters `reports.theirfirm.com`.
- The Worker checks real DNS over DNS-over-HTTPS and reports `pending`,
  `verified` or `failed`, with the observed value on anything that is not
  verified.
- The API returns `servingReady: false`, and the UI says *"DNS is correct.
  Serving from this hostname is being provisioned — until it is live, shared
  links keep using algosize.com and nothing is interrupted."*

That last part is why this is safe to ship before the Cloudflare work: a
customer is never told a domain works when it does not, and shared links
never break in any state.

To finish it you need **Cloudflare for SaaS** (custom hostnames) on the
algosize.com zone:

1. A **fallback origin** on the zone, pointing at whatever should serve the
   custom hostnames.
2. A DNS record for `cname.algosize.com` — this is the target customers point
   their CNAME at. It must match `REPORT_CNAME_TARGET` in
   `worker/wrangler.toml` (currently `cname.algosize.com`).
3. A **custom hostname** created per customer domain, with DV certificate
   issuance, so Cloudflare will terminate TLS for a domain we do not own.
4. Set `CUSTOM_HOSTNAMES_ENABLED` as a var on the production Worker once the
   above is real. The Worker only reads it as a boolean — its presence flips
   `servingReady` to true, which is what stops the UI hedging.

Step 3 is per-customer and is the part that would eventually want automating
(a Cloudflare API token with `#zone:edit`, called from the verify handler).
That is deliberately **not** built: it would put a zone-scoped credential
inside the request path of a customer-controlled input, which is a much bigger
security decision than it looks and should be made on purpose rather than as a
side effect of shipping a settings page.

Note the pricing: Cloudflare for SaaS includes 100 custom hostnames, then
charges per hostname per month. Worth confirming before enabling.

### Replit prompt

> I want to scope the work to make Algosize custom report domains actually
> serve. **Do not change anything yet — this is a read-only investigation.**
>
> For the algosize.com zone in Cloudflare, report:
>
> 1. Is Cloudflare for SaaS (custom hostnames) enabled on this account? If not,
>    what plan/product does enabling it require, and what does it cost beyond
>    the included quota?
> 2. Is a **fallback origin** configured on the zone? If so, what is it?
> 3. Does a DNS record for `cname.algosize.com` exist? Paste it — type, value,
>    and whether it is proxied.
> 4. List any custom hostnames already registered on the zone.
> 5. List the current Worker routes on the zone.
>
> Then tell me what the minimum set of changes would be to serve one test
> hostname, and roughly what each step costs. Do not create anything.
>
> Context for accuracy: our Worker verifies the customer's CNAME itself over
> DNS-over-HTTPS and never talks to the Cloudflare API. It expects customers to
> point at `cname.algosize.com` (configurable via the `REPORT_CNAME_TARGET`
> var). The missing half is purely TLS termination and routing for hostnames we
> do not own.

---

## 5. Nothing needed for these

Listed because it is worth knowing they are *not* blockers:

- **No new secrets.** Account management adds no secret of any kind. The only
  new config values are `REPORT_CNAME_TARGET` (a plain var, already in
  `wrangler.toml` for all three environments) and the optional
  `CUSTOM_HOSTNAMES_ENABLED`.
- **No new KV namespace, D1 database, R2 bucket, queue or Durable Object.**
  Sessions reuse the existing `SESSIONS` KV and its per-user index, which was
  already built and until now had no user-facing caller at all.
- **No Stripe product or price changes.** Referral credit is pushed to the
  customer's Stripe *balance*, which Stripe applies to the next invoice
  automatically. No coupon, no promotion code, no new price object.
- **Avatar and logo uploads.** Both take an `https://` URL rather than a file
  upload, so no bucket and no public asset host is needed. If you later want
  real uploads, the existing `REPORTS` R2 binding can take a second prefix and
  be served through the Worker — but that is a separate change.

---

## 6. Rollback

The migration only adds columns and tables. Nothing reads them unless the new
code is deployed, and the new code degrades rather than failing when they are
absent:

- `readNotificationPrefs` falls back to the defaults on a read error, so a
  pre-0015 database sends *more* mail, never less. That direction is
  deliberate — the failure mode has to point at delivering the payment-failed
  notice, not at dropping it.
- `creditBalance` reports `complete: false`, which the UI renders as "could not
  be read" rather than "$0.00".
- `getOrCreateReferralCode` returns null, and the referrals section says so.

So rolling the *Worker* back to the previous version is sufficient and safe.
There is no need to reverse the migration, and no data is lost by leaving it
applied.
