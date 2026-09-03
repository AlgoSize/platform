---
layout: page
title: PO-05 Environments and endpoints
description: How Algosize separates production from staging, and what is expected of the machines developers work on.
permalink: /security/compliance/po-05-environments-endpoints/
---

**Last updated: 3 September 2026**

Part of the [Algosize compliance pack]({{ '/security/compliance/' | relative_url }}). It describes what this organisation does today. Where something is planned but not running, it says so under **Roadmap** rather than describing the intended end state in the present tense.

---


## Purpose

Describe how environments are separated and what protects the endpoints
developers work from.

## Scope

Cloudflare Workers environments, their data bindings, and developer machines.

## Roles & responsibilities

The engineering lead holds Cloudflare account access and is the only person who
can change bindings.

## Process / controls

### Environment separation

Separation is per-binding, not per-namespace-prefix. Production and staging are
distinct Workers with distinct resources at every layer:

| Binding | Production | Staging |
|---|---|---|
| Database | `algosize` | `algosize-staging` |
| Session and user KV | Distinct namespace ids | Distinct namespace ids |
| Report object storage | `algosize-reports` | `algosize-reports-staging` |
| Scan queue and dead-letter queue | `algosize-scans` | `algosize-scans-staging` |
| Sandbox service binding | `algosize-sandbox` | `algosize-sandbox-staging` |
| Route | `algosize.com/api/*` | `staging.algosize.com/api/*` |
| Outbound email sender | `noreply@` | `noreply-staging@` |

There is no shared datastore between them. A staging deploy cannot read or write
production data, because the binding it would need does not exist in its
environment.

Secrets are per-environment too: `wrangler secret put --env` writes to one
environment only, and nothing in the tracked configuration carries a secret
value.

**A binding check runs before every deploy** and refuses to proceed if a
required binding is missing or still holds a placeholder value. That check is
the reason a misconfigured environment fails loudly at deploy time rather than
quietly at request time.

### Developer endpoints

Local development runs against `wrangler dev` with a git-ignored `.dev.vars`
file. No production credential is required to run the test suite: the suite
builds its own in-memory database and stubs every external call, so the ordinary
development loop never touches production data.

## Evidence & artifacts

`wrangler.toml`, which shows the per-binding separation in reviewable form; the
binding check's output in the deploy job log.

## SSDF mapping

| Practice | How this document addresses it |
|---|---|
| **PO.5.1** Separate and protect each environment | The separation table. |
| **PO.5.2** Secure and harden development endpoints | The developer-endpoint section, and the Roadmap below, which is the more honest half. |

## CRA mapping

Supports Annex I Part I(2)(a) — placing the product on the market with no known
exploitable vulnerabilities — by ensuring pre-production testing cannot silently
run against production data.

## Roadmap

- **No enforced endpoint hardening policy.** There is no requirement, and no
  verification, that developer machines have full-disk encryption, screen lock,
  or managed antivirus. There is no MDM.
- **No multi-factor authentication requirement.** Neither on developer accounts
  for GitHub and Cloudflare, nor for customers signing in to Algosize — sign-in
  is a single-use emailed link or Google OAuth, so the second factor is whatever
  protects that mailbox. The product surfaces this honestly in its own account
  settings rather than showing a toggle that does nothing.
- **Staging is defined but not provisioned.** Its configuration is complete and
  its bindings are declared, but the underlying resources have not been created,
  so pre-production testing today happens locally rather than on a deployed
  staging environment.

## Review & revision

Reviewed when an environment or binding is added or removed.
