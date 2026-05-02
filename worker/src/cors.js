// CORS middleware for the Algosize Worker.
//
// We allow exactly one origin (the Jekyll site origin from env.SITE_ORIGIN)
// and credentials. The Stripe webhook is excluded — Stripe calls it
// server-to-server and CORS does not apply there.

const ALLOWED_METHODS = "GET, POST, OPTIONS";
const ALLOWED_HEADERS = "Content-Type, Authorization";

/**
 * Compute the CORS headers for a given request.
 * If the request's Origin matches env.SITE_ORIGIN we echo it back, otherwise
 * we return no Access-Control-Allow-Origin (the browser will block).
 */
export function corsHeaders(request, env) {
  const origin = request.headers.get("Origin") || "";
  const allow = origin && origin === env.SITE_ORIGIN ? origin : env.SITE_ORIGIN;
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Methods": ALLOWED_METHODS,
    "Access-Control-Allow-Headers": ALLOWED_HEADERS,
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  };
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
