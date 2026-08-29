// The MCP endpoint: JSON-RPC dispatch over Streamable HTTP.
//
// One route (`/api/mcp`) serves POST, GET and DELETE. This file owns the
// things a tool must never do for itself — scope enforcement, plan gating,
// telemetry — so that a tool is only ever a description plus an adapter, and
// forgetting a check in one of twenty tools is not possible.

import {
  MSG, METHOD, RPC, parseMessage, rpcResult, rpcError, rpcErrorResponse,
  negotiateVersion, serverCapabilities, serverInfo, SERVER_INSTRUCTIONS,
  SUPPORTED_PROTOCOL_VERSIONS, MCP_PROTOCOL_HEADER,
} from "../mcp/protocol.js";
import {
  originAllowed, mcpHeaders, jsonRpcResponse, transportError,
  acceptsEventStream, MCP_SESSION_HEADER,
} from "../mcp/transport.js";
import {
  createSession, getSession, updateSession, deleteSession, assertSessionOwner,
} from "../mcp/session.js";
import { identityOf, requestHasScope } from "../mcp/auth.js";
import {
  getTool, listTools, publicTool, listResources, listResourceTemplates,
  matchResource, listPrompts, getPrompt, TOOL_GROUPS, TOOLS,
} from "../mcp/registry.js";
import { logToolCall, usageSummary, OUTCOME } from "../mcp/telemetry.js";
import { listConnections, revokeClientTokens } from "../mcp/tokens.js";
import { resolveEntitlementForOrg } from "../entitlement.js";
import { captureException } from "../observability.js";
import { isFlagEnabled } from "../flags.js";
import { makeApiKeyRateLimit } from "../middleware/rate-limit.js";

// A second, tighter bucket for calls that spend money.
//
// The envelope limiter in index.js allows 120 requests a minute per
// credential, which is right for a conversational client doing a dozen reads
// per turn. It is the wrong number for ANALYSES: 120 metered calls in a minute
// would burn a free plan's entire monthly allowance twenty-four times over,
// and a paid plan's real compute along with it.
//
// So this exists to protect the CUSTOMER'S allowance from a looping client,
// not to protect the server. A well-behaved assistant never comes near 20
// analyses a minute — that rate only happens when something is retrying in a
// loop, which is exactly when the bill should stop growing.
//
// Its own keyName, so it counts separately from the envelope limit rather
// than sharing a bucket with the reads.
const meteredToolRateLimit = makeApiKeyRateLimit({
  keyName: "mcp_metered", limit: 20, windowSec: 60,
});

/**
 * Is the MCP surface on for this org?
 *
 * Defaults OFF unless the environment says otherwise, so merging this branch
 * changes nothing in production until the runbook flips it. `MCP_ENABLED` is
 * the environment-wide switch; the `mcp.enabled` flag allows a per-org
 * rollout on top of it.
 */
async function mcpEnabled(env, ctx, orgId) {
  if (String(env.MCP_ENABLED || "").toLowerCase() === "true") return true;
  try {
    return await isFlagEnabled(env, ctx, "mcp.enabled", orgId);
  } catch {
    // A flag lookup that fails must not open a surface that is meant to be
    // closed. Fail shut.
    return false;
  }
}

function disabled(request, env) {
  return transportError(request, env, 404, "not_found",
    "The MCP endpoint is not enabled for this account.");
}

// ---------------------------------------------------------------------------
// POST /api/mcp
// ---------------------------------------------------------------------------
export async function mcpPostHandler(request, env, ctx) {
  if (!originAllowed(request, env)) {
    return transportError(request, env, 403, "forbidden_origin",
      "This origin is not allowed to reach the MCP endpoint.");
  }
  const identity = identityOf(request);
  if (!(await mcpEnabled(env, ctx, identity.orgId))) return disabled(request, env);

  let payload;
  try {
    payload = await request.json();
  } catch {
    return jsonRpcResponse(
      rpcErrorResponse(RPC.PARSE_ERROR, "Request body is not valid JSON."),
      request, env, { status: 400 },
    );
  }

  const batch    = Array.isArray(payload);
  const messages = batch ? payload : [payload];
  if (batch && messages.length === 0) {
    return jsonRpcResponse(
      rpcErrorResponse(RPC.INVALID_REQUEST, "A batch must contain at least one message."),
      request, env, { status: 400 },
    );
  }

  // The session, if one was presented. `initialize` is the only method allowed
  // to arrive without it.
  const sessionId = request.headers.get(MCP_SESSION_HEADER);
  let session = sessionId ? await getSession(env, sessionId) : null;
  if (sessionId && !session) {
    // 404 is specified: it tells a client its session is gone and it should
    // re-initialize, which is recoverable. A 400 would read as "your request
    // was wrong" and the client would keep sending the same dead id.
    return transportError(request, env, 404, "session_not_found",
      "Unknown or expired session. Send `initialize` to start a new one.");
  }
  if (session && !assertSessionOwner(session, identity.orgId)) {
    // A valid credential for org B presenting org A's session id. Reported as
    // if the session simply does not exist, because confirming it exists tells
    // the caller something about another tenant.
    return transportError(request, env, 404, "session_not_found",
      "Unknown or expired session. Send `initialize` to start a new one.");
  }

  const responses = [];
  let newSessionId = null;

  for (const raw of messages) {
    const msg = parseMessage(raw);

    if (msg.kind === MSG.INVALID) {
      // A malformed NOTIFICATION still gets no reply — it has no id to answer.
      if (msg.id === null || msg.id === undefined) continue;
      responses.push(rpcError(msg.id, RPC.INVALID_REQUEST, msg.reason));
      continue;
    }
    // A response from the client is acknowledged by silence; this server never
    // sends requests, so there is nothing it could be answering.
    if (msg.kind === MSG.RESPONSE) continue;

    if (msg.kind === MSG.NOTIFICATION) {
      if (msg.method === METHOD.INITIALIZED && session) {
        ctx.waitUntil(updateSession(env, sessionId, { ready: true }));
      }
      continue;                      // notifications never get a response
    }

    // --- requests ---------------------------------------------------------
    try {
      const out = await dispatch(msg, { request, env, ctx, identity, session, sessionId });
      if (out && out.__newSession) {
        newSessionId = out.__newSession.id;
        session = out.__newSession.record;
        responses.push(out.response);
      } else {
        responses.push(out);
      }
    } catch (err) {
      await captureException(env, ctx, err, {
        request, tags: { source: "mcp", method: msg.method },
      });
      responses.push(rpcError(msg.id, RPC.INTERNAL_ERROR, "The server failed to handle this request."));
    }
  }

  // Nothing but notifications and/or responses. The spec says 202 with an
  // empty body — NOT an empty array, which a client would try to parse as a
  // batch reply.
  if (responses.length === 0) {
    return new Response(null, { status: 202, headers: mcpHeaders(request, env) });
  }

  if (sessionId) ctx.waitUntil(updateSession(env, sessionId, {}));

  return jsonRpcResponse(batch ? responses : responses[0], request, env, {
    sessionId: newSessionId || sessionId,
  });
}

// ---------------------------------------------------------------------------
// Method dispatch
// ---------------------------------------------------------------------------
async function dispatch(msg, cx) {
  const { request, env, ctx, identity, session, sessionId } = cx;

  switch (msg.method) {
    case METHOD.PING:
      return rpcResult(msg.id, {});

    case METHOD.INITIALIZE: {
      const wanted = msg.params && msg.params.protocolVersion;
      const neg = negotiateVersion(wanted);
      if (!neg.ok) {
        return rpcError(msg.id, RPC.UNSUPPORTED_VERSION,
          `Unsupported protocol revision "${wanted}".`,
          { supported: neg.supported });
      }
      const created = await createSession(env, {
        protocolVersion: neg.version,
        clientInfo:   (msg.params && msg.params.clientInfo) || null,
        capabilities: (msg.params && msg.params.capabilities) || {},
        orgId:      identity.orgId,
        userId:     identity.userId,
        authMethod: identity.authMethod,
        scopes:     identity.scopes,
      });
      return {
        __newSession: created,
        response: rpcResult(msg.id, {
          protocolVersion: neg.version,
          capabilities:    serverCapabilities(),
          serverInfo:      serverInfo(),
          instructions:    SERVER_INSTRUCTIONS,
        }),
      };
    }

    // Every method below this point needs a session. Enforced once here rather
    // than in each branch, so a new method cannot be added without it.
    default:
      if (!session) {
        return rpcError(msg.id, RPC.SESSION_REQUIRED,
          "No active session. Send `initialize` first and echo the Mcp-Session-Id header.");
      }
  }

  const entitled = await isEntitled(env, ctx, identity.orgId, request);

  switch (msg.method) {
    case METHOD.TOOLS_LIST:
      return rpcResult(msg.id, { tools: listTools({ scopes: identity.scopes, entitled }) });

    case METHOD.TOOLS_CALL:
      return await callTool(msg, cx, entitled);

    case METHOD.RESOURCES_LIST:
      return rpcResult(msg.id, { resources: listResources({ scopes: identity.scopes }) });

    case METHOD.RESOURCES_TEMPLATES:
      return rpcResult(msg.id, { resourceTemplates: listResourceTemplates({ scopes: identity.scopes }) });

    case METHOD.RESOURCES_READ:
      return await readResource(msg, cx, entitled);

    case METHOD.PROMPTS_LIST:
      return rpcResult(msg.id, { prompts: listPrompts() });

    case METHOD.PROMPTS_GET: {
      const name = msg.params && msg.params.name;
      const built = getPrompt(name, (msg.params && msg.params.arguments) || {});
      if (!built)       return rpcError(msg.id, RPC.INVALID_PARAMS, `No prompt named "${name}".`);
      if (built.error)  return rpcError(msg.id, RPC.INVALID_PARAMS, built.error);
      return rpcResult(msg.id, built);
    }

    case METHOD.LOGGING_SET_LEVEL: {
      const level = (msg.params && msg.params.level) || "info";
      await updateSession(env, sessionId, { logLevel: level });
      return rpcResult(msg.id, {});
    }

    case METHOD.COMPLETION_COMPLETE:
      // Advertised as a capability we do not fill in. An empty completion is
      // the spec's way of saying "no suggestions"; returning an error here
      // would make a host show a failure for something purely optional.
      return rpcResult(msg.id, { completion: { values: [], total: 0, hasMore: false } });

    default:
      return rpcError(msg.id, RPC.METHOD_NOT_FOUND, `Unknown method "${msg.method}".`);
  }
}

/** Paid-plan resolution, failing closed and never throwing into dispatch. */
async function isEntitled(env, ctx, orgId, request) {
  if (!orgId) return false;
  try {
    const e = await resolveEntitlementForOrg(env, orgId, { ctx, request });
    return Boolean(e && e.active);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// tools/call
// ---------------------------------------------------------------------------
async function callTool(msg, cx, entitled) {
  const { request, env, ctx, identity } = cx;
  const name = msg.params && msg.params.name;
  const args = (msg.params && msg.params.arguments) || {};
  const tool = getTool(name);

  if (!tool) {
    return rpcError(msg.id, RPC.INVALID_PARAMS, `No tool named "${name}".`);
  }

  // Scope is checked HERE, once, for every tool. A tool never checks its own.
  if (!requestHasScope(request, tool.scope)) {
    ctx.waitUntil(logToolCall(env, {
      orgId: identity.orgId, toolName: name, authMethod: identity.authMethod,
      scopeUsed: tool.scope, status: OUTCOME.DENIED, errorCode: "insufficient_scope",
    }));
    return rpcError(msg.id, RPC.UNAUTHORIZED_SCOPE,
      `This connection does not hold the "${tool.scope}" scope.`,
      { required: tool.scope, granted: identity.scopes });
  }

  // Plan gating produces an isError RESULT, not an RPC error: "you need a
  // paid plan" is information the model should relay to the user, and an RPC
  // error would surface as a broken connection instead.
  if (tool.paidOnly && !entitled) {
    ctx.waitUntil(logToolCall(env, {
      orgId: identity.orgId, toolName: name, authMethod: identity.authMethod,
      scopeUsed: tool.scope, status: OUTCOME.DENIED, errorCode: "plan_required",
    }));
    return rpcResult(msg.id, toolResult({
      text: `${name} requires a paid plan. See ${siteOrigin(env)}/#pricing.`,
      isError: true,
    }));
  }

  // Only metered tools pay this toll. A read that happens to be slow is not
  // the thing being guarded against, and limiting reads here would break the
  // "check your existing runs before analysing" behaviour the tool
  // descriptions actively encourage.
  if (tool.metered) {
    const limited = await meteredToolRateLimit(request, env, ctx);
    if (limited instanceof Response) {
      let retryAfterSec = 60;
      try { retryAfterSec = (await limited.clone().json()).retryAfterSec ?? 60; } catch { /* keep the default */ }
      ctx.waitUntil(logToolCall(env, {
        orgId: identity.orgId, toolName: name, authMethod: identity.authMethod,
        scopeUsed: tool.scope, status: OUTCOME.RATE_LIMITED, errorCode: "rate_limited",
      }));
      // An isError RESULT, not an RPC error: the model can read this, wait,
      // and carry on. An RPC error would surface as a broken connection.
      return rpcResult(msg.id, toolResult({
        text:
          `${name} is rate limited: at most 20 analyses a minute per organisation. ` +
          `Wait ${retryAfterSec}s and try again. This limit exists to stop a retry loop ` +
          `from spending the monthly run allowance — read-only tools are unaffected ` +
          `and can be used meanwhile.`,
        isError: true,
      }));
    }
  }

  const started = Date.now();
  let outcome;
  try {
    outcome = await tool.run({ args, request, env, ctx });
  } catch (err) {
    await captureException(env, ctx, err, {
      request, tags: { source: "mcp_tool", tool: name },
    });
    outcome = {
      text: `${name} failed unexpectedly. The error has been recorded.`,
      isError: true, errorCode: "tool_exception",
    };
  }
  const durationMs = Date.now() - started;

  ctx.waitUntil(logToolCall(env, {
    orgId: identity.orgId, toolName: name, authMethod: identity.authMethod,
    scopeUsed: tool.scope, durationMs, runId: outcome.runId || null,
    errorCode: outcome.errorCode || null,
    status: !outcome.isError ? OUTCOME.OK
      : outcome.errorCode === "quota_exceeded" ? OUTCOME.QUOTA_EXCEEDED
      : outcome.errorCode === "rate_limited"   ? OUTCOME.RATE_LIMITED
      : OUTCOME.ERROR,
  }));

  return rpcResult(msg.id, toolResult(outcome));
}

/**
 * The wire shape of a tool result.
 *
 * Always both a text block and, when the tool produced one, structuredContent.
 * Hosts differ in which they use, and a result carrying only one of them
 * renders as empty in the other kind of host.
 *
 * Secrets are scrubbed on the way out as a last line of defence. No tool
 * should ever be able to echo a credential — but a handler's error message is
 * written by code far from here, and the cost of being wrong once is a token
 * in a model's context and then in a transcript.
 */
function toolResult({ text, structured, isError }) {
  const out = {
    content: [{ type: "text", text: redact(String(text ?? "")) }],
    isError: isError === true,
  };
  if (structured !== undefined && structured !== null) out.structuredContent = structured;
  return out;
}

const SECRET_PATTERN = /\b(ask_live_|ask_mcp_)[A-Za-z0-9_-]{6,}/g;
function redact(s) {
  return s.replace(SECRET_PATTERN, "$1[redacted]");
}

function siteOrigin(env) {
  return String((env && env.SITE_ORIGIN) || "https://algosize.com").replace(/\/+$/, "");
}

// ---------------------------------------------------------------------------
// resources/read
// ---------------------------------------------------------------------------
async function readResource(msg, cx, entitled) {
  const { request, env, ctx, identity } = cx;
  const uri = msg.params && msg.params.uri;
  const match = matchResource(uri);
  if (!match) return rpcError(msg.id, RPC.INVALID_PARAMS, `No resource at "${uri}".`);

  if (!requestHasScope(request, match.descriptor.scope)) {
    return rpcError(msg.id, RPC.UNAUTHORIZED_SCOPE,
      `This connection does not hold the "${match.descriptor.scope}" scope.`);
  }

  // A resource is served by the same tool a caller could have invoked
  // directly, through the same adapter and the same org scoping. There is no
  // second data path to audit.
  const tool = getTool(match.descriptor.tool);
  if (!tool) return rpcError(msg.id, RPC.INTERNAL_ERROR, "This resource is misconfigured.");
  if (tool.paidOnly && !entitled) {
    return rpcError(msg.id, RPC.INVALID_PARAMS, "This resource requires a paid plan.");
  }

  const outcome = await tool.run({ args: match.args, request, env, ctx });
  ctx.waitUntil(logToolCall(env, {
    orgId: identity.orgId, toolName: `resource:${match.descriptor.tool}`,
    authMethod: identity.authMethod, scopeUsed: match.descriptor.scope,
    status: outcome.isError ? OUTCOME.ERROR : OUTCOME.OK, errorCode: outcome.errorCode || null,
  }));

  return rpcResult(msg.id, {
    contents: [{
      uri,
      mimeType: match.descriptor.mimeType,
      text: redact(outcome.structured !== undefined && outcome.structured !== null
        ? JSON.stringify(outcome.structured, null, 2)
        : String(outcome.text ?? "")),
    }],
  });
}

// ---------------------------------------------------------------------------
// GET /api/mcp — the server→client stream
// ---------------------------------------------------------------------------
export async function mcpGetHandler(request, env, ctx) {
  if (!originAllowed(request, env)) {
    return transportError(request, env, 403, "forbidden_origin", "This origin is not allowed.");
  }
  const identity = identityOf(request);
  if (!(await mcpEnabled(env, ctx, identity.orgId))) return disabled(request, env);

  if (!acceptsEventStream(request)) {
    return transportError(request, env, 406, "not_acceptable",
      "GET /api/mcp requires Accept: text/event-stream.");
  }
  const sessionId = request.headers.get(MCP_SESSION_HEADER);
  const session = sessionId ? await getSession(env, sessionId) : null;
  if (!session || !assertSessionOwner(session, identity.orgId)) {
    return transportError(request, env, 404, "session_not_found",
      "Unknown or expired session.");
  }

  // The spec explicitly allows 405 when the server has nothing to push, and
  // that is the honest answer today: every tool here is request/response, and
  // holding an idle stream open would consume a subrequest for the session's
  // whole life to deliver nothing. When progress notifications for long
  // architecture scans land, this becomes a real stream.
  return transportError(request, env, 405, "no_server_stream",
    "This server sends no unsolicited messages; responses arrive on the POST that requested them.");
}

// ---------------------------------------------------------------------------
// DELETE /api/mcp
// ---------------------------------------------------------------------------
export async function mcpDeleteHandler(request, env, ctx) {
  if (!originAllowed(request, env)) {
    return transportError(request, env, 403, "forbidden_origin", "This origin is not allowed.");
  }
  const identity = identityOf(request);
  const sessionId = request.headers.get(MCP_SESSION_HEADER);
  const session = sessionId ? await getSession(env, sessionId) : null;
  // Only the owner may tear a session down, and an unknown id is reported as
  // success: teardown is idempotent, and saying "no such session" would let a
  // caller probe which ids exist.
  if (session && assertSessionOwner(session, identity.orgId)) {
    await deleteSession(env, sessionId);
  }
  return new Response(null, { status: 204, headers: mcpHeaders(request, env) });
}

// ---------------------------------------------------------------------------
// GET /api/mcp/manifest — public, cacheable
// ---------------------------------------------------------------------------
//
// The whole catalog with no credential. It is safe because it contains only
// what the tools ARE, never any customer's data, and it is what lets the
// dashboard render the catalog — and a prospective customer read it — before
// connecting anything.
export function mcpManifestHandler(request, env) {
  const body = {
    name: "algosize",
    version: serverInfo().version,
    protocolVersions: [...SUPPORTED_PROTOCOL_VERSIONS],
    endpoint: `${siteOrigin(env)}/api/mcp`,
    instructions: SERVER_INSTRUCTIONS,
    groups: TOOL_GROUPS,
    tools: TOOLS.map(publicTool),
    prompts: listPrompts(),
  };
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      "content-type": "application/json",
      "cache-control": "public, max-age=300",
      "access-control-allow-origin": "*",
    },
  });
}

// ---------------------------------------------------------------------------
// GET /api/mcp/usage  and  the connected-clients endpoints
// ---------------------------------------------------------------------------
export async function mcpUsageHandler(request, env) {
  const identity = identityOf(request);
  if (!identity.orgId) {
    const { requireOrgContext } = await import("./monitors.js");
    const ctxOrg = await requireOrgContext(request, env);
    if (ctxOrg.error) return ctxOrg.error;
    identity.orgId = ctxOrg.orgId;
  }
  const summary = await usageSummary(env, identity.orgId, {});
  return json(summary);
}

export async function mcpListClientsHandler(request, env) {
  const { requireOrgContext } = await import("./monitors.js");
  const ctxOrg = await requireOrgContext(request, env);
  if (ctxOrg.error) return ctxOrg.error;
  return json({ connections: await listConnections(env, ctxOrg.orgId) });
}

export async function mcpRevokeClientHandler(request, env) {
  const { requireOrgContext } = await import("./monitors.js");
  const ctxOrg = await requireOrgContext(request, env);
  if (ctxOrg.error) return ctxOrg.error;
  const clientId = request.params && request.params.id;
  if (!clientId) return json({ error: "invalid_request", message: "No client id supplied." }, 400);
  const revoked = await revokeClientTokens(env, ctxOrg.orgId, clientId);
  return json({ ok: true, clientId, tokensRevoked: revoked });
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status, headers: { "content-type": "application/json" },
  });
}
