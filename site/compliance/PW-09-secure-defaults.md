---
layout: page
title: PW-09 Secure baseline and default configuration
description: The secure defaults Algosize ships with, and how each one is enforced rather than merely intended.
permalink: /security/compliance/pw-09-secure-defaults/
---

**Last updated: 3 September 2026**

Part of the [Algosize compliance pack]({{ '/security/compliance/' | relative_url }}). It describes what this organisation does today. Where something is planned but not running, it says so under **Roadmap** rather than describing the intended end state in the present tense.

---


## Purpose

Define the secure baseline the product ships with, and say how each default is
enforced.

## Scope

Default configuration of the deployed product and of the repository.

## Roles & responsibilities

The reviewer checks that a new feature ships closed rather than open.

## Process / controls

### The baseline

| Default | Enforced by |
|---|---|
| No secrets in tracked files | Two in-house detectors run over the tracked tree on every pull request; `.dev.vars` and `.env` are git-ignored |
| Secrets reach production only via `wrangler secret put` | No secret is declared in tracked configuration, and the file says so at the point someone would be tempted |
| Sharing is opt-in | A report is private until a share link is created, and a link carries a maximum lifetime of 90 days with a 7-day default |
| Sessions revocable | A server-side record backs every token, so revocation takes effect before expiry rather than waiting for it |
| API keys are hashed at rest | Only a SHA-256 hash and a display prefix are stored; the plaintext exists exactly once, in the response that created it |
| Credential material never logged | Analyzer output passes a global redaction pass; MCP results are scrubbed of credential-shaped strings on the way out; error reports carry an allowlist of headers and never cookies or authorization |
| Query strings excluded from error reports | The reporter records origin and path only |
| Telemetry minimised | Marketing analytics are cookieless and never run on the dashboard |
| Inputs are bounded | Every ingestion path has a byte cap, and an oversized submission is refused rather than truncated silently |
| MCP tool inputs are strict | Every tool schema sets `additionalProperties: false` |
| Absent configuration means off | An unconfigured error reporter sends nothing rather than falling back to a default destination |

### The governing principle

**A default that has to be chosen correctly is not a secure default.** Where the
safe behaviour could be expressed as the absence of configuration, it is: an
unset error-reporting endpoint sends nothing; an unshared report is private; an
unconfigured integration is skipped with a notice rather than half-enabled.

### Documentation for acquirers

The defaults a customer can observe or change are documented on the
[Security page]({{ '/security/' | relative_url }}) and in the product's own
account settings, which state the real posture rather than showing controls that
do nothing.

## Evidence & artifacts

The secrets baseline suite; the redaction tests; the share-expiry tests; the
Security page, whose claims are pinned by their own suite.

## SSDF mapping

| Practice | How this document addresses it |
|---|---|
| **PW.9.1** Define a secure baseline for configuring each software feature | The baseline table. Evidenced in part automatically — our analyzer reads the secrets scan for this control, and deliberately refuses to mark it met on a clean result, because finding no committed credential is not evidence that defaults are secure. |
| **PW.9.2** Implement default settings and document them for acquirers | The baseline table plus the Security page. |

## CRA mapping

Annex I Part I(2)(b) — secure-by-default configuration — is directly addressed
by the baseline table.

## Roadmap

- **No multi-factor authentication.** Sign-in is a single-use emailed link or
  Google OAuth, so the second factor is whatever protects that mailbox. The
  account page says exactly this rather than offering an inert toggle.
- **An API key carries full organisation authority.** Scopes exist for MCP
  OAuth tokens, which carry only what was consented to, but not for API keys.
- **Run records are hidden at 90 days, not deleted.** The read cutoff is
  enforced everywhere including our own support tooling, but the rows remain
  until a hard-delete job that is written and not yet in service. This is
  published on the [Security page]({{ '/security/' | relative_url }}) too,
  including how to request a manual deletion.
- **Report bodies in object storage are cleaned by a bucket lifecycle rule
  configured outside this repository**, so their erasure cannot be evidenced
  from the source alone.

## Review & revision

Reviewed when a new default is introduced or an existing one changes.
