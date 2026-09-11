/**
 * OAuth 2.1 authorization server for the MCP endpoint.
 *
 * This server sits between an MCP client and Pinterest. The client never sees a
 * Pinterest token: it authorizes here, and the Pinterest credential is sealed
 * inside the access token this server issues. That indirection is what lets any
 * number of people connect their own Pinterest account to the same deployment.
 *
 *   MCP client            this server                Pinterest
 *      |  GET /mcp (401 + resource metadata)            |
 *      |  POST /register  ->  client_id                 |
 *      |  GET /authorize  ------------------->  consent screen
 *      |                  <-- /oauth/pinterest/callback --
 *      |  <-- redirect with our code                    |
 *      |  POST /token     ->  access token (seals Pinterest token)
 *      |  POST /mcp with that token                     |
 *
 * Requires Pinterest Standard access to be useful for anyone but the app owner:
 * under Trial access Pinterest only authorizes the developer's own account.
 */
import { Router, type Request, type Response } from "express";
import type { ServerConfig } from "../config.js";
import { SpentCodes, TokenCipher, verifyPkce } from "./tokens.js";
import { DEFAULT_SCOPES, KNOWN_SCOPES } from "../tools/oauth.js";

const PINTEREST_AUTHORIZE_URL = "https://www.pinterest.com/oauth/";

const CODE_TTL_SECONDS = 600; // 10 minutes, per OAuth 2.1 guidance
const ACCESS_TTL_SECONDS = 60 * 60 * 24 * 25; // just under Pinterest's ~30 day token
const REFRESH_TTL_SECONDS = 60 * 60 * 24 * 300; // Pinterest refresh tokens last ~1 year
const CLIENT_TTL_SECONDS = 60 * 60 * 24 * 365;

interface PendingAuthorization extends Record<string, unknown> {
  client_id: string;
  redirect_uri: string;
  state?: string;
  code_challenge: string;
  scope: string;
}

interface AuthorizationCode extends Record<string, unknown> {
  access_token: string;
  refresh_token?: string;
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  scope: string;
}

interface RegisteredClient extends Record<string, unknown> {
  redirect_uris: string[];
  client_name?: string;
}

export interface AuthDeps {
  config: ServerConfig;
  cipher: TokenCipher;
  /** Absolute base URL of this deployment, e.g. https://host — no trailing slash. */
  issuer: (req: Request) => string;
}

function oauthError(res: Response, status: number, error: string, description: string): void {
  res.status(status).json({ error, error_description: description });
}

/** Loopback redirects vary by port, so they are compared without it. */
function redirectUriAllowed(candidate: string, allowed: string[]): boolean {
  if (allowed.includes(candidate)) return true;
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return false;
  }
  if (parsed.hostname !== "127.0.0.1" && parsed.hostname !== "localhost") return false;

  return allowed.some((entry) => {
    try {
      const known = new URL(entry);
      return (
        (known.hostname === "127.0.0.1" || known.hostname === "localhost") &&
        known.pathname === parsed.pathname
      );
    } catch {
      return false;
    }
  });
}

export function createAuthRouter(deps: AuthDeps): Router {
  const { config, cipher, issuer } = deps;
  const router = Router();
  const spentCodes = new SpentCodes();

  const configured = (): boolean => Boolean(config.appId && config.appSecret);

  /** RFC 9728 — tells the client which authorization server guards this resource. */
  router.get("/.well-known/oauth-protected-resource", (req: Request, res: Response) => {
    const base = issuer(req);
    res.json({
      resource: `${base}/mcp`,
      authorization_servers: [base],
      scopes_supported: [...KNOWN_SCOPES],
      bearer_methods_supported: ["header"],
      resource_documentation: "https://github.com/aymandakirgh/pinterest-mcp",
    });
  });

  /** RFC 8414 — what this authorization server supports. */
  const authorizationServerMetadata = (req: Request, res: Response): void => {
    const base = issuer(req);
    res.json({
      issuer: base,
      authorization_endpoint: `${base}/authorize`,
      token_endpoint: `${base}/token`,
      registration_endpoint: `${base}/register`,
      scopes_supported: [...KNOWN_SCOPES],
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      authorization_response_iss_parameter_supported: true,
    });
  };
  router.get("/.well-known/oauth-authorization-server", authorizationServerMetadata);
  router.get("/.well-known/openid-configuration", authorizationServerMetadata);

  /**
   * RFC 7591 dynamic client registration. The client id is itself a sealed
   * envelope holding the registration, so nothing is stored server-side.
   */
  router.post("/register", (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const redirectUris = body.redirect_uris;

    if (!Array.isArray(redirectUris) || redirectUris.length === 0) {
      return oauthError(res, 400, "invalid_redirect_uri", "redirect_uris must be a non-empty array");
    }
    for (const uri of redirectUris) {
      if (typeof uri !== "string") {
        return oauthError(res, 400, "invalid_redirect_uri", "redirect_uris must be strings");
      }
      let parsed: URL;
      try {
        parsed = new URL(uri);
      } catch {
        return oauthError(res, 400, "invalid_redirect_uri", `not a valid URL: ${uri}`);
      }
      // Anything other than TLS or a loopback address would leak the code in transit.
      const loopback = parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost";
      if (parsed.protocol !== "https:" && !loopback && parsed.protocol !== "http:") {
        return oauthError(res, 400, "invalid_redirect_uri", `unsupported scheme: ${parsed.protocol}`);
      }
      if (parsed.protocol === "http:" && !loopback) {
        return oauthError(res, 400, "invalid_redirect_uri", "http is only allowed for loopback");
      }
    }

    const clientId = cipher.seal(
      "client",
      {
        redirect_uris: redirectUris,
        client_name: typeof body.client_name === "string" ? body.client_name : undefined,
      },
      CLIENT_TTL_SECONDS,
    );

    res.status(201).json({
      client_id: clientId,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      redirect_uris: redirectUris,
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      client_name: body.client_name,
    });
  });

  router.get("/authorize", (req: Request, res: Response) => {
    if (!configured()) {
      return oauthError(
        res,
        503,
        "temporarily_unavailable",
        "This deployment has no Pinterest app credentials configured.",
      );
    }

    const {
      response_type: responseType,
      client_id: clientId,
      redirect_uri: redirectUri,
      code_challenge: codeChallenge,
      code_challenge_method: challengeMethod,
      state,
      scope,
    } = req.query as Record<string, string | undefined>;

    if (responseType !== "code") {
      return oauthError(res, 400, "unsupported_response_type", "only response_type=code is supported");
    }
    if (!clientId) return oauthError(res, 400, "invalid_request", "client_id is required");
    if (!redirectUri) return oauthError(res, 400, "invalid_request", "redirect_uri is required");
    if (!codeChallenge || challengeMethod !== "S256") {
      return oauthError(
        res,
        400,
        "invalid_request",
        "PKCE is required: send code_challenge with code_challenge_method=S256",
      );
    }

    const client = cipher.open<RegisteredClient>("client", clientId);
    if (!client) {
      return oauthError(res, 400, "invalid_client", "unknown or expired client_id; register again");
    }
    // Validated before any redirect, so an attacker cannot aim the code elsewhere.
    if (!redirectUriAllowed(redirectUri, client.redirect_uris)) {
      return oauthError(res, 400, "invalid_request", "redirect_uri does not match this client");
    }

    const requested = (scope ?? "").split(/[\s,]+/).filter(Boolean);
    const granted = requested.filter((entry) => (KNOWN_SCOPES as readonly string[]).includes(entry));
    const effective = granted.length > 0 ? granted : [...DEFAULT_SCOPES];

    const pending = cipher.seal(
      "code",
      {
        client_id: clientId,
        redirect_uri: redirectUri,
        state,
        code_challenge: codeChallenge,
        scope: effective.join(","),
      } satisfies PendingAuthorization,
      CODE_TTL_SECONDS,
    );

    const target = new URL(PINTEREST_AUTHORIZE_URL);
    target.searchParams.set("client_id", config.appId as string);
    target.searchParams.set("redirect_uri", `${issuer(req)}/oauth/pinterest/callback`);
    target.searchParams.set("response_type", "code");
    target.searchParams.set("scope", effective.join(","));
    target.searchParams.set("state", pending);
    res.redirect(target.toString());
  });

  /** Where Pinterest sends the user back. Not an endpoint MCP clients call. */
  router.get("/oauth/pinterest/callback", async (req: Request, res: Response) => {
    const { code, state, error, error_description: errorDescription } = req.query as Record<
      string,
      string | undefined
    >;

    const pending = state ? cipher.open<PendingAuthorization>("code", state) : null;
    if (!pending) {
      return oauthError(
        res,
        400,
        "invalid_request",
        "Authorization state was missing, tampered with or expired. Start the flow again.",
      );
    }

    const back = new URL(pending.redirect_uri);
    if (pending.state) back.searchParams.set("state", pending.state);
    // RFC 9207: let the client detect an authorization-server mix-up.
    back.searchParams.set("iss", issuer(req));

    if (error) {
      back.searchParams.set("error", error);
      if (errorDescription) back.searchParams.set("error_description", errorDescription);
      return res.redirect(back.toString());
    }
    if (!code) {
      back.searchParams.set("error", "invalid_request");
      back.searchParams.set("error_description", "Pinterest returned no authorization code");
      return res.redirect(back.toString());
    }

    try {
      const tokens = await exchangeWithPinterest(config, issuer(req), {
        grant_type: "authorization_code",
        code,
        redirect_uri: `${issuer(req)}/oauth/pinterest/callback`,
      });

      const ourCode = cipher.seal(
        "code",
        {
          access_token: tokens.access_token,
          refresh_token: tokens.refresh_token,
          client_id: pending.client_id,
          redirect_uri: pending.redirect_uri,
          code_challenge: pending.code_challenge,
          scope: pending.scope,
        } satisfies AuthorizationCode,
        CODE_TTL_SECONDS,
      );

      back.searchParams.set("code", ourCode);
      res.redirect(back.toString());
    } catch (caught) {
      back.searchParams.set("error", "server_error");
      back.searchParams.set(
        "error_description",
        caught instanceof Error ? caught.message : "Pinterest token exchange failed",
      );
      res.redirect(back.toString());
    }
  });

  router.post("/token", async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, string | undefined>;
    const grantType = body.grant_type;

    if (grantType === "authorization_code") {
      const { code, code_verifier: verifier, client_id: clientId, redirect_uri: redirectUri } = body;
      if (!code) return oauthError(res, 400, "invalid_request", "code is required");
      if (!verifier) return oauthError(res, 400, "invalid_request", "code_verifier is required");

      const opened = cipher.open<AuthorizationCode>("code", code);
      if (!opened || !("access_token" in opened)) {
        return oauthError(res, 400, "invalid_grant", "authorization code is invalid or expired");
      }
      if (!spentCodes.claim(code, CODE_TTL_SECONDS)) {
        return oauthError(res, 400, "invalid_grant", "authorization code has already been redeemed");
      }
      if (clientId && clientId !== opened.client_id) {
        return oauthError(res, 400, "invalid_grant", "code was issued to a different client");
      }
      if (redirectUri && redirectUri !== opened.redirect_uri) {
        return oauthError(res, 400, "invalid_grant", "redirect_uri does not match the request");
      }
      if (!verifyPkce(verifier, opened.code_challenge)) {
        return oauthError(res, 400, "invalid_grant", "PKCE verification failed");
      }

      return res.json(
        issueTokens(cipher, opened.access_token, opened.refresh_token, opened.scope),
      );
    }

    if (grantType === "refresh_token") {
      const opened = body.refresh_token
        ? cipher.open<{ refresh_token: string; scope: string }>("refresh", body.refresh_token)
        : null;
      if (!opened) {
        return oauthError(res, 400, "invalid_grant", "refresh token is invalid or expired");
      }

      try {
        const tokens = await exchangeWithPinterest(config, issuer(req), {
          grant_type: "refresh_token",
          refresh_token: opened.refresh_token,
        });
        return res.json(
          issueTokens(
            cipher,
            tokens.access_token,
            tokens.refresh_token ?? opened.refresh_token,
            opened.scope,
          ),
        );
      } catch (caught) {
        return oauthError(
          res,
          400,
          "invalid_grant",
          caught instanceof Error ? caught.message : "refresh failed",
        );
      }
    }

    return oauthError(res, 400, "unsupported_grant_type", `unsupported grant_type: ${grantType}`);
  });

  return router;
}

function issueTokens(
  cipher: TokenCipher,
  pinterestAccessToken: string,
  pinterestRefreshToken: string | undefined,
  scope: string,
): Record<string, unknown> {
  return {
    access_token: cipher.seal(
      "access",
      { access_token: pinterestAccessToken, scope },
      ACCESS_TTL_SECONDS,
    ),
    token_type: "Bearer",
    expires_in: ACCESS_TTL_SECONDS,
    scope: scope.split(",").join(" "),
    ...(pinterestRefreshToken
      ? {
          refresh_token: cipher.seal(
            "refresh",
            { refresh_token: pinterestRefreshToken, scope },
            REFRESH_TTL_SECONDS,
          ),
        }
      : {}),
  };
}

interface PinterestTokens {
  access_token: string;
  refresh_token?: string;
}

async function exchangeWithPinterest(
  config: ServerConfig,
  _issuer: string,
  form: Record<string, string>,
): Promise<PinterestTokens> {
  const credentials = Buffer.from(`${config.appId}:${config.appSecret}`).toString("base64");
  const response = await fetch(`${config.baseUrl.replace(/\/+$/, "")}/oauth/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${credentials}`,
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: new URLSearchParams(form).toString(),
  });

  const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok || typeof payload.access_token !== "string") {
    const detail =
      typeof payload.message === "string" ? payload.message : `HTTP ${response.status}`;
    throw new Error(`Pinterest rejected the token request: ${detail}`);
  }

  return {
    access_token: payload.access_token,
    refresh_token: typeof payload.refresh_token === "string" ? payload.refresh_token : undefined,
  };
}
