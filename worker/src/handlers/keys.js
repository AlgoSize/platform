// API key management — the human side of Task #P-4.
//
//   POST   /api/keys        create a key, owner/admin only
//   GET    /api/keys        list the org's keys, owner/admin only
//   DELETE /api/keys/:id    revoke a key, owner/admin only
//
// Machine access to the analyzers goes through requireAuth in src/auth.js,
// which is where a presented key is actually verified on every request.
// Everything here is management: minting, listing, revoking. Same
// owner/admin gate as org.js's member management, and for the same reason —
// an API key is a standing credential against the org's data and its Stripe
// customer, so creating or revoking one is exactly as sensitive as adding or
// removing a member.

import { getActiveOrg, canManageMembers } from "./_orgs.js";
import { createApiKey, listApiKeys, getApiKey, revokeApiKey } from "./_api_keys.js";
import { auditFromRequest, AUDIT_ACTIONS } from "../audit.js";

const MAX_NAME_LEN = 100;

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * Resolve the caller's org, refusing anyone who isn't an owner or admin of
 * it. API-key requests are refused outright — a key cannot mint or revoke
 * keys for itself; managing keys requires a human owner or admin session, or
 * a compromised key could re-arm itself after being revoked.
 */
async function requireKeyManager(request, env) {
  if (request.authMethod === "api_key") {
    return {
      error: jsonResponse(
        { error: "forbidden", message: "API keys cannot manage API keys. Sign in to manage keys." },
        403,
      ),
    };
  }

  const sessionUser = request.user || {};
  if (!sessionUser.userId) {
    return { error: jsonResponse({ error: "unauthorized" }, 401) };
  }

  const active = await getActiveOrg(env, sessionUser.userId);
  if (!active) {
    return {
      error: jsonResponse(
        { error: "no_organisation", message: "This account is not a member of any organisation." },
        404,
      ),
    };
  }

  if (!canManageMembers(active.role)) {
    return {
      error: jsonResponse(
        { error: "forbidden", message: "Only an owner or admin can manage API keys.", role: active.role },
        403,
      ),
    };
  }

  return { org: active.org, role: active.role, userId: sessionUser.userId };
}

// ---------------------------------------------------------------------------
// POST /api/keys   body {name}
// ---------------------------------------------------------------------------
export async function createApiKeyHandler(request, env) {
  const ctxOrg = await requireKeyManager(request, env);
  if (ctxOrg.error) return ctxOrg.error;
  const { org, userId } = ctxOrg;

  let body;
  try { body = await request.json(); }
  catch { return jsonResponse({ error: "invalid_json", message: "Request body must be valid JSON." }, 400); }

  const name = body && typeof body.name === "string" ? body.name.trim() : "";
  if (!name || name.length > MAX_NAME_LEN) {
    return jsonResponse(
      { error: "invalid_name", message: `Give the key a name, up to ${MAX_NAME_LEN} characters — e.g. "CI — main branch".` },
      400,
    );
  }

  const { key, record } = await createApiKey(env, { orgId: org.orgId, name, createdBy: userId });

  // The PREFIX, never the key. This row is read by the admin panel and
  // exported; a log that reproduces the credential is a second place to
  // leak it from, and the prefix is all anyone needs to match a log line
  // to a key in the list.
  await auditFromRequest(request, env, null, {
    action:     AUDIT_ACTIONS.API_KEY_CREATED,
    targetType: "api_key",
    targetId:   record.keyId,
    orgId:      org.orgId,
    metadata:   { name: record.name, prefix: record.prefix },
  });

  return jsonResponse(
    {
      ok: true,
      key,
      message: "This is the only time the full key is shown. Store it now — it cannot be recovered later, only revoked and replaced.",
      keyId:      record.keyId,
      name:       record.name,
      prefix:     record.prefix,
      createdAt:  record.createdAt,
    },
    201,
  );
}

// ---------------------------------------------------------------------------
// GET /api/keys
// ---------------------------------------------------------------------------
export async function listApiKeysHandler(request, env) {
  const ctxOrg = await requireKeyManager(request, env);
  if (ctxOrg.error) return ctxOrg.error;

  // Never the key itself, never the hash — prefix + lifecycle timestamps
  // only. This is the whole reason the key isn't recoverable after creation:
  // if this list could show it, "shown once" would be a lie.
  const keys = await listApiKeys(env, ctxOrg.org.orgId);
  return jsonResponse({
    keys: keys.map((k) => ({
      keyId:      k.keyId,
      name:       k.name,
      prefix:     k.prefix,
      createdBy:  k.createdBy,
      createdAt:  k.createdAt,
      lastUsedAt: k.lastUsedAt,
      revokedAt:  k.revokedAt,
    })),
  });
}

// ---------------------------------------------------------------------------
// DELETE /api/keys/:id
// ---------------------------------------------------------------------------
export async function revokeApiKeyHandler(request, env) {
  const ctxOrg = await requireKeyManager(request, env);
  if (ctxOrg.error) return ctxOrg.error;

  const keyId = request.params && request.params.id;
  if (!keyId) {
    return jsonResponse({ error: "invalid_request", message: "No key id supplied." }, 400);
  }

  // Confirm the key belongs to THIS org before touching it — revokeApiKey
  // already scopes its UPDATE the same way, but checking first lets us
  // return the more accurate 404 rather than a generic "nothing changed".
  const existing = await getApiKey(env, ctxOrg.org.orgId, keyId);
  if (!existing) {
    return jsonResponse({ error: "not_found", message: "No API key with that id on this organisation." }, 404);
  }
  if (existing.revokedAt !== null) {
    return jsonResponse({ ok: true, keyId, alreadyRevoked: true });
  }

  const revoked = await revokeApiKey(env, ctxOrg.org.orgId, keyId);

  await auditFromRequest(request, env, null, {
    action:     AUDIT_ACTIONS.API_KEY_REVOKED,
    targetType: "api_key",
    targetId:   keyId,
    orgId:      ctxOrg.org.orgId,
    metadata:   { name: existing.name, prefix: existing.prefix },
  });

  return jsonResponse({ ok: true, keyId, revoked });
}
