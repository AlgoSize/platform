---
layout: page
title: PO-01 Security requirements
description: Security requirements for the development infrastructure, for the software Algosize builds, and what we communicate to component suppliers.
permalink: /security/compliance/po-01-security-requirements/
---

**Last updated: 3 September 2026**

Part of the [Algosize compliance pack]({{ '/security/compliance/' | relative_url }}). It describes what this organisation does today. Where something is planned but not running, it says so under **Roadmap** rather than describing the intended end state in the present tense.

---


## Purpose

State the security requirements that apply to (a) the infrastructure we develop
on, (b) the software we ship, and (c) the third parties whose components we
depend on.

## Scope

The Algosize platform: the Cloudflare Worker API, the Jekyll marketing site and
dashboard, the MCP server package, and the GitHub repository and Actions
workflows that build and deploy them.

## Roles & responsibilities

One engineering group owns all of it. There is no separate platform or security
team, so the same people write the code, run the deploys, and answer
vulnerability reports. See [PO-02]({{ '/security/compliance/po-02-roles-training/' | relative_url }}).

## Process / controls

### Development infrastructure

| Component | Requirement in force |
|---|---|
| GitHub repository | Changes reach `main` through pull requests. CI must pass before the deploy job runs. |
| GitHub Actions | Every workflow declares least-privilege `permissions:` explicitly rather than inheriting the default token scope. |
| Cloudflare Workers | Production and staging are separate Workers with separate bindings — see [PO-05]({{ '/security/compliance/po-05-environments-endpoints/' | relative_url }}). |
| Secrets | Reach the Worker only through `wrangler secret put`. No secret is declared in `wrangler.toml`, and `.dev.vars` is git-ignored. |
| Deployment | Runs from CI on push, never from a laptop. A binding check runs before `wrangler deploy`; a smoke test runs after. |

### Software we build

The product requirements that carry security weight are documented on the
[Security page]({{ '/security/' | relative_url }}) rather than repeated here.
In summary, and each is implemented rather than aspirational:

- **Tenant isolation.** The organisation is resolved from the credential, never
  from a request parameter. A caller cannot ask for another organisation's data
  by changing an id.
- **Credential separation.** An API key authenticates as the organisation and
  cannot reach any route that needs a human — billing, org management, account
  deletion. That is a property of the auth layer, not a route-by-route check.
- **Server-side verdicts.** Findings are computed from submitted bytes. A CI job
  cannot post its own clean result.
- **Redaction before storage.** Analyzer output passes a global redaction pass;
  MCP tool results are scrubbed of credential-shaped strings on the way out;
  error reports carry an allowlist of headers, never cookies or authorization.
- **Retention is bounded and stated.** Every retention period is a named
  constant in code, and the [Security page]({{ '/security/' | relative_url }})
  publishes the table.

### Third parties who provide components

Two distinct populations:

**Subprocessors** — services that receive customer data. The complete list, what
each receives, and why, is published in the
[Security page's subprocessor table]({{ '/security/' | relative_url }}). It is
maintained as a table rather than prose so that a customer can diff it.

**Software dependencies.** The deployed Worker has four runtime dependencies.
That number is a deliberate control: a small dependency surface is the cheapest
supply-chain mitigation available, and it is why the MCP package ships with zero
dependencies at all. Dependencies are audited on every pull request and weekly
by our own dependency analyzer, which fails the build on a high-severity
advisory.

## Evidence & artifacts

- Workflow definitions in `.github/workflows/` — reviewable in the repository.
- The dependency audit's pull-request comment and its SARIF upload to the GitHub
  Security tab.
- `wrangler.toml`, which shows the binding separation and declares that secrets
  are never stored in it.

## SSDF mapping

| Practice | How this document addresses it |
|---|---|
| **PO.1.1** Security requirements for development infrastructure | The infrastructure table above. |
| **PO.1.2** Security requirements for organization-developed software | The product requirements above, each linked to its implementation. This document is the attestation for this control. |
| **PO.1.3** Communicate requirements to third parties who provide components | The subprocessor table and the dependency-surface policy above. |

## CRA mapping

Supports Annex I Part I (secure-by-design properties) by recording what those
properties are for this product. Feeds the technical documentation expected
under Annex VII.

## Roadmap

- **No written vendor security review.** Subprocessors are chosen and listed, but
  there is no recurring review of their security posture on a defined cadence.
  We rely on each provider's own published certifications, which we do not
  independently verify.
- **No formal requirement-approval step.** Requirements are recorded in code
  comments and in these documents rather than signed off in a separate register.

## Review & revision

Reviewed when the subprocessor list changes, when a new binding or external
service is added, or annually — whichever comes first.
