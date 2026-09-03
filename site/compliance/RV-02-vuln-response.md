---
layout: page
title: RV-02 Vulnerability response
description: What Algosize does once a vulnerability is confirmed, from triage through deployment and verification.
permalink: /security/compliance/rv-02-vuln-response/
---

**Last updated: 3 September 2026**

Part of the [Algosize compliance pack]({{ '/security/compliance/' | relative_url }}). It describes what this organisation does today. Where something is planned but not running, it says so under **Roadmap** rather than describing the intended end state in the present tense.

---


## Purpose

Describe the response once a vulnerability is confirmed — who does what, in what
order.

## Scope

Vulnerabilities found by any route: an external report, our own scanning, a
dependency advisory, or an incident.

## Roles & responsibilities

The engineering lead runs the response. Reported issues follow
[RV-01]({{ '/security/compliance/rv-01-vuln-disclosure/' | relative_url }}) for
communication with the reporter.

## Process / controls

### Response by severity

| Severity | Response |
|---|---|
| **Critical** | Stop other work. Assess exposure — was it reached, and by whom, using the audit log. Fix, test, deploy. Revoke affected credentials. Notify affected customers, and regulators where personal data is involved. Root-cause afterwards. |
| **High** | Scheduled immediately into current work. Fix, test, deploy within the target. Sweep for the same class elsewhere. |
| **Medium** | Tracked and scheduled. Fixed with a regression test. |
| **Low** | Tracked. Fixed opportunistically. |

### Every fix, regardless of severity

1. **A test that fails without the fix.** Confirmed to fail against the unfixed
   code — a regression test that never went red is not evidence.
2. **A class sweep.** The same rule runs across the whole tree, not just the
   reported location. See
   [RV-03]({{ '/security/compliance/rv-03-root-cause/' | relative_url }}).
3. **Deployment through the normal gates.** A security fix does not bypass CI.
   A fix that fails the suite is not a fix.

### Where a dependency is the cause

The dependency audit reports the advisory, the affected package and version, and
where a fixed version exists. The response is an upgrade where one is available;
where none is, the decision — mitigate, replace, or accept — is recorded in the
pull request that takes it.

### Standing monitoring

A scheduled sweep re-checks watched repositories against the advisory database
and alerts on what is *new* rather than resending the whole backlog. The
dependency audit also runs weekly on a schedule, so a newly published advisory
against an unchanged dependency is caught without anyone opening a pull request.

## Evidence & artifacts

The commit and pull request carrying each fix and its test; the run record
showing the advisory count before and after; the audit log for credential
revocations.

## SSDF mapping

| Practice | How this document addresses it |
|---|---|
| **RV.2.1** Analyze each vulnerability to gather sufficient information about risk | Evidenced automatically: every advisory carries its CVSS score and vector where the source published one, which is what makes a risk decision reviewable rather than a matter of opinion. |
| **RV.2.2** Plan and implement risk responses | The response table. Our analyzer marks this not covered — whether fixes shipped is visible, whether they were *planned* is not — so this document is the evidence. |

## CRA mapping

**Annex I Part II(2)** — address and remediate vulnerabilities without delay —
is addressed by the target times in
[RV-01]({{ '/security/compliance/rv-01-vuln-disclosure/' | relative_url }}) and
the response table above.

## Roadmap

- **No incident response runbook** separate from this document, and no tested
  incident exercise.
- **No formal customer notification template or channel** for a security fix.
- **No defined regulatory notification path** beyond the personal-data breach
  commitment in the [Privacy Policy]({{ '/privacy/' | relative_url }}).
- **One responder.** There is no second person to escalate to, and no
  documented cover.

## Review & revision

Reviewed after each critical or high-severity response, and annually.
