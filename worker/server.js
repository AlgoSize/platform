// Unified Express.js server for Replit.
// Serves:
//   /api/*         → Cloudflare Worker handlers (adapted)
//   everything else → Jekyll static site (_site_build/)
//
// This replaces both `wrangler dev` (for the API) and `jekyll serve`
// (for the frontend) with a single process on port 5000.

import express from "express";
import { createSqliteDb } from "./src/adapters/sqlite-db.js";
import { getKVNamespace } from "./src/adapters/kv-store.js";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { existsSync } from "fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SITE_DIR = join(__dirname, "..", "_site_build");

// ---------------------------------------------------------------------------
// Env — mimics Cloudflare Workers bindings
// ---------------------------------------------------------------------------
const PORT = parseInt(process.env.PORT || "5000", 10);
const SITE_ORIGIN = process.env.SITE_ORIGIN || `http://localhost:${PORT}`;

const env = {
  DB:       createSqliteDb(),
  SESSIONS: getKVNamespace("SESSIONS"),
  USERS:    getKVNamespace("USERS"),
  SANDBOX:  null,  // in-process sandbox fallback (no service binding needed)

  JWT_SECRET:             process.env.JWT_SECRET             || "dev-secret-change-me-in-production-32c",
  COOKIE_NAME:            process.env.COOKIE_NAME            || "algosize_session",
  SITE_ORIGIN,
  STRIPE_SECRET_KEY:      process.env.STRIPE_SECRET_KEY      || "",
  STRIPE_WEBHOOK_SECRET:  process.env.STRIPE_WEBHOOK_SECRET  || "",
  STRIPE_PRICE_ID:        process.env.STRIPE_PRICE_ID        || "",
  OPENAI_API_KEY:         process.env.OPENAI_API_KEY         || "",
  ADMIN_EMAILS:           process.env.ADMIN_EMAILS           || "guillaumelauzier@gmail.com",
  ANALYTICS_DOMAIN:       process.env.ANALYTICS_DOMAIN       || "algosize.com",
  PLAUSIBLE_ENDPOINT:     process.env.PLAUSIBLE_ENDPOINT     || "https://plausible.io",
  EMAIL_FROM:             process.env.EMAIL_FROM             || "Algosize <noreply@algosize.com>",
  EMAIL_DELEGATED_USER:   process.env.EMAIL_DELEGATED_USER   || "noreply@algosize.com",
  E2E_TEST_SECRET:        process.env.E2E_TEST_SECRET        || "",
  GOOGLE_SERVICE_ACCOUNT_JSON: process.env.GOOGLE_SERVICE_ACCOUNT_JSON || "",
  SENTRY_DSN:             process.env.SENTRY_DSN             || "",
};

// ---------------------------------------------------------------------------
// Import the main Worker router
// ---------------------------------------------------------------------------
import workerApp from "./src/index.js";

// ---------------------------------------------------------------------------
// Bridge: Node.js IncomingMessage → Workers Request, Workers Response → res
// ---------------------------------------------------------------------------

function adaptRequest(req, rawBody) {
  const protocol = req.headers["x-forwarded-proto"] || "http";
  const host = req.headers.host || `localhost:${PORT}`;
  const url = `${protocol}://${host}${req.originalUrl}`;

  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (Array.isArray(v)) {
      for (const val of v) headers.append(k, val);
    } else if (v !== undefined) {
      try { headers.set(k, v); } catch { /* skip headers that fail */ }
    }
  }

  const init = { method: req.method, headers };
  if (!["GET", "HEAD", "OPTIONS"].includes(req.method) && rawBody) {
    init.body = rawBody;
  }
  return new Request(url, init);
}

async function adaptWorkerResponse(workerRes, res) {
  res.status(workerRes.status);
  for (const [k, v] of workerRes.headers.entries()) {
    // Express will throw on some special headers — skip those
    try { res.setHeader(k, v); } catch { /* skip */ }
  }
  const buf = await workerRes.arrayBuffer();
  res.end(Buffer.from(buf));
}

// Minimal Worker execution context
function makeCtx() {
  const tasks = [];
  return {
    waitUntil(p) { tasks.push(Promise.resolve(p).catch(() => {})); },
    _flush() { return Promise.allSettled(tasks); },
  };
}

// ---------------------------------------------------------------------------
// Express app
// ---------------------------------------------------------------------------
const app = express();

// 1. Raw body capture (needed for Stripe webhook sig verification)
app.use((req, res, next) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    req.rawBody = Buffer.concat(chunks);
    next();
  });
});

// 2. API routes — bridge to Worker handlers
app.all("/api/*", async (req, res) => {
  try {
    const workerReq = adaptRequest(req, req.rawBody);
    const ctx = makeCtx();
    const workerRes = await workerApp.fetch(workerReq, env, ctx);
    await adaptWorkerResponse(workerRes, res);
    ctx._flush().catch((err) => console.error("ctx.waitUntil error:", err));
  } catch (err) {
    console.error("Worker adapter error:", err);
    if (!res.headersSent) {
      res.status(500).json({ error: "internal_error", message: err.message });
    }
  }
});

// 3. Static site (Jekyll build output)
if (existsSync(SITE_DIR)) {
  app.use(express.static(SITE_DIR));
  // Jekyll generates directory-based URLs like /dashboard/ → serve index.html
  app.get("/*", (req, res, next) => {
    const possiblePath = join(SITE_DIR, req.path, "index.html");
    if (existsSync(possiblePath)) {
      res.sendFile(possiblePath);
    } else {
      next();
    }
  });
} else {
  app.get("/", (_req, res) => {
    res.send(`<h2>Algosize API running. Jekyll site not built yet.</h2>
      <p>Run <code>cd site && bundle exec jekyll build --destination ../_site_build</code> to build.</p>
      <p>API: <a href="/api/health">/api/health is not a real route</a> — try <a href="/health">/health</a></p>`);
  });
}

// 4. Health check
app.get("/health", (_req, res) => res.json({ ok: true }));

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Algosize server listening on port ${PORT}`);
  console.log(`  Site: ${SITE_ORIGIN}`);
  console.log(`  API:  ${SITE_ORIGIN}/api/*`);
  console.log(`  Static site dir: ${existsSync(SITE_DIR) ? SITE_DIR : "(not built yet)"}`);
});
