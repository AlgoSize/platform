---
layout: page
title: SSDF mapping
description: Every NIST SSDF v1.1 practice mapped to the Algosize document or scan artifact that evidences it.
permalink: /security/compliance/ssdf-mapping/
---

**Last updated: 3 September 2026** · Catalog version `2026-09-02.1`

Every practice in **NIST SSDF SP 800-218 v1.1** — all 41 — mapped to
the document or artifact that evidences it. Part of the
[Algosize compliance pack]({{ '/security/compliance/' | relative_url }}).

## How to read the Coverage column

This column is **not** a pass/fail. It says *how a control can be known*, which
is a different question from whether it holds:

| Value | Meaning |
|---|---|
| `automated` | A scan this platform runs produces an artifact bearing on the control. |
| `attested` | No scan can see it. A named person signs a claim, and the linked document is that claim. |
| `not covered` | Neither. The Notes column gives the reason in one sentence. |

`not covered` is a statement about the limits of code analysis, not a finding
against this organisation. The values here are generated from the product's own
control catalog and pinned by a test, so this table cannot drift from what the
product itself asserts.

## Practices

| Practice | Title | Coverage | Document(s) | Evidence type | Notes |
|---|---|---|---|---|---|
| **PO.1.1** | Identify and document security requirements for the development infrastructure | `not covered` | [PO-01]({{ '/security/compliance/po-01-security-requirements/' | relative_url }}) | Document only | Infrastructure requirements are an organizational document; nothing in a repository scan reads them. |
| **PO.1.2** | Identify and document security requirements for organization-developed software | `attested` | [PO-01]({{ '/security/compliance/po-01-security-requirements/' | relative_url }}) | Document | The document is the evidence; no scan can produce it. |
| **PO.1.3** | Communicate requirements to third parties who provide components | `not covered` | [PO-01]({{ '/security/compliance/po-01-security-requirements/' | relative_url }}) | Document only | Vendor communication leaves no artifact in code. |
| **PO.2.1** | Create new roles and alter responsibilities as needed | `not covered` | [PO-02]({{ '/security/compliance/po-02-roles-training/' | relative_url }}) | Document only | HR and role definitions are outside the codebase. |
| **PO.2.2** | Provide role-based training for all personnel with SDLC responsibilities | `attested` | [PO-02]({{ '/security/compliance/po-02-roles-training/' | relative_url }}) | Document | The document is the evidence; no scan can produce it. |
| **PO.2.3** | Obtain upper management commitment to secure development | `not covered` | [PO-02]({{ '/security/compliance/po-02-roles-training/' | relative_url }}) | Document only | Management commitment is not a code artifact. |
| **PO.3.1** | Specify which tools must or should be included in each toolchain | `not covered` | [PO-03]({{ '/security/compliance/po-03-toolchain/' | relative_url }}) | Document only | The toolchain policy itself is a document; only its output is visible here. |
| **PO.3.2** | Follow recommended security practices to deploy, operate and maintain tools | `not covered` | [PO-03]({{ '/security/compliance/po-03-toolchain/' | relative_url }}) | Document only | Tool operation happens outside the repository. |
| **PO.3.3** | Configure tools to generate artifacts of their support of secure development | `automated` | [PO-03]({{ '/security/compliance/po-03-toolchain/' | relative_url }}) | Scan artifact | Evidenced from stored scan runs. |
| **PO.4.1** | Define criteria for software security checks and track throughout the SDLC | `attested` | [PO-04]({{ '/security/compliance/po-04-security-criteria/' | relative_url }}) | Document | The document is the evidence; no scan can produce it. |
| **PO.4.2** | Implement processes and mechanisms to gather and safeguard the information supporting the criteria | `not covered` | [PO-04]({{ '/security/compliance/po-04-security-criteria/' | relative_url }}) | Document only | The process is organizational; the scanner sees its output, not the process. |
| **PO.5.1** | Separate and protect each environment involved in software development | `not covered` | [PO-05]({{ '/security/compliance/po-05-environments-endpoints/' | relative_url }}) | Document only | Environment separation is infrastructure the analyzer never touches. |
| **PO.5.2** | Secure and harden development endpoints | `not covered` | [PO-05]({{ '/security/compliance/po-05-environments-endpoints/' | relative_url }}) | Document only | Developer laptops are not in the repository. |
| **PS.1.1** | Store all forms of code based on the principle of least privilege | `attested` | [PS-01]({{ '/security/compliance/ps-01-code-access/' | relative_url }}) | Document | The document is the evidence; no scan can produce it. |
| **PS.2.1** | Make software integrity verification information available to acquirers | `not covered` | [PS-02]({{ '/security/compliance/ps-02-release-integrity/' | relative_url }}) | Document only | Signing and publication of checksums happen in release infrastructure, not in the scanned tree. |
| **PS.3.1** | Securely archive the files and supporting data for each software release | `not covered` | [PS-02]({{ '/security/compliance/ps-02-release-integrity/' | relative_url }}) | Document only | Release archives are outside the scan. |
| **PS.3.2** | Collect, safeguard, maintain and share provenance data for all components of each release | `automated` | [PS-02]({{ '/security/compliance/ps-02-release-integrity/' | relative_url }}) | Scan artifact | Evidenced from stored scan runs. |
| **PW.1.1** | Use forms of risk modeling — threat modeling, attack modeling — to assess risk | `not covered` | [PW-01]({{ '/security/compliance/pw-01-design-risk/' | relative_url }}) | Document only | Threat modelling is a design activity. No analyzer here performs or detects it. |
| **PW.1.2** | Track and maintain the software's security requirements, risks and design decisions | `automated` | [PW-01]({{ '/security/compliance/pw-01-design-risk/' | relative_url }}) | Scan artifact | Evidenced from stored scan runs. |
| **PW.1.3** | Build in support for standardized security features and services | `not covered` | [PW-01]({{ '/security/compliance/pw-01-design-risk/' | relative_url }}) | Document only | Whether a design chose standard features is a review judgment, not a scan output. |
| **PW.2.1** | Have one or more qualified people review the software design | `not covered` | [PW-02]({{ '/security/compliance/pw-02-design-review/' | relative_url }}) | Document only | Design review leaves no artifact the analyzer reads. |
| **PW.4.1** | Acquire and maintain well-secured software components from third parties | `automated` | [PO-01]({{ '/security/compliance/po-01-security-requirements/' | relative_url }}), [RV-02]({{ '/security/compliance/rv-02-vuln-response/' | relative_url }}) | Scan artifact | Evidenced from stored scan runs. |
| **PW.4.4** | Verify that acquired third-party components comply with requirements | `automated` | [PO-01]({{ '/security/compliance/po-01-security-requirements/' | relative_url }}), [RV-02]({{ '/security/compliance/rv-02-vuln-response/' | relative_url }}) | Scan artifact | Evidenced from stored scan runs. |
| **PW.5.1** | Follow all secure coding practices appropriate to the development languages | `automated` | [PW-07]({{ '/security/compliance/pw-07-code-review/' | relative_url }}) | Scan artifact | Evidenced from stored scan runs. |
| **PW.6.1** | Use build tools that offer features to improve executable security | `not covered` | [PW-06]({{ '/security/compliance/pw-06-build-security/' | relative_url }}) | Document only | Compiler and build flags are not read by the scanner. |
| **PW.6.2** | Determine which build features to use and how to configure them | `not covered` | [PW-06]({{ '/security/compliance/pw-06-build-security/' | relative_url }}) | Document only | Build configuration policy is outside scope. |
| **PW.7.1** | Determine whether code review and/or code analysis should be used | `attested` | [PW-07]({{ '/security/compliance/pw-07-code-review/' | relative_url }}) | Document | The document is the evidence; no scan can produce it. |
| **PW.7.2** | Perform code review and/or code analysis against secure coding standards | `automated` | [PW-07]({{ '/security/compliance/pw-07-code-review/' | relative_url }}) | Scan artifact | Evidenced from stored scan runs. |
| **PW.8.1** | Determine if executable code testing should be performed | `not covered` | [PW-08]({{ '/security/compliance/pw-08-test-strategy/' | relative_url }}) | Document only | Test strategy is a decision, not an artifact. |
| **PW.8.2** | Scope, design and perform executable code testing | `not covered` | [PW-08]({{ '/security/compliance/pw-08-test-strategy/' | relative_url }}) | Document only | Dynamic testing is not something this platform does. It reads code; it does not run it. |
| **PW.9.1** | Define a secure baseline for how to configure each software feature | `automated` | [PW-09]({{ '/security/compliance/pw-09-secure-defaults/' | relative_url }}) | Scan artifact | Evidenced from stored scan runs. |
| **PW.9.2** | Implement the default settings and document them for acquirers | `not covered` | [PW-09]({{ '/security/compliance/pw-09-secure-defaults/' | relative_url }}) | Document only | Documentation for acquirers is outside the tree. |
| **RV.1.1** | Gather information on potential vulnerabilities from public sources | `automated` | [RV-02]({{ '/security/compliance/rv-02-vuln-response/' | relative_url }}) | Scan artifact | Evidenced from stored scan runs. |
| **RV.1.2** | Review, analyze and test the code to identify previously undetected vulnerabilities | `automated` | [PW-07]({{ '/security/compliance/pw-07-code-review/' | relative_url }}), [RV-02]({{ '/security/compliance/rv-02-vuln-response/' | relative_url }}) | Scan artifact | Evidenced from stored scan runs. |
| **RV.1.3** | Have a policy that addresses vulnerability disclosure and remediation | `attested` | [RV-01]({{ '/security/compliance/rv-01-vuln-disclosure/' | relative_url }}) | Document | The document is the evidence; no scan can produce it. |
| **RV.2.1** | Analyze each vulnerability to gather sufficient information about risk | `automated` | [RV-02]({{ '/security/compliance/rv-02-vuln-response/' | relative_url }}) | Scan artifact | Evidenced from stored scan runs. |
| **RV.2.2** | Plan and implement risk responses for vulnerabilities | `not covered` | [RV-02]({{ '/security/compliance/rv-02-vuln-response/' | relative_url }}) | Document only | A response plan is a decision record. Whether fixes shipped is visible in PW.4.1; whether they were planned is not. |
| **RV.3.1** | Analyze identified vulnerabilities to determine their root causes | `not covered` | [RV-03]({{ '/security/compliance/rv-03-root-cause/' | relative_url }}) | Document only | Root-cause analysis is human work with no code artifact. |
| **RV.3.2** | Analyze root causes over time to identify patterns | `not covered` | [RV-03]({{ '/security/compliance/rv-03-root-cause/' | relative_url }}) | Document only | Pattern analysis across incidents happens outside the repository. |
| **RV.3.3** | Review the software for similar vulnerabilities to eliminate a class | `automated` | [RV-03]({{ '/security/compliance/rv-03-root-cause/' | relative_url }}) | Scan artifact | Evidenced from stored scan runs. |
| **RV.3.4** | Review the SDLC process and update it to prevent recurrence | `not covered` | [RV-03]({{ '/security/compliance/rv-03-root-cause/' | relative_url }}) | Document only | Process review is organizational. |

## Summary

| Coverage | Count |
|---|---|
| `automated` | 12 |
| `attested` | 6 |
| `not covered` | 23 |
| **Total** | **41** |

Counts, not a percentage. A percentage here would mostly measure how much of
SSDF is about code rather than anything about this organisation.
