---
layout: page
title: CRA mapping
description: EU Cyber Resilience Act Annex I Part II obligations mapped to the Algosize document or scan artifact that evidences each one.
permalink: /security/compliance/cra-mapping/
---

**Last updated: 3 September 2026** · Catalog version `2026-09-02.1`

All 8 vulnerability-handling obligations of **EU Cyber Resilience Act,
Annex I, Part II**, mapped to the document or artifact that evidences each. Part
of the [Algosize compliance pack]({{ '/security/compliance/' | relative_url }}).

**This is a mapping, not a conformity claim.** Algosize is not a notified body
and has not undergone a conformity assessment. Framework names are referenced to
describe what each artifact corresponds to. Whether any of this satisfies an
obligation that applies to you is your assessor's judgement.

## Annex I, Part II — vulnerability handling

| Practice | Title | Coverage | Document(s) | Evidence type | Notes |
|---|---|---|---|---|---|
| **II.1** | Identify and document vulnerabilities and components, including a software bill of materials | `automated` | [PS-02]({{ '/security/compliance/ps-02-release-integrity/' | relative_url }}) | Scan artifact | Evidenced from stored scan runs. |
| **II.2** | Address and remediate vulnerabilities without delay, including by providing security updates | `automated` | [RV-02]({{ '/security/compliance/rv-02-vuln-response/' | relative_url }}) | Scan artifact | Evidenced from stored scan runs. |
| **II.3** | Apply effective and regular tests and reviews of the security of the product | `automated` | [PW-07]({{ '/security/compliance/pw-07-code-review/' | relative_url }}), [PW-08]({{ '/security/compliance/pw-08-test-strategy/' | relative_url }}) | Scan artifact | Evidenced from stored scan runs. |
| **II.4** | Once a security update is available, share and publicly disclose information about fixed vulnerabilities | `not covered` | [RV-01]({{ '/security/compliance/rv-01-vuln-disclosure/' | relative_url }}) | Document only | Publication happens on a website or advisory feed, not in the scanned tree. |
| **II.5** | Put in place and enforce a policy on coordinated vulnerability disclosure | `attested` | [RV-01]({{ '/security/compliance/rv-01-vuln-disclosure/' | relative_url }}) | Document | The document is the evidence; no scan can produce it. |
| **II.6** | Take measures to facilitate the sharing of information about potential vulnerabilities | `not covered` | [RV-01]({{ '/security/compliance/rv-01-vuln-disclosure/' | relative_url }}) | Document only | A contact channel is an organizational arrangement with no code artifact. |
| **II.7** | Provide for mechanisms to securely distribute updates to address vulnerabilities | `not covered` | [PS-02]({{ '/security/compliance/ps-02-release-integrity/' | relative_url }}) | Document only | Update distribution is release infrastructure the scanner does not reach. |
| **II.8** | Ensure that security patches or updates are disseminated without delay and free of charge | `not covered` | [PS-02]({{ '/security/compliance/ps-02-release-integrity/' | relative_url }}) | Document only | Dissemination timing and pricing are commercial facts, not code. |

## Annex I, Part I — security properties

Part I is addressed across the pack rather than control-by-control:

| Property | Where |
|---|---|
| No known exploitable vulnerabilities at release | [PO-04]({{ '/security/compliance/po-04-security-criteria/' | relative_url }}), [PW-06]({{ '/security/compliance/pw-06-build-security/' | relative_url }}) |
| Secure by default configuration | [PW-09]({{ '/security/compliance/pw-09-secure-defaults/' | relative_url }}) |
| Confidentiality and integrity of data | [Security page]({{ '/security/' | relative_url }}), [PO-01]({{ '/security/compliance/po-01-security-requirements/' | relative_url }}) |
| Minimising attack surface | [PO-01]({{ '/security/compliance/po-01-security-requirements/' | relative_url }}) — four runtime dependencies, zero in the MCP package |
| Recording and monitoring relevant activity | [PO-04]({{ '/security/compliance/po-04-security-criteria/' | relative_url }}) — the audit log |
| Secure data erasure | [PW-09]({{ '/security/compliance/pw-09-secure-defaults/' | relative_url }}), and the retention caveat on the [Security page]({{ '/security/' | relative_url }}) |

## The largest gaps against Part II

Stated here rather than left to be inferred from the table:

1. **No published advisories.** Fixed vulnerabilities are communicated to the
   reporter, not disclosed publicly — Part II(4).
2. **No SBOM for our own product.** The generator ships to customers; no
   workflow runs it against this repository — Part II(1).
3. **No separately distributed, verifiable update artifact.** Updates reach
   customers as a service deploy — Part II(7).

## Summary

| Coverage | Count |
|---|---|
| `automated` | 3 |
| `attested` | 1 |
| `not covered` | 4 |
| **Total** | **8** |
