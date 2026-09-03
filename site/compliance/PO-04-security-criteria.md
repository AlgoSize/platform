---
layout: page
title: PO-04 Security check criteria
description: What must pass at each stage of the Algosize SDLC, and where the evidence for those checks is kept.
permalink: /security/compliance/po-04-security-criteria/
---

**Last updated: 3 September 2026**

Part of the [Algosize compliance pack]({{ '/security/compliance/' | relative_url }}). It describes what this organisation does today. Where something is planned but not running, it says so under **Roadmap** rather than describing the intended end state in the present tense.

---


## Purpose

Define the criteria a change must meet at each stage before it advances, and say
where the evidence supporting those criteria is kept.

## Scope

Every change to the Worker, the site, or the MCP package.

## Roles & responsibilities

The engineering lead approves exceptions. There is no separate approver — see
the concentration risk in
[PO-02]({{ '/security/compliance/po-02-roles-training/' | relative_url }}).

## Process / controls

### Criteria by stage

| Stage | Must be true to advance |
|---|---|
| Design | For a change touching authentication, tenancy, billing, or data retention: a written note of the risk considered and the decision taken. See [PW-01]({{ '/security/compliance/pw-01-design-risk/' | relative_url }}). |
| Code | Reviewed in a pull request. No new secret committed. No new critical source finding. |
| Test | The full suite passes. A change to behaviour ships with a test that fails without it. |
| Dependency | No new high-severity advisory against a shipped dependency. Enforced by a gate that fails the build. |
| Complexity | No measured regression on an audited function. Enforced by a gate that fails the build. |
| Release | Bindings verified present before deploy; a post-deploy smoke test confirms the Worker answers. |

### Exceptions

An exception is recorded in the pull request that takes it, in prose, naming
what was skipped and why. We do not maintain a separate exception register; for
an organisation this size a second system would go stale rather than get read.

### A standing rule that governs all of the above

**Nothing may report a clean result it did not measure.** A skipped analyzer
reads "not measured", never zero. A truncated scan reports its counts as a floor
rather than a total. This rule is enforced in code and pinned by tests, and it
is the reason our own compliance analyzer can only ever weaken a verdict, never
strengthen one.

## Evidence & artifacts

| Evidence | Where it lives | How long |
|---|---|---|
| Pull-request review and gate comments | GitHub | Life of the repository |
| Analyzer run records | Product database | Visible for 90 days |
| SARIF findings | GitHub Security tab | GitHub's retention |
| Audit log | Product database | Retained indefinitely, deliberately |
| Published evidence records | Product database | One year past the period they describe |

Access to the run records and audit log is restricted to the owning
organisation, and to Algosize administrators for support. Retention specifics
are published on the [Security page]({{ '/security/' | relative_url }}).

## SSDF mapping

| Practice | How this document addresses it |
|---|---|
| **PO.4.1** Define criteria for software security checks and track throughout the SDLC | The criteria table. This document is the attestation for this control. |
| **PO.4.2** Gather and safeguard information supporting the criteria | The evidence table. |

## CRA mapping

Annex I Part II(3): the criteria table is the definition of "regular tests and
reviews" for this product.

## Roadmap

- **Design-stage criteria are not enforced by tooling.** Nothing blocks a merge
  for a missing design note; it depends on review catching it.
- **Run evidence becomes unreadable at 90 days**, which is shorter than a
  typical audit period. Published evidence records exist to survive that, but
  they must be cut before the window closes.

## Review & revision

Reviewed when a gate threshold changes, and annually.
