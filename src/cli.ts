#!/usr/bin/env node
/**
 * `x420-mcp`: run X420's services as MCP tools over stdio. Settings come from the environment (see docs/mcp-server.md):
 * X420_MCP_ORIGIN, X420_MCP_WALLET_PRIVATE_KEY, X420_MCP_MAX_USD, X420_MCP_NETWORK.
 */
import { startStdio } from "./server.js";

startStdio().catch((e: unknown) => {
  process.stderr.write(`x420-mcp: ${(e as Error).message}\n`);
  process.exit(1);
});
