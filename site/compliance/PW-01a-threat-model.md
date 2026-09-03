---
layout: page
title: PW-01a Standing threat model
description: The assets Algosize holds, the trust boundaries around them, the threats considered against each, and the decisions taken — including the risks knowingly accepted.
permalink: /security/compliance/pw-01a-threat-model/
---

**Last updated: 3 September 2026**

Part of the [Algosize compliance pack]({{ '/security/compliance/' | relative_url }}). It describes what this organisation does today. Where something is planned but not running, it says so under **Roadmap** rather than describing the intended end state in the present tense.

---

This document exists because [PW-01]({{ '/security/compliance/pw-01-design-risk/' | relative_url }}) said it did not. Its Roadmap read: *"No standing threat model for the system as a whole. Decisions are recorded per change; there is no maintained document enumerating assets, trust boundaries and threats across the whole product."* That gap is what this closes.

It is deliberately not a catalogue of every conceivable attack. It is the list of things worth stealing, the lines they sit behind, and what was decided about each — including where the decision was to accept the risk rather than remove it.

## Assets

What an attacker would actually want, in the order we would mind losing it.

| Asset | Where it lives | Why it matters |
|---|---|---|
| **Customer source code** | In transit only. Submitted to a scan, held in memory, never written to a database. | The most sensitive thing customers hand us. A breach here is a breach of *their* product, not just ours. |
| **Scan findings** | `runs.result_json` in D1 | A list of a customer's unfixed vulnerabilities is a target package for attacking them. |
| **API keys** | `api_keys.key_hash` — SHA-256, never the plaintext | A key carries full organisation authority. |
| **Session material** | `JWT_SECRET` (Worker secret); sessions in KV | Forging a session is forging any user. |
| **Billing identifiers** | `organisations.stripe_customer_id`; card data never touches us | Held by Stripe. We store the pointer, not the instrument. |
| **The compliance record** | `compliance_audits`, frozen and immutable once published | A record that could be edited after the fact is not a record. |
| **Our GitHub read credential** | `GITHUB_TOKEN` (Worker secret), public-read only | Deliberately scoped so its loss costs a rate limit, not a repository. |

## Trust boundaries

Six, and every one of them is a place where a check either happens or the whole thing is theatre.

1. **Browser → Worker.** Session cookie, `SameSite=Lax`, single-origin CORS checked against `SITE_ORIGIN` with no wildcard.
2. **API client → Worker.** Bearer key, looked up by SHA-256 hash. The lookup establishes the organisation; nothing downstream trusts a client-supplied org id.
3. **Worker → D1.** Every tenant-scoped read carries the organisation id. The queries that do not are keyed on their own primary key or are deliberately cross-organisation admin routes, which is [why the scanner's tenant-scope rule is graded at medium confidence]({{ '/security/compliance/pw-07-code-review/' | relative_url }}) rather than treated as a finding of fact.
4. **Worker → customer code.** The scan boundary. Submitted content is scanned for credentials *before* parsing, and a document containing one is rejected rather than processed.
5. **Worker → the optimizer sandbox.** The only place in the product that evaluates code it did not write. See below.
6. **Worker → third parties.** GitHub (read, public), OSV (advisory lookup), Stripe (billing), Cloudflare Workers AI and model providers (the fix pipeline). Each is a place customer-derived data can leave.

## Threats considered, and what was decided

### T1 — Untrusted code executes in our runtime

**Where:** the algorithm optimizer compiles user-submitted code with `new Function` (`worker/src/analyzers/sandbox_runner.js`). Our own scanner reports this as a high-severity finding, and it is right to.

**Decision: accepted, with bounds, and recorded as an accepted risk in the product itself.** This is the feature — measuring how a function actually behaves requires running it. Four layers bound it: the source must declare a single top-level function; it is rewritten with AST timeout instrumentation before compilation; dangerous globals are shadowed to `undefined` inside the compiled scope; and the body runs inside an IIFE so its declarations cannot collide with the surrounding frame. Cloudflare's isolate provides no filesystem and no ambient network.

**Residual risk:** an isolate escape in V8 itself. We do not mitigate that and could not.

This is the first entry in the product's own accepted-risk register — named owner, written rationale, expiry — so the acceptance appears beside the finding rather than the finding disappearing.

### T2 — Cross-tenant data access

**Where:** every read of `runs`, `monitors`, `api_keys`, `arch_snapshots`, `compliance_*`.

**Decision: mitigated by construction.** Organisation scope is resolved once, from the credential, and passed into the query — never taken from the request. The queries that carry no tenant filter are of three kinds and each is deliberate: the authentication lookup itself (it *establishes* the tenant; scoping it would be circular), updates keyed on their own primary key, and admin routes that are cross-organisation on purpose.

**Residual risk:** a future query written without the filter. The scanner's `missing_tenant_scope` rule watches for exactly this and fires when a file's other queries scope a table and one does not.

### T3 — Customer source code is retained or leaked

**Decision: mitigated by not storing it.** Submitted code is scanned in memory. Findings carry a *masked* snippet, never live credential material, and finding fingerprints are computed from the masked form. The estimator and the compliance evidence path both strip snippet and evidence fields before anything is persisted or published.

**Residual risk:** a finding's file path and line number are stored, and a path can itself be mildly revealing. Accepted: without it a finding cannot be acted on.

### T4 — A credential leaks through an error message or a log

**Decision: mitigated at the boundary.** Documents containing detectable secrets are rejected *before* parsing, and the rejection deliberately does not echo the matched material. This is asserted by a test rather than left to review.

### T5 — Session or key compromise

**Decision: partially mitigated, and the gap is published.** Keys are stored hashed; JWTs are signed with a pinned algorithm and a minimum 32-byte secret; sessions can be listed and revoked.

**There is no multi-factor authentication.** Sign-in is a single-use emailed link or Google OAuth, so the second factor is whatever protects that mailbox. This is stated on [PW-09]({{ '/security/compliance/pw-09-secure-defaults/' | relative_url }}) and remains the largest open item in this model.

### T6 — Evidence is altered after publication

**Decision: mitigated by immutability.** A published compliance audit is frozen; a later change supersedes rather than rewrites, so a pack keeps saying what was true when it was cut. Attestations and accepted risks both expire, read-side, so neither can quietly outlive the claim it was signed for.

### T7 — A dependency or model provider is compromised

**Decision: partially mitigated.** Dependency advisories are checked on every sweep and on every pull request. The model providers in the fix pipeline receive code excerpts, which is disclosed.

**We do not generate an SBOM for our own repository** while selling that capability. That is the clearest gap in this section and is tracked as such.

### T8 — Denial of service or quota exhaustion

**Decision: partially mitigated, and the detail is held back.** Per-IP rate limiting exists on the public endpoints. Its implementation has a known weakness which is recorded in the internal roadmap rather than published, because the detail assists an attacker more than it informs a buyer. The existence of the gap is disclosed here; the mechanism is available under NDA.

## What this model does not cover

- **Physical and personnel security.** One person, one laptop; there is no office.
- **Availability targets.** No SLA is offered, so no availability threat is modelled against one.
- **Customer-side threats.** What a customer does with an exported report is outside this boundary.

## Review

Reviewed when a trust boundary changes, when an asset is added, and at each compliance attestation renewal — at most a year apart, because the attestation that points at this document expires.

## Roadmap

- **No multi-factor authentication.** The single largest item in T5, and it is not scheduled.
- **No independent review of this model.** It is written by the same person who wrote the system it describes, which is the same single-reviewer concentration recorded in PO-02.
- **T8's mitigation is weaker than it looks.** Held back from publication in detail; the fix is known and not yet made.
- **No SBOM for our own repository**, per T7.

## Review & revision

This document is versioned in the repository that implements the system it describes. Changes to either arrive in the same pull request.
