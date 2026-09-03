---
layout: page
title: RV-01 Vulnerability disclosure
description: Where to report a vulnerability in Algosize, and how reports are triaged and remediated.
permalink: /security/compliance/rv-01-vuln-disclosure/
---

**Last updated: 3 September 2026**

Part of the [Algosize compliance pack]({{ '/security/compliance/' | relative_url }}). It describes what this organisation does today. Where something is planned but not running, it says so under **Roadmap** rather than describing the intended end state in the present tense.

---


## Purpose

Point to the published disclosure policy and record the internal triage process
behind it.

## Scope

Vulnerabilities in the Algosize platform, the marketing site, or the published
MCP package.

---

## The policy itself lives on the Security page

**The canonical, customer-facing vulnerability disclosure policy is
[section 7 of the Security page]({{ '/security/#7-reporting-a-vulnerability' | relative_url }}).**
It is not restated here, deliberately: a second copy of a published SLA is a
second thing to forget to update, and the one that goes stale is always the copy
nobody links to.

In brief, and authoritative only there: report to
**[security@algosize.com](mailto:security@algosize.com)**; we acknowledge within
3 business days and give a substantive response or a schedule within 10;
safe harbour applies to good-faith research; there is no paid bounty.

This document covers what happens after a report arrives.

---

## Roles & responsibilities

The engineering lead receives, triages and fixes. There is no separate security
team and no rotation — see
[PO-02]({{ '/security/compliance/po-02-roles-training/' | relative_url }}).

## Process / controls

### Triage

On receipt: acknowledge, reproduce, classify, and tell the reporter what we
found. A report we cannot reproduce gets that answer rather than silence.

### Severity

| Severity | Definition |
|---|---|
| **Critical** | Cross-tenant data access, authentication bypass, remote code execution, or credential disclosure |
| **High** | Privilege escalation within a tenant, unauthenticated access to authenticated data, or a stored credential exposed to a party who should not hold it |
| **Medium** | Information disclosure with limited impact, a bypass of a non-security control, or a denial-of-service affecting one tenant |
| **Low** | Issues requiring improbable preconditions, or hardening opportunities with no demonstrated impact |

### Target remediation

| Severity | Fix deployed within |
|---|---|
| Critical | 72 hours of confirmation |
| High | 14 days |
| Medium | 60 days |
| Low | Next convenient release |

These are targets we hold ourselves to, not contractual commitments. Where one
will be missed we tell the reporter before it expires rather than after.

### Coordinated disclosure

We ask for reasonable time to fix before publication and will agree a date
rather than impose one. We credit reporters by name unless they prefer
otherwise.

## Evidence & artifacts

The reporting mailbox; the commit and pull request carrying each fix; the audit
log for any access change made in response.

## SSDF mapping

| Practice | How this document addresses it |
|---|---|
| **RV.1.3** Have a policy that addresses vulnerability disclosure and remediation | The published policy plus the triage and target tables here. Together these are the attestation for this control. |

## CRA mapping

| Expectation | Status |
|---|---|
| **Annex I Part II(5)** — a policy on coordinated vulnerability disclosure | Met: published, with SLAs and safe harbour. |
| **Annex I Part II(6)** — measures to facilitate sharing information about potential vulnerabilities | Partially: a monitored address with safe harbour exists. See Roadmap. |
| **Annex I Part II(4)** — publicly disclose information about fixed vulnerabilities | See Roadmap. |

## Roadmap

- **No published security advisories.** When we fix a vulnerability we tell the
  reporter; we do not publish an advisory, so a customer cannot see what was
  fixed and when. CRA Annex I Part II(4) expects that disclosure, and this is the
  clearest gap in this document.
- **No security.txt** at a well-known path.
- **No GitHub Security Advisories** or CVE issuance process.
- **No customer notification path for a security fix** short of a personal
  data breach, which is covered separately in the
  [Privacy Policy]({{ '/privacy/' | relative_url }}).
- **No bug bounty.**

## Review & revision

Reviewed after any report that exposes a gap in the process, and annually.
