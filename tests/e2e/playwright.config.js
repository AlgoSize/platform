// Playwright config for the Algosize end-to-end suite.
//
// Boots the Jekyll site (port 5000) and a wrangler dev Worker (port 8787)
// in parallel via webServer, then runs the specs in tests/. The local KV
// state for the Worker is seeded by global-setup.mjs before either server
// boots — that lets us mint a synthetic session cookie that the analyzer
// endpoints accept (no Stripe round trip required).
//
// Stripe itself is mocked at the browser layer via page.route() in the
// landing spec, so the suite never reaches a real Stripe endpoint.

import { defineConfig } from "@playwright/test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT  = path.resolve(__dirname, "../..");
const SITE_DIR   = path.resolve(REPO_ROOT, "site");
const WORKER_DIR = path.resolve(REPO_ROOT, "worker");

export default defineConfig({
  testDir: "./tests",
  // The two specs share the seeded local KV (one synthetic session). Run
  // them serially so logout in the dashboard spec can't race the landing
  // spec's checkout flow.
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["list"], ["github"]] : "list",
  timeout: 30_000,
  expect: { timeout: 10_000 },

  globalSetup: "./global-setup.mjs",

  use: {
    // Tests run on port 5001 (not 5000) so they coexist with the user's
    // long-running "Start application" workflow on Replit, which serves
    // Jekyll on 5000 with the default config (no api_base override).
    // Reusing that workflow's server would defeat jekyll-test-overrides.yml.
    baseURL: "http://localhost:5001",
    trace:       process.env.CI ? "retain-on-failure" : "off",
    screenshot:  "only-on-failure",
    video:       "off",
    actionTimeout: 10_000,
    navigationTimeout: 20_000,
  },

  webServer: [
    {
      // Marketing site + dashboard. We layer `jekyll-test-overrides.yml`
      // on top of site/_config.yml so the dashboard's api_base addresses
      // the Worker as http://localhost:8787 (same-site as localhost:5000)
      // rather than the default http://127.0.0.1:8787. That keeps the
      // session cookie (SameSite=Lax) flowing on cross-port fetches.
      command:
        "bundle exec jekyll serve --host 127.0.0.1 --port 5001 --no-watch " +
        "--config _config.yml," + path.resolve(__dirname, "jekyll-test-overrides.yml"),
      cwd: SITE_DIR,
      port: 5001,
      reuseExistingServer: !process.env.CI,
      timeout: 180_000,
      stdout: "pipe",
      stderr: "pipe",
    },
    {
      // Cloudflare Worker via wrangler dev. KV state is in-memory (no
      // --persist-to) — every restart starts with empty SESSIONS + USERS
      // and the dashboard spec re-seeds via POST /api/_test/seed in
      // beforeAll. That keeps tests independent from any stale on-disk
      // state and avoids cross-process SQLite contention.
      command: "./node_modules/.bin/wrangler dev --port 8787 --ip 127.0.0.1",
      cwd: WORKER_DIR,
      port: 8787,
      reuseExistingServer: !process.env.CI,
      timeout: 180_000,
      stdout: "pipe",
      stderr: "pipe",
      env: {
        // Disable interactive prompts + telemetry pings on first run in CI.
        WRANGLER_SEND_METRICS: "false",
        CI: "true",
      },
    },
  ],

  projects: [
    {
      name: "chromium",
      use: {
        // Use the Chromium that ships with Playwright. CI installs it via
        // `npx playwright install --with-deps chromium`. On the Replit
        // workspace (NixOS), Playwright's bundled chromium can't find its
        // shared libs, so we honour REPLIT_PLAYWRIGHT_CHROMIUM_EXECUTABLE
        // when it's set — the rest of the suite is identical.
        browserName: "chromium",
        launchOptions: process.env.REPLIT_PLAYWRIGHT_CHROMIUM_EXECUTABLE
          ? { executablePath: process.env.REPLIT_PLAYWRIGHT_CHROMIUM_EXECUTABLE }
          : undefined,
      },
    },
  ],
});
