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
    // The user id comes from requireAuth, which has already resolved it — so
    // the per-user session index entry is dropped alongside the session
    // rather than lingering as an orphan that reads as a live device.
    await revokeJWT(env, request.token, request.user && request.user.userId);
  }
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: {
      "content-type": "application/json",
      "Set-Cookie": buildClearSessionCookie(env),
    },
  });
}
