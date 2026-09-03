---
layout: page
title: PS-02 Release integrity and archiving
description: How an Algosize release is identified, what is archived with it, and what an acquirer can verify.
permalink: /security/compliance/ps-02-release-integrity/
---

**Last updated: 3 September 2026**

Part of the [Algosize compliance pack]({{ '/security/compliance/' | relative_url }}). It describes what this organisation does today. Where something is planned but not running, it says so under **Roadmap** rather than describing the intended end state in the present tense.

---


## Purpose

Say how a release is identified, what integrity information exists for it, and
what is archived.

## Scope

The Cloudflare Worker (the product), the marketing site, and the published MCP
npm package.

## Roles & responsibilities

Releases are deployed by CI on merge to `main`. No human step sits between a
merge and a production deploy other than the gates themselves.

## Process / controls

### Release identity

The Worker is a continuously deployed service, not a versioned download. Its
release identity is the **Cloudflare deployment version** — an id assigned at
deploy time and bound into the running Worker, so the code can report which
build answered a request.

That identity is surfaced rather than hidden: every dependency-audit comment on
a pull request carries the analyzer build that produced it. A customer reading a
finding can tell which build measured it, which is what makes a finding
reproducible.

When no version metadata is available the code reports the literal string
`unreleased` rather than guessing or omitting the field.

### What an acquirer can verify

- **Published evidence records carry a SHA-256** over their canonical form,
  shown in the product UI, so a recipient can verify the file they were sent is
  the file that was published.
- **The MCP npm package** is published through npm and carries npm's own
  integrity hash and provenance for the tarball.

### Archiving

A published compliance evidence record freezes, per control, the control's
wording as of a stated catalog version, the verdict, the numbers asserted, and
the source scan identifier. It is retained for **one year past the period it
describes** — deliberately longer than the 90 days for which the underlying scan
evidence stays readable, because that is the whole point of freezing it.

## Evidence & artifacts

The deployment version reported in analyzer output; the SHA-256 on each
published evidence record; the npm registry entry for the MCP package.

## SSDF mapping

| Practice | How this document addresses it |
|---|---|
| **PS.2.1** Make software integrity verification information available to acquirers | Partially. Evidence-record hashes and npm integrity exist; there is no signed release artifact for the service itself — see Roadmap. |
| **PS.3.1** Securely archive files and supporting data for each release | Partially. Evidence records are archived; a full per-release archive is not — see Roadmap. |
| **PS.3.2** Collect and share provenance data for all components of each release | The product generates a CycloneDX 1.5 bill of materials with package URLs on demand from any dependency audit. |

## CRA mapping

| Expectation | Status |
|---|---|
| Annex I Part II(1) — identify and document components, including an SBOM | The generator exists and is exercised for customers. See Roadmap for our own repository. |
| Annex I Part II(7) — securely distribute updates | Updates reach customers as a Cloudflare deploy over TLS. There is no separately distributed artifact for a customer to verify. |

## Roadmap

- **We do not generate an SBOM for our own repository.** The CycloneDX generator
  ships as a product feature and no workflow runs it against this codebase. This
  is the single cheapest CRA gap on the list to close, and stating it while
  selling the generator to others would be indefensible.
- **No signed releases.** No git tags, no changelog, no sigstore or equivalent
  signing of a release artifact.
- **No per-release archive.** Source at a given deploy is recoverable from git
  history, but there is no assembled archive pairing a release with its SBOM,
  scan reports, and configuration.

## Review & revision

Reviewed when the release or deployment process changes.
