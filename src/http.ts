#!/usr/bin/env node
/**
 * Streamable-HTTP entry point, for running this server as a hosted remote MCP
 * endpoint rather than a local subprocess.
 *
 * Stateless by design: every POST builds its own server, transport and Pinterest
 * client, then tears them down. That costs a little per call and buys the property
 * that matters for a shared deployment — one caller's token can never be reused to
 * serve another caller's request.
 */
import express, { type Request, type Response } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { loadConfig } from "./config.js";
import { createOAuthRouter } from "./oauth-web.js";
import { SERVER_NAME, SERVER_VERSION, buildServer } from "./server.js";

const config = loadConfig();
const port = Number(process.env.PORT ?? 3000);

/**
 * A caller supplies their own Pinterest token per request. `Authorization: Bearer`
 * is the conventional slot; the explicit header exists for clients that already
 * spend Authorization on their own gateway auth.
 */
function tokenFromRequest(req: Request): string | undefined {
  const explicit = req.header("x-pinterest-access-token");
  if (explicit && explicit.trim()) return explicit.trim();

  const authorization = req.header("authorization");
  const match = authorization?.match(/^Bearer\s+(.+)$/i);
  if (match?.[1]?.trim()) return match[1].trim();

  return undefined;
}

const app = express();
app.use(express.json({ limit: "12mb" })); // base64 pin images travel in the body

app.get("/health", (_req: Request, res: Response) => {
  res.json({
    status: "ok",
    server: SERVER_NAME,
    version: SERVER_VERSION,
    // Never echo the token itself, only whether a fallback exists.
    default_token_configured: Boolean(config.accessToken),
    web_login_available: Boolean(config.appId && config.appSecret),
  });
});

// Browser flow for minting a token: GET /auth
app.use(createOAuthRouter(config));

app.get("/", (_req: Request, res: Response) => {
  res.redirect(config.appId && config.appSecret ? "/auth" : "/health");
});

app.post("/mcp", async (req: Request, res: Response) => {
  const accessToken = tokenFromRequest(req);

  if (!accessToken && !config.accessToken) {
    res.status(401).json({
      jsonrpc: "2.0",
      error: {
        code: -32001,
        message:
          "No Pinterest access token. Send it as 'Authorization: Bearer <token>' or 'X-Pinterest-Access-Token', or set PINTEREST_ACCESS_TOKEN on the server.",
      },
      id: null,
    });
    return;
  }

  const server = buildServer(config, accessToken);
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });

  res.on("close", () => {
    void transport.close();
    void server.close();
  });

  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    console.error("Error handling MCP request:", error);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" },
        id: null,
      });
    }
  }
});

// Stateless mode has no stream to resume and no session to delete.
const methodNotAllowed = (_req: Request, res: Response): void => {
  res.status(405).json({
    jsonrpc: "2.0",
    error: { code: -32000, message: "This endpoint is stateless; use POST /mcp." },
    id: null,
  });
};
app.get("/mcp", methodNotAllowed);
app.delete("/mcp", methodNotAllowed);

app.listen(port, () => {
  console.log(`${SERVER_NAME} v${SERVER_VERSION} listening on :${port}`);
  console.log(`  MCP endpoint: POST http://localhost:${port}/mcp`);
  console.log(`  Health check: GET  http://localhost:${port}/health`);
});
