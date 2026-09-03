---
layout: page
title: PW-01 Design, risk and security services
description: How Algosize records security requirements, risks and design decisions, and which standard security services it builds on.
permalink: /security/compliance/pw-01-design-risk/
---

**Last updated: 3 September 2026**

Part of the [Algosize compliance pack]({{ '/security/compliance/' | relative_url }}). It describes what this organisation does today. Where something is planned but not running, it says so under **Roadmap** rather than describing the intended end state in the present tense.

---


## Purpose

Record how risk is considered at design time, where those decisions are written
down, and which standard security services the product is built on rather than
reinventing.

## Scope

Any change that touches authentication, tenancy, billing, retention, or the
handling of customer code.

## Roles & responsibilities

The engineering lead performs and records the design consideration. See the
concentration risk in
[PO-02]({{ '/security/compliance/po-02-roles-training/' | relative_url }}).

## Process / controls

### Where design decisions live

Design decisions are recorded **in the code, at the place they bind**, as a
header comment stating what was considered and why the alternative was rejected.
This is a deliberate choice over a separate design register: a decision recorded
next to the code that implements it is read by the next person to touch that
code, and a register is not.

Representative examples a reader can go and check:

- Why the audit log survives organisation deletion — "a deletion path that
  erases its own evidence is not one anybody should trust."
- Why an API key sets an organisation but never a user — so that routes needing
  a human are unreachable with a key, as a property rather than a per-route
  check.
- Why an API key cannot manage API keys — otherwise a compromised key could
  re-arm itself after revocation.
- Why the CI ingestion endpoint refuses cookies and takes bearer tokens only — a
  cookie is reachable from any page you visit.
- Why audit-log pagination is on row id rather than timestamp — a timestamp
  cursor skips every row sharing the boundary second, which is the one failure
  an audit log cannot have.
- Why there are two secret detectors that are not unified — one recognises
  credential values by format, the other recognises key names, and merging them
  would lose one of the two.

### Threat-modelling record

For a security-relevant change, the pull request records: the asset at risk, the
trust boundary crossed, the threat considered, and the mitigation chosen or the
risk knowingly accepted.

### Standard security services used

The product does not implement its own primitives where a standard exists:

| Service | What is used |
|---|---|
| Session integrity | HMAC-SHA-256 via the platform's own crypto, with the algorithm pinned in the header check and a constant-time comparison |
| Authorisation delegation | OAuth 2.1 with PKCE for MCP clients, including refresh-token rotation and chain revocation |
| Federated sign-in | Google OAuth |
| Payments | Stripe, which receives card details directly — they never touch our infrastructure |
| Transport | TLS terminated at Cloudflare's edge |
| Vulnerability data | OSV.dev, the public advisory database |

## Evidence & artifacts

Code comments at the decision sites; pull-request discussion; the architecture
analyzer's component and dependency map for the system as built.

## SSDF mapping

| Practice | How this document addresses it |
|---|---|
| **PW.1.1** Use risk modeling to assess risk | The threat-modelling record above. Our own analyzer marks this not covered — "threat modelling is a design activity; no analyzer here performs or detects it" — so this document is the only evidence. |
| **PW.1.2** Track security requirements, risks and design decisions | The standing threat model at [PW-01a]({{ '/security/compliance/pw-01a-threat-model/' | relative_url }}), plus the in-code decision record. Attested rather than scanned: the product used to answer this from the architecture map and refuse to mark it met, because a dependency graph is not a threat model — and then told the reader to attest, which its own API forbade for an automated control. It is now attested, and the attestation points at a document. |
| **PW.1.3** Build in support for standardized security features and services | The standard-services table. |

## CRA mapping

Supports Annex I Part I — secure by design — by recording the design reasoning
behind the security properties claimed.

## Roadmap

- **The threat model has no independent reviewer.** [PW-01a]({{ '/security/compliance/pw-01a-threat-model/' | relative_url }})
  now exists — assets, trust boundaries, threats and the decisions taken — but
  it is written by the same person who wrote the system it describes.
- **Decisions in code comments are not indexed.** They are discoverable by
  reading the relevant file, not by searching a register.

## Review & revision

Reviewed annually, and after any security-relevant architectural change.
