---
layout: page
title: PW-07 Code review and analysis
description: When Algosize code is reviewed, what automated analysis runs against it, and what those tools do and do not see.
permalink: /security/compliance/pw-07-code-review/
---

**Last updated: 3 September 2026**

Part of the [Algosize compliance pack]({{ '/security/compliance/' | relative_url }}). It describes what this organisation does today. Where something is planned but not running, it says so under **Roadmap** rather than describing the intended end state in the present tense.

---


## Purpose

State when human review is required, what automated analysis runs, and — as
importantly — the limits of that analysis.

## Scope

Every change to the repository.

## Roles & responsibilities

The engineering lead reviews. See
[PW-02]({{ '/security/compliance/pw-02-design-review/' | relative_url }}) for the
single-reviewer limitation, which applies here too.

## Process / controls

### Human review

Every change reaches `main` through a pull request. A change touching
authentication, tenancy, billing or retention gets the design review in
[PW-02]({{ '/security/compliance/pw-02-design-review/' | relative_url }}) as
well.

### Automated analysis

Running on every pull request, against our own tree:

| Analysis | Blocks a merge? |
|---|---|
| Full test suite — roughly 76 suites | Yes |
| MCP purity guard — no analyzer, quota or database import may leak into an MCP tool | Yes |
| Source analysis over tracked files (`selfscan`) | **On critical findings only** |
| Dependency advisories against shipped dependencies | **Yes, on high severity** |
| Browser end-to-end | Yes |
| Architecture analysis | No — comments only |
| Complexity regression on audited functions | Yes |

### What the analysis does not see

This section exists because a code-analysis policy that lists only its coverage
is misleading. Our own compliance analyzer applies exactly this reasoning to
customers and it applies to us:

- Source analysis is **pattern and lightweight dataflow**, not whole-program
  taint analysis. Findings are evidence a rule matched, not proof of
  exploitability.
- Coverage is reported per scan as files scanned against files eligible. A
  truncated scan reports its counts as a **floor**, never a total.
- Findings in test code are severity-capped for one specific rule where
  measurement showed the noise swamped the signal — 107 matches against 2 real
  ones — and that cap is documented at the rule rather than applied silently.
  Credential findings are never capped.
- **There is no dynamic testing.** See
  [PW-08]({{ '/security/compliance/pw-08-test-strategy/' | relative_url }}).

## Evidence & artifacts

Pull-request review history; gate comments; SARIF findings in the GitHub
Security tab; the run record behind each comment, identified by analyzer build.

## SSDF mapping

| Practice | How this document addresses it |
|---|---|
| **PW.7.1** Determine whether code review and/or code analysis should be used | This document is the attestation for this control: both, on every change, with the thresholds above. |
| **PW.7.2** Perform code review and/or code analysis against secure coding standards | Evidenced automatically. Our analyzer qualifies its own verdict where a language got pattern matching rather than dataflow, and quotes the scan's own coverage gaps verbatim rather than paraphrasing them. |

## CRA mapping

Annex I Part II(3) — effective and regular tests and reviews of the security of
the product.

## Roadmap

- **Source analysis blocks on critical only.** A high-severity source finding
  does not stop a merge; only a critical one does.
- **One reviewer.** See
  [PO-02]({{ '/security/compliance/po-02-roles-training/' | relative_url }}).
- **No third-party static analysis.** We analyse our own code with our own
  analyzer, which shares its blind spots with itself. An independent tool would
  find a different set.

## Review & revision

Reviewed when a gate threshold changes.
