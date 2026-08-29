// OAuth 2.1 discovery documents.
//
// These two JSON files are what turn a 401 into a working connection. A
// spec-compliant MCP host that gets `WWW-Authenticate: Bearer
// resource_metadata="…"` fetches the protected-resource document, follows it
// to the authorization server, reads this metadata, registers itself, and
// runs the PKCE flow — with no configuration from the user beyond a URL.
// Get these wrong and the host simply reports "authentication failed" with
// nothing actionable, so every field here is one a client actually reads.
//
// Why the issuer is derived from the request rather than hard-coded
// ----------------------------------------------------------------
// Staging and production are the same code with different hostnames, and an
// issuer that says `algosize.com` while serving from `staging.algosize.com`
// fails validation in any client that checks — which the spec requires them
// to do. Deriving it from the request URL keeps the two environments honest
// without a per-environment constant to forget.

import { ALL_SCOPES } from "./tokens.js";

/**
 * The issuer origin for this request.
 *
 * `env.SITE_ORIGIN` wins when set, because it is the canonical public origin
 * and the request may have arrived through an internal hostname. The request
 * URL is the fallback so `wrangler dev` works with no configuration at all.
 */
export function issuerFor(request, env) {
  if (env && env.MCP_ISSUER) return String(env.MCP_ISSUER).replace(/\/+$/, "");
  if (env && env.SITE_ORIGIN) return String(env.SITE_ORIGIN).replace(/\/+$/, "");
  try {
    return new URL(request.url).origin;
  } catch {
    return "https://algosize.com";
  }
}

/** Where the protected-resource document lives, for the WWW-Authenticate hint. */
export function protectedResourceMetadataUrl(request, env) {
  return `${issuerFor(request, env)}/.well-known/oauth-protected-resource`;
}

/**
 * RFC 8414 authorization-server metadata.
 *
 * `code_challenge_methods_supported` lists S256 and only S256. OAuth 2.1
 * removes `plain`, and advertising it would invite a client to use a
 * challenge that is not a challenge — the verifier and the challenge being
 * the same string means an intercepted authorization code is directly
 * redeemable.
 */
export function authorizationServerMetadata(request, env) {
  const issuer = issuerFor(request, env);
  return {
    issuer,
    authorization_endpoint: `${issuer}/api/mcp/oauth/authorize`,
    token_endpoint:         `${issuer}/api/mcp/oauth/token`,
    registration_endpoint:  `${issuer}/api/mcp/oauth/register`,
    revocation_endpoint:    `${issuer}/api/mcp/oauth/revoke`,
    scopes_supported:       [...ALL_SCOPES],
    response_types_supported: ["code"],
    grant_types_supported:    ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none", "client_secret_post"],
    // RFC 8707. The client names the resource it wants a token for, and the
    // token endpoint checks it — that is what stops a token minted for one
    // MCP server being replayed against another.
    resource_indicators_supported: true,
    service_documentation: `${issuer}/docs/mcp`,
  };
}

/**
 * RFC 9728 protected-resource metadata.
 *
 * `resource` must be the MCP endpoint itself, not the site root: it is the
 * identifier a client puts in the `resource` parameter, and a mismatch there
 * is rejected at the token endpoint.
 */
export function protectedResourceMetadata(request, env) {
  const issuer = issuerFor(request, env);
  return {
    resource: `${issuer}/api/mcp`,
    authorization_servers: [issuer],
    scopes_supported: [...ALL_SCOPES],
    bearer_methods_supported: ["header"],
    resource_documentation: `${issuer}/docs/mcp`,
  };
}

/**
 * Serve a metadata document.
 *
 * Public, unauthenticated and CORS-open by necessity — a browser-based host
 * fetches these before it has any credential to present, and a document that
 * requires auth to discover how to authenticate is a loop. They contain no
 * secrets: every value is a public URL or a scope name.
 *
 * Cached for five minutes. Long enough to absorb a client that re-fetches on
 * every connection attempt, short enough that flipping an environment
 * variable takes effect while someone is still watching the deploy.
 */
export function metadataResponse(doc) {
  return new Response(JSON.stringify(doc, null, 2), {
    status: 200,
    headers: {
      "content-type": "application/json",
      "cache-control": "public, max-age=300",
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET, OPTIONS",
      "access-control-allow-headers": "Content-Type, Authorization",
    },
  });
}
