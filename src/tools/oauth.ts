import { z } from "zod";
import { ok, run, type ToolModule } from "./shared.js";
import { PRODUCTION_BASE_URL } from "../client.js";

/** The scopes this server's tools can use, grouped so the agent can pick a sensible set. */
export const KNOWN_SCOPES = [
  "user_accounts:read",
  "boards:read",
  "boards:write",
  "boards:read_secret",
  "boards:write_secret",
  "pins:read",
  "pins:write",
  "pins:read_secret",
  "pins:write_secret",
] as const;

/** Enough for everything this server exposes except secret boards. */
export const DEFAULT_SCOPES = [
  "user_accounts:read",
  "boards:read",
  "boards:write",
  "pins:read",
  "pins:write",
] as const;

const AUTHORIZE_URL = "https://www.pinterest.com/oauth/";

/**
 * The token endpoint takes Basic app credentials and a form body, not the Bearer
 * token + JSON the rest of v5 uses, so these two tools bypass PinterestClient.
 */
async function tokenRequest(
  form: Record<string, string>,
  appId: string,
  appSecret: string,
  baseUrl: string,
): Promise<unknown> {
  const credentials = Buffer.from(`${appId}:${appSecret}`).toString("base64");
  const response = await fetch(`${baseUrl.replace(/\/+$/, "")}/oauth/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${credentials}`,
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: new URLSearchParams(form).toString(),
  });

  const text = await response.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text;
  }
  if (!response.ok) {
    throw new Error(`Pinterest token endpoint returned ${response.status}: ${JSON.stringify(parsed)}`);
  }
  return parsed;
}

export interface OAuthConfig {
  appId?: string;
  appSecret?: string;
  redirectUri?: string;
  baseUrl?: string;
}

export function registerOAuthTools(config: OAuthConfig): ToolModule {
  return ({ server }) => {
    const baseUrl = config.baseUrl ?? PRODUCTION_BASE_URL;

    server.registerTool(
      "pinterest_build_oauth_url",
      {
        title: "Build an OAuth authorization URL",
        description:
          "Build the Pinterest consent URL to open in a browser. The user approves, Pinterest redirects to your redirect_uri with a `code` query parameter, and you exchange that code with pinterest_exchange_oauth_code. Makes no network call.",
        inputSchema: {
          app_id: z
            .string()
            .optional()
            .describe("Pinterest app id. Falls back to the PINTEREST_APP_ID environment variable."),
          redirect_uri: z
            .string()
            .url()
            .optional()
            .describe(
              "Must match a redirect URI registered on the app exactly. Falls back to PINTEREST_REDIRECT_URI.",
            ),
          scopes: z
            .array(z.enum(KNOWN_SCOPES))
            .optional()
            .describe(`Scopes to request. Defaults to: ${DEFAULT_SCOPES.join(", ")}.`),
          state: z
            .string()
            .optional()
            .describe("Opaque value echoed back on redirect. Use it to defend against CSRF."),
        },
        annotations: { readOnlyHint: true, openWorldHint: false },
      },
      async ({ app_id, redirect_uri, scopes, state }) =>
        run(async () => {
          const clientId = app_id ?? config.appId;
          const redirect = redirect_uri ?? config.redirectUri;
          if (!clientId) {
            throw new Error("No app id. Pass app_id or set PINTEREST_APP_ID.");
          }
          if (!redirect) {
            throw new Error("No redirect URI. Pass redirect_uri or set PINTEREST_REDIRECT_URI.");
          }

          const url = new URL(AUTHORIZE_URL);
          url.searchParams.set("client_id", clientId);
          url.searchParams.set("redirect_uri", redirect);
          url.searchParams.set("response_type", "code");
          url.searchParams.set("scope", (scopes ?? DEFAULT_SCOPES).join(","));
          if (state) url.searchParams.set("state", state);

          return ok({
            authorization_url: url.toString(),
            next_step:
              "Open this URL, approve access, then copy the `code` query parameter from the redirect and pass it to pinterest_exchange_oauth_code.",
            scopes_requested: scopes ?? DEFAULT_SCOPES,
          });
        }),
    );

    server.registerTool(
      "pinterest_exchange_oauth_code",
      {
        title: "Exchange an OAuth code for tokens",
        description:
          "Exchange the `code` from the OAuth redirect for an access token and refresh token. Access tokens last about 30 days; refresh tokens about a year. Store both securely.",
        inputSchema: {
          code: z.string().describe("The `code` query parameter from the redirect URL."),
          app_id: z.string().optional().describe("Falls back to PINTEREST_APP_ID."),
          app_secret: z.string().optional().describe("Falls back to PINTEREST_APP_SECRET."),
          redirect_uri: z
            .string()
            .url()
            .optional()
            .describe("Must be identical to the one used to build the authorization URL."),
        },
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: true,
        },
      },
      async ({ code, app_id, app_secret, redirect_uri }) =>
        run(async () => {
          const clientId = app_id ?? config.appId;
          const clientSecret = app_secret ?? config.appSecret;
          const redirect = redirect_uri ?? config.redirectUri;
          if (!clientId || !clientSecret) {
            throw new Error(
              "Missing app credentials. Pass app_id and app_secret, or set PINTEREST_APP_ID and PINTEREST_APP_SECRET.",
            );
          }
          if (!redirect) {
            throw new Error("No redirect URI. Pass redirect_uri or set PINTEREST_REDIRECT_URI.");
          }

          const tokens = await tokenRequest(
            { grant_type: "authorization_code", code, redirect_uri: redirect },
            clientId,
            clientSecret,
            baseUrl,
          );
          return ok({
            ...(tokens as Record<string, unknown>),
            next_step:
              "Set the access_token as PINTEREST_ACCESS_TOKEN and keep the refresh_token somewhere safe.",
          });
        }),
    );

    server.registerTool(
      "pinterest_refresh_access_token",
      {
        title: "Refresh an access token",
        description:
          "Trade a refresh token for a fresh access token. Use this when calls start failing with 401.",
        inputSchema: {
          refresh_token: z.string().describe("The refresh token from the original exchange."),
          app_id: z.string().optional().describe("Falls back to PINTEREST_APP_ID."),
          app_secret: z.string().optional().describe("Falls back to PINTEREST_APP_SECRET."),
          scope: z
            .string()
            .optional()
            .describe("Optionally narrow the new token to a subset of the original scopes."),
        },
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: true,
        },
      },
      async ({ refresh_token, app_id, app_secret, scope }) =>
        run(async () => {
          const clientId = app_id ?? config.appId;
          const clientSecret = app_secret ?? config.appSecret;
          if (!clientId || !clientSecret) {
            throw new Error(
              "Missing app credentials. Pass app_id and app_secret, or set PINTEREST_APP_ID and PINTEREST_APP_SECRET.",
            );
          }

          const form: Record<string, string> = { grant_type: "refresh_token", refresh_token };
          if (scope) form.scope = scope;
          return ok(await tokenRequest(form, clientId, clientSecret, baseUrl));
        }),
    );
  };
}
