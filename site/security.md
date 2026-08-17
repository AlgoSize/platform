---
layout: page
title: Security
description: What Algosize stores, what it never stores, how long it keeps it, who else processes it, and how to report a vulnerability.
permalink: /security/
---

**Last updated: 17 August 2026**

This page is written for the person who has to sign off on running us against
their code. It describes what the system actually does today. Where something
is planned but not yet running, it says so rather than describing the intended
end state in the present tense.

Report a vulnerability: **[security@algosize.com](mailto:security@algosize.com)**.

---

## 1. What we never store

- **Your source files.** Source submitted to the scanner is analysed in memory
  and discarded. What persists is the finding — rule, file path, line number,
  and severity — not the file it came from.
- **Lockfile contents from CI runs.** A CI run stores the *paths* of the
  lockfiles it scanned. The lockfile bytes themselves are parsed, queried, and
  dropped.
- **API key plaintext.** Keys are stored as a SHA-256 hash plus a 16-character
  display prefix. The full key exists exactly once, in the response that
  created it. We cannot recover it, show it again, or email it to you — only
  revoke it and issue a new one.
- **Passwords.** There are none. Sign-in is a single-use emailed link or Google
  OAuth.
- **Card numbers.** Payment details go to Stripe directly and never touch our
  infrastructure. We hold a Stripe customer ID, a price ID, a subscription
  status, and a renewal date.

## 2. What we do store

| Category | Fields |
|---|---|
| Account | Email address, organisation membership, role, active organisation |
| Billing | Stripe customer ID, price ID, subscription status, current period end, seats purchased |
| Run records | Analyzer, computed result, one-line headline, duration, timestamp, and the organisation and user it belongs to |
| Run inputs | Retained only when under 256 KB. Anything larger is replaced with an `_omitted` marker, which disables re-run for that record |
| API keys | SHA-256 hash, name, display prefix, creator, created / last-used / revoked timestamps |
| Monitors | Repository URL, branch, schedule, last run time, and the advisory IDs seen on the last run |

Monitors keep the previous run's advisory IDs for one reason: it is what lets
the alert email contain only what is *new*. Without it every scheduled email
would re-send the entire backlog.

## 3. Retention

| Data | Retention |
|---|---|
| Session tokens | 30 days, then expire |
| Sign-in links | 15 minutes, single use — deleted the moment they are redeemed |
| Organisation invites | 7 days, single use |
| Run history | Hidden from every read path after 90 days |
| Account and billing records | Kept for the life of the account, then as required for tax and accounting |

**One honest caveat on run history.** The 90-day cutoff is enforced at read
time — after 90 days a run is invisible to you, to your organisation, and to
our own support tooling. The rows are not yet physically deleted from the
database; the scheduled hard-delete job is written but not in service. Until it
is, treat 90 days as the point at which data becomes unreachable, not the point
at which it is destroyed. If you need a hard deletion before then, email
[privacy@algosize.com](mailto:privacy@algosize.com) and we will run it
manually and confirm.

## 4. What leaves our infrastructure during a scan

A dependency audit sends **package name, ecosystem, and version** to the OSV
advisory database. That is the whole outbound payload — your lockfile, your
repository name, and your source are not transmitted to OSV or to any other
advisory provider.

A secret scan makes no outbound requests at all. Detection is entirely local to
the worker.

## 5. Subprocessors

| Subprocessor | Purpose | What it receives |
|---|---|---|
| Cloudflare | Compute, database, object and key-value storage, queues | All service data |
| Stripe | Payments and subscription management | Email address, billing details you enter on Stripe's own form |
| Google (Workspace Gmail API) | Transactional email — sign-in links, invites, alerts | Recipient address and message body |
| OSV.dev | Vulnerability advisory data | Package name, ecosystem, version |
| Sentry | Error monitoring | Exception traces, request metadata. Optional; disabled when unconfigured |
| OpenAI | Refactor suggestions in the algorithm optimizer only | The function you submit to that specific tool. Never invoked by the dependency or secret scanners |
| Plausible | Marketing-site analytics | Page URL and referrer. Cookieless, no cross-site identifier, marketing pages only — never the dashboard |

The OpenAI row is worth reading twice if it matters to you: it is reachable
only from the algorithm optimizer, a tool that is not part of the auditing
product. Running dependency and secret audits never sends anything to a model
provider.

## 6. Access and authentication

- Sessions are HMAC-SHA-256 signed tokens in an `HttpOnly`, `Secure`,
  `SameSite=Lax` cookie, backed by a server-side record so a session can be
  revoked rather than merely expiring.
- API keys authenticate as the **organisation**, not as a person, so
  membership can change without breaking a pipeline. They are scoped to that
  organisation's data.
- An API key cannot manage API keys. Creating or revoking a key requires an
  interactive owner or admin session — otherwise a compromised key could
  re-arm itself after being revoked.
- The CI ingestion endpoint refuses cookie sessions and accepts bearer keys
  only. A cookie is reachable from any page you visit; a bearer token is not.
- Findings are computed server-side from the bytes you submit. A CI job cannot
  post its own verdict — submitting an empty finding list does not produce a
  clean report, because the report is not built from what was submitted.

## 7. Reporting a vulnerability

Email **[security@algosize.com](mailto:security@algosize.com)**. Please
include enough detail to reproduce: affected endpoint or page, request and
response, and what you expected instead.

- We acknowledge within **3 business days** and give you a substantive
  response, or a schedule for one, within **10 business days**.
- We will tell you when the issue is fixed, and credit you by name unless you
  prefer otherwise.
- We do not currently run a paid bounty.

**Safe harbour.** We will not pursue or support legal action against research
conducted in good faith under these terms: give us reasonable time to fix
before disclosing publicly, do not access, modify, or delete data belonging to
anyone else, do not degrade the service for other users, and stop at the point
where you have demonstrated the issue rather than proving how far it goes. If
you are unsure whether something is in scope, ask first.

## 8. Data protection requests

For access, export, correction, or deletion, email
[privacy@algosize.com](mailto:privacy@algosize.com). See the
[Privacy Policy]({{ '/privacy/' | relative_url }}) for the legal bases we rely
on and your rights under GDPR and comparable regimes.
