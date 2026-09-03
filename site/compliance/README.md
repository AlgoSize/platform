---
layout: page
title: Compliance pack
description: Algosize's secure-development documentation, mapped to NIST SSDF v1.1 and the EU Cyber Resilience Act.
permalink: /security/compliance/
---

**Last updated: 3 September 2026** · Control catalog version `2026-09-02.1`

This is Algosize's secure-development documentation: what we require, how we
build, and what we do when something is wrong. It is mapped to
**NIST SSDF v1.1** and to **Annex I Part II of the EU Cyber Resilience Act**.

It is a companion to the [Security page]({{ '/security/' | relative_url }}),
which covers what the *product* does with your data. This pack covers how the
product is *built*. Neither restates the other.

---

## Two things to know before reading

**This is not a certification.** Algosize holds no SOC 2 report, no ISO 27001
certificate, and has not undergone a CRA conformity assessment. Framework names
appear here to describe what a given artifact corresponds to, not to claim
accreditation. Whether any of it satisfies an obligation that applies to you is
your auditor's or assessor's judgement.

**Every document states its own gaps.** Each ends with a **Roadmap** section
naming what is not done. Those sections are not oversights left in by accident;
they are the point. A pack with no gaps in it, from an organisation this size,
would be a pack nobody should believe. If you are evaluating us, read the
Roadmap sections first — they are where the real information is.

---

## The documents

### Prepare the Organization

| Document | Covers |
|---|---|
| [PO-01 Security requirements]({{ '/security/compliance/po-01-security-requirements/' | relative_url }}) | What we require of our development infrastructure, of the software we ship, and of component suppliers |
| [PO-02 Roles, training and commitment]({{ '/security/compliance/po-02-roles-training/' | relative_url }}) | Who owns which security responsibility, and the concentration risk in that answer |
| [PO-03 Secure toolchain]({{ '/security/compliance/po-03-toolchain/' | relative_url }}) | Which tools must be in the chain, which gates block a merge, and which only comment |
| [PO-04 Security check criteria]({{ '/security/compliance/po-04-security-criteria/' | relative_url }}) | What must be true at each stage before a change advances, and where the evidence lives |
| [PO-05 Environments and endpoints]({{ '/security/compliance/po-05-environments-endpoints/' | relative_url }}) | Per-binding separation of production from staging, and what is expected of developer machines |

### Protect the Software

| Document | Covers |
|---|---|
| [PS-01 Code access]({{ '/security/compliance/ps-01-code-access/' | relative_url }}) | Who can read and write the source, and the path from a commit to production |
| [PS-02 Release integrity]({{ '/security/compliance/ps-02-release-integrity/' | relative_url }}) | How a release is identified, what can be verified, and what is archived |

### Produce Well-Secured Software

| Document | Covers |
|---|---|
| [PW-01 Design, risk and security services]({{ '/security/compliance/pw-01-design-risk/' | relative_url }}) | Where design decisions are recorded, and which standard security services we build on |
| [PW-02 Design review]({{ '/security/compliance/pw-02-design-review/' | relative_url }}) | When a design must be reviewed before it is built |
| [PW-06 Build and deployment]({{ '/security/compliance/pw-06-build-security/' | relative_url }}) | The deploy path and the production configuration that carries security weight |
| [PW-07 Code review and analysis]({{ '/security/compliance/pw-07-code-review/' | relative_url }}) | What runs on every change — and what that analysis does not see |
| [PW-08 Test strategy]({{ '/security/compliance/pw-08-test-strategy/' | relative_url }}) | What is tested at each layer, and the decision not to run dynamic security testing |
| [PW-09 Secure defaults]({{ '/security/compliance/pw-09-secure-defaults/' | relative_url }}) | The baseline the product ships with, and how each default is enforced |

### Respond to Vulnerabilities

| Document | Covers |
|---|---|
| [RV-01 Vulnerability disclosure]({{ '/security/compliance/rv-01-vuln-disclosure/' | relative_url }}) | Triage, severity and target remediation times behind the published policy |
| [RV-02 Vulnerability response]({{ '/security/compliance/rv-02-vuln-response/' | relative_url }}) | What happens once a vulnerability is confirmed |
| [RV-03 Root cause and improvement]({{ '/security/compliance/rv-03-root-cause/' | relative_url }}) | Getting from a fixed defect to a changed process |

### Mappings

| Document | Covers |
|---|---|
| [SSDF mapping]({{ '/security/compliance/ssdf-mapping/' | relative_url }}) | All 41 SSDF v1.1 practices → document or artifact |
| [CRA mapping]({{ '/security/compliance/cra-mapping/' | relative_url }}) | All 8 Annex I Part II obligations → document or artifact, plus the three largest gaps |

---

## How coverage is decided

Algosize builds a compliance analyzer, and the same control catalog that powers
it decides the Coverage column in both mapping tables. Three states:

| State | Meaning | Evidence |
|---|---|---|
| `automated` | A scan produces an artifact bearing on the control | The scan run |
| `attested` | No scan can see it; a named person signs a claim | The document in this pack **is** that claim |
| `not covered` | Neither, and the catalog says why in one sentence | The reason itself |

Those values are generated from the catalog and pinned by a test, so this pack
cannot claim coverage the product would not claim for a customer in the same
position. That symmetry is deliberate: we are the first user of our own tool,
and a pack that graded itself more generously than the product grades others
would not be worth reading.

---

## Reporting a vulnerability

**[security@algosize.com](mailto:security@algosize.com)** — see
[section 7 of the Security page]({{ '/security/#7-reporting-a-vulnerability' | relative_url }})
for SLAs and safe-harbour terms, and
[RV-01]({{ '/security/compliance/rv-01-vuln-disclosure/' | relative_url }}) for
what happens next.

Some known weaknesses are tracked internally rather than published, where
publishing the detail would help an attacker more than it would help you decide.
If you are evaluating Algosize and need that list, ask at the address above and
we will share it under NDA.

---

## When these artifacts are needed

Not every company needs a pack like this, and it is worth being clear about who
does.

### You probably need most of it

**Selling B2B SaaS to enterprises, in the US or EU.** Prospects send security
questionnaires and ask for SOC 2 or ISO 27001. Neither of those is a document
you can write yourself, but roughly two-thirds of a questionnaire asks how you
develop software securely — and that is exactly what an SSDF-mapped pack
answers. It also shortens the audit itself: an auditor who can read your
policies before the kickoff call spends the call on evidence rather than
orientation.

**Selling into a regulated sector.**

- *Fintech and payments* — PCI DSS, plus whatever the acquiring bank's risk team
  asks for, which is usually more.
- *Healthcare* — HIPAA in the US; FDA premarket cybersecurity for medical
  devices; EU MDR/IVDR.
- *Public sector and critical infrastructure* — FedRAMP, NIS2, sectoral rules.

These buyers generally will not accept "we're careful" as an answer. They expect
a named process for secure development, vulnerability handling, and change
control, and they expect it to have existed before they asked.

**Placing a product with digital elements on the EU market.** The CRA applies to
software and connected hardware sold into the EU, and it expects secure-by-design
and by-default properties, a vulnerability-handling process, a coordinated
disclosure policy, an SBOM, and technical documentation. Obligations phase in
through 2026–2027. A pack like this is a substantial part of that technical
documentation — and unlike a certification, nobody can produce it for you.

**Building AI-enabled products**, particularly for employment, credit, education
or public services. The EU AI Act expects risk management, logging, human
oversight and security testing for high-risk systems, and its technical-
documentation requirements overlap heavily with what is here.

**Handling sensitive data** — personal data under GDPR or equivalent, or health,
financial or children's data. The higher the impact of a failure, the more a
buyer expects the controls to be written down rather than merely intended.

### You can start much lighter

**A small B2C app with low-risk functionality**, no enterprise sales, and little
sensitive data does not need nineteen documents. Start with three things: a
security page that says what you store and for how long, a vulnerability
reporting address that someone actually reads, and a short note on how changes
get reviewed before they ship.

**Internal tools** are similar. Focus on secure defaults, a way to hear about
problems, and enough written down that the next person can pick it up.

### Either way

The cheapest time to write this is before someone asks for it. Written under
deadline for a specific deal, it comes out as marketing. Written beforehand, it
comes out as a description of how you actually work — and it is far more useful
to your own team, who can read it when deciding how to build the next thing.

---

## Review and revision

Each document states its own review cadence. The pack as a whole is reviewed
annually, and whenever the control catalog version changes.
