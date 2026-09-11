#!/usr/bin/env node
/**
 * Streamable-HTTP entry point, for running this server as a hosted remote MCP
 * endpoint rather than a local subprocess.
 *
 * Stateless by design: every POST builds its own server, transport and Pinterest
 * client, then tears them down. That costs a little per call and buys the property
 * that matters for a shared deployment — one caller's token can never be reused to
 * serve another caller's request.
 *
 * Three ways to authenticate, in order of preference:
 *   1. An OAuth token minted by this server (see src/auth), which seals the
 *      caller's own Pinterest credential inside it. This is what lets many people
 *      connect their own accounts to one deployment.
 *   2. A raw Pinterest token passed directly, for scripts and single-user setups.
 *   3. PINTEREST_ACCESS_TOKEN on the server, for a private single-account instance.
 */
import express, { type Request, type Response } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createAuthRouter } from "./auth/router.js";
import { TokenCipher, resolveAuthSecret } from "./auth/tokens.js";
import { loadConfig } from "./config.js";
import { createOAuthRouter } from "./oauth-web.js";
import { SERVER_NAME, SERVER_VERSION, buildServer } from "./server.js";

const config = loadConfig();
const port = Number(process.env.PORT ?? 3000);

const { secret, ephemeral } = resolveAuthSecret(config.authSecret);
const cipher = new TokenCipher(secret);

/** Absolute origin of this deployment; OAuth metadata must advertise it exactly. */
function issuer(req: Request): string {
  if (config.publicBaseUrl) return config.publicBaseUrl;
  // Behind Railway/Heroku-style proxies the original scheme arrives in a header.
  const proto = req.get("x-forwarded-proto")?.split(",")[0] ?? req.protocol;
  return `${proto}://${req.get("host")}`;
}

interface ResolvedAuth {
  token?: string;
  /** True when the caller presented a bearer token this server could not open. */
  rejected?: boolean;
}

/**
 * An OAuth token issued here wins; anything else opaque is taken at face value as
 * a Pinterest token so direct API users keep working.
 */
function resolveAuth(req: Request): ResolvedAuth {
  const explicit = req.header("x-pinterest-access-token")?.trim();
  if (explicit) return { token: explicit };

  const bearer = req.header("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
  if (bearer) {
    const opened = cipher.open<{ access_token: string }>("access", bearer);
    if (opened?.access_token) return { token: opened.access_token };
    // Tokens this server minted are long and base64url; a short opaque string is
    // far more likely to be someone passing their Pinterest token directly.
    return { token: bearer };
  }

  return config.accessToken ? { token: config.accessToken } : { rejected: true };
}

const app = express();
app.set("trust proxy", true);
app.use(express.json({ limit: "12mb" })); // base64 pin images travel in the body
app.use(express.urlencoded({ extended: false })); // OAuth token endpoint posts a form

app.get("/health", (_req: Request, res: Response) => {
  res.json({
    status: "ok",
    server: SERVER_NAME,
    version: SERVER_VERSION,
    // Never echo the token itself, only whether a fallback exists.
    default_token_configured: Boolean(config.accessToken),
    web_login_available: Boolean(config.appId && config.appSecret),
    oauth_enabled: Boolean(config.appId && config.appSecret),
    // A restart invalidates issued tokens unless MCP_AUTH_SECRET is set.
    auth_secret_ephemeral: ephemeral,
  });
});

// OAuth 2.1 authorization server: metadata, registration, authorize, token.
app.use(createAuthRouter({ config, cipher, issuer }));

// Human-facing browser flow for minting a raw token: GET /auth
app.use(createOAuthRouter(config));

app.get("/", (_req: Request, res: Response) => {
  res.redirect(config.appId && config.appSecret ? "/auth" : "/health");
});

app.post("/mcp", async (req: Request, res: Response) => {
  const { token, rejected } = resolveAuth(req);

  if (!token || rejected) {
    // RFC 9728: point the client at the metadata that starts the OAuth dance.
    res.set(
      "WWW-Authenticate",
      `Bearer resource_metadata="${issuer(req)}/.well-known/oauth-protected-resource"`,
    );
    res.status(401).json({
      jsonrpc: "2.0",
      error: {
        code: -32001,
        message:
          "Authentication required. Connect this server through OAuth, or send a Pinterest token as 'Authorization: Bearer <token>' or 'X-Pinterest-Access-Token'.",
      },
      id: null,
    });
    return;
  }

  const server = buildServer(config, token);
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
  if (config.appId && config.appSecret) {
    console.log(`  OAuth login:  GET  http://localhost:${port}/auth`);
  } else {
    console.log("  OAuth disabled: set PINTEREST_APP_ID and PINTEREST_APP_SECRET to enable it");
  }
  if (ephemeral) {
    console.warn(
      "  WARNING: MCP_AUTH_SECRET is unset, so a random key is in use. Issued OAuth tokens will stop working when this process restarts.",
    );
  }
});
