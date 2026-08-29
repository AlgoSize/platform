# MCP build contract (internal, delete before merge)

Repo: `/home/user/workspace/algosize`, branch `feat/mcp-server`.
Worker code lives in `worker/`. ESM, no TypeScript, `itty-router`, **no new runtime deps in `worker/`**.

## Non-negotiable rules

1. **Read before you write.** Never guess a signature. Open the module.
2. **Reuse, never fork.** An MCP tool MUST reach the product only through
   `callHandler` from `worker/src/mcp/dispatch.js`. If a tool re-implements
   analyzer logic, validation, quota accounting, or entitlement checks, it is wrong.
3. `worker/scripts/test-mcp-purity.mjs` will fail the build if any file under
   `worker/src/mcp/tools/` imports an analyzer, `enforceQuota`, `entitlement.js`,
   or references `env.DB`.
4. Every SQL read filters `org_id` first.
5. Never log, audit, or return a secret, a token, a tool argument, or a tool result.
6. Comments explain **why**, not what. Match the density and voice of the
   existing `worker/src/` files — they are unusually well commented; read a few first.
7. Every new behaviour gets a `node` test script in `worker/scripts/`.

## Already written (read these; do not edit them)

- `worker/src/mcp/protocol.js` — `RPC`, `MSG`, `METHOD`, `parseMessage`, `rpcResult`,
  `rpcErrorResponse`, `rpcError`, `negotiateVersion`, `serverCapabilities`,
  `serverInfo`, `SERVER_INSTRUCTIONS`, `MCP_PROTOCOL_HEADER`,
  `SUPPORTED_PROTOCOL_VERSIONS`, `LATEST_PROTOCOL_VERSION`
- `worker/src/mcp/session.js` — KV-backed sessions (`mcp:sess:<id>`, 24h)
- `worker/src/mcp/dispatch.js` — `callHandler(chain, {method,path,query,params,body,request,env,ctx})`
  → `{status, ok, json, text, response}`
- `worker/src/mcp/tokens.js` — `SCOPES`, `SCOPE_DESCRIPTIONS`, `hasScope`,
  `normalizeScope`, `issueTokenPair`, `resolveAccessToken`, `resolveRefreshToken`,
  `revokeToken`, `revokeClientTokens`, `revokeTokenChain`, `listConnections`,
  `MCP_TOKEN_TAG`, `sha256Hex`, `generateToken`
- `worker/src/mcp/auth.js` — `mcpAuth`, `requestHasScope`, `identityOf`
- `worker/src/mcp/metadata.js` — `issuerFor`, `authorizationServerMetadata`,
  `protectedResourceMetadata`, `protectedResourceMetadataUrl`, `metadataResponse`
- `worker/src/mcp/transport.js` — `originAllowed`, `mcpHeaders`, `mcpPreflight`,
  `jsonRpcResponse`, `transportError`, `eventStream`, `MCP_SESSION_HEADER`
- `worker/src/mcp/registry.js` — `TOOLS`, `getTool`, `listTools`, `listResources`,
  `listResourceTemplates`, `matchResource`, `listPrompts`, `getPrompt`
- `worker/src/mcp/telemetry.js` — `logToolCall`, `OUTCOME`
- `worker/src/handlers/mcp.js` — JSON-RPC dispatch + `mcpUsageHandler`
- `worker/migrations/0019_mcp.sql` — `mcp_clients`, `mcp_authorizations`,
  `mcp_tokens`, `mcp_tool_calls`; `runs.credential_kind`, `runs.credential_id`
- `worker/wrangler.toml` — `.well-known` zone routes, `MCP_ENABLED`,
  `MCP_ALLOWED_ORIGINS`

## The tool shape (exact)

`worker/src/mcp/tools/index.js` exports `TOOLS`, a flat array of:

```js
{
  name: "algosize_analyze_cost",          // stable, snake_case, algosize_ prefix
  title: "Analyse cloud spend",           // human label
  description: "…",                        // written FOR A MODEL: when to use it,
                                           // what it costs, what it needs
  scope: "algosize:read" | "algosize:analyze" | "algosize:manage",
  paidOnly: false,                         // true => requires active subscription
  metered: true,                           // true => underlying route is behind enforceQuota
  annotations: {
    readOnlyHint: false, destructiveHint: false,
    idempotentHint: false, openWorldHint: false,
  },
  inputSchema:  { type: "object", properties: {…}, required: […],
                  additionalProperties: false },
  outputSchema: { type: "object", properties: {…} } | null,
  async run({ args, request, env, ctx }) {
    // ONLY route into the product through callHandler.
    return { text, structured, isError, errorCode, runId };
  },
}
```

`run` returns:

| field | meaning |
|---|---|
| `text` | required. The prose a model reads. Summarise; do not dump raw JSON. |
| `structured` | optional object matching `outputSchema`. |
| `isError` | `true` when the tool ran and failed. **Not** an RPC error. |
| `errorCode` | stable machine code. Use `"quota_exceeded"` on a 402 and `"rate_limited"` on a 429 — `handlers/mcp.js` maps those to distinct metrics. |
| `runId` | set when the call started an analyzer run. |

`handlers/mcp.js` enforces scope, plan and telemetry. A tool never checks either.

### `callHandler` usage

```js
import { callHandler } from "../dispatch.js";
import { requireAuth } from "../../auth.js";      // NO — already applied upstream
```

Do **not** re-apply `requireAuth`; the request is already authenticated. Pass the
same middleware chain `worker/src/index.js` uses for that route **minus**
`requireAuth` and minus the rate limiters, e.g. for `/api/analyze/cost`:

```js
const res = await callHandler([enforceQuota(costHandler)], {
  method: "POST", path: "/api/analyze/cost", body: args, request, env, ctx,
});
if (res.status === 402) return { text: `Monthly run quota exhausted. …`, isError: true, errorCode: "quota_exceeded" };
```

`enforceQuota` must stay in the chain for every metered tool. That is the whole
reason tools go through `callHandler` rather than calling handlers directly.

## Scope assignment

- `algosize:read` — every list/get/read tool, `algosize_whoami`
- `algosize:analyze` — the six analyzer/estimate tools, `algosize_generate_fix`
- `algosize:manage` — monitor create/update/delete/run-now, `algosize_share_run`

`algosize:manage` does **not** grant API-key creation, billing, member
management, or `/api/admin/*`. Those endpoints have no tool at all.
