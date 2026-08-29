#!/usr/bin/env node
// The `algosize-mcp` binary: stdio in, Algosize's MCP endpoint out.
//
// Everything that could be a decision lives in src/bridge.mjs; this file only
// wires it to the process. Diagnostics go to stderr, never stdout — stdout is
// the JSON-RPC channel, and one stray log line there desynchronises the host's
// parser and takes the whole connection down.

import { readConfig, runBridge, runDegradedBridge } from "../src/bridge.mjs";

const config = readConfig(process.env);

for (const p of config.problems) process.stderr.write(`algosize-mcp: ${p}\n`);

if (config.problems.length) {
  // Deliberately NOT exit(1). A host reports a server that exits at startup as
  // "Connection closed" and shows none of the message above, so the user sees
  // a dead connector with no reason. Staying up and explaining the problem
  // through the protocol puts it where they will actually read it.
  runDegradedBridge({
    input: process.stdin,
    output: process.stdout,
    problems: config.problems,
  });
} else {
  process.stderr.write(`algosize-mcp: connected to ${config.endpoint}\n`);
  runBridge({
    input: process.stdin,
    output: process.stdout,
    config,
    log: (m) => process.stderr.write(`algosize-mcp: ${m}\n`),
  });
}
