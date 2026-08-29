#!/usr/bin/env node
// The `algosize-mcp` binary: stdio in, Algosize's MCP endpoint out.
//
// Everything that could be a decision lives in src/bridge.mjs; this file only
// wires it to the process. Diagnostics go to stderr, never stdout — stdout is
// the JSON-RPC channel, and one stray log line there desynchronises the host's
// parser and takes the whole connection down.

import { readConfig, runBridge } from "../src/bridge.mjs";

const config = readConfig(process.env);
if (config.problems.length) {
  for (const p of config.problems) process.stderr.write(`algosize-mcp: ${p}\n`);
  process.exit(1);
}

process.stderr.write(`algosize-mcp: connected to ${config.endpoint}\n`);

runBridge({
  input: process.stdin,
  output: process.stdout,
  config,
  log: (m) => process.stderr.write(`algosize-mcp: ${m}\n`),
});
