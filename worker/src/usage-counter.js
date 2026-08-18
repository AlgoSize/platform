// Durable Object class reserved for the roadmap's strongly consistent usage
// counters. The current quota implementation still uses USERS KV; keeping the
// class exported now makes the first migration deployable and lets the quota
// storage move independently later.
export class UsageCounter {
  constructor(state) {
    this.state = state;
  }

  async fetch() {
    return new Response("UsageCounter is reserved for the quota migration", {
      status: 501,
    });
  }
}