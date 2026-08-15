// Guard spec: prove the Worker under test is the Algosize *API* Worker,
// with its bindings, before any functional spec runs.
//
// Why this exists. Wrangler resolves its config by walking up the directory
// tree, so a `wrangler.jsonc` at the repo root takes precedence over
// `worker/wrangler.toml` even when wrangler is started from inside
// `worker/`. Cloudflare's autoconfig bot opened exactly that PR, and
// `wrangler dev` silently booted a different Worker: no KV, no D1, no vars,
// just a static-asset server. Every /api/* call 404'd and the suite failed
// deep inside the dashboard spec with a timeout that said nothing about the
// real cause.
//
// The filename starts with `00-` because the suite runs serially in file
// order (fullyParallel: false, workers: 1), so this runs first and fails
// fast with an actionable message.

import { test, expect } from "@playwright/test";

const WORKER_ORIGIN = "http://127.0.0.1:8787";

const WRONG_WORKER_HINT =
  "The Worker on :8787 is not the Algosize API Worker. Wrangler almost " +
  "certainly loaded the wrong config — check for a wrangler.json/.jsonc at " +
  "the repo root shadowing worker/wrangler.toml, and confirm the dev command " +
  "passes `--config wrangler.toml`.";

test.describe("worker health", () => {
  test("the API Worker is running with its routes mounted", async ({ request }) => {
    // /api/me is auth-gated, so an unauthenticated request is a cheap probe
    // that exercises routing + the requireAuth middleware without needing a
    // session. 401 proves the real router is mounted; 404 means some other
    // Worker answered.
    const res = await request.get(`${WORKER_ORIGIN}/api/me`);
    expect(res.status(), WRONG_WORKER_HINT).toBe(401);

    const body = await res.json();
    expect(body.error, WRONG_WORKER_HINT).toBe("unauthorized");
  });

  test("the Worker has its JWT secret configured", async ({ request }) => {
    // requireAuth throws when JWT_SECRET is missing or too short, which the
    // top-level handler turns into a 500. A 401 here therefore also proves
    // worker/.dev.vars was picked up — the other half of "the right Worker
    // booted with the right config".
    const res = await request.get(`${WORKER_ORIGIN}/api/me`, {
      headers: { Authorization: "Bearer not-a-real-token" },
    });
    expect(
      res.status(),
      "Expected 401 for a bogus token. A 500 means JWT_SECRET is missing or " +
      "under 32 chars — check that worker/.dev.vars exists and that wrangler " +
      "dev loaded it.",
    ).toBe(401);
  });

  test("unknown API paths 404 as JSON, not as HTML", async ({ request }) => {
    // The static-asset Worker from the wrong config answers unknown paths
    // with an HTML page; the API Worker answers with its JSON fallthrough.
    // This distinguishes the two even if a future route makes /api/me
    // public.
    const res = await request.get(`${WORKER_ORIGIN}/api/definitely-not-a-route`);
    expect(res.status()).toBe(404);
    expect(res.headers()["content-type"] || "", WRONG_WORKER_HINT).toContain("application/json");
    const body = await res.json();
    expect(body.error).toBe("not_found");
  });
});
