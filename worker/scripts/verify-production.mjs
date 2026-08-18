// Post-deploy verification against a LIVE deployment.
//
//   SITE_ORIGIN=https://algosize.com node scripts/verify-production.mjs
//
// This is not a test — it makes real HTTPS requests to a deployed Worker and
// reports whether the things provisioning was supposed to set up are actually
// there. `npm test` never runs it; it is the last step of DEPLOY.md §7.
//
// WHAT EACH PROBE CAN AND CANNOT PROVE
//
// The groups below answer genuinely different questions, and it is worth being
// precise about which, because the obvious reading of the unauthenticated group
// is wrong:
//
//   0. Reachability — one request to an unrouted path, expecting the Worker's
//                     own 404 JSON. Proves SITE_ORIGIN reaches THIS Worker and
//                     not something in front of it. A failure here stops the
//                     run, because everything after it would fail identically.
//
//   1. Schema      — GET /api/admin/schema-check. The only probe that inspects
//                    the database directly, per migration, per column. This is
//                    the authoritative answer to "are the migrations applied?"
//                    Needs an admin session.
//
//   2. Unauthed    — GET the authed endpoints with no credentials, expect 401.
//                    This proves the ROUTE IS DEPLOYED: registered, reachable,
//                    and short-circuiting at auth. It does NOT prove the tables
//                    those routes read exist — `requireAuth` returns 401 before
//                    any handler runs, so a database missing every table still
//                    passes this group cleanly. A 500 here means the Worker
//                    itself is broken (bad binding, module-scope throw); a 404
//                    means the deployed bundle predates the route.
//
//   3. Authed      — the same endpoints WITH the admin session. These reach the
//                    handlers, so they do touch D1, and this is the group where
//                    a 500 really does mean a missing table. Skipped without a
//                    cookie, which is why the cookie is worth providing even
//                    though every probe is optional-by-design.
//
// ENVIRONMENT
//
//   SITE_ORIGIN            required. Origin of the deployment, e.g.
//                          https://algosize.com or https://algosize.<acct>.workers.dev
//   ADMIN_SESSION_COOKIE   optional. A session for an email in ADMIN_EMAILS.
//                          Either the full `algosize_session=<jwt>` pair or the
//                          bare JWT. Without it, groups 1 and 3 are SKIPPED with
//                          a warning and the run can still pass — a skip is not
//                          a pass, and the summary says so.
//   COOKIE_NAME            optional, defaults to algosize_session. Only needed
//                          if the deployment overrides it in wrangler.toml.
//
// Exit code is 0 when nothing FAILED, 1 otherwise. Skips do not fail the run,
// so this is safe to wire into a deploy pipeline that has no admin credential —
// it just verifies less there.

const TIMEOUT_MS = Number(process.env.VERIFY_TIMEOUT_MS || 15000);

// ---------------------------------------------------------------------------
// Result recording
// ---------------------------------------------------------------------------

const results = [];
const record = (state, name, detail) => {
  results.push({ state, name, detail });
  const mark = { pass: "\x1b[32m✓\x1b[0m", fail: "\x1b[31m✗\x1b[0m", skip: "\x1b[33m–\x1b[0m" }[state];
  console.log(`  ${mark} ${name}${detail ? ` — ${detail}` : ""}`);
};
const pass = (name, detail) => record("pass", name, detail);
const fail = (name, detail) => record("fail", name, detail);
const skip = (name, detail) => record("skip", name, detail);

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const ORIGIN = (process.env.SITE_ORIGIN || "").trim().replace(/\/+$/, "");
if (!ORIGIN) {
  console.error("SITE_ORIGIN is not set.\n");
  console.error("  SITE_ORIGIN=https://algosize.com node scripts/verify-production.mjs\n");
  process.exit(2);
}
try {
  const u = new URL(ORIGIN);
  if (u.protocol !== "https:" && u.hostname !== "localhost" && u.hostname !== "127.0.0.1") {
    console.error(`SITE_ORIGIN must be https (got ${u.protocol}//). Refusing to send a session cookie in clear text.`);
    process.exit(2);
  }
} catch {
  console.error(`SITE_ORIGIN is not a valid URL: ${ORIGIN}`);
  process.exit(2);
}

const COOKIE_NAME = (process.env.COOKIE_NAME || "algosize_session").trim();

/**
 * Normalise ADMIN_SESSION_COOKIE into a Cookie header value.
 *
 * Accepts either what you'd copy out of devtools (`algosize_session=eyJ…`) or
 * the bare token, because both are what people actually paste, and getting it
 * wrong produces a 401 that reads like an expired session rather than a
 * malformed header.
 */
function cookieHeader() {
  const raw = (process.env.ADMIN_SESSION_COOKIE || "").trim();
  if (!raw) return null;
  return raw.includes("=") ? raw : `${COOKIE_NAME}=${raw}`;
}
const COOKIE = cookieHeader();

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

/**
 * One request, never throwing. Network and timeout failures come back as
 * `{ error }` so a DNS blip is reported as one failed probe rather than an
 * unhandled rejection that hides every check after it.
 *
 * `redirect: "manual"` matters for /api/checkout: a successful non-JSON
 * checkout answers 303 to stripe.com, and following it would replace the
 * status we are asserting on with Stripe's.
 */
async function probe(path, { method = "GET", cookie = null, body = null, accept = null } = {}) {
  const headers = {};
  if (cookie) headers.cookie = cookie;
  if (accept) headers.accept = accept;
  if (body !== null) headers["content-type"] = "application/json";
  try {
    const res = await fetch(`${ORIGIN}${path}`, {
      method,
      headers,
      body: body === null ? undefined : JSON.stringify(body),
      redirect: "manual",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    let json = null;
    let text = "";
    try {
      text = await res.text();
      json = text ? JSON.parse(text) : null;
    } catch {
      // HTML error page or a redirect with an empty body — `text` still holds
      // whatever came back, which is what the failure message wants to show.
    }
    return { status: res.status, json, text, headers: res.headers };
  } catch (err) {
    return { error: (err && err.message) || String(err) };
  }
}

/** First line of a response body, trimmed — enough to identify an error page. */
const snippet = (res, n = 120) =>
  (res.text || "").replace(/\s+/g, " ").trim().slice(0, n) || "(empty body)";

// ---------------------------------------------------------------------------
// 0. Reachability — is SITE_ORIGIN actually this Worker?
// ---------------------------------------------------------------------------

/**
 * Confirm the origin answers as the Worker before probing anything else.
 *
 * The router's catch-all returns `{"error":"not_found"}` for an unrouted path,
 * which is a cheap and unambiguous fingerprint: it proves DNS resolved, TLS
 * completed, the request reached the Worker, and the router is running.
 *
 * Without this, anything sitting in FRONT of the Worker — Cloudflare Access on
 * a staging hostname, a corporate egress proxy, a WAF rule — answers every
 * probe with the same status, and the run reports six identical failures whose
 * text describes the symptom ("expected 401, got 403") rather than the cause.
 * That happened on the first real run of this script, against a workers.dev
 * preview URL blocked by an egress allowlist. One clear failure beats six
 * misleading ones, so a failure here short-circuits the rest of the run.
 *
 * Returns true when the probes below are worth attempting.
 */
async function checkReachable() {
  console.log("\nReachability");
  const res = await probe("/api/__verify_probe_404");
  if (res.error) {
    fail("origin reachable", `request failed: ${res.error} — check SITE_ORIGIN and DNS`);
    return false;
  }
  if (res.status === 404 && res.json && res.json.error === "not_found") {
    pass("origin reachable", "the Worker's router is answering");
    return true;
  }
  // A 404 that is not the Worker's own means something else served it.
  if (res.status === 403 || res.status === 401 || res.status === 407) {
    fail("origin reachable",
         `HTTP ${res.status} from something in front of the Worker — Cloudflare Access, ` +
         `a WAF rule, or an egress proxy. Body: ${snippet(res)}`);
    return false;
  }
  if (res.status >= 500) {
    fail("origin reachable", `HTTP ${res.status} — the origin is erroring: ${snippet(res)}`);
    return false;
  }
  fail("origin reachable",
       `expected the Worker's 404 JSON, got HTTP ${res.status}: ${snippet(res)}. ` +
       `Is SITE_ORIGIN pointing at the Worker rather than the static site?`);
  return false;
}

// ---------------------------------------------------------------------------
// 1. Schema
// ---------------------------------------------------------------------------

async function checkSchema() {
  console.log("\nSchema — GET /api/admin/schema-check");
  if (!COOKIE) {
    skip("migrations applied",
         "no ADMIN_SESSION_COOKIE; set it to verify the production schema");
    return;
  }
  const res = await probe("/api/admin/schema-check", { cookie: COOKIE });
  if (res.error) return fail("migrations applied", `request failed: ${res.error}`);

  if (res.status === 401) {
    return fail("migrations applied",
                "401 — the session cookie is missing, expired or revoked. Sign in again and re-copy it.");
  }
  if (res.status === 403) {
    return fail("migrations applied",
                "403 — the session is valid but the email is not in ADMIN_EMAILS on this deployment.");
  }
  if (res.status === 404) {
    return fail("migrations applied",
                "404 — the deployed Worker predates /api/admin/schema-check. Redeploy.");
  }
  if (res.status !== 200 || !res.json) {
    return fail("migrations applied", `HTTP ${res.status}: ${snippet(res)}`);
  }

  const { ok, appliedCount, total, pending, migrations } = res.json;
  if (ok) {
    pass("migrations applied", `${appliedCount}/${total}`);
  } else {
    fail("migrations applied",
         `${appliedCount}/${total} — pending: ${(pending || []).join(", ")}`);
    // The failing checks by name, because "0004 is pending" is not actionable
    // on its own — a migration fails as a unit but is usually missing one piece.
    for (const m of migrations || []) {
      if (m.applied) continue;
      const missing = (m.checks || []).filter((c) => !c.present).map((c) => c.target);
      console.log(`      ${m.migration} ${m.name}: missing ${missing.join(", ")}`);
    }
    console.log(`      apply with: wrangler d1 execute algosize --env production --remote --file=migrations/<file>.sql`);
  }
}

// ---------------------------------------------------------------------------
// 2. Unauthenticated — routes are deployed
// ---------------------------------------------------------------------------

// /api/ci/snippet is API-key-only at the handler, but requireAuth still runs
// first, so an anonymous caller gets the same 401 as everywhere else.
const AUTHED_ENDPOINTS = ["/api/me", "/api/org", "/api/monitors", "/api/keys", "/api/ci/snippet"];

async function checkUnauthenticated() {
  console.log("\nRoutes deployed — authed endpoints with no cookie (expect 401)");
  for (const path of AUTHED_ENDPOINTS) {
    const res = await probe(path);
    if (res.error) { fail(`GET ${path}`, `request failed: ${res.error}`); continue; }
    if (res.status === 401) { pass(`GET ${path}`, "401"); continue; }
    if (res.status === 404) {
      fail(`GET ${path}`, "404 — route not registered in the deployed bundle");
      continue;
    }
    if (res.status >= 500) {
      fail(`GET ${path}`, `HTTP ${res.status} — the Worker threw before auth: ${snippet(res)}`);
      continue;
    }
    if (res.status === 200) {
      // Worth failing loudly: an endpoint behind requireAuth answering an
      // anonymous request is an authentication hole, not a passing probe.
      fail(`GET ${path}`, "200 without credentials — this endpoint is NOT gated");
      continue;
    }
    fail(`GET ${path}`, `expected 401, got ${res.status}: ${snippet(res)}`);
  }
}

// ---------------------------------------------------------------------------
// 3. Authenticated — the handlers actually run, so D1 is actually read
// ---------------------------------------------------------------------------

// Each entry names the tables the handler reads, so a 500 can point at the
// migration to apply instead of just reporting that something broke.
const AUTHED_READS = [
  { path: "/api/me",         reads: "users, organisations, memberships (0001, 0004)" },
  { path: "/api/org",        reads: "organisations, memberships (0004)" },
  { path: "/api/keys",       reads: "api_keys (0005)" },
  { path: "/api/monitors",   reads: "monitors (0006)" },
];

async function checkAuthenticated() {
  console.log("\nHandlers reach D1 — same endpoints with the admin session");
  if (!COOKIE) {
    skip("authenticated reads",
         "no ADMIN_SESSION_COOKIE; missing tables cannot be detected without one");
    return;
  }
  for (const { path, reads } of AUTHED_READS) {
    const res = await probe(path, { cookie: COOKIE });
    if (res.error) { fail(`GET ${path}`, `request failed: ${res.error}`); continue; }
    if (res.status === 401) {
      fail(`GET ${path}`, "401 — session cookie rejected; re-copy it and rerun");
      continue;
    }
    if (res.status >= 500) {
      fail(`GET ${path}`, `HTTP ${res.status} — likely a missing table. Reads ${reads}. Body: ${snippet(res)}`);
      continue;
    }
    pass(`GET ${path}`, `${res.status} — reads ${reads}`);
  }
}

// ---------------------------------------------------------------------------
// 4. Checkout — is a tier price configured?
// ---------------------------------------------------------------------------

async function checkCheckout() {
  console.log("\nBilling — POST /api/checkout {plan:\"solo\"}");
  const res = await probe("/api/checkout", { method: "POST", body: { plan: "solo" } });
  if (res.error) return fail("solo plan checkout", `request failed: ${res.error}`);

  // 303 to Stripe (form fallback) or 200 with {url} (JSON caller) both mean the
  // price resolved and Stripe accepted it.
  if (res.status === 303 || res.status === 302) {
    const location = res.headers.get("location") || "";
    return pass("solo plan checkout",
                `${res.status} → ${location.slice(0, 60) || "(no location header)"}`);
  }
  if (res.status === 200 && res.json && res.json.url) {
    return pass("solo plan checkout", "200 with a Checkout Session url");
  }
  if (res.status === 503 && res.json && res.json.error === "plan_not_available") {
    // Not a failure. This is the honest, correct answer from a deployment where
    // STRIPE_PRICE_SOLO_MONTHLY has not been set — the endpoint refusing to
    // silently bill some other price is the behaviour we want.
    return skip("solo plan checkout",
                "503 plan_not_available — STRIPE_PRICE_SOLO_MONTHLY is not set on this deployment");
  }
  if (res.status >= 500) {
    return fail("solo plan checkout", `HTTP ${res.status}: ${snippet(res)}`);
  }
  if (res.status === 429) {
    return skip("solo plan checkout", "429 rate limited — rerun in a minute");
  }
  fail("solo plan checkout", `expected 200/303 or 503 plan_not_available, got ${res.status}: ${snippet(res)}`);
}

// ---------------------------------------------------------------------------

async function main() {
  console.log(`Verifying ${ORIGIN}`);
  console.log(COOKIE
    ? "Admin session: provided"
    : "\x1b[33mAdmin session: absent — schema and authenticated checks will be skipped\x1b[0m");

  if (await checkReachable()) {
    await checkSchema();
    await checkUnauthenticated();
    await checkAuthenticated();
    await checkCheckout();
  } else {
    console.log("\nSkipping the remaining checks — they would all fail the same way.");
  }

  const failed  = results.filter((r) => r.state === "fail");
  const skipped = results.filter((r) => r.state === "skip");
  const passed  = results.filter((r) => r.state === "pass");

  console.log("\n" + "─".repeat(64));
  console.log(`${passed.length} passed, ${failed.length} failed, ${skipped.length} skipped`);

  if (failed.length) {
    console.log("\nFailed:");
    for (const f of failed) console.log(`  ✗ ${f.name} — ${f.detail}`);
  }
  if (skipped.length) {
    console.log("\nSkipped (not verified — not the same as verified-good):");
    for (const s of skipped) console.log(`  – ${s.name} — ${s.detail}`);
  }

  if (failed.length) {
    console.log("\n\x1b[31mFAIL\x1b[0m — this deployment is not fully provisioned.");
    process.exit(1);
  }
  console.log(skipped.length
    ? "\n\x1b[32mPASS\x1b[0m — everything checked is healthy, but some checks were skipped."
    : "\n\x1b[32mPASS\x1b[0m — deployment fully verified.");
}

main().catch((err) => {
  console.error("\nverify-production crashed:", err);
  process.exit(1);
});
