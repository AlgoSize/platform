// stdio ↔ Streamable HTTP bridge.
//
// Some MCP hosts speak only stdio. This is the adapter, and it is deliberately
// a DUMB PIPE: it does not know what tools exist, does not cache, does not
// transform payloads, and does not validate arguments.
//
// That is the whole design constraint. The moment this file knows the catalog,
// the catalog has two sources of truth — and the copy that ships on someone's
// laptop via npx is the one that goes stale. A tool added to the Worker on
// Tuesday must appear in an already-installed bridge on Tuesday, which only
// works if the bridge never had an opinion about the list.
//
// What it DOES own is the transport seam: framing stdio's newline-delimited
// JSON, carrying the Authorization header, tracking Mcp-Session-Id across
// requests, retrying idempotent reads, and turning a 401 into a sentence
// someone can act on rather than a stack trace.

import { createInterface } from "node:readline";

export const DEFAULT_BASE_URL = "https://algosize.com";

/** Read configuration from the environment, and say precisely what is missing. */
export function readConfig(env = process.env) {
  const apiKey  = env.ALGOSIZE_API_KEY || "";
  const baseUrl = (env.ALGOSIZE_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, "");
  const problems = [];
  if (!apiKey) {
    problems.push(
      "ALGOSIZE_API_KEY is not set. Create a key at " +
      `${baseUrl}/dashboard/#/account/keys and put it in your MCP client's env block.`);
  } else if (!apiKey.startsWith("ask_live_")) {
    // Caught here rather than at the server, because the server's answer is a
    // generic 401 and the actual mistake — pasting a key prefix, a session
    // cookie, or an OAuth token — is obvious from the string itself.
    problems.push(
      'ALGOSIZE_API_KEY does not look like an Algosize key: it should begin with "ask_live_".');
  }
  return { apiKey, baseUrl, endpoint: `${baseUrl}/api/mcp`, problems };
}

// Methods that are safe to retry. A retried `tools/call` could run a metered
// analysis twice and charge for both, so the list is reads only — and
// `tools/call` is deliberately absent even though most tools are read-only,
// because this file does not know which.
const IDEMPOTENT = new Set([
  "initialize", "ping", "tools/list", "resources/list",
  "resources/templates/list", "resources/read", "prompts/list", "prompts/get",
]);

const MAX_ATTEMPTS = 3;

function backoffMs(attempt) {
  // Exponential with jitter. The jitter matters when several MCP clients
  // reconnect after the same blip: without it they retry in lockstep and
  // rebuild the spike they are backing off from.
  return Math.min(4000, 2 ** attempt * 250) + Math.floor(Math.random() * 250);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Forward one JSON-RPC message and return the parsed reply, or null when the
 * server answered 202 (a notification, which has no reply).
 */
export async function forward(message, state, { fetchImpl = fetch, log = () => {} } = {}) {
  const headers = {
    "content-type": "application/json",
    "accept": "application/json",
    "authorization": `Bearer ${state.apiKey}`,
  };
  if (state.sessionId) headers["Mcp-Session-Id"] = state.sessionId;
  if (state.protocolVersion) headers["MCP-Protocol-Version"] = state.protocolVersion;

  const retryable = IDEMPOTENT.has(message.method);
  let lastError = null;

  for (let attempt = 0; attempt < (retryable ? MAX_ATTEMPTS : 1); attempt++) {
    if (attempt > 0) await sleep(backoffMs(attempt));
    let res;
    try {
      res = await fetchImpl(state.endpoint, {
        method: "POST", headers, body: JSON.stringify(message),
      });
    } catch (err) {
      lastError = `network error: ${err && err.message ? err.message : err}`;
      continue;
    }

    // The session id arrives on the initialize response and must ride on every
    // later request. Captured here rather than in the caller so a
    // re-initialize after an expiry updates it without anyone remembering to.
    const sid = res.headers.get("mcp-session-id");
    if (sid) state.sessionId = sid;

    if (res.status === 401) {
      return rpcError(message.id, -32001,
        "Algosize rejected the API key. Set ALGOSIZE_API_KEY to a key from " +
        `${state.baseUrl}/dashboard/#/account/keys — the current value was not accepted.`);
    }
    if (res.status === 404 && state.sessionId) {
      // The session expired. Clearing it lets the host's next initialize
      // establish a fresh one instead of retrying a dead id forever.
      state.sessionId = null;
      return rpcError(message.id, -32001,
        "The Algosize session expired. Reconnect to continue.");
    }
    if (res.status === 202) return null;              // notification, no reply

    if (res.status >= 500 && retryable) {
      lastError = `server error ${res.status}`;
      continue;
    }

    const text = await res.text();
    if (!text) {
      // A REQUEST must always be answered. An empty body on an error status
      // used to fall through as `null`, which sends nothing back — and a host
      // waiting on that id waits forever, showing the user a call that never
      // finishes rather than an error they can read. Only a notification
      // (no id) may legitimately go unanswered, which rpcError handles.
      if (!res.ok) {
        return rpcError(message.id, -32603,
          `Algosize returned HTTP ${res.status} with no body.`);
      }
      return null;
    }
    try {
      return JSON.parse(text);
    } catch {
      return rpcError(message.id, -32603,
        `Algosize returned a non-JSON response (HTTP ${res.status}).`);
    }
  }

  log(`giving up after ${MAX_ATTEMPTS} attempts: ${lastError}`);
  return rpcError(message.id, -32603,
    `Could not reach Algosize at ${state.endpoint}: ${lastError}`);
}

function rpcError(id, code, message) {
  // A notification that fails has no id and therefore no reply — answering it
  // would be a protocol violation on top of whatever already went wrong.
  if (id === undefined || id === null) return null;
  return { jsonrpc: "2.0", id, error: { code, message } };
}

/**
 * Serve a misconfigured bridge, instead of dying.
 *
 * The obvious thing to do without an API key is print the problem and
 * exit(1). That is what this did, and it is wrong: an MCP host reports a
 * server that exits at startup as "Connection closed", and the carefully
 * worded stderr line explaining exactly which variable to set never reaches
 * the person who needs it. They see a dead connector and no reason.
 *
 * So a misconfigured bridge stays up and answers honestly. `initialize`
 * succeeds, so the host connects and shows the server; everything else
 * returns the configuration problem as its error text, which is where a user
 * actually looks. The server is visibly present and visibly explaining
 * itself, rather than invisibly absent.
 *
 * It advertises no tools, so a model is never offered something that cannot
 * work.
 */
export function runDegradedBridge({ input, output, problems }) {
  const explanation = problems.join(" ");
  const rl = createInterface({ input, crlfDelay: Infinity });

  rl.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let message;
    try { message = JSON.parse(trimmed); } catch { return; }
    if (message.id === undefined || message.id === null) return;   // notification

    if (message.method === "initialize") {
      output.write(JSON.stringify({
        jsonrpc: "2.0", id: message.id,
        result: {
          protocolVersion: (message.params && message.params.protocolVersion) || "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "algosize", version: "1.0.0" },
          instructions: `Algosize is not configured. ${explanation}`,
        },
      }) + "\n");
      return;
    }
    // An empty catalog rather than an error: a host that cannot list tools
    // often retries or reports a protocol fault, whereas zero tools plus the
    // instructions above reads as "connected, nothing available yet".
    if (message.method === "tools/list") {
      output.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { tools: [] } }) + "\n");
      return;
    }
    output.write(JSON.stringify({
      jsonrpc: "2.0", id: message.id,
      error: { code: -32001, message: explanation },
    }) + "\n");
  });

  return { done: new Promise((resolve) => rl.on("close", resolve)) };
}

/**
 * Run the bridge over a pair of streams.
 *
 * Split out from the binary so the smoke test can drive it with ordinary
 * strings instead of spawning a process and racing its stdio.
 */
export function runBridge({ input, output, config, fetchImpl = fetch, log = () => {} }) {
  const state = {
    apiKey: config.apiKey,
    baseUrl: config.baseUrl,
    endpoint: config.endpoint,
    sessionId: null,
    protocolVersion: null,
  };

  const rl = createInterface({ input, crlfDelay: Infinity });

  // Messages are handled strictly in order. MCP allows concurrency, but a
  // bridge that interleaved would have to serialise the session-id update
  // anyway — and an out-of-order initialize would send later calls without a
  // session at all.
  let queue = Promise.resolve();

  rl.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    queue = queue.then(async () => {
      let message;
      try {
        message = JSON.parse(trimmed);
      } catch {
        output.write(JSON.stringify({
          jsonrpc: "2.0", id: null,
          error: { code: -32700, message: "The MCP client sent invalid JSON." },
        }) + "\n");
        return;
      }
      if (message.method === "initialize" && message.params && message.params.protocolVersion) {
        state.protocolVersion = message.params.protocolVersion;
      }
      const reply = await forward(message, state, { fetchImpl, log });
      // A notification has no id and MUST produce no output, whatever came
      // back over HTTP. Enforced here rather than trusted from the server:
      // framing is this layer's job, and a stray reply on stdout desynchronises
      // the host's parser — it matches the reply to the wrong request and
      // every later call is answered with the previous call's result.
      const isNotification = message.id === undefined || message.id === null;
      if (reply && !isNotification) output.write(JSON.stringify(reply) + "\n");
    }).catch((err) => {
      log(`bridge error: ${err && err.message ? err.message : err}`);
    });
  });

  return { state, done: new Promise((resolve) => rl.on("close", () => queue.then(resolve, resolve))) };
}
