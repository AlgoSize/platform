// Streamable HTTP transport concerns: origin checking, headers, and the SSE
// stream. One endpoint (`/api/mcp`) serves POST, GET and DELETE, per the
// 2025-06-18 revision — there is no legacy `/sse` + `/messages` split.

import { MCP_PROTOCOL_HEADER } from "./protocol.js";

export const MCP_SESSION_HEADER = "Mcp-Session-Id";

// Hosts that may drive this endpoint from a browser. Native clients (Claude
// Code, Claude Desktop, curl, the stdio bridge) send no Origin at all.
const BUILT_IN_ORIGINS = Object.freeze([
  "https://claude.ai",
  "https://www.claude.ai",
]);

// Matches https://<anything>.anthropic.com — subdomains only, and only over
// TLS. Written as an anchored pattern rather than an `endsWith` check because
// `endsWith(".anthropic.com")` also accepts
// `https://anthropic.com.attacker.example`, which is a different site.
const ANTHROPIC_SUBDOMAIN = /^https:\/\/[a-z0-9-]+(\.[a-z0-9-]+)*\.anthropic\.com$/i;

// Loopback in any of its spellings, for `wrangler dev` and the bridge's own
// tests. Port is free-form because dev servers pick one.
const LOCALHOST = /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;

/**
 * The DNS-rebinding guard the MCP spec requires.
 *
 * A MISSING Origin is allowed and a PRESENT but unlisted one is refused, which
 * looks backwards until you remember what the header means: browsers always
 * send it and cannot forge it, while non-browser clients never send it. So
 * "absent" identifies a native client — the case rebinding cannot reach —
 * and "present and wrong" identifies exactly the attack, a page on some other
 * site pointing a victim's browser at this endpoint with their cookies
 * attached.
 */
export function originAllowed(request, env) {
  const origin = request.headers.get("Origin");
  if (!origin) return true;

  if (env && env.SITE_ORIGIN && origin === env.SITE_ORIGIN) return true;
  if (BUILT_IN_ORIGINS.includes(origin)) return true;
  if (ANTHROPIC_SUBDOMAIN.test(origin)) return true;
  if (LOCALHOST.test(origin)) return true;

  // Operator escape hatch, comma-separated. Exists so an on-prem or
  // white-label host can be added without a code deploy; it is exact-match
  // only, with no wildcard support, because a wildcard here is how an
  // allowlist quietly becomes an allow-everything.
  const extra = (env && env.MCP_ALLOWED_ORIGINS) || "";
  return extra.split(",").map((s) => s.trim()).filter(Boolean).includes(origin);
}

/**
 * CORS and MCP headers for a response.
 *
 * `Mcp-Session-Id` must appear in Access-Control-Expose-Headers or a
 * browser-based host cannot read the session id off the initialize response
 * — the fetch succeeds, the header is invisible, and every subsequent request
 * is rejected for a missing session. It fails silently and looks like a
 * server bug, so it is set here rather than left to each response site.
 */
export function mcpHeaders(request, env, extra = {}) {
  const origin  = request.headers.get("Origin");
  const headers = {
    "Access-Control-Expose-Headers": MCP_SESSION_HEADER,
    "Vary": "Origin",
    ...extra,
  };
  if (origin && originAllowed(request, env)) {
    headers["Access-Control-Allow-Origin"]      = origin;
    headers["Access-Control-Allow-Credentials"] = "true";
  }
  return headers;
}

/** Preflight for the MCP endpoint. Returns undefined for non-OPTIONS so routing continues. */
export function mcpPreflight(request, env) {
  if (request.method !== "OPTIONS") return;
  return new Response(null, {
    status: 204,
    headers: mcpHeaders(request, env, {
      "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
      // Authorization and content-type are the ordinary two; the MCP pair is
      // what a spec-compliant host sends and what the site-wide cors.js does
      // not know about.
      "Access-Control-Allow-Headers":
        `Content-Type, Authorization, ${MCP_SESSION_HEADER}, ${MCP_PROTOCOL_HEADER}, Last-Event-ID`,
      "Access-Control-Max-Age": "86400",
    }),
  });
}

/** A single JSON-RPC response (or a batch array) as one JSON body. */
export function jsonRpcResponse(payload, request, env, { status = 200, sessionId = null } = {}) {
  const extra = { "content-type": "application/json" };
  if (sessionId) extra[MCP_SESSION_HEADER] = sessionId;
  return new Response(payload === null ? "" : JSON.stringify(payload), {
    status,
    headers: mcpHeaders(request, env, extra),
  });
}

/**
 * A transport-level failure, as an HTTP status rather than a JSON-RPC error.
 *
 * Used for the conditions that happen before or outside the JSON-RPC layer:
 * a forbidden origin, an unknown session, a body that never parsed as JSON at
 * all. Anything the RPC layer can attribute to a message id should go back as
 * an rpcError instead, so the client can match it to the call it made.
 */
export function transportError(request, env, status, code, message) {
  return new Response(JSON.stringify({ error: code, message }), {
    status,
    headers: mcpHeaders(request, env, { "content-type": "application/json" }),
  });
}

/**
 * Open a server→client SSE stream.
 *
 * Returns `{ response, send, close }`. The caller writes events with `send`
 * and must call `close` — an SSE response whose writer is never closed holds
 * the Worker's subrequest open until the platform kills it, which shows up as
 * a mysterious 30-second stall rather than as an error.
 *
 * `X-Accel-Buffering: no` is set because an intermediary that buffers will
 * hold events until the stream ends, which for a progress stream defeats the
 * entire point.
 */
export function eventStream(request, env, { sessionId = null } = {}) {
  const { readable, writable } = new TransformStream();
  const writer  = writable.getWriter();
  const encoder = new TextEncoder();
  let closed = false;

  async function send(data, { event = null, id = null } = {}) {
    if (closed) return false;
    let frame = "";
    if (id) frame += `id: ${id}\n`;
    if (event) frame += `event: ${event}\n`;
    frame += `data: ${JSON.stringify(data)}\n\n`;
    try {
      await writer.write(encoder.encode(frame));
      return true;
    } catch {
      // The client hung up. Not an error worth surfacing: it is the normal
      // end of a stream whose reader closed the tab.
      closed = true;
      return false;
    }
  }

  async function close() {
    if (closed) return;
    closed = true;
    try { await writer.close(); } catch { /* already torn down */ }
  }

  const extra = {
    "content-type":  "text/event-stream",
    "cache-control": "no-cache, no-transform",
    "connection":    "keep-alive",
    "X-Accel-Buffering": "no",
  };
  if (sessionId) extra[MCP_SESSION_HEADER] = sessionId;

  return {
    response: new Response(readable, { status: 200, headers: mcpHeaders(request, env, extra) }),
    send,
    close,
  };
}

/** True when the client said it can read an SSE body. */
export function acceptsEventStream(request) {
  return (request.headers.get("Accept") || "").includes("text/event-stream");
}
