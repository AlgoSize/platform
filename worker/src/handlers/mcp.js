/**
 * Route entry point for all /api/mcp requests.
 * Wired into worker/src/index.js behind the mcp.enabled flag.
 *
 * POST   /api/mcp  — JSON-RPC request (single response or SSE)
 * GET    /api/mcp  — SSE stream for server→client notifications
 * DELETE /api/mcp  — explicit session teardown
 */

import { checkOrigin, mcpCorsHeaders, jsonResponse, originForbidden,
         extractProtocolVersion, extractSessionId } from '../mcp/transport.js';
import { validateMessage, rpcResult, rpcError, negotiateVersion,
         buildCapabilities, LATEST_PROTOCOL_VERSION, RPC_ERRORS } from '../mcp/protocol.js';
import { createSession, getSession, deleteSession } from '../mcp/session.js';
import { mcpAuth, assertScope } from '../mcp/auth.js';
import { dispatchToolCall }     from '../mcp/registry.js';
import { listTools }            from '../mcp/registry.js';
import { listResources, readResource } from '../mcp/resources.js';
import { listPrompts, getPrompt }      from '../mcp/prompts.js';
import { logToolCall }          from '../mcp/audit.js';

export async function mcpHandler(request, env, ctx) {
  // Origin check (DNS-rebinding protection)
  if (!checkOrigin(request, env)) return originForbidden();

  const corsHeaders = mcpCorsHeaders(request);

  // CORS preflight
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  // Auth (mcpAuth is composed after requireAuth in the middleware chain)
  const authErr = await mcpAuth(request, env);
  if (authErr) return authErr;

  // DELETE — session teardown
  if (request.method === 'DELETE') {
    const sid = extractSessionId(request);
    await deleteSession(env, sid);
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  // GET — SSE notification stream (long-poll for arch scan progress)
  if (request.method === 'GET') {
    const sid = extractSessionId(request);
    const session = await getSession(env, sid);
    if (!session) {
      return new Response(
        JSON.stringify({ error: 'Session not found' }),
        { status: 404, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
      );
    }
    // Minimal SSE keep-alive stream (tools push events via ctx.waitUntil)
    const { response, send, close } = (await import('../mcp/transport.js')).openSseStream(corsHeaders);
    send('connected', { sessionId: sid });
    // Keep open for 30 s max (Cloudflare Worker subrequest limit)
    ctx.waitUntil(new Promise(r => setTimeout(() => { close(); r(); }, 29000)));
    return response;
  }

  // POST — JSON-RPC
  if (request.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405, headers: corsHeaders });
  }

  let msg;
  try {
    msg = await request.json();
  } catch {
    return jsonResponse(rpcError(null, RPC_ERRORS.PARSE_ERROR, 'Invalid JSON'), corsHeaders);
  }

  const msgErr = validateMessage(msg);
  if (msgErr) return jsonResponse(msgErr, corsHeaders);

  const { id, method, params } = msg;

  // ── initialize ──────────────────────────────────────────────────────────────
  if (method === 'initialize') {
    const clientVersion = params?.protocolVersion;
    const agreed = negotiateVersion(clientVersion);
    if (!agreed) {
      return jsonResponse(
        rpcError(id, RPC_ERRORS.UNSUPPORTED_VERSION, 'Unsupported protocol version', {
          supported: ['2025-06-18'],
        }),
        corsHeaders
      );
    }
    const sessionId = await createSession(env, {
      protocolVersion: agreed,
      clientInfo:      params?.clientInfo,
      capabilities:    params?.capabilities,
      orgId:           request.org.id,
      userId:          request.user?.userId ?? null,
      authMethod:      request.authMethod,
      mcpScopes:       request.mcpScopes,
    });
    return jsonResponse(
      rpcResult(id, {
        protocolVersion: agreed,
        capabilities:    buildCapabilities(),
        serverInfo:      { name: 'algosize-mcp', version: '1.0.0' },
      }),
      { ...corsHeaders, 'Mcp-Session-Id': sessionId }
    );
  }

  // All other methods require an initialised session
  const sessionId = extractSessionId(request);
  const session   = await getSession(env, sessionId);
  if (!session) {
    return jsonResponse(
      rpcError(id, RPC_ERRORS.NOT_INITIALIZED, 'Session not initialised — call initialize first'),
      corsHeaders
    );
  }

  // ── initialized notification (client acknowledgement — no response) ─────────
  if (method === 'notifications/initialized') {
    return new Response(null, { status: 202, headers: corsHeaders });
  }

  // ── tools/list ──────────────────────────────────────────────────────────────
  if (method === 'tools/list') {
    return jsonResponse(rpcResult(id, { tools: listTools(request.mcpScopes) }), corsHeaders);
  }

  // ── tools/call ──────────────────────────────────────────────────────────────
  if (method === 'tools/call') {
    const toolName  = params?.name;
    const toolArgs  = params?.arguments ?? {};
    const start     = Date.now();
    let status      = 'ok';
    let result;
    try {
      result = await dispatchToolCall(toolName, toolArgs, request, env, ctx);
    } catch (err) {
      status = 'error';
      result = { isError: true, content: [{ type: 'text', text: err.message }] };
    }
    // Audit (best-effort)
    ctx.waitUntil(
      logToolCall(env, {
        orgId:      request.org.id,
        toolName,
        authMethod: request.authMethod,
        scopeUsed:  request.mcpScopes?.join(' ') ?? '',
        status,
        durationMs: Date.now() - start,
        runId:      result?._runId ?? null,
        errorCode:  result?.isError ? (result._errorCode ?? 'tool_error') : null,
      })
    );
    // Strip internal fields before sending
    delete result?._runId;
    delete result?._errorCode;
    return jsonResponse(rpcResult(id, result), corsHeaders);
  }

  // ── resources/list ──────────────────────────────────────────────────────────
  if (method === 'resources/list') {
    return jsonResponse(rpcResult(id, { resources: listResources() }), corsHeaders);
  }

  // ── resources/read ──────────────────────────────────────────────────────────
  if (method === 'resources/read') {
    const scopeErr = assertScope(request, 'algosize:read');
    if (scopeErr) return jsonResponse(rpcError(id, scopeErr.code, scopeErr.message, scopeErr.data), corsHeaders);
    const contents = await readResource(params?.uri, request, env, ctx);
    return jsonResponse(rpcResult(id, { contents }), corsHeaders);
  }

  // ── prompts/list ────────────────────────────────────────────────────────────
  if (method === 'prompts/list') {
    return jsonResponse(rpcResult(id, { prompts: listPrompts() }), corsHeaders);
  }

  // ── prompts/get ─────────────────────────────────────────────────────────────
  if (method === 'prompts/get') {
    const prompt = getPrompt(params?.name, params?.arguments);
    if (!prompt) {
      return jsonResponse(rpcError(id, RPC_ERRORS.METHOD_NOT_FOUND, `Unknown prompt: ${params?.name}`), corsHeaders);
    }
    return jsonResponse(rpcResult(id, prompt), corsHeaders);
  }

  // ── ping ────────────────────────────────────────────────────────────────────
  if (method === 'ping') {
    return jsonResponse(rpcResult(id, {}), corsHeaders);
  }

  return jsonResponse(
    rpcError(id, RPC_ERRORS.METHOD_NOT_FOUND, `Unknown method: ${method}`),
    corsHeaders
  );
}
