/**
 * Streamable HTTP transport for MCP 2025-06-18.
 * Handles origin validation, request routing, and SSE upgrade.
 */

import { rpcError, RPC_ERRORS } from './protocol.js';

// Origins allowed to call /api/mcp from a browser context.
// Native clients and CLI tools send no Origin header — those are always allowed.
const FIRST_PARTY_ORIGINS = [
  'https://claude.ai',
];
const ANTHROPIC_ORIGIN_RE = /^https:\/\/[a-z0-9-]+\.anthropic\.com$/;

/**
 * Check the Origin header for DNS-rebinding protection.
 * Returns true if the request is allowed to proceed.
 */
export function checkOrigin(request, env) {
  const origin = request.headers.get('Origin');
  // No Origin header → native client or curl → always allowed
  if (!origin) return true;
  // First-party site
  if (env.SITE_ORIGIN && origin === env.SITE_ORIGIN) return true;
  // Claude.ai and *.anthropic.com
  if (FIRST_PARTY_ORIGINS.includes(origin)) return true;
  if (ANTHROPIC_ORIGIN_RE.test(origin)) return true;
  return false;
}

/**
 * Build CORS headers for an allowed origin.
 */
export function mcpCorsHeaders(request) {
  const origin = request.headers.get('Origin') ?? '*';
  return {
    'Access-Control-Allow-Origin':  origin,
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type, Mcp-Session-Id, Mcp-Protocol-Version',
    'Access-Control-Expose-Headers': 'Mcp-Session-Id',
    'Access-Control-Max-Age': '86400',
  };
}

/**
 * Send a single JSON-RPC response (the common case).
 */
export function jsonResponse(payload, extraHeaders = {}) {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      ...extraHeaders,
    },
  });
}

/**
 * Open an SSE stream and return { response, send, close }.
 * Used for long-running operations (architecture scans) that emit
 * progress notifications before the final result.
 */
export function openSseStream(extraHeaders = {}) {
  let controller;
  const stream = new ReadableStream({
    start(c) { controller = c; },
  });
  const response = new Response(stream, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'X-Accel-Buffering': 'no',
      ...extraHeaders,
    },
  });
  const enc = new TextEncoder();
  function send(event, data) {
    const line = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    controller.enqueue(enc.encode(line));
  }
  function close() { controller.close(); }
  return { response, send, close };
}

/**
 * Extract and validate the Mcp-Protocol-Version header.
 * Returns the version string or null.
 */
export function extractProtocolVersion(request) {
  return request.headers.get('Mcp-Protocol-Version') ?? null;
}

/**
 * Extract the Mcp-Session-Id header.
 */
export function extractSessionId(request) {
  return request.headers.get('Mcp-Session-Id') ?? null;
}

/**
 * Build a 403 response for rejected origins.
 */
export function originForbidden() {
  return new Response(
    JSON.stringify(rpcError(null, RPC_ERRORS.INTERNAL_ERROR, 'Origin not allowed')),
    { status: 403, headers: { 'Content-Type': 'application/json' } }
  );
}
