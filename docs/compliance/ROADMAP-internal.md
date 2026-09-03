# Compliance roadmap — internal

**Not published.** The public pack at `site/compliance/` states every gap that
helps a customer make a decision. This file holds the remainder: findings whose
detail would assist an attacker more than it would inform a buyer.

The split is deliberate, and the public
[README](../../site/compliance/README.md) says the split exists and offers the
list under NDA. That is disclosure of the existence of the list, which is honest;
publishing exploitation detail about a live service is not the same thing as
honesty.

If you disagree with where an item sits, move it — the public pack is the
default and this file is the exception, not the other way round.

---

## Held back from publication

### Rate limiting is racy and fails open

The limiter is KV-backed and therefore non-atomic: concurrent requests read the
same counter and all write `count+1`, so a burst of N advances the counter by 1.
The limit binds against sequential traffic, not against a burst. If the KV
binding is absent the middleware fails open rather than closed.

The code says all of this at the implementation, including an explicit warning
not to cite the limiter and the quota system as compensating controls for each
other. Publishing the shape of the race would hand someone the exact technique.

**Fix:** move the counter to the Durable Object already bound for usage
counting, which gives atomic increment. Then it can be published.

### No CSRF token

The posture rests on `SameSite=Lax` cookies plus a single-origin CORS check.
That is a reasonable combination and it is not a token. State-changing
`POST` requests carry no per-session CSRF token.

**Fix:** either add a double-submit token, or move the session cookie to
`SameSite=Strict` and measure what breaks in the OAuth callback flows.

### Staging is defined but not provisioned

The configuration is complete and the bindings are declared, but the underlying
D1 and KV resources hold placeholder identifiers, so no staging environment
exists to deploy to. The pre-deploy binding check refuses a staging deploy for
exactly this reason.

Published as "staging is defined but not provisioned" in PO-05, which is the
useful half. The placeholder identifiers themselves stay here.

**Fix:** provision the resources, or delete the environment block. A configured
environment that cannot be deployed to is worse than no environment, because it
reads as one.

### The production verification script is not wired into CI

`scripts/verify-production.mjs` checks migrations applied per column, Stripe
portal and webhook configuration, and that protected routes actually reject
anonymous callers. It runs manually.

Published in PW-06 as a Roadmap line. What it probes stays here.

**Fix:** run it as a post-deploy job against production, non-blocking at first.

### `ADMIN_EMAILS` is a personal address

The production admin allowlist is a personal Gmail account. It gates roughly
fifteen cross-organisation admin routes, and it is in tracked configuration.

**Fix:** a role address on the company domain, with the personal address removed
from the allowlist. Until then, that mailbox is a production access control and
should be treated as one.

### Self-scan blocks on critical only

`npm run selfscan` exits non-zero only on `critical`. A high-severity source
finding does not block a merge.

Published in PW-07 as a Roadmap line, without the exit condition.

**Fix:** lower to `high` and fix the resulting backlog, or record why `critical`
is the right threshold.

---

## Ordered by value, if you only do a few

1. **Generate an SBOM for this repository in CI.** The generator already exists
   and ships to customers. This is the cheapest real CRA gap on the list, and
   the most embarrassing to leave open while selling the feature.
2. **Move rate limiting to the Durable Object.** Removes the only finding here
   that is both real and unpublishable.
3. **A role address for `ADMIN_EMAILS`.**
4. **A second person with production access.** Everything in PO-02 about
   separation of duties is blocked on this, and no process change substitutes.
5. **Publish security advisories for fixed vulnerabilities.** CRA Annex I
   Part II(4), and currently the clearest gap in RV-01.
