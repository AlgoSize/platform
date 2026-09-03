---
layout: page
title: PW-02 Design review
description: When an Algosize change requires design review before implementation, and who performs it.
permalink: /security/compliance/pw-02-design-review/
---

**Last updated: 3 September 2026**

Part of the [Algosize compliance pack]({{ '/security/compliance/' | relative_url }}). It describes what this organisation does today. Where something is planned but not running, it says so under **Roadmap** rather than describing the intended end state in the present tense.

---


## Purpose

Say when a design must be reviewed before it is built, and by whom.

## Scope

Changes to authentication, authorisation, tenancy, billing, data retention, the
handling of submitted code, or any new external service.

## Roles & responsibilities

The engineering lead reviews. There is no second qualified reviewer — the
central limitation of this control, stated in
[PO-02]({{ '/security/compliance/po-02-roles-training/' | relative_url }}).

## Process / controls

### When review is required

| Trigger | Review required |
|---|---|
| New authentication or credential type | Yes |
| Change to how an organisation is resolved from a credential | Yes |
| New route reachable without a session | Yes |
| New external service receiving customer data | Yes — and the subprocessor table must be updated before release |
| Change to a retention period | Yes |
| New analyzer or a change to what a verdict means | Yes |
| Copy, styling, refactor with no behaviour change | No |

### What the review checks

1. Does the change let a caller reach data belonging to another organisation?
2. Does it create a path where a result can be reported without being measured?
3. Does it widen what a credential can do?
4. Does it store something the [Security page]({{ '/security/' | relative_url }})
   says we do not store?
5. Does it add an outbound destination for customer data?

Question 4 is why the security page is written as a set of specific claims:
several are pinned by tests, so a change that contradicts one fails the suite
rather than quietly making the page wrong.

### Record

The review is recorded in the pull request. An accepted risk is written down as
an accepted risk, naming what was accepted.

## Evidence & artifacts

Pull-request review history.

## SSDF mapping

| Practice | How this document addresses it |
|---|---|
| **PW.2.1** Have one or more qualified people review the software design | This document, plus the pull-request record. Our own analyzer marks it not covered — "design review leaves no artifact the analyzer reads." |

## CRA mapping

Annex I Part II(3) — regular reviews of the security of the product.

## Roadmap

- **One reviewer, who is also the author.** For most changes the person
  reviewing the design is the person who proposed it. This is a real weakness in
  the control and it cannot be fixed by process alone.
- **No external design review** or third-party architecture assessment has been
  performed.

## Review & revision

Reviewed annually.
