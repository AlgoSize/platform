---
layout: page
title: PS-01 Code access
description: Who can read and write the Algosize source, and what protects the path from a commit to production.
permalink: /security/compliance/ps-01-code-access/
---

**Last updated: 3 September 2026**

Part of the [Algosize compliance pack]({{ '/security/compliance/' | relative_url }}). It describes what this organisation does today. Where something is planned but not running, it says so under **Roadmap** rather than describing the intended end state in the present tense.

---


## Purpose

Record how source code is stored and who can change it.

## Scope

The `AlgoSize/platform` repository and the npm package published from it.

## Roles & responsibilities

The engineering lead holds repository administration. Every contributor has an
individually named GitHub account; there are no shared credentials.

## Process / controls

- **Least privilege by default.** Repository access is granted per person, and
  write access only to people who ship changes.
- **Changes reach `main` through pull requests.** Every merge in the history is
  a pull-request merge.
- **CI must pass before deployment.** The deploy job depends on the test job, so
  a red suite cannot reach production even if a change is merged.
- **Workflow tokens are least-privilege.** Each workflow declares the narrowest
  `permissions:` it needs rather than inheriting the default.
- **Publishing is separately gated.** The npm package publishes only when a
  token is present and only for a version not already on the registry.

The customer-facing half of code access — how the *product* protects the code
you submit to it, what it stores and what it discards — is on the
[Security page]({{ '/security/' | relative_url }}) and is not repeated here.

## Evidence & artifacts

Repository membership and the commit history; workflow definitions; the audit
log for credential events on the product side.

## SSDF mapping

| Practice | How this document addresses it |
|---|---|
| **PS.1.1** Store all forms of code based on least privilege | This document is the attestation for this control. Our own analyzer marks it as needing one, because the absence of a committed secret says nothing about who can read the repository. |

## CRA mapping

Supports Annex I Part I(2) by protecting the integrity of the source from which
the product is built.

## Roadmap

- **Branch protection is not recorded as code.** Required reviews and required
  status checks are GitHub server-side settings. They are not in the repository,
  so this document cannot cite a reviewable artifact for them and an auditor
  cannot verify them from the source alone.
- **No `CODEOWNERS` file**, so no review is automatically routed to a
  designated owner.
- **No pull-request template**, so a security-relevant change is not prompted
  for a design note at the point it is opened.
- **No multi-factor authentication requirement** on the GitHub organisation.
- **No commit signing** requirement or verification.

## Review & revision

Reviewed when repository access changes, and annually.
