// Helpers shared between specs.
//
// Reads the session token written by global-setup.mjs and applies it as a
// cookie to a Playwright BrowserContext. We scope the cookie to
// `domain: localhost` so the browser sends it on requests to BOTH the
// Jekyll site (localhost:5000) AND the Worker (localhost:8787) — same
// site, different ports. This mirrors the dev cookie set by the Worker
// in TESTING.md step 4 (HttpOnly + SameSite=Lax + no Secure on http
// localhost).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname  = path.dirname(fileURLToPath(import.meta.url));
const TOKEN_FILE = path.resolve(__dirname, "..", ".session-token");

export const COOKIE_NAME = "algosize_session";
export const E2E_EMAIL   = "e2e@algosize.test";

export function readSessionToken() {
  if (process.env.E2E_SESSION_TOKEN) return process.env.E2E_SESSION_TOKEN.trim();
  if (!fs.existsSync(TOKEN_FILE)) {
    throw new Error(
      `[e2e] session token file missing at ${TOKEN_FILE} — globalSetup must run first`,
    );
  }
  return fs.readFileSync(TOKEN_FILE, "utf8").trim();
}

export async function applySessionCookie(context) {
  const token = readSessionToken();
  await context.addCookies([
    {
      name:     COOKIE_NAME,
      value:    token,
      domain:   "localhost",
      path:     "/",
      httpOnly: true,
      secure:   false,
      sameSite: "Lax",
    },
  ]);
  return token;
}
