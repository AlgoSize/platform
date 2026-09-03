---
layout: page
title: PW-08 Test strategy
description: What Algosize tests, how, and the deliberate decision not to run dynamic security testing.
permalink: /security/compliance/pw-08-test-strategy/
---

**Last updated: 3 September 2026**

Part of the [Algosize compliance pack]({{ '/security/compliance/' | relative_url }}). It describes what this organisation does today. Where something is planned but not running, it says so under **Roadmap** rather than describing the intended end state in the present tense.

---


## Purpose

State what testing is performed, at what stage, and what is deliberately not
tested.

## Scope

All automated testing of the Worker, the site and the MCP package.

## Roles & responsibilities

A change to behaviour ships with a test. The reviewer checks that the test fails
without the change — a test that passes either way is not evidence.

## Process / controls

### Layers

| Layer | What it covers | When |
|---|---|---|
| Unit | Analyzer logic, auth primitives, quota, billing state, compliance resolution | Every run of the suite |
| Integration | HTTP handlers called directly against an in-memory database seeded from the real migration files | Every run of the suite |
| Frontend behaviour | Dashboard modules executed against a strict DOM shim, so rendering rules are asserted rather than grepped for | Every run of the suite |
| Browser end-to-end | Playwright against a locally served site and Worker | Pull requests touching the site or worker |
| Schema | Every migration checked table-by-table and column-by-column against a live deployment | Manually, post-deploy |

The integration layer applies the real migrations rather than a hand-written
fixture schema, so a migration that would break a handler in production breaks
the suite instead.

### Security-relevant tests

The suite includes dedicated suites for the secrets baseline, source analysis,
dependency analysis, authentication, quota enforcement, rate limiting,
entitlement, organisation scoping, and — for the legal pages — a suite that pins
published claims to the code that implements them, so a page cannot make a
promise the code stopped keeping.

### Negative testing as a first-class idea

Several suites assert what must **not** happen: that a control cannot report a
result it did not measure, that a not-covered control never renders as a
failure, that a redaction pass leaves no source snippet behind, that a
credential does not reach a route meant for a human. Where a regression test is
added for a defect, it is run against the unfixed code first to confirm it
actually fails — a test that never went red is not evidence.

## Evidence & artifacts

Suite output in CI logs; the Playwright report artifact on failure.

## SSDF mapping

| Practice | How this document addresses it |
|---|---|
| **PW.8.1** Determine if executable code testing should be performed | This document. The answer is yes for functional and negative testing, and no for dynamic security testing — see below. |
| **PW.8.2** Scope, design and perform executable code testing | The layers table, for functional testing. **Not met for dynamic security testing.** |

## CRA mapping

Annex I Part II(3). Partially satisfied: regular automated testing is real;
security-specific dynamic testing is not performed.

## Roadmap

- **No dynamic application security testing.** No DAST, no fuzzing, no
  authenticated scanner run against a deployed environment. Our own analyzer
  states the equivalent limitation to customers in plain terms — "it reads code;
  it does not run it" — and the same is true of how we test ourselves.
- **No penetration test.** No internal or third-party penetration test has been
  performed against the platform.
- **No load or abuse testing** against the rate limits and quotas.

## Review & revision

Reviewed annually, and whenever a new test layer is added.
