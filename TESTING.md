# Algosize — End-to-End Smoke Test

A manual checklist a single person can walk in one sitting to confirm the full
landing → checkout → dashboard → analyzers → logout loop still works. This
file is the source of truth for "does the happy path work?" — keep it honest;
if you find a bug, fix the bug **and** update the relevant step.

Last walked: 2026-05-02 against `d2ade9e` (Task #8 merged) plus the dynamic
results in [Appendix A](#appendix-a--dynamic-probe-results).

---

## 0. Prerequisites

You need:

- **Ruby 3.2 + bundler** (Jekyll site).
- **Node 20 + npm** (Worker tooling — wrangler is already in
  `worker/node_modules`).
- A **Stripe test-mode account** with:
  - `sk_test_…` secret key,
  - a recurring price ID (`price_…`) attached to a product,
  - a webhook endpoint pointing at the local Worker (use the Stripe CLI:
    `stripe listen --forward-to http://localhost:8787/api/stripe/webhook`)
    which prints a `whsec_…` signing secret.
- A **modern browser** with DevTools open on the Network tab.

Set the Worker secrets (one-time, into `worker/.dev.vars`):

```
JWT_SECRET=<32+ random bytes, e.g. `openssl rand -hex 32`>
STRIPE_SECRET_KEY=sk_test_…
STRIPE_PRICE_ID=price_…
STRIPE_WEBHOOK_SECRET=whsec_…
SITE_ORIGIN=http://localhost:5000
COOKIE_NAME=algosize_session
```

> The committed `worker/.dev.vars` ships with **placeholders** so the Worker
> still boots; replace them with real test-mode values before walking
> steps 2–4.

Boot both services in two terminals:

```bash
# terminal 1 — site
cd site && bundle exec jekyll serve --host 0.0.0.0 --port 5000 --livereload

# terminal 2 — worker
cd worker && ./node_modules/.bin/wrangler dev --port 8787

# terminal 3 — Stripe webhook forwarder (only needed for steps 2–4)
stripe listen --forward-to http://localhost:8787/api/stripe/webhook
```

Before you start, run the unit tests once and confirm all seven suites pass:

```bash
cd worker && npm test
# expect: test-auth, test-stripe, test-cost, test-vuln, test-algo, test-logout, test-me — all green
```

---

## The Checklist

Tick each box as you go. **Every step must pass before this file is committed.**

### 1. Landing page renders

- [ ] Open <http://localhost:5000/>.
- [ ] Page loads with no console errors and no failed network requests.
- [ ] At least one pricing card is visible with a CTA button reading
      something like "Get started" / "Subscribe" inside a
      `<form action="/api/checkout" method="post">`.

**Where to look if it fails:** `site/index.html` (CTA form is around line 171).

---

### 2. CTA → Stripe Checkout

- [ ] Click the CTA button on a pricing card.
- [ ] In DevTools → Network you see a `POST` to `http://localhost:8787/api/checkout`
      from `Origin: http://localhost:5000`. The request is sent with
      `credentials: "omit"` (intentional — checkout-start is unauthenticated;
      see `site/assets/js/checkout.js`).
- [ ] The response is **HTTP 200** with JSON `{ "url": "https://checkout.stripe.com/c/pay/cs_test_…" }`.
- [ ] The browser is redirected to that Stripe Checkout URL (handled by
      `site/assets/js/checkout.js`, line 63: `window.location.assign(body.url)`).

**Failure modes already verified:**
- With the placeholder `sk_test_placeholder` key, `/api/checkout` returns
  **HTTP 502** with body `{"error":"checkout_failed","message":"internal error; reference = …"}`
  — that is the expected guard rail (see Appendix A, probe 03). You must
  swap in a real `sk_test_…` key before this step can pass.

---

### 3. Stripe test-card checkout

On the Stripe Checkout page:

- [ ] Email: any address you can read (you'll see it on `/dashboard`).
- [ ] Card number: `4242 4242 4242 4242`.
- [ ] Expiry: any future date, CVC: any 3 digits, ZIP: any 5 digits.
- [ ] Click **Subscribe**. Stripe processes the payment and triggers a
      `checkout.session.completed` webhook.
- [ ] In terminal 3 (Stripe CLI) you see the event forwarded with
      `[200 OK]` from the Worker.
- [ ] In the Worker dev log you see a `POST /api/stripe/webhook 200`
      followed by a `Set-Cookie: algosize_session=…` on the redirect-back
      response.

---

### 4. Lands on `/dashboard/` with valid session cookie

- [ ] Stripe redirects you to `http://localhost:5000/dashboard/?session_id=cs_test_…`.
- [ ] The dashboard page renders — header reads "Three analyzers, one workspace.",
      three panels visible (`#panel-cost`, `#panel-vuln`, `#panel-algo`),
      `Sign out` button (`#logout-btn`) in the header.
- [ ] DevTools → Application → Cookies for `localhost:8787` shows
      `algosize_session=eyJ…` with `HttpOnly`, `SameSite=Lax`, `Path=/`,
      `Max-Age=2592000` (30 days). The `Secure` flag is **dropped on
      `localhost`** by `worker/src/handlers/checkout.js` so http dev works;
      in production (Cloudflare → Workers domain) the same cookie is
      issued with `Secure`.
- [ ] No `401` requests in the Network tab. (The dashboard itself is a static
      page; the analyzer endpoints aren't called until you click "Run".)
- [ ] **Header is hydrated from `GET /api/me`, not hardcoded.** On page load
      the dashboard fires a `GET http://localhost:8787/api/me` (Network tab)
      that returns **HTTP 200** with JSON `{ "email": "<the email you typed
      into Stripe Checkout>", "subStatus": "active" }`. The header then shows
      that real email next to the "Subscription active" pill (green dot).
      Cross-check by re-running with a different test-mode email — the header
      must change to match. If you cancel the subscription in the Stripe
      dashboard, refresh `/dashboard/`: the same `/api/me` call returns
      `subStatus: "cancelled"` (or `"inactive"`) and the pill flips to
      "Subscription cancelled" with the inactive-dot colour.

---

### 5. Cost analyzer

- [ ] In the **Cloud cost analyzer** panel click **Load sample**, then
      **Run analysis →**.
- [ ] Network: `POST /api/analyze/cost` returns **HTTP 200** with a JSON body
      containing `currentSpend`, `totalSavingsPct`, and `suggestions[]`.
- [ ] The output area renders three stat cards (current spend, projected
      savings %, # of suggestions) followed by a list of suggestions.
- [ ] The "Top suggested savings" Chart.js bar chart appears below
      (loaded from CDN with SRI `sha384-…`).
- [ ] Suggestions include at least one **high-impact** item — the sample
      includes an under-utilized `EC2 batch jobs` workload (8% utilization)
      and an `Egress us-east → eu-west` line item, both of which the
      analyzer flags.

Equivalent curl (with a real session cookie pasted in):

```bash
curl -i -X POST http://localhost:8787/api/analyze/cost \
  -H "Content-Type: application/json" \
  -H "Origin: http://localhost:5000" \
  -H "Cookie: algosize_session=<paste from DevTools>" \
  -d '{"services":[{"name":"EC2 batch","monthlySpend":1500,"utilization":0.08,"category":"compute","reserved":false}]}'
```

---

### 6. Vulnerability scanner — planted findings

- [ ] In the **Vulnerability scanner** panel click **Load sample**
      (a snippet that hard-codes an AWS key + DB password and concatenates
      user input into a SQL query and into `eval`), then **Run scan →**.
- [ ] Network: `POST /api/analyze/vuln` returns **HTTP 200**.
- [ ] The output lists at least these findings:
  - `hardcoded-aws-key` (severity high) on the line containing `AKIAIOSFODNN7EXAMPLE`,
  - `hardcoded-secret` on the `dbPwd` line,
  - `sql-injection` on the `db.query("SELECT * FROM users WHERE id = '" + id + "'", …)` line,
  - `eval-use` on the `eval(code)` line.
- [ ] Each finding shows a severity tag, a line number, and a remediation hint.

---

### 7. Algorithm optimizer — planted O(n²)

- [ ] In the **Algorithm optimizer** panel click **Load sample**
      (a `findDuplicates` function with a nested `for` loop), then
      **Optimize →**.
- [ ] Network: `POST /api/analyze/algo` returns **HTTP 200**.
- [ ] The output diagnoses **time complexity O(n²)** and recommends an
      O(n) rewrite using a `Set` / hash map (look for the words
      "Set" or "hash" in the suggestion text).
- [ ] If the analyzer ships a "before / after" snippet, the "after" version
      uses a single loop and a `Set`-based seen tracker.

---

### 8. Logout

- [ ] Click the **Sign out** button in the dashboard header.
- [ ] Network: `POST /api/logout` returns **HTTP 200** with response header
      `Set-Cookie: algosize_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`
      (issued by `buildClearSessionCookie` in `worker/src/auth.js`; the
      clear cookie deliberately omits `Secure` so it works in both dev and
      prod).
- [ ] DevTools → Application → Cookies: the `algosize_session` cookie is
      gone for `localhost:8787`.
- [ ] The browser is redirected to `http://localhost:5000/` (landing page),
      handled in `site/assets/js/dashboard.js` line 378.

---

### 9. `/dashboard` is blocked without a session

- [ ] In the same browser tab, navigate to <http://localhost:5000/dashboard/>.
- [ ] The static dashboard HTML loads (Jekyll serves it as a static page),
      **but** as soon as you click any **Run analysis →** / **Run scan →** /
      **Optimize →** button the corresponding `POST /api/analyze/*` call
      returns **HTTP 401** `{"error":"unauthorized","reason":"missing_token"}`.
- [ ] The dashboard's fetch wrapper catches the 401 and immediately
      redirects you back to `/` (see `site/assets/js/dashboard.js` lines
      137–141: `window.location.assign("/")`).
- [ ] After the redirect, no analyzer output is rendered (the wrapper
      returns a never-resolving promise so the renderers never fire).

---

## Appendix A — dynamic probe results

The following was captured by `/tmp/wrangler-smoke/smoke.sh` against
`wrangler dev` running locally on `127.0.0.1:8787`. These are the parts of
the checklist that can be verified **without** real Stripe test-mode keys
(steps 1, parts of 2, and steps 5–9 minus the cookie-bearing happy path):

| #  | Probe                                            | HTTP | Notes                                                   |
|----|--------------------------------------------------|------|---------------------------------------------------------|
| 01 | `OPTIONS /api/analyze/cost` from `localhost:5000` | 204  | `Access-Control-Allow-Origin: http://localhost:5000` ✓  |
| 02 | `OPTIONS /api/analyze/cost` from `evil.example`  | 204  | **No** `Allow-Origin` echoed — browser will block ✓     |
| 03 | `POST /api/checkout` (placeholder Stripe keys)   | 502  | `{"error":"checkout_failed","message":"internal error; reference = …"}` — proves the Stripe error path is wired |
| 04 | `POST /api/analyze/cost` no cookie               | 401  | `{"error":"unauthorized","reason":"missing_token"}`     |
| 05 | `POST /api/analyze/vuln` no cookie               | 401  | same                                                     |
| 06 | `POST /api/analyze/algo` no cookie               | 401  | same                                                     |
| 07 | `POST /api/logout` no cookie                     | 401  | same                                                     |
| 08 | `GET /api/does-not-exist`                        | 404  | `{"error":"not_found","path":"/api/does-not-exist"}`    |
| 09 | `GET /api/me` no cookie                          | 401  | `{"error":"unauthorized","reason":"missing_token"}` (Task #11 dashboard hydration; happy path requires a real session cookie and is covered by step 4) |

Re-run the script anytime:

```bash
bash /tmp/wrangler-smoke/smoke.sh
cat /tmp/wrangler-smoke/results.txt
```

(The script itself is throwaway tooling — it lives under `/tmp/` on
purpose. Recreate it from this file if you need it.)

---

## What this file deliberately doesn't cover

- **Automated browser tests** (Playwright/Cypress) — explicitly out of
  scope per Task #9.
- **Load / performance** — out of scope.
- **Production walk-through** — covered by `DEPLOY.md` (Task #10).
- **Stripe webhook signature edge cases** — covered by `worker/scripts/test-stripe.mjs`.
