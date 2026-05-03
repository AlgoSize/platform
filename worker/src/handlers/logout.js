// POST /api/logout — revoke the current session.
//
// Auth is enforced by `requireAuth` middleware in the router, which attaches
// `request.token` after verifying the JWT against KV. We then:
//   1. Delete the SESSIONS KV row so the token can never be reused (defense
//      in depth — the cookie is also cleared, but a copied/leaked token in a
//      header would otherwise still pass verification until its 30-day exp).
//   2. Send Set-Cookie with Max-Age=0 so the browser drops the session cookie.
//
// The endpoint is idempotent: if the KV row is already gone (e.g. a double
// click), revokeJWT just calls KV.delete which is a no-op on missing keys.

import { revokeJWT, buildClearSessionCookie } from "../auth.js";

export async function logoutHandler(request, env) {
  if (request.token) {
    await revokeJWT(env, request.token);
  }
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: {
      "content-type": "application/json",
      "Set-Cookie": buildClearSessionCookie(env),
    },
  });
}
