/**
 * mcpAuth middleware — composed AFTER requireAuth.
 *
 * Flow:
 *  1. requireAuth already ran. If it set request.org, grant all 3 scopes.
 *  2. If requireAuth returned 401 and bearer starts with `ask_mcp_`,
 *     resolve against mcp_tokens, set identity fields.
 *  3. Otherwise → 401 with WWW-Authenticate pointing to the resource metadata.
 */

const ALL_SCOPES = ['algosize:read', 'algosize:analyze', 'algosize:manage'];

/**
 * Resolve an ask_mcp_ bearer token against the DB.
 * Returns the token row or null.
 */
async function resolveMcpToken(env, rawToken) {
  const { sha256Hex } = await import('../auth.js');
  const hash = await sha256Hex(rawToken);
  const row = await env.DB.prepare(
    `SELECT t.token_id, t.org_id, t.user_id, t.scope, t.expires_at, t.revoked_at, t.client_id
       FROM mcp_tokens t
      WHERE t.token_hash = ? AND t.token_type = 'access'`
  ).bind(hash).first();
  if (!row) return null;
  if (row.revoked_at) return null;
  if (row.expires_at < Math.floor(Date.now() / 1000)) return null;
  // Update last_used_at (best-effort, don't await)
  env.DB.prepare('UPDATE mcp_tokens SET last_used_at = ? WHERE token_id = ?')
    .bind(Math.floor(Date.now() / 1000), row.token_id)
    .run();
  return row;
}

/**
 * mcpAuth — call after requireAuth.
 *
 * On success, attaches to the request object:
 *   request.mcpScopes    — string[]
 *   request.authMethod   — 'api_key' | 'mcp_oauth' | 'session'
 *   request.mcpTokenId   — string | null
 *
 * Returns a 401 Response if auth fails, or null to continue.
 */
export async function mcpAuth(request, env) {
  // Case 1: requireAuth already authenticated (api_key or cookie session)
  if (request.org) {
    request.mcpScopes  = ALL_SCOPES;
    request.authMethod = request.user?.userId ? 'session' : 'api_key';
    request.mcpTokenId = null;
    return null; // proceed
  }

  // Case 2: MCP OAuth token
  const authHeader = request.headers.get('Authorization') ?? '';
  const bearerMatch = authHeader.match(/^Bearer\s+(ask_mcp_[A-Za-z0-9_-]+)$/);
  if (bearerMatch) {
    const token = await resolveMcpToken(env, bearerMatch[1]);
    if (token) {
      // Load org
      const org = await env.DB.prepare('SELECT * FROM orgs WHERE id = ?').bind(token.org_id).first();
      if (org) {
        request.org          = org;
        request.user         = token.user_id ? { userId: token.user_id } : null;
        request.authMethod   = 'mcp_oauth';
        request.mcpScopes    = token.scope.split(' ');
        request.mcpTokenId   = token.token_id;
        return null; // proceed
      }
    }
  }

  // Case 3: Unauthenticated → 401 with resource metadata hint
  const resourceMeta = `${env.SITE_ORIGIN ?? ''}/.well-known/oauth-protected-resource`;
  return new Response(
    JSON.stringify({ error: 'unauthorized', error_description: 'Valid bearer token required' }),
    {
      status: 401,
      headers: {
        'Content-Type': 'application/json',
        'WWW-Authenticate': `Bearer resource_metadata="${resourceMeta}"`,
      },
    }
  );
}

/**
 * Assert that the authenticated request has a required scope.
 * Returns a JSON-RPC scope error object, or null if the scope is present.
 */
export function assertScope(request, requiredScope) {
  const scopes = request.mcpScopes ?? [];
  if (scopes.includes(requiredScope)) return null;
  return {
    code: -32003,
    message: `Scope required: ${requiredScope}`,
    data: { required: requiredScope, granted: scopes },
  };
}
