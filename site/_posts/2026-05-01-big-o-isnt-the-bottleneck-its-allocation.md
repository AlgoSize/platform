---
title: "Big-O isn't the bottleneck. It's allocation."
date: 2026-05-01 09:00:00 -0400
description: "Most slow code in production isn't slow because the algorithm is wrong. It's slow because every iteration is allocating, and the allocator (and the GC behind it) is doing the work nobody profiled. Here's how to spot the cliff."
author: Algosize Engineering
tags: [performance, profiling, gc]
image: /assets/img/blog/big-o-allocation.svg
primary_keyword: "memory allocation performance"
---

The first instinct of every engineer who reads a hot-path is to check the algorithm. *Is this nested loop O(n²) when it could be O(n log n)?* It almost never is. The function has been there for two years, the team has reviewed it twice, and Big-O is the kind of correctness problem that gets caught on the second pass, not the hundredth.

The thing that *does* get worse over time, silently, in code reviews nobody flags, is **allocation per iteration**. A `.map().filter().slice()` chain that allocates four arrays where the original code allocated one. A closure pulled out into a "cleaner" inner function that captures a reference and prevents an escape analysis. A logger that builds a structured object on every call site, even on the call sites where the log line is below the active level.

Each one is invisible in a CPU profile until the day the GC pause hits 200ms and your p99 goes vertical. Then a postmortem discovers the cliff, and someone writes a Slack message that begins "actually it's not the algorithm, it's…"

This post is the field guide we use when we get a "this loop got slow" ticket. It does not assume you've ever read a flame graph. It assumes you've shipped working code and now the working code is slow.

## The shape of the cliff

Plot p50 latency against `n` for a hot path that allocates per iteration. Up until you hit some threshold, the line is roughly linear in `n` and roughly flat per-call — you're spending CPU on actual work, the allocator is fast, GC is happening between calls, all is well.

Cross the threshold — your nursery (young-generation heap) fills mid-call, GC fires, and the call has to wait for the collection to finish. Now your line jumps from "linear in `n`" to "linear in `n` with periodic 50–200ms cliffs" and your p99 looks like a barbed-wire fence.

The shape matters because it is *not* what you'd expect from an algorithmic problem. Algorithmic problems give you a smooth curve — `n²` looks parabolic, `n log n` looks like `n` with a gentle warp. Allocation cliffs give you a flat-then-spike profile, where p50 is fine and p99 is a disaster.

If you take one thing away from this post: **a flat p50 and a spiky p99 is almost always allocation, not algorithm**.

## Where the allocations hide

Every language has its own allocator quirks, but the categories of "allocation that gets written without anyone noticing" are remarkably stable across languages. Here's what we look for, in roughly the order they bite.

### 1. Method-chain landmines

The same data transformation, written two ways:

```js
// Allocates: 1 array.
const out = [];
for (const item of items) {
  if (!item.active) continue;
  out.push(item.value * 2);
}

// Allocates: 2 arrays. (filter result, then map result.)
const out = items
  .filter(item => item.active)
  .map(item => item.value * 2);
```

For `n=10`, who cares. For `n=100,000` called inside an event handler that fires fifty times a second, the second version makes 100 intermediate arrays a second the GC has to walk and collect. Same Big-O. Different performance.

The fix isn't "stop using `.map().filter()`" — it's to know which paths are hot. You can leave the chain in a request handler that runs once per request. You should rewrite it in the inner loop of a parser or a render pipeline.

### 2. Closures that capture too much

```js
function processBatch(records, ctx) {
  return records.map(record => transform(record, ctx));   // closure allocated per call
}
```

In V8 specifically, the inner arrow function above will often be re-created on every call to `processBatch`, *and* prevented from being inlined because it captures `ctx`. If `processBatch` is on the hot path, the inner closure is now an allocation per call multiplied by the call frequency.

Lifting the inner function out:

```js
const transformOne = (record, ctx) => transform(record, ctx);

function processBatch(records, ctx) {
  return records.map(record => transformOne(record, ctx));
}
```

…doesn't help — you've just moved the problem. The real fix is to drop `.map()` for a manual loop in this hot path and let the optimiser inline `transform` directly. Five lines longer, zero allocations per record.

### 3. String concatenation in logs

```js
logger.debug("processed " + record.id + " in " + ms + "ms with " + JSON.stringify(meta));
```

Every call to that line allocates a string, calls `JSON.stringify` (which allocates a much larger string), and then *throws it all away* if the logger's level is above `debug`. On a hot path running ten thousand times per second, that's ten thousand JSON serializations of `meta` per second, none of which were ever written to disk.

The fix is the well-known guard pattern:

```js
if (logger.isDebugEnabled()) {
  logger.debug("processed " + record.id + " in " + ms + "ms with " + JSON.stringify(meta));
}
```

…or, better, lazy logger APIs that take a function and only call it if the level is active. Most modern logging libraries (`pino`, `winston`'s structured mode, etc.) handle this for you if you stop concatenating strings and start passing structured objects:

```js
logger.debug({ id: record.id, ms, meta }, "processed record");
```

The library short-circuits before allocation if the level is below `debug`.

### 4. Buffers and slices

Once you go past the script-level languages and into Go / Rust / Node-with-typed-arrays, the killer allocation is usually a slice or a buffer that gets created fresh every iteration when it could have been pooled.

In Go:

```go
for _, record := range records {
  buf := make([]byte, 0, 1024)         // fresh slice every iteration
  buf = encode(buf, record)
  out = append(out, buf...)
}
```

The `make` inside the loop allocates 1KB on every iteration. For a million records that's 1GB of garbage the GC has to walk. Lift the buffer out and reset it:

```go
buf := make([]byte, 0, 1024)
for _, record := range records {
  buf = buf[:0]
  buf = encode(buf, record)
  out = append(out, buf...)
}
```

Same Big-O. One allocation instead of a million.

The Node equivalent uses `Buffer.allocUnsafe` plus a reusable scratch buffer; the Rust equivalent uses `Vec::with_capacity` once and `clear()` per iteration.

### 5. Iterator-protocol overhead

JavaScript's iterator protocol (`for...of`, generator functions, `[Symbol.iterator]`) is *not* free. Every iteration allocates an `IteratorResult` object — `{ value: T, done: boolean }` — that the GC then has to clean up.

For the vast majority of code this is irrelevant. For the inner loop of a streaming JSON parser running a hundred million times per process lifetime, it adds up to a measurable chunk of GC pressure. The fix in the hottest paths is to abandon the iterator protocol and use index-based iteration over a typed array. Less elegant. Significantly faster.

The point is not "don't use iterators". The point is "iterators have a cost, and the cost is almost always invisible until you measure it."

## How to actually measure

Profilers love showing you CPU. Profilers do not, by default, show you allocation rate. So we want a different lens.

In Node, the simplest one-line measurement is `--trace-gc`:

```
$ node --trace-gc app.js
[12345:0x1] 12 ms: Scavenge 24.5 (28.0) -> 4.3 (28.5) MB, 2.4 ms ...
```

The frequency of those lines is what you care about. If you see a `Scavenge` every 50ms, you're allocating roughly 24MB every 50ms — half a gigabyte per second. That's a *lot* of garbage, and even though scavenges are fast, the cumulative pause time will move p99.

In Go, run with `GODEBUG=gctrace=1` for the same effect. In the JVM, `-Xlog:gc*`. In Rust, you have to opt into instrumentation explicitly because the default doesn't have a GC, but `dhat` will tell you allocation counts and sizes.

Once you know you have an allocation problem, get a heap profile. `node --inspect`, then "Memory" panel in Chrome DevTools, "Allocation sampling". Run your hot path. The flame graph will rank functions by *bytes allocated*, not CPU spent. The function that's allocating the most is almost never the function that's slowest in a CPU profile, because the allocator itself is fast — it's the GC pauses *between* calls that hurt.

## A worked example

A customer last year had a JSON-over-HTTP service whose p50 was 8ms and whose p99 was 320ms. The team had spent a week on the algorithm — was the JSON parser quadratic? Were they accidentally `JSON.parse`-ing twice? — and found nothing.

`--trace-gc` showed a major GC every 1.2s, lasting 90–110ms each. Heap profile showed 78% of the bytes allocated were going to a single function: a request-shape validator that took the inbound payload, ran a recursive `Object.entries().map(…)` on it, then `JSON.stringify`'d the result for an audit log nobody read.

The fix was three lines: cache the validator's known-good schema once, replace the recursive `.map()` with a manual loop that wrote into a pre-allocated array, and remove the `JSON.stringify` for the audit log (which was a debug feature from 2018 that nobody had remembered to delete).

The algorithm was identical before and after. p99 dropped from 320ms to 14ms.

That's the shape of every allocation-bound performance bug we've ever seen. The Big-O is fine. The diff is "fewer intermediate objects". The result is dramatic.

## When the algorithm *is* the bottleneck

To be clear: algorithmic problems exist. We've seen `O(n²)` written into a billing-line aggregator, an `O(2ⁿ)` regex used as a cache key, and a fascinating hash-table implementation that rehashed on every insert. Big-O matters.

But — and this is the point — if you have not yet *measured* whether you're CPU-bound or allocation-bound, **start with measurement, not algorithm**. The reason "rewrite the algorithm" feels productive is that it's tractable engineering work. The reason it usually doesn't help is that the actual cost lives somewhere the engineer didn't look.

The decision tree we use:

1. Profile p50 vs p99. **Smooth-and-rising** → likely algorithm. **Flat-then-spiky** → likely allocation.
2. If algorithm: read the inner loop, count the comparisons, check the data structure, optimise.
3. If allocation: enable GC tracing, identify the call site, eliminate or pool the allocation, re-measure.
4. If both: fix allocation first. It's almost always cheaper, and the algorithm work goes faster on a quiet GC.

> Spend the hour reading a flame graph before you spend the week rewriting the algorithm.

The bias toward "improve Big-O" is the bias toward the kind of work that sounds smart in a performance review. The bias toward "eliminate allocation" is the bias toward the work that ships a faster service. Most of the time you want the second one.

If you want a tool that already runs the allocation profile against a function and reports a refactor that drops the allocation count, that's the algorithm optimizer Algosize ships. But honestly, `--trace-gc` and ten minutes of squinting at the heap profile will get you 80% of the way there. Start there. The cliff is real, and once you see it, you can't unsee it.
