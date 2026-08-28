/**
 * dispatch.js — the ONLY bridge between MCP tools and existing route handlers.
 *
 * Tools call callHandler() exclusively. No tool may import enforceQuota,
 * resolveEntitlement, env.DB, or any analyzer module directly.
 * This structural constraint is verified by scripts/test-mcp-purity.mjs.
 */

/**
 * Build a synthetic Request that looks like what the existing HTTP handlers
 * expect, then run it through the same middleware chain.
 *
 * @param {object} env            - Worker env bindings
 * @param {object} ctx            - Worker ExecutionContext
 * @param {object} identity       - { org, user, authMethod, mcpScopes, mcpTokenId }
 * @param {string} method         - HTTP method (GET, POST, PATCH, DELETE)
 * @param {string} path           - URL path, e.g. '/api/runs'
 * @param {object|null} body      - Request body (will be JSON-serialised)
 * @param {object} [params={}]    - Path parameters, merged onto request.params
 * @returns {Promise<{status, body, headers}>}
 */
export async function callHandler(env, ctx, identity, method, path, body = null, params = {}) {
  const url = `https://internal.algosize.invalid${path}`;
  const init = { method };
  if (body !== null) {
    init.body    = JSON.stringify(body);
    init.headers = { 'Content-Type': 'application/json' };
  }
  const syntheticReq = new Request(url, init);

  // Attach identity fields that requireAuth would normally set
  syntheticReq._mcpDispatch = true;
  syntheticReq._identity    = identity;   // { org, user, authMethod, mcpScopes, mcpTokenId }
  syntheticReq._params      = params;

  // Import and run the main router. It will detect _mcpDispatch and
  // skip the network-level auth middleware, using _identity instead.
  const { handleRequest } = await import('../index.js');
  const response = await handleRequest(syntheticReq, env, ctx);

  const responseBody    = await response.text();
  const responseHeaders = Object.fromEntries(response.headers.entries());
  return {
    status:  response.status,
    body:    responseBody,
    headers: responseHeaders,
  };
}

/**
 * Parse a callHandler response body as JSON.
 * Returns { ok, data, error } — never throws.
 */
export function parseResponse(result) {
  try {
    const data = JSON.parse(result.body);
    const ok   = result.status >= 200 && result.status < 300;
    return { ok, status: result.status, data, error: ok ? null : data };
  } catch {
    return { ok: false, status: result.status, data: null, error: { message: result.body } };
  }
}
