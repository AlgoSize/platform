// UsageCounter — the strongly consistent free-tier quota counter.
//
// WHY THIS EXISTS
//
// The free-tier limit used to be enforced entirely in USERS KV, and it did not
// hold. KV has no atomic increment, and src/quota.js gated on a value it read
// before running the handler, so the check was check-then-act with the
// handler's whole execution time as the race window. Measured: 20 concurrent
// requests from a fresh free user produced 20 successful runs and left the
// counter at 1 — every increment read 0 and wrote 1. Because the counter never
// advanced, the burst was repeatable indefinitely. That is a bypass, not an
// off-by-one, and it was the only thing standing between a free account and
// unmetered sandbox compute.
//
// A Durable Object fixes it because it supplies the one thing KV cannot: a
// single serialised writer per meter id. `idFromName(meterId)` routes every
// request for one account to one object, and `blockConcurrencyWhile` makes
// "read the count, compare it to the limit, write the new count" a single
// uninterruptible step. Two concurrent reservations at the boundary can no
// longer both observe the pre-increment value.
//
// RESERVE / RELEASE, NOT INCREMENT
//
// Making the check atomic means spending the run at the gate, before the
// handler's outcome is known — you cannot both decide on a count and defer
// writing it. But the pre-existing contract was that a validation error or a
// sandbox crash must not cost a free run, and silently regressing that would
// trade one user-visible bug for another. So callers reserve at the gate and
// release on any non-200:
//
//   reserve → allowed?  → run handler → 200      → keep the reservation
//                                     → non-200  → release it
//
// The failure path costs one extra DO round trip, which is the right place to
// pay for it. A lost release (isolate eviction between the handler returning
// and the release landing) leaks one run against that user's month — strictly
// less bad than the alternative, and bounded at one per crash rather than
// unbounded per burst.
//
// STORAGE SHAPE
//
// One record per object: `{ month, count }` under the key `rec`. Keeping the
// month inside the record rather than in the key means rollover needs no
// cleanup pass and no alarm — a request for a different month than the stored
// one resets the count instead of accumulating keys that DO storage would
// otherwise hold forever (unlike KV, DO storage has no TTL).
//
// MIGRATION
//
// On the first touch of a given month the object seeds its count from the
// legacy KV counter for that same month, so deploying mid-month does not hand
// every free user a fresh set of runs. The seed inherits whatever undercount
// the old KV path had accrued, which is a one-time carry-over in the user's
// favour and not worth reconciling. After that first touch the DO is the sole
// source of truth and KV is no longer read or written for metering.

const STORAGE_KEY = "rec";

export class UsageCounter {
  constructor(state, env) {
    this.state = state;
    this.env   = env;
  }

  /**
   * Load the record for `month`, seeding from legacy KV on first touch.
   *
   * Called only from inside blockConcurrencyWhile, so the KV read it may
   * perform cannot interleave with another reservation on this object.
   */
  async #load(month, meterId) {
    const rec = await this.state.storage.get(STORAGE_KEY);
    if (rec && rec.month === month) return rec;

    // Either brand new, or the calendar month rolled over. Both start from the
    // legacy KV counter for THIS month: on a rollover that key is absent and
    // the seed is 0, which is exactly the reset we want.
    let seed = 0;
    if (this.env && this.env.USERS && meterId) {
      try {
        const raw = await this.env.USERS.get(`quota:${meterId}:${month}`);
        const n   = raw ? parseInt(raw, 10) : 0;
        if (Number.isFinite(n) && n > 0) seed = n;
      } catch {
        // A KV hiccup during seeding must not fail the request. Starting at 0
        // grants at most one month of quota to one user, whereas throwing here
        // would 500 every free analyzer call on this object.
      }
    }
    return { month, count: seed };
  }

  async fetch(request) {
    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: "bad_request" }, 400);
    }
    const { op, meterId, month, limit } = body || {};
    if (!op || !month) return json({ error: "bad_request" }, 400);

    // Every branch that reads-then-writes runs inside this, which is what
    // makes the check atomic. Without it an `await` inside the callback would
    // let a second request observe the pre-write count.
    return this.state.blockConcurrencyWhile(async () => {
      const rec = await this.#load(month, meterId);

      if (op === "peek") {
        return json({ used: rec.count });
      }

      if (op === "reserve") {
        const cap = Number.isFinite(limit) ? limit : 0;
        if (rec.count >= cap) {
          return json({ allowed: false, used: rec.count });
        }
        rec.count += 1;
        await this.state.storage.put(STORAGE_KEY, rec);
        return json({ allowed: true, used: rec.count });
      }

      if (op === "release") {
        // Floor at zero: a duplicate release (a retry, a double-invoked
        // waitUntil) must not mint quota out of nothing.
        if (rec.count > 0) {
          rec.count -= 1;
          await this.state.storage.put(STORAGE_KEY, rec);
        }
        return json({ used: rec.count });
      }

      return json({ error: "unknown_op", op }, 400);
    });
  }
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
