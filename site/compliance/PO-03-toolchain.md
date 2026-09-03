---
layout: page
title: PO-03 Secure toolchain
description: Which tools are required in the Algosize development toolchain, and how those tools are themselves deployed and protected.
permalink: /security/compliance/po-03-toolchain/
---

**Last updated: 3 September 2026**

Part of the [Algosize compliance pack]({{ '/security/compliance/' | relative_url }}). It describes what this organisation does today. Where something is planned but not running, it says so under **Roadmap** rather than describing the intended end state in the present tense.

---


## Purpose

Specify the tools that must be in the toolchain, and how those tools are
operated securely.

## Scope

Everything between a developer's editor and a running production Worker.

## Roles & responsibilities

Toolchain changes — adding a workflow, changing a gate threshold — go through
the same pull-request review as any other change. See
[PW-07]({{ '/security/compliance/pw-07-code-review/' | relative_url }}).

## Process / controls

### Required tools

| Stage | Tool | Required outcome |
|---|---|---|
| Change control | GitHub pull requests | No direct commits to `main` in normal operation. |
| Unit and integration tests | `npm test` — a chain of roughly 76 suites | Must pass before the deploy job runs. |
| Browser end-to-end | Playwright | Runs on pull requests touching the site or worker. |
| Dependency advisories | Algosize dependency audit | **Fails the build on a high-severity advisory.** |
| Source code analysis | Algosize SAST, run over our own tree by `npm run selfscan` | **Blocks on a critical finding.** |
| Secret detection | Two in-house detectors — one recognises credential *values* by published format, one recognises key *names* that suggest a secret | Exercised as unit tests on every run of the suite. |
| Architecture | Algosize architecture analyzer | Reports on pull requests. Advisory, not blocking. |
| Complexity | Algosize algorithm optimizer | **Fails the build on a measured regression.** |
| Static export | SARIF upload to the GitHub Security tab | Findings are visible where GitHub surfaces them. |

Two of those rows deserve their honest qualifier. The architecture gate is
configured not to fail a build — it comments. And the self-scan blocks only on
*critical*; a high-severity source finding will not stop a merge on its own.

### Protecting the tools themselves

- **GitHub Actions.** Every workflow pins an explicit least-privilege
  `permissions:` block. Third-party actions are limited to first-party GitHub
  actions plus the CodeQL SARIF uploader.
- **Cloudflare.** Deploys use an API token held as a GitHub Actions secret, not
  a global key.
- **Secrets in CI.** Supplied as GitHub Actions secrets and referenced by name.
  A workflow whose credential is absent emits a notice and skips rather than
  failing confusingly or, worse, proceeding without the check.
- **npm publish.** The MCP package publishes only when a token is present and
  the version is not already on the registry.

## Evidence & artifacts

Workflow files in `.github/workflows/`; the gate comments on each pull request;
the SARIF entries in the repository's Security tab.

## SSDF mapping

| Practice | How this document addresses it |
|---|---|
| **PO.3.1** Specify which tools must be included in each toolchain | The required-tools table. |
| **PO.3.2** Deploy, operate and maintain tools securely | The protection section. |
| **PO.3.3** Configure tools to generate artifacts of their support of secure development | Evidenced automatically: our own compliance analyzer reads CI and scheduled runs for this control rather than taking a document's word for it. |

## CRA mapping

Annex I Part II(3) — regular tests and reviews of the security of the product —
is evidenced by the test and analysis gates above.

## Roadmap

- **No third-party secret scanner.** We run our own detectors, and no
  gitleaks/trufflehog/GitHub secret-scanning step. Two detectors written by the
  same team share the same blind spots.
- **No automated dependency updates.** No Dependabot, no Renovate, no
  `npm audit` step. Upgrades are manual and prompted by the audit gate firing.
- **No pinned transitive dependencies.** There is no `overrides` block, so a
  transitive dependency can move within its semver range between installs.
- **The architecture gate does not block.** It is configured to comment only.

## Review & revision

Reviewed when a workflow or a gate threshold changes.
