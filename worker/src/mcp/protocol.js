/**
 * MCP protocol constants, JSON-RPC framing, and capability negotiation.
 * Protocol revision: 2025-06-18 (Streamable HTTP)
 */

export const SUPPORTED_PROTOCOL_VERSIONS = ['2025-06-18'];
export const LATEST_PROTOCOL_VERSION = '2025-06-18';

// JSON-RPC 2.0 error codes + MCP extensions
export const RPC_ERRORS = {
  PARSE_ERROR:       -32700,
  INVALID_REQUEST:   -32600,
  METHOD_NOT_FOUND:  -32601,
  INVALID_PARAMS:    -32602,
  INTERNAL_ERROR:    -32603,
  // MCP-specific
  UNSUPPORTED_VERSION: -32000,
  NOT_INITIALIZED:     -32001,
  QUOTA_EXCEEDED:      -32002,
  SCOPE_DENIED:        -32003,
};

/**
 * Wrap a result in a JSON-RPC 2.0 success response.
 */
export function rpcResult(id, result) {
  return { jsonrpc: '2.0', id, result };
}

/**
 * Wrap an error in a JSON-RPC 2.0 error response.
 */
export function rpcError(id, code, message, data) {
  const error = { code, message };
  if (data !== undefined) error.data = data;
  return { jsonrpc: '2.0', id: id ?? null, error };
}

/**
 * Validate that the JSON-RPC message is well-formed.
 * Returns null on success, or an error object to send back.
 */
export function validateMessage(msg) {
  if (!msg || typeof msg !== 'object') {
    return rpcError(null, RPC_ERRORS.PARSE_ERROR, 'Message must be a JSON object');
  }
  if (msg.jsonrpc !== '2.0') {
    return rpcError(msg.id ?? null, RPC_ERRORS.INVALID_REQUEST, 'jsonrpc must be "2.0"');
  }
  if (typeof msg.method !== 'string' || !msg.method) {
    return rpcError(msg.id ?? null, RPC_ERRORS.INVALID_REQUEST, 'method is required');
  }
  return null;
}

/**
 * Build the server capabilities object returned in initialize.
 */
export function buildCapabilities() {
  return {
    tools:     { listChanged: false },
    resources: { listChanged: false, subscribe: false },
    prompts:   { listChanged: false },
    logging:   {},
  };
}

/**
 * Negotiate protocol version. Returns the agreed version or null if unsupported.
 */
export function negotiateVersion(clientVersion) {
  if (SUPPORTED_PROTOCOL_VERSIONS.includes(clientVersion)) return clientVersion;
  return null;
}
