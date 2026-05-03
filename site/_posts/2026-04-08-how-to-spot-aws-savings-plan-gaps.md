---
title: "How to spot AWS Savings Plan gaps before the bill arrives"
date: 2026-04-08 09:00:00 -0400
description: "AWS Savings Plans look great in the dashboard until you read them line by line. Here's the four-gap checklist we run on every Cost &amp; Usage Report — and how to fix each one before next month's invoice."
author: Algosize Engineering
tags: [cloud-cost, aws, finops]
image: /assets/img/blog/aws-savings-plan-gaps.png
primary_keyword: "AWS Savings Plan coverage"
---

You bought a 1-year, no-upfront Compute Savings Plan twelve months ago. The Cost Explorer card says "94% utilization" and you stop reading. Next month the same card says 88%, the month after 81%, and by the end of the renewal cycle you're paying On-Demand prices on a third of your fleet *and* a separate fixed commitment for capacity nobody is using.

The dashboard isn't lying. It's just answering a different question than the one you actually care about. **Utilization** measures how much of your *commitment* you spent. **Coverage** measures how much of your *spend* was at the discounted rate. Most teams stare at the first number, miss the second, and pay the gap in cash.

This post is the four-gap checklist we run on every customer's Cost &amp; Usage Report (CUR). It takes about an hour the first time, twenty minutes a month after that, and we've yet to run it on an account where it didn't pay for the engineer's whole afternoon.

## The metric you actually want

Open a fresh tab and write this on a sticky note: **uncovered eligible spend**. Not utilization. Not effective savings rate. Not commitment used.

Uncovered eligible spend is the dollar amount you paid On-Demand for resources a Savings Plan *would have* discounted if the math had lined up. It's the part of the bill nobody sends you a Slack alert about, because from AWS's point of view nothing went wrong — you used a service, you paid for it, end of story.

A Savings Plan is a futures contract. You pre-commit to $X per hour of compute and AWS gives you up to 66% off the published rate on anything that fits the contract. The contract has fine print, the fine print has edges, and the gaps live on those edges.

There are exactly four edges that matter in practice. We list them in order of how often they bite, not how big they are.

## Gap 1: family-mismatch

A Compute Savings Plan covers EC2, Fargate, and Lambda usage *across instance families*, but only if AWS can re-price the family at the same hourly rate as your commitment. An EC2 Instance Savings Plan does not — it's locked to a single family in a single region.

The trap is the EC2 Instance Savings Plan. You bought it back when the team was running c5 boxes for everything. Two quarters later someone read a benchmark, the platform team flipped the auto-scaling group to c6i, and the new boxes are 8% cheaper at On-Demand prices. Your old commitment now covers nothing they're running. Utilization on the dashboard reads 100% (you're "using" all of it on the few c5 boxes still in the fleet) and coverage on c6i reads 0%.

How to find it: pull the CUR for the last full month, group by `pricing/Term` and `lineItem/UsageType`, and look for any usage type with a non-trivial On-Demand spend that *also* has a sibling family covered by an Instance Savings Plan. We use this query as a starting point:

```sql
SELECT line_item_usage_type, SUM(line_item_unblended_cost) AS od_spend
FROM cur_table
WHERE line_item_line_item_type = 'Usage'
  AND pricing_term = 'OnDemand'
  AND product_product_family = 'Compute Instance'
GROUP BY 1
HAVING SUM(line_item_unblended_cost) > 100
ORDER BY 2 DESC;
```

Any row in the output that lives in a family adjacent to one you've already committed to is a candidate. The fix is almost always to convert the Instance Savings Plan to a Compute Savings Plan at renewal — same dollar commitment, much wider coverage, ~6% smaller discount. We've never had a customer regret the trade.

## Gap 2: region-mismatch

Compute Savings Plans are region-agnostic across EC2 and Fargate. They are *not* region-agnostic across services in the way you'd think. Sagemaker Savings Plans? Region-locked. RDS Reserved Instances? Region-locked. The new Bedrock provisioned-throughput commitment? Region-locked.

The bite happens when your platform team runs a DR exercise, fails over to a secondary region for two days, and the bill for those two days runs at On-Demand rates on top of your existing commitment in the primary region. We've seen this pattern most often in financial-services customers who rehearse failover quarterly — the rehearsal is excellent practice, the surprise spend afterwards is not.

How to find it: in the same CUR, group by `product/region` and `pricing/Term`. Anything On-Demand in a region where you don't hold a regional commitment is a candidate.

The fix is policy, not procurement. Pick one of:

- Buy a small Compute Savings Plan in the DR region sized to a 24-hour failover.
- Run the DR exercise on Spot to keep the unplanned spend bounded.
- Accept the cost of the rehearsal and budget for it explicitly. ("Surprise" spend is much worse than budgeted spend, even if the dollar amount is identical.)

## Gap 3: instance-class skew

Some of the largest gaps we see are inside a single family. You have a Compute Savings Plan, you're running c6i across the fleet, and you assume coverage is 100%. Then someone provisions a c6i*d*.4xlarge for a stateful workload that needs the local NVMe and the SP rate doesn't match the d-suffix variant 1:1 — there's a small premium for the local storage, and that premium is uncovered.

The same thing happens between regular and `n` (high-network) variants, between `g` (graviton) and non-graviton, and between metal and virtualised within the same family. Each is a single-digit-percent variance in coverage. They add up.

How to find it: split coverage reports by full instance type, not just family. AWS's own coverage report defaults to family-level rollups, which is exactly the rollup that hides this gap. In the CUR, group by `product/instanceType` rather than `product/instanceFamily` and you'll see the skew immediately.

The fix is to either (a) re-quote your commitment with the heavier-variant rate factored in, or (b) standardise on the base variant for the workload and only deviate when there's a measured reason. The standardisation play is usually the cheaper one — most teams discover the d-suffix wasn't actually needed.

## Gap 4: sandbox and dev burn

The most common gap we see is also the most embarrassing one. The platform team buys a tight Compute Savings Plan sized to production traffic. The data team spins up a 32-vCPU Notebooks instance for a Friday-afternoon experiment, leaves it running over the weekend, and Monday morning you've paid On-Demand on a workload that wasn't part of the commitment plan.

You can't predict experiments. You can predict that there will be experiments. So size the commitment with a 10–15% headroom buffer over the production baseline, *then* set up a budget alert at the buffer-line so the platform team gets pinged the moment dev burn pushes utilization into the buffer.

How to find it: tag every non-prod resource with an `env=dev|staging|sandbox` tag (you should be doing this anyway for a thousand other reasons). In the CUR, group by `resourceTags/user_env` and look at the On-Demand fraction by environment. If `dev` or `sandbox` shows up with five-figure monthly On-Demand spend, you have a gap.

The fix has two halves: (1) buy a small Savings Plan sized to typical dev burn, and (2) put a hard cap on instance size in non-prod via Service Control Policies. Most teams won't *consciously* spin up an x1e.16xlarge for a Friday notebook, but somebody will eventually click the wrong dropdown.

## A weekly review that takes 20 minutes

Once you've found and fixed the gaps once, the maintenance loop is short:

1. **Monday morning**, pull the CUR for last week, run the four group-bys above.
2. Note any row where uncovered eligible spend exceeds your alert threshold (we use $1,000/week as a starting point — adjust to your bill size).
3. For each row, decide: is this a one-off (DR rehearsal, weekend experiment) or a trend (a new family rolling out across the fleet)?
4. One-offs go in a "watch" list. Trends become a procurement ticket — convert, top up, or reshape the commitment.
5. **Last business day of the quarter**, review the watch list. Anything that became a trend during the quarter joins the procurement ticket queue. Anything that didn't gets archived.

That's it. Twenty minutes, every Monday. The first time you run it you'll find six-to-twelve months of accumulated gap. The discipline after that catches the next gap inside a week instead of a year.

## What this looks like end-to-end

The customer who prompted this checklist had a 3-year all-upfront Compute Savings Plan that the dashboard showed at 96% utilization. We pulled their CUR and ran the four queries. Findings:

- **Family-mismatch:** $14,200/mo of On-Demand c6i spend that the SP wasn't routing to (their commitment was Instance-flavoured, not Compute-flavoured).
- **Region-mismatch:** $3,400/mo of On-Demand in eu-west-2, which they only used for a customer-specific compliance workload nobody had told the platform team about.
- **Instance-class skew:** $1,800/mo on the d-suffix variant.
- **Sandbox burn:** $6,100/mo on a single g5.12xlarge instance an ML researcher had provisioned and forgotten about three weeks earlier.

Total gap: $25,500/month, or $306,000/year, on a Savings Plan the dashboard had told them was working perfectly.

The gaps were all closed within a sprint. The instance-class skew got reshaped at the next renewal, the dev burn got a Service Control Policy and a Slack alert, and we left the team with the four queries in a SQL file they run every Monday.

> Utilization is the wrong question. The right question is: how much eligible spend slipped past the discount last month?

If you want a tool that runs the four queries on your CUR and surfaces the gaps for you, that's literally what Algosize's cost analyzer does — drop in a CUR export, get the four numbers and the per-row drill-down. But the queries above will take you 90% of the way there with nothing more than `aws s3 cp` and `duckdb`.

Either way: stop reading utilization, start reading coverage, and run the checklist on Monday morning. The bill arrives on the 3rd.
