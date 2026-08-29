# @algosize/mcp

Connect an AI coding assistant to [Algosize](https://algosize.com) so it can run
dependency, cost, complexity and architecture analysis as tools inside a
conversation, and read results you already have.

There are two ways to connect. Prefer the **remote endpoint** — it needs no
install and picks up new tools the moment they ship. Use the **local bridge**
only for hosts that speak stdio and cannot talk to a remote MCP server.

## Before you start

Create an API key at
<https://algosize.com/dashboard/#/account/keys>. It is shown once, at creation.
The key authenticates as your **organisation**, not as you — the same subject
your plan and run allowance belong to.

An MCP connection can analyse, read results, and manage monitors. It **cannot**
create API keys, change billing, add or remove members, or reach anything
under `/api/admin`. Those endpoints have no tool at all, so no permission
setting can expose them.

## Claude Code

Remote (recommended):

```bash
claude mcp add --transport http algosize https://algosize.com/api/mcp \
  --header "Authorization: Bearer ask_live_your_key_here"
```

Local bridge:

```bash
claude mcp add algosize --env ALGOSIZE_API_KEY=ask_live_your_key_here \
  -- npx -y @algosize/mcp
```

Working inside this repository, `.mcp.json` at the repo root already declares
the server; export `ALGOSIZE_API_KEY` in your shell and Claude Code picks it up.

## Claude Desktop

`claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "algosize": {
      "command": "npx",
      "args": ["-y", "@algosize/mcp"],
      "env": { "ALGOSIZE_API_KEY": "ask_live_your_key_here" }
    }
  }
}
```

## Cursor

`.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "algosize": {
      "command": "npx",
      "args": ["-y", "@algosize/mcp"],
      "env": { "ALGOSIZE_API_KEY": "ask_live_your_key_here" }
    }
  }
}
```

## Configuration

| Variable | Required | Meaning |
|---|---|---|
| `ALGOSIZE_API_KEY` | yes | An `ask_live_…` key. |
| `ALGOSIZE_BASE_URL` | no | Defaults to `https://algosize.com`. Point at staging to test. |

## What it costs

The analysis tools — dependency scan, cloud cost, complexity, architecture,
infrastructure estimate — each consume one run from your organisation's monthly
allowance. Everything else is free: listing and reading runs, reports, the
scorecard, monitors, architecture snapshots, and CI snippets.

Each tool's description tells the model which it is, so a well-behaved
assistant checks your existing runs before paying for a new analysis. If the
allowance runs out, the tool returns a readable error naming the limit rather
than failing the connection.

One tool, `algosize_share_run`, creates a link **anyone who has it can open**.
It is marked open-world so hosts do not auto-approve it, and its description
says what it does in its first sentence.

## What this package is

A dumb pipe, on purpose. It forwards JSON-RPC frames, injects your
`Authorization` header, tracks the session id, retries idempotent reads with
jittered backoff, and turns a 401 into a sentence naming the page where you get
a working key.

It deliberately does **not** know what tools exist, cache anything, or
transform payloads. If it did, the catalogue would have two sources of truth
and the copy installed on a laptop would be the stale one — a tool shipped on
Tuesday must appear in an already-installed bridge on Tuesday.

It also never retries `tools/call`. A retried analysis could run twice and be
charged twice, and this layer cannot tell which calls are safe to repeat.

## Troubleshooting

**"ALGOSIZE_API_KEY is not set"** — the env block did not reach the process.
Check it is inside the server's own `env` object in your client config, not
your shell.

**A 401 mentioning the keys page** — the key was rejected. It may have been
revoked, or belong to a different environment than `ALGOSIZE_BASE_URL`.

**"The Algosize session expired"** — sessions last 24 hours. Reconnect; the
host will re-initialize.

**The tool list is empty** — the MCP surface is enabled per environment and
per organisation. If you are an existing customer and see nothing, it has not
been turned on for your account yet.

## Development

```bash
node mcp/test/smoke.test.mjs
```
