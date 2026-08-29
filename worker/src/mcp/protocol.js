// JSON-RPC 2.0 framing for the MCP endpoint, and nothing else.
//
// This module is deliberately ignorant of Algosize. It knows how to tell a
// request from a notification, how to shape a result, and which protocol
// revisions we answer to — no tools, no auth, no database. Everything that
// knows what a "run" is lives above it. Keeping the envelope layer pure is
// what lets the protocol tests run without a D1 stub or a fake org.
//
// Two framing rules from the spec are easy to get wrong and expensive to get
// wrong, so they are encoded here rather than left to each call site:
//
//   1. A message with no `id` is a NOTIFICATION. It gets no response, ever —
//      not even an error. Answering one is a protocol violation that some
//      hosts treat as a fatal desync.
//   2. `id: 0` and `id: ""` are valid ids. Testing `if (msg.id)` drops both
//      and turns a real request into a silently-ignored notification, which
//      then reads to the client as a hung call.

export const LATEST_PROTOCOL_VERSION = "2025-06-18";

// Newest first. `negotiateVersion` walks this in order, so the head of the
// list is what an unversioned or unrecognised client gets.
export const SUPPORTED_PROTOCOL_VERSIONS = Object.freeze([
  "2025-06-18",
  "2025-03-26",
  "2024-11-05",
]);

// The header a Streamable HTTP client sends to pin the revision it speaks.
export const MCP_PROTOCOL_HEADER = "MCP-Protocol-Version";

/** JSON-RPC 2.0 reserved error codes, plus the MCP-specific range we use. */
export const RPC = Object.freeze({
  PARSE_ERROR:      -32700,
  INVALID_REQUEST:  -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS:   -32602,
  INTERNAL_ERROR:   -32603,
  // -32000..-32099 is the implementation-defined server range. These three
  // are ours, and they are transport-level failures only: a tool that runs
  // and fails returns an isError RESULT, never one of these. The distinction
  // matters because a host renders a JSON-RPC error as "the connection is
  // broken" and a model cannot recover from it, whereas an isError result is
  // just information the model can read and act on.
  UNSUPPORTED_VERSION: -32000,
  UNAUTHORIZED_SCOPE:  -32003,
  SESSION_REQUIRED:    -32001,
});

/** Message kinds `parseMessage` can return. */
export const MSG = Object.freeze({
  REQUEST:      "request",
  NOTIFICATION: "notification",
  RESPONSE:     "response",
  INVALID:      "invalid",
});

/** Every method name we dispatch on, in one place so typos surface here. */
export const METHOD = Object.freeze({
  INITIALIZE:          "initialize",
  INITIALIZED:         "notifications/initialized",
  PING:                "ping",
  TOOLS_LIST:          "tools/list",
  TOOLS_CALL:          "tools/call",
  RESOURCES_LIST:      "resources/list",
  RESOURCES_TEMPLATES: "resources/templates/list",
  RESOURCES_READ:      "resources/read",
  PROMPTS_LIST:        "prompts/list",
  PROMPTS_GET:         "prompts/get",
  LOGGING_SET_LEVEL:   "logging/setLevel",
  COMPLETION_COMPLETE: "completion/complete",
});

// Shown to the model by hosts that surface server instructions. Written for a
// model rather than a human: it exists to stop the two failure modes that cost
// a customer real money — burning metered runs by re-analysing something
// already in history, and calling the share tool without realising it mints a
// link anyone can open.
export const SERVER_INSTRUCTIONS =
  "Algosize analyses codebases and infrastructure: dependency vulnerabilities, " +
  "cloud and infrastructure cost, algorithmic complexity, and architecture. " +
  "Analysis tools consume the organisation's monthly run allowance — before " +
  "starting a new analysis, check algosize_list_runs for a recent result that " +
  "already answers the question. Read-only tools are free; use them freely. " +
  "algosize_share_run creates a link that anyone who has it can open, so only " +
  "call it when the user has asked for something shareable.";

/**
 * Classify and shallow-validate one incoming JSON-RPC message.
 *
 * Returns `{ kind, id, method, params }`. `kind` is one of MSG.*; for
 * MSG.INVALID a `reason` explains what was wrong so the caller can put
 * something actionable in the error rather than "invalid request".
 *
 * `id` is returned verbatim, including 0 and "", because both are legal and
 * both must be echoed back exactly as sent.
 */
export function parseMessage(msg) {
  if (msg === null || typeof msg !== "object" || Array.isArray(msg)) {
    return { kind: MSG.INVALID, id: null, reason: "message must be a JSON object" };
  }
  if (msg.jsonrpc !== "2.0") {
    return { kind: MSG.INVALID, id: msg.id ?? null, reason: 'jsonrpc must be "2.0"' };
  }

  // A response carries result/error and never a method. We accept these so a
  // batch containing them can be acknowledged with 202 rather than rejected;
  // we never act on one, because this server sends no requests to the client.
  const hasMethod = typeof msg.method === "string" && msg.method.length > 0;
  if (!hasMethod) {
    if ("result" in msg || "error" in msg) {
      return { kind: MSG.RESPONSE, id: msg.id ?? null };
    }
    return { kind: MSG.INVALID, id: msg.id ?? null, reason: "missing method" };
  }

  // `params` is optional; when present it must be structured. A string or
  // number here means the client is malformed, and letting it through would
  // surface much later as a confusing property access on a primitive.
  const params = msg.params;
  if (params !== undefined && (params === null || typeof params !== "object")) {
    return { kind: MSG.INVALID, id: msg.id ?? null, reason: "params must be an object or array" };
  }

  // The id test is `in`, not truthiness — see the header note on id 0 and "".
  const isRequest = "id" in msg && msg.id !== null;
  return {
    kind:   isRequest ? MSG.REQUEST : MSG.NOTIFICATION,
    id:     isRequest ? msg.id : null,
    method: msg.method,
    params: params === undefined ? {} : params,
  };
}

/** A JSON-RPC success envelope. */
export function rpcResult(id, result) {
  return { jsonrpc: "2.0", id, result };
}

/**
 * A JSON-RPC error envelope.
 *
 * Reach for this only for transport-level faults — a method that does not
 * exist, params that cannot be parsed, a scope the caller does not hold. A
 * tool that ran and failed is a SUCCESSFUL rpc call carrying an isError
 * result; see the note on RPC above.
 */
export function rpcError(id, code, message, data) {
  const error = { code, message };
  if (data !== undefined) error.data = data;
  return { jsonrpc: "2.0", id, error };
}

/**
 * The same thing for a message we could not even attribute to an id.
 *
 * The spec is explicit that a parse failure is answered with `id: null`,
 * because there is no id to echo — the bytes never parsed.
 */
export function rpcErrorResponse(code, message, data) {
  return rpcError(null, code, message, data);
}

/**
 * Pick the revision to speak.
 *
 * Returns `{ ok: true, version }` when we can talk to the client, and
 * `{ ok: false, supported }` when we cannot. We do NOT silently downgrade an
 * unknown future revision to our latest: a client asking for a revision we
 * have never seen may depend on framing we do not implement, and answering
 * it in an older dialect produces a confusing partial failure much later
 * instead of one clear message at connect time.
 */
export function negotiateVersion(clientVersion) {
  // No version offered at all is the pre-negotiation default the spec allows;
  // it means "assume the oldest thing you support" in the HTTP header case,
  // but on `initialize` it means an old client, so we answer with our latest
  // and let capability negotiation sort out the rest.
  if (!clientVersion) return { ok: true, version: LATEST_PROTOCOL_VERSION };
  if (SUPPORTED_PROTOCOL_VERSIONS.includes(clientVersion)) {
    return { ok: true, version: clientVersion };
  }
  return { ok: false, supported: [...SUPPORTED_PROTOCOL_VERSIONS] };
}

/**
 * What this server can do.
 *
 * `listChanged` is true for tools and resources because both genuinely change
 * within a live session: a plan upgrade widens the tool list, and a finished
 * analyzer run adds a resource. `subscribe` is false — we do not hold
 * per-resource subscriptions, and advertising one we do not honour would have
 * clients waiting on updates that never arrive.
 */
export function serverCapabilities() {
  return {
    tools:     { listChanged: true },
    resources: { subscribe: false, listChanged: true },
    prompts:   { listChanged: false },
    logging:   {},
  };
}

/** Identity reported in the `initialize` result. */
export function serverInfo() {
  return { name: "algosize", title: "Algosize", version: SERVER_VERSION };
}

// Bumped by hand when the MCP surface changes in a way a client could notice
// — a tool added or removed, a schema tightened. It is not the product
// version: the Worker ships many times without the MCP contract moving.
export const SERVER_VERSION = "1.0.0";
