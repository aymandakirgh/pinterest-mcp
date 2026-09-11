import { PRODUCTION_BASE_URL, SANDBOX_BASE_URL } from "./client.js";

export interface ServerConfig {
  accessToken: string | undefined;
  appId: string | undefined;
  appSecret: string | undefined;
  redirectUri: string | undefined;
  baseUrl: string;
  maxRetries: number;
  /** Key that seals the tokens the MCP authorization server issues. */
  authSecret: string | undefined;
  /** Absolute origin of this deployment, used to build OAuth URLs. */
  publicBaseUrl: string | undefined;
}

/**
 * Reads configuration from the environment. Every field is optional: a server with
 * no token still starts and still lists its tools, so an agent can run the OAuth
 * tools to obtain one. Tools that need a token fail with a clear message instead.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const useSandbox = isTruthy(env.PINTEREST_SANDBOX);
  const baseUrl =
    env.PINTEREST_API_BASE_URL ?? (useSandbox ? SANDBOX_BASE_URL : PRODUCTION_BASE_URL);

  const retries = Number(env.PINTEREST_MAX_RETRIES);

  return {
    accessToken: nonEmpty(env.PINTEREST_ACCESS_TOKEN),
    appId: nonEmpty(env.PINTEREST_APP_ID),
    appSecret: nonEmpty(env.PINTEREST_APP_SECRET),
    redirectUri: nonEmpty(env.PINTEREST_REDIRECT_URI),
    baseUrl,
    maxRetries: Number.isFinite(retries) && retries > 0 ? Math.floor(retries) : 3,
    authSecret: nonEmpty(env.MCP_AUTH_SECRET),
    publicBaseUrl: nonEmpty(env.PUBLIC_BASE_URL)?.replace(/\/+$/, ""),
  };
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

function isTruthy(value: string | undefined): boolean {
  if (!value) return false;
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}
