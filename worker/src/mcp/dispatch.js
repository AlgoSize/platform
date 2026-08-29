// The one and only bridge from an MCP tool into the product.
//
// Every tool reaches Algosize through `callHandler` and through nothing else.
// `scripts/test-mcp-purity.mjs` fails the build if a file under tools/ imports
// an analyzer, `enforceQuota`, `entitlement.js`, or touches `env.DB` — so this
// is a structural guarantee rather than a convention people remember.
//
// Why it takes the middleware chain as an argument
// ------------------------------------------------
// The caller passes the SAME chain `index.js` registers for that route, minus
// `requireAuth` (the request is already authenticated by the time a tool runs)
// and minus the rate limiters (the MCP envelope has its own, and running the
// HTTP limiter here would meter one call against two buckets). For
// /api/analyze/cost that means `[enforceQuota(analyzeCostHandler)]`.
//
// Passing the chain explicitly is what makes the quota guarantee real. An
// earlier draft of this module re-entered the whole router with a
// `_mcpDispatch` flag and asked the router to skip auth for flagged requests.
// That is a deliberate authentication bypass living in the main request path,
// one property assignment away from being reachable from outside — and it did
// not work anyway, because index.js has no such export. Handing the chain in
// keeps the bypass from existing at all: this module can only ever run
// exactly the functions its caller named.
//
// The synthetic request is a real `Request`
// -----------------------------------------
// Not a mock. Handlers read `request.json()`, `request.headers`, and
// `new URL(request.url)`, and a stand-in object would drift from that the
// first time a handler reached for something the mock lacked.

// Identity is copied field by field rather than by spreading the original
// request, because these are exactly the fields `requireAuth` sets and the
// list doubles as documentation of the trust boundary. Anything not named
// here does NOT cross into the synthetic request — notably the caller's
// Authorization header, which a downstream handler has no business re-reading.
const IDENTITY_FIELDS = ["user", "org", "authMethod", "apiKeyId", "mcpScopes", "mcpTokenId"];

// Handlers that reject oversized input do so on their own; this is a floor
// under the whole MCP surface so a client cannot force us to serialise an
// unbounded body into memory before any handler gets a chance to refuse it.
const MAX_BODY_BYTES = 8 * 1024 * 1024;

/**
 * Run one existing route handler chain as if it had been reached over HTTP.
 *
 * @param {Function[]} chain  The route's middleware chain, in order, minus
 *                            requireAuth and minus rate limiters. Each entry
 *                            is `(request, env, ctx)` and follows itty-router
 *                            semantics: return a Response to short-circuit,
 *                            return undefined to fall through to the next.
 * @param {object}     o
 * @param {string}     o.method  HTTP method.
 * @param {string}     o.path    Path only, e.g. "/api/runs".
 * @param {object}     [o.query] Serialised onto the URL's search string.
 * @param {object}     [o.params] Path params, as itty-router would have parsed
 *                                them (`/api/runs/:id` → `{ id }`).
 * @param {object}     [o.body]  JSON body. Omitted entirely for GET/DELETE.
 * @param {Request}    o.request The authenticated MCP request, for identity.
 * @returns {Promise<{status:number, ok:boolean, json:object|null, text:string, response:Response}>}
 */
export async function callHandler(chain, { method, path, query, params, body, request, env, ctx }) {
  const url = new URL(path, "https://mcp.internal.invalid");
  for (const [k, v] of Object.entries(query || {})) {
    // Undefined means "the tool did not supply this optional filter" and must
    // not become the literal string "undefined" in the query — handlers that
    // check `searchParams.has(...)` would then see a filter nobody asked for.
    if (v === undefined || v === null) continue;
    url.searchParams.set(k, String(v));
  }

  const init = { method, headers: new Headers() };
  if (body !== undefined && body !== null && method !== "GET" && method !== "DELETE") {
    const serialised = JSON.stringify(body);
    if (serialised.length > MAX_BODY_BYTES) {
      return synthetic(413, { error: "payload_too_large", message: "Input exceeds the maximum accepted size." });
    }
    init.body = serialised;
    init.headers.set("content-type", "application/json");
  }

  const synthReq = new Request(url.toString(), init);

  for (const field of IDENTITY_FIELDS) {
    if (request && request[field] !== undefined) synthReq[field] = request[field];
  }
  // itty-router populates these on a real request; handlers read them directly.
  synthReq.params = params || {};
  synthReq.query  = Object.fromEntries(url.searchParams.entries());

  let response = null;
  for (const step of chain) {
    const out = await step(synthReq, env, ctx);
    // itty-router's contract: a Response ends the chain, anything else
    // (including undefined) continues it. enforceQuota returning a 402 is
    // exactly this case, and it is the reason the chain runs in order rather
    // than the handler being called directly.
    if (out instanceof Response) { response = out; break; }
  }

  if (!response) {
    // A chain that fell through without producing a Response is a wiring bug
    // in the tool, not a customer-visible condition. Reported as a 500 with a
    // named reason so the tool surfaces something honest rather than reading
    // an empty body as success.
    return synthetic(500, { error: "no_response", message: `No handler in the chain for ${method} ${path} returned a response.` });
  }

  return await readResponse(response);
}

/**
 * Read a handler's Response into the shape tools consume.
 *
 * The body is read once and kept as both text and parsed JSON, because the
 * caller cannot read it twice and some routes (the markdown report) are
 * legitimately not JSON. `json` is null in that case rather than throwing —
 * a tool asking for markdown should not have to guard against a parse error
 * for the normal path.
 */
async function readResponse(response) {
  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { status: response.status, ok: response.ok, json, text, response };
}

function synthetic(status, payload) {
  const text = JSON.stringify(payload);
  return {
    status,
    ok: false,
    json: payload,
    text,
    response: new Response(text, { status, headers: { "content-type": "application/json" } }),
  };
}
