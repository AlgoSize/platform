---
layout: page
title: PO-02 Roles, training and management commitment
description: Who owns security decisions at Algosize, what training is expected, and management's stated commitment to secure development.
permalink: /security/compliance/po-02-roles-training/
---

**Last updated: 3 September 2026**

Part of the [Algosize compliance pack]({{ '/security/compliance/' | relative_url }}). It describes what this organisation does today. Where something is planned but not running, it says so under **Roadmap** rather than describing the intended end state in the present tense.

---


## Purpose

Say who is accountable for each security responsibility, what training people
are expected to have, and record management's commitment to funding this work.

## Scope

Everyone with access to the repository, to Cloudflare, or to production data.

## Roles & responsibilities

Algosize is a very small engineering organisation. Rather than describe a
role structure we do not have, here is the actual allocation:

| Responsibility | Owner |
|---|---|
| Security policy and these documents | Engineering lead |
| Vulnerability triage and remediation | Engineering lead |
| Release approval | Engineering lead |
| Incident response | Engineering lead |
| Access grants and revocation (GitHub, Cloudflare, Stripe) | Engineering lead |

**This concentration is itself a risk, and we state it rather than obscure it
behind a RACI table.** One person holds every security responsibility. There is
no separation of duties, no second approver on a release, and no one to escalate
to if that person is unavailable. A customer weighing this should factor it in.

Some responsibilities are deliberately *not* gated on that person. Any member of
an organisation can add or pause a monitor, because gating monitoring behind an
approval would mean the engineer who actually watches the dependencies has to
ask someone else to add a repository. That is a recorded risk acceptance, not an
oversight.

## Process / controls

**Access.** Production access is Cloudflare account access plus the GitHub
repository. Both are individually named accounts; there are no shared logins.

**Onboarding.** New contributors read this pack, the
[Security page]({{ '/security/' | relative_url }}), and
[PW-07]({{ '/security/compliance/pw-07-code-review/' | relative_url }}) before
their first merged change.

## Evidence & artifacts

- The audit log records sign-ins, membership changes, key creation and
  revocation, and account deletion. It is append-only and survives organisation
  deletion by design, because a deletion path that erases its own evidence is
  not one anybody should trust.
- Sign-in history is self-service on the account page.

## SSDF mapping

| Practice | How this document addresses it |
|---|---|
| **PO.2.1** Create new roles and alter responsibilities | The allocation table, including the stated concentration risk. |
| **PO.2.2** Role-based training for personnel with SDLC responsibilities | The onboarding expectation above. This document is the attestation for this control, and it attests to a gap as much as to a control. |
| **PO.2.3** Upper management commitment to secure development | The statement below. |

## CRA mapping

Supports the organisational side of Annex I Part II by naming who handles a
vulnerability report and who approves the fix.

## Management commitment

Security work is funded as product work, not as overhead competing with it. In
practice that has meant: a dedicated secure-development analyzer suite built
before it had a paying customer, a security page that publishes our own gaps,
and a standing rule that no analyzer may report a clean result it did not
measure. We commit to keeping the gaps in this pack accurate even where an
accurate gap is commercially inconvenient.

## Roadmap

- **No formal security training programme.** There is no scheduled or
  role-based training, no completion tracking, and no external course
  requirement. Onboarding is reading this pack.
- **No separation of duties.** A second approver on production deploys is the
  single highest-value change available here, and it is blocked on the
  organisation having a second person with production access.
- **No documented on-call or escalation path** for the case where the
  engineering lead is unavailable.
- **No background checks or formal offboarding checklist.**

## Review & revision

Reviewed when anyone joins or leaves, and annually.
