---
layout: page
title: RV-03 Root cause and process improvement
description: How Algosize analyses the cause of a vulnerability, looks for the same class elsewhere, and changes its process in response.
permalink: /security/compliance/rv-03-root-cause/
---

**Last updated: 3 September 2026**

Part of the [Algosize compliance pack]({{ '/security/compliance/' | relative_url }}). It describes what this organisation does today. Where something is planned but not running, it says so under **Roadmap** rather than describing the intended end state in the present tense.

---


## Purpose

Describe how we get from a fixed defect to a changed process.

## Scope

Any confirmed vulnerability, and any defect that reached production and could
have been caught by an existing gate.

## Roles & responsibilities

The engineering lead writes the root-cause note. See
[PO-02]({{ '/security/compliance/po-02-roles-training/' | relative_url }}).

## Process / controls

### Root-cause note

For any critical or high-severity vulnerability, a short note recording:

| Field | Content |
|---|---|
| What | The defect, in one sentence |
| How it was found | Report, scan, incident, or review |
| Why it existed | The decision or omission that allowed it — not the line of code |
| Why it was not caught | Which gate should have caught it and did not |
| Fix | What changed, and the test that pins it |
| Class sweep | Where else the same shape was looked for, and what was found |
| Process change | What changes so this class does not recur, or an explicit "none needed" |

"Why it existed" asks for the decision, not the line. A note that says "missing
null check" has not found a root cause.

### Class sweep

The product's own rule engine runs every rule against every eligible file rather
than only where a finding was first reported, so a class of defect is swept
repository-wide by construction. That is how RV.3.3 is evidenced without a
manual step — but the *decision* about which class to sweep for is human, and
that is what the note records.

### Pattern analysis

Quarterly, we read back the root-cause notes and the standing gap list looking
for a repeated cause rather than a repeated symptom. The question is which gate
keeps not catching things, not which file keeps breaking.

### Process improvement log

A process change is recorded where it takes effect. When a gate threshold moves,
a new suite is added, or a rule changes severity, the reason is written at the
change — in the pull request and in the code — so the next person to consider
reverting it can see what it was for.

Two entries in that log from this codebase, as worked examples:

- A test-code severity cap was added to one source rule after measurement showed
  107 matches in test files against 2 real ones. The cap is recorded at the rule
  with that measurement, so it can be re-judged rather than inherited.
- The pull-request gate was widened after a change rewriting a queue entrypoint
  reported six green checks having run zero worker tests. The workflow header
  records why, so nobody narrows it back for speed.

## Evidence & artifacts

Root-cause notes; the pull request carrying each process change; the gate
configuration history.

## SSDF mapping

| Practice | How this document addresses it |
|---|---|
| **RV.3.1** Determine root causes | The root-cause note. Our analyzer marks this not covered — human work with no code artifact — so this document is the evidence. |
| **RV.3.2** Analyze root causes over time to identify patterns | The quarterly review. |
| **RV.3.3** Review the software for similar vulnerabilities to eliminate a class | Evidenced automatically by the repository-wide rule sweep. |
| **RV.3.4** Review the SDLC process and update it to prevent recurrence | The process improvement log. |

## CRA mapping

Supports Annex I Part II(2) and (3) by making remediation systematic rather than
per-incident.

## Roadmap

- **No root-cause notes exist yet**, because no critical or high-severity
  vulnerability has been reported against the platform. The template is defined;
  it is untested by use.
- **The quarterly pattern review has not yet run a full cycle.**
- **The improvement log is distributed rather than indexed** — entries live at
  the change, which makes them readable in context and hard to enumerate.

## Review & revision

Reviewed quarterly alongside the pattern analysis.
