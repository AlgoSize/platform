// Authentication for the MCP endpoint.
//
// Composed AFTER requireAuth rather than replacing it. That ordering is the
// whole design: an `ask_live_` key or a browser cookie is resolved by exactly
// the code every other route uses — same hashing, same revocation check, same
// per-org rate limiting, same `last_used_at` bump — and this module only adds
// the third credential type the product did not have before.
//
// The alternative, a parallel auth path that "also understands API keys",
// would mean two implementations of the most security-sensitive function in
// the codebase, drifting apart on the next change. There is one.

import { resolveAccessToken, hasScope, ALL_SCOPES, MCP_TOKEN_TAG } from "./tokens.js";
import { protectedResourceMetadataUrl } from "./metadata.js";

function bearerOf(request) {
  const raw = request.headers.get("Authorization") || "";
  const m = raw.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : null;
}

/**
 * Resolve the caller, or return a 401 the client can act on.
 *
 * Returns null on success (itty-router's "continue" signal) after setting
 * `request.mcpScopes`, `request.authMethod`, and — for the OAuth path —
 * `request.org` / `request.user` / `request.mcpTokenId`.
 *
 * Scope granting differs by credential, and the asymmetry is deliberate:
 *
 *   API key    → all three scopes. The key already authorises every one of
 *                these operations over plain HTTP; refusing them over MCP
 *                would be theatre, not security.
 *   Cookie     → all three scopes. Same reasoning, and it lets the dashboard's
 *                own MCP inspector work without minting a token.
 *   OAuth      → exactly the scopes the user consented to, and no more. This
 *                is the only credential where the granting party is a person
 *                making a decision on a consent screen, so it is the only one
 *                where a narrower grant is meaningful.
 */
export async function mcpAuth(request, env, ctx) {
  // requireAuth ran first and succeeded. `org` is set for API keys; `user` for
  // cookie sessions. Either is a fully authorised caller.
  if (request.org || request.user) {
    request.mcpScopes  = [...ALL_SCOPES];
    request.authMethod = request.authMethod || (request.org ? "api_key" : "session");
    request.mcpTokenId = null;
    return null;
  }

  const bearer = bearerOf(request);
  if (bearer && bearer.startsWith(MCP_TOKEN_TAG)) {
    const token = await resolveAccessToken(env, bearer);
    if (token && token.valid) {
      // Only the org id is attached, matching exactly what requireAuth's
      // API-key path sets. An earlier draft selected the whole organisation
      // row and assigned it to `request.org`, which is both a wider object
      // than any handler wants and a query against a table that does not
      // exist under that name (`organisations`, not `orgs`). Downstream code
      // reads `request.org.orgId` and nothing else.
      request.org        = { orgId: token.org_id };
      request.user       = token.user_id ? { userId: token.user_id } : undefined;
      request.authMethod = "mcp_oauth";
      request.mcpScopes  = String(token.scope || "").split(/\s+/).filter(Boolean);
      request.mcpTokenId = token.token_id;
      return null;
    }
  }

  return unauthorized(request, env);
}

/**
 * The 401 that starts an OAuth flow.
 *
 * `WWW-Authenticate: Bearer resource_metadata="…"` is the entire mechanism by
 * which a host discovers it can authenticate at all. Without this header a
 * spec-compliant client reports "unauthorized" and stops; with it, the client
 * fetches the metadata, registers, and runs PKCE unattended. It is one header
 * and it is the difference between a connector that works and one that does
 * not, so it is centralised here rather than repeated at each call site.
 */
export function unauthorized(request, env, description = "A valid bearer token is required.") {
  return new Response(
    JSON.stringify({ error: "unauthorized", error_description: description }),
    {
      status: 401,
      headers: {
        "content-type": "application/json",
        "WWW-Authenticate":
          `Bearer realm="algosize", resource_metadata="${protectedResourceMetadataUrl(request, env)}"`,
      },
    },
  );
}

/** Does the authenticated request hold `scope`? */
export function requestHasScope(request, scope) {
  return hasScope(request.mcpScopes || [], scope);
}

/**
 * The identity a tool call is attributed to.
 *
 * Everything downstream — the quota meter, the usage row, the run's
 * provenance — keys off the ORG, never the person. That matches how the rest
 * of the product bills and stores: an API key belongs to the organisation, a
 * run belongs to the organisation, and a member leaving must not orphan
 * either. `userId` rides along only for the audit trail on OAuth grants,
 * where a specific person did click approve.
 */
export function identityOf(request) {
  return {
    orgId:      request.org && request.org.orgId ? request.org.orgId : null,
    userId:     request.user && request.user.userId ? request.user.userId : null,
    authMethod: request.authMethod || "unknown",
    scopes:     request.mcpScopes || [],
    tokenId:    request.mcpTokenId || null,
    apiKeyId:   request.apiKeyId || null,
  };
}
