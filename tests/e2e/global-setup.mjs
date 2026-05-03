// Playwright globalSetup: mint a JWT for the synthetic e2e session and
// stash it on disk + in-process so specs can pick it up at runtime.
//
// The actual KV seeding (writing the JWT into SESSIONS + USERS) is done
// LATER, by the dashboard spec's beforeAll, via POST /api/_test/seed on
// the Worker itself. Doing it through the Worker avoids cross-process
// SQLite contention against wrangler dev's persist-to layer that the
// earlier "seed via standalone Miniflare" approach kept running into.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname    = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT    = path.resolve(__dirname, "../..");
const TOKEN_FILE   = path.resolve(__dirname, ".session-token");
const PAYLOAD_FILE = path.resolve(__dirname, ".session-payload.json");

// MUST match worker/.dev.vars JWT_SECRET — the Worker enforces a 32-char
// minimum, so we re-use the shipped placeholder rather than rolling a new
// one (keeps the test config in lock-step with what wrangler dev reads).
const JWT_SECRET = "local-dev-only-jwt-secret-32-chars-min-not-for-prod-xxxxx";

const E2E_USER = {
  userId:           "usr_e2etest00000000001",
  email:            "e2e@algosize.test",
  stripeCustomerId: "cus_e2etest_synthetic",
  subStatus:        "active",
};

function b64url(buf) {
  return Buffer.from(buf).toString("base64url");
}

// HS256 JWT, byte-for-byte compatible with worker/src/auth.js#signJWT.
function signJWT(payload, secret, ttlSec) {
  const now  = Math.floor(Date.now() / 1000);
  const full = { iat: now, exp: now + ttlSec, ...payload };
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body   = b64url(JSON.stringify(full));
  const input  = `${header}.${body}`;
  const sig    = b64url(crypto.createHmac("sha256", secret).update(input).digest());
  return `${input}.${sig}`;
}

export default async function globalSetup() {
  fs.rmSync(TOKEN_FILE, { force: true });
  fs.rmSync(PAYLOAD_FILE, { force: true });

  // 1 hour TTL — the suite completes in seconds; this just has to outlive
  // a single Playwright run.
  const ttlSec = 60 * 60;
  const token = signJWT(
    { sub: E2E_USER.userId, email: E2E_USER.email, subStatus: E2E_USER.subStatus },
    JWT_SECRET,
    ttlSec,
  );

  const now = Math.floor(Date.now() / 1000);
  const payload = {
    token,
    session: {
      userId:    E2E_USER.userId,
      email:     E2E_USER.email,
      subStatus: E2E_USER.subStatus,
      iat:       now,
    },
    user: {
      userId:           E2E_USER.userId,
      email:            E2E_USER.email,
      stripeCustomerId: E2E_USER.stripeCustomerId,
      subStatus:        E2E_USER.subStatus,
      createdAt:        now,
      updatedAt:        now,
    },
  };

  fs.writeFileSync(TOKEN_FILE,   token,                       "utf8");
  fs.writeFileSync(PAYLOAD_FILE, JSON.stringify(payload, null, 2), "utf8");

  // Surface for any spec that prefers env vars over reading the files.
  process.env.E2E_SESSION_TOKEN   = token;
  process.env.E2E_SESSION_PAYLOAD = JSON.stringify(payload);

  // eslint-disable-next-line no-console
  console.log(
    `[e2e] minted synthetic session for ${E2E_USER.email}; ` +
    `token in ${path.relative(REPO_ROOT, TOKEN_FILE)}`,
  );
}
