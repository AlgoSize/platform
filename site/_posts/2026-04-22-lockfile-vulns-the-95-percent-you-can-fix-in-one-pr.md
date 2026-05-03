---
title: "Lockfile vulns: the 95% you can fix in one PR"
date: 2026-04-22 08:30:00 -0400
description: "Most CVEs in your npm or pnpm audit are patch-version bumps with no breaking changes. Here's how to clear the backlog in a single, safe pull request — and why the remaining 5% deserves a different process entirely."
author: Algosize Engineering
tags: [security, vuln-scanning, ci]
image: /assets/img/blog/lockfile-vulns.svg
primary_keyword: "lockfile vulnerabilities"
---

Open `npm audit` on any non-trivial Node project and you will see a wall of red. Forty-six high-severity, twelve critical, three hundred moderate. The nightly CI job flags them. The security dashboard at your shop counts them. Three sprints later the count has gone up, not down, because the team that's "supposed to" fix them is the same team trying to ship features.

Here's the thing nobody says out loud: **the overwhelming majority of those CVEs are patch-version bumps with no breaking changes**. The reason your audit count is still climbing isn't that the fixes are hard. It's that the workflow for applying them is. People pattern-match on "security work = scary, careful, slow" and so each individual bump becomes a careful, slow, scary three-day investigation.

We've watched dozens of teams clear their lockfile vulnerability backlog in a single afternoon. The trick is to stop doing it one CVE at a time, and to be honest about which fixes deserve scrutiny and which deserve a rubber stamp.

## The 95/4/1 split

Run `npm audit --json` (or the pnpm/yarn equivalent) on any production codebase that's been around for more than a year. Pipe the output through `jq` and group findings by the *type* of fix the audit recommends. Almost every codebase we've checked lands in the same shape:

- **~95% are patch bumps.** Same major, same minor, fixed patch. `4.17.15` → `4.17.21`. No API changes by definition (under semver), and the fix is usually a one-line escape, parser tightening, or DoS guard.
- **~4% are minor bumps.** New API surface available, old API still works, behaviour preserved. Slightly more risk because library authors occasionally interpret "minor" loosely.
- **~1% are major bumps.** Breaking API changes, possibly deprecations, possibly a rewrite. These are real engineering work.

The reason the audit feels endless is that teams treat all three buckets identically — every CVE gets the same triage meeting, the same hand-wringing, the same Slack thread. The 1% that needs the meeting is buried under the 95% that doesn't, and so the meeting never gets the depth it actually deserves.

The fix is to *separate* the buckets, then apply different processes to each.

## The bump-everything PR

The 95% bucket — patch-only, in-range, semver-safe — gets one PR, every two weeks, that bumps every patch. You do not read the changelog of every library. You do not write a test plan for each CVE. You read the diff *of the fix's commit list*, run the existing test suite, and merge.

The mechanics in npm:

```bash
git checkout -b chore/lockfile-bumps-$(date +%Y-%m-%d)
npm update           # applies patch+minor bumps respecting your semver ranges
npm audit fix         # adds explicit overrides for transitive CVEs
npm test
git add package.json package-lock.json
git commit -m "chore(deps): scheduled patch bumps + audit fixes"
```

That's the whole PR. It will move dozens to hundreds of versions in a single sweep. The tests either pass or they don't. If they pass, you ship it.

The objection at this point is always the same: *"What if a patch bump silently breaks something the tests don't catch?"* And yes, occasionally a library author misunderstands semver and ships a behavioural change in a patch release. We have seen it. It happens roughly once every two-to-three years per codebase. The risk is real but it is *small*, and it is dramatically smaller than the risk of running known-vulnerable versions in production for nine more months because the team is paralysed by the size of the audit list.

You also recover from the bad-patch case in fifteen minutes — `npm install lodash@4.17.20` (the previous version), commit, deploy, file an issue with the upstream. Compare to the cost of every team running CVE bingo for the next quarter and the trade is obvious.

## The fixture/snapshot trap

There's exactly one common failure mode for the bump-everything PR, and it's worth calling out so you can pre-empt it: **fixture and snapshot tests built against pinned upstream behaviour**.

Examples:

- A snapshot of an HTTP request body, where the underlying library bumped its default `User-Agent` between patch versions and now the snapshot diff is one line of metadata.
- A test that asserts an exact stack trace string and the library's error formatter changed.
- A regex against an exported JSON config that gained a new optional field.

These show up as test failures in your bump PR. They are *not* real regressions. They're test-suite tech debt the bump merely surfaced. Resist the urge to revert the bump; instead, loosen the assertion to focus on the behaviour that actually matters and re-record the snapshot. (If you do need to assert exact bytes — for, say, a deterministic build artifact — pin the specific dependency in `package.json` with `"library": "1.2.3"` and add a comment explaining why.)

## CI: lockfile drift, not just audit

The bump-PR workflow only works if your CI catches *new* vulnerabilities the next time the schedule runs. The way most teams set this up is `npm audit --audit-level=high` in CI, which fails the build the moment a new high-severity CVE drops.

This sounds great until you realise that *new high-severity CVEs drop on dependencies you don't directly control all the time*. A perfectly stable PR can suddenly fail CI because a transitive dependency four levels down published a patch with a CVE the day before. Now your "always-green main" branch goes red until somebody runs the bump PR.

Better: split the check into two jobs.

1. **Block-on-new** — fail the PR build only if *this PR* introduces a new vulnerability versus `main`. This catches developers adding a new dep with a known issue.
2. **Notify-on-existing** — run nightly against `main`, post the diff to a Slack channel the security team owns. New CVEs get triaged, not enforced — they go onto the backlog the next bump PR will sweep.

This separates "this PR is making things worse" (a hard block, deserves attention) from "the world changed under us" (a notification, batched for the next sweep).

In practice it means the developer who's trying to ship a feature stops getting paged for vulnerabilities they didn't introduce, and the security backlog stops being shaped by whoever happened to push commits last Tuesday.

## The 4% bucket: minor bumps

Minor bumps go into a separate PR per library, queued and reviewed sequentially. Same scheduled cadence (every two weeks works well), same person doing the queuing, but each one gets its own PR so the changelog can be read and the smoke-test plan can be written. We have a Slack template:

> **Minor bump:** `axios 0.21.0 → 0.27.2`
> **Changelog:** [link]
> **Surface area used in this codebase:** 4 files, all in `src/api/`. Calls `axios.get`, `axios.post`, `axios.create`, `axios.defaults`.
> **Verified against:** unit tests, integration smoke (`scripts/smoke-axios.mjs`), staging soak (24h).
> **Rollback plan:** revert PR, redeploy. Lockfile is the only artifact.

That's still a small amount of work — maybe 30 minutes per library — but it's *manageable* work, and it doesn't fight for time with the 95% bucket.

## The 1% bucket: major bumps

Major bumps are real engineering. They go on the roadmap. They get a story, an estimate, a code-search of every consumer, and a feature flag if the library spans a system boundary. They do not get done in the audit-clearing sweep, and they don't get done by whoever happens to draw the short straw at security stand-up.

Counter-intuitively, *separating* the major bumps from the patch bumps means the major bumps actually get done. When everything is on the same backlog, "the audit list" never goes down, the team gives up, and the major bumps pile up forever. When the audit list is a sweep that completes every two weeks, the major bumps stand out, get prioritised, and ship.

## Worked example: a 240-CVE backlog

A customer came to us last quarter with `npm audit` showing 241 vulnerabilities (24 critical, 89 high, 128 moderate). Their security team had been chipping at it for six months and the count had gone *up* by 14 in that time.

We pulled their lockfile and ran the 95/4/1 split. The actual numbers:

- **228** were patch bumps inside their existing semver ranges. `npm audit fix` resolved all 228 in one command.
- **9** were minor bumps. Two were Express middleware (read changelog, no surface change), four were utility libraries with deprecation warnings, three were dev-only build tooling.
- **4** were major bumps: a new major of `node-fetch`, a major of `react-router`, and two ORM majors. None had usable patches available within the existing major.

Total time spent: one engineer-day for the bump-everything PR (most of it waiting for CI), four engineer-days spread across the next sprint for the minors, and the four majors went onto the roadmap. The audit dropped from 241 to 4 in eleven days.

The four remaining issues weren't a problem to be solved. They were a list of clearly-scoped engineering tasks. That's the whole point.

## A workflow you can paste into a runbook

Here is the workflow we hand to teams. Copy-paste it.

1. **Every other Monday:** open the bump-everything PR. Run `npm update && npm audit fix`, run tests, push. If green in 24h, merge. No standalone review meeting required for in-range bumps.
2. **Same day:** triage anything `npm audit fix` couldn't resolve into the 4% (minor) or 1% (major) bucket.
3. **Within the sprint:** ship the minor-bump PRs, one per library, with the Slack template above.
4. **At sprint planning:** any major-version bump becomes a story with an estimate. It is real work; treat it as real work.
5. **In CI:** block-on-new on PRs, notify-on-existing on `main` nightly.

That's it. The 95% gets cleared on a schedule, the 4% gets careful per-library attention, and the 1% gets real engineering. The audit count goes down monotonically and stays down.

> Most security work isn't risky. Most security work is just unscheduled.

When you stop treating "security" as a special category that demands special process for every line item, and start treating it like any other recurring chore — payroll, dependency updates, secret rotation — the backlog becomes a workflow instead of a wall. And the few items that genuinely deserve scrutiny actually get it.

If you want a scanner that already groups your CVEs into the 95/4/1 buckets and shows you which lockfile lines move where, [Algosize's vulnerability scanner](/#features) does it from a repo URL or a pasted lockfile. But the workflow above will work with `npm audit` and a calendar invite.
