// CORS middleware for the Algosize Worker.
//
// We allow exactly one origin (the Jekyll site origin from env.SITE_ORIGIN)
// and credentials. The Stripe webhook is excluded — Stripe calls it
// server-to-server and CORS does not apply there.

// DELETE is here for /api/mcp (explicit session teardown) and the account and
// monitor deletes; PATCH and PUT for the account and org editors. The list was
// GET/POST/OPTIONS long after routes using the others existed — non-browser
// callers ignore CORS entirely, so nothing broke visibly and the gap only
// showed up from a browser.
const ALLOWED_METHODS = "GET, POST, PATCH, PUT, DELETE, OPTIONS";

// Mcp-Session-Id and MCP-Protocol-Version are what a browser-based MCP host
// sends on every request after `initialize`. Without them in the allow list
// the preflight fails and the host reports a generic network error.
const ALLOWED_HEADERS = "Content-Type, Authorization, Mcp-Session-Id, MCP-Protocol-Version, Last-Event-ID";

// Response headers a browser is permitted to READ. Mcp-Session-Id must be
// here or a browser host cannot see the session id on the initialize
// response: the fetch succeeds, the header is invisible, and every later
// request is rejected for a missing session. It fails silently and looks like
// a server bug, which is why it is set globally rather than per-response.
const EXPOSED_HEADERS = "Mcp-Session-Id";

/**
 * Compute the CORS headers for a given request.
 * If the request's Origin matches env.SITE_ORIGIN we echo it back. Otherwise
 * we omit Access-Control-Allow-Origin entirely — the browser will then block
 * the response. Non-browser clients (curl, server-to-server) ignore CORS, so
 * 200/501/etc bodies still come through; that matches real CORS semantics.
 */
export function corsHeaders(request, env) {
  const origin = request.headers.get("Origin") || "";
  const headers = {
    "Access-Control-Allow-Methods": ALLOWED_METHODS,
    "Access-Control-Allow-Headers": ALLOWED_HEADERS,
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Expose-Headers": EXPOSED_HEADERS,
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  };
  if (origin && origin === env.SITE_ORIGIN) {
    headers["Access-Control-Allow-Origin"] = origin;
  }
  return headers;
}

/**
 * Itty-router preflight handler. Returns 204 with CORS headers for OPTIONS.
 * Returns undefined for non-preflight requests so routing continues.
 */
export function handlePreflight(request, env) {
  if (request.method !== "OPTIONS") return;
  return new Response(null, { status: 204, headers: corsHeaders(request, env) });
}

/**
 * Wrap a Response by merging CORS headers in. Used by the router's `finally`
 * step so every real response (including errors) carries CORS.
 */
export function withCors(response, request, env) {
  const headers = new Headers(response.headers);
  for (const [k, v] of Object.entries(corsHeaders(request, env))) {
    headers.set(k, v);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
