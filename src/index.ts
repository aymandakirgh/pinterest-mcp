#!/usr/bin/env node
/**
 * stdio entry point — the transport Claude Desktop, Claude Code and most MCP
 * clients launch locally. Nothing may be written to stdout except protocol
 * frames, so all diagnostics go to stderr.
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { SERVER_NAME, SERVER_VERSION, buildServer } from "./server.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const server = buildServer(config);

  const transport = new StdioServerTransport();
  await server.connect(transport);

  const tokenState = config.accessToken
    ? "access token loaded"
    : "no access token — only the OAuth tools will work until PINTEREST_ACCESS_TOKEN is set";
  console.error(`${SERVER_NAME} v${SERVER_VERSION} ready on stdio (${tokenState})`);
}

main().catch((error) => {
  console.error(`${SERVER_NAME} failed to start:`, error);
  process.exit(1);
});
