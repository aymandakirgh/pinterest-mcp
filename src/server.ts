import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { PinterestClient } from "./client.js";
import type { ServerConfig } from "./config.js";
import { registerAccountTools } from "./tools/account.js";
import { registerBoardTools } from "./tools/boards.js";
import { registerOAuthTools } from "./tools/oauth.js";
import { registerPinTools } from "./tools/pins.js";
import { registerRawTool } from "./tools/raw.js";
import { registerSearchTools } from "./tools/search.js";

export const SERVER_NAME = "pinterest-mcp";
export const SERVER_VERSION = "0.3.0";

const INSTRUCTIONS = `Tools for the Pinterest API v5 on behalf of one authenticated account.

Scope of the API, so you do not promise what it cannot do:
- Everything is scoped to the authenticated user's own account. There is no public
  discovery search — pinterest_search_my_pins searches only the user's own pins.
- Analytics windows cover at most the last 90 days.
- Video pins are a three-step flow: pinterest_register_media, upload the file to the
  returned URL, then pinterest_create_pin with source_type 'video_id'.

Start with pinterest_get_user_account to confirm the token works and learn the
account type. If a call fails with 403, the token is missing that endpoint's scope:
re-authorize with pinterest_build_oauth_url requesting the scope named in the failing
tool's description.`;

/**
 * Builds a server instance. One per session for HTTP, one per process for stdio —
 * so a hosted deployment can serve callers with different tokens without leaking
 * one caller's credentials into another's client.
 */
export function buildServer(config: ServerConfig, accessToken?: string): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { instructions: INSTRUCTIONS },
  );

  const client = new PinterestClient({
    accessToken: accessToken ?? config.accessToken,
    baseUrl: config.baseUrl,
    maxRetries: config.maxRetries,
  });

  const context = {
    server,
    client,
    resolveToken: () => accessToken ?? config.accessToken,
  };

  registerAccountTools(context);
  registerBoardTools(context);
  registerPinTools(context);
  registerSearchTools(context);
  registerRawTool(context);
  registerOAuthTools({
    appId: config.appId,
    appSecret: config.appSecret,
    redirectUri: config.redirectUri,
    baseUrl: config.baseUrl,
  })(context);

  return server;
}
