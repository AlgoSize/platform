---
layout: page
title: PW-06 Build and deployment configuration
description: How the Algosize Worker is built and deployed, and which configuration settings are required in production.
permalink: /security/compliance/pw-06-build-security/
---

**Last updated: 3 September 2026**

Part of the [Algosize compliance pack]({{ '/security/compliance/' | relative_url }}). It describes what this organisation does today. Where something is planned but not running, it says so under **Roadmap** rather than describing the intended end state in the present tense.

---


## Purpose

Record the build and deployment configuration that carries security weight.

## Scope

The Cloudflare Worker build and deploy path, and the configuration it runs with.

## Roles & responsibilities

Configuration changes go through pull-request review. The engineering lead holds
the Cloudflare credential.

## Process / controls

### The deploy path

Merge to `main` → tests run → if green, the deploy job runs a binding check,
deploys the sandbox Worker, deploys the main Worker, then smoke-tests a live
endpoint expecting an authentication response. A failure at any step fails the
job.

Two properties of that path matter:

- **The deploy job depends on the test job.** A red suite cannot deploy.
- **The binding check runs before `wrangler deploy`, not after.** A missing or
  placeholder binding stops the deploy rather than producing a Worker that
  starts and then fails at request time.

Deploys are immutable: Cloudflare keeps prior versions, and rollback is
redeploying a previous version rather than reverting and rebuilding.

### Required configuration

| Setting | Production value | Why |
|---|---|---|
| Session cookie | `HttpOnly`, `Secure`, `SameSite=Lax` | Not readable from script; not sent cross-site on navigation |
| CORS origin | Exactly one origin, the site's own | Not a wildcard, not a list |
| Credentialed CORS | Allowed only for that single origin | With `Vary: Origin` so a cache cannot cross responses |
| Session secret | 32 bytes minimum, enforced in code | A short secret throws at startup rather than signing weakly |
| JWT algorithm | Pinned in the header check | Rejects an algorithm-confusion token outright |
| Secrets | Set with `wrangler secret put` only | Never present in tracked configuration |
| Error reporting | Structured console output; external reporting only when explicitly configured | Absent configuration means no data leaves, rather than a silent default |

### What the build does not do

The Worker is deployed as source with no bundler-level transformation of our own
beyond what `wrangler` performs. There are no compiler hardening flags to set,
because there is no compilation step — the honest answer for this runtime rather
than a borrowed one from a C toolchain.

## Evidence & artifacts

`wrangler.toml` and the workflow definitions, both reviewable; the deploy job
log showing the binding check and smoke test.

## SSDF mapping

| Practice | How this document addresses it |
|---|---|
| **PW.6.1** Use build tools that offer features to improve executable security | Addressed honestly: this runtime has no compiler hardening step. The equivalent controls are the pre-deploy binding check and the test dependency. |
| **PW.6.2** Determine which build features to use and how to configure them | The required-configuration table. |

## CRA mapping

Supports Annex I Part I(2)(a) and (b) — no known exploitable vulnerabilities at
release, and secure-by-default configuration.

## Roadmap

- **No deployment approval gate.** The Worker deploy job has no GitHub
  environment protection rule, so a merge to `main` deploys to production
  without a second human confirmation.
- **No reproducible build attestation.** Nothing proves the deployed bundle
  corresponds to a specific commit beyond the workflow log.
- **The production verification script is not wired into CI.** A thorough
  post-deploy checker exists — migrations applied, billing configured, protected
  routes actually protected — and it is run manually rather than automatically.

## Review & revision

Reviewed when the deploy workflow or a production configuration value changes.
