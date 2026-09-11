import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { PinterestApiError, type PinterestClient } from "../client.js";

/** Everything a tool module needs to register itself. */
export interface ToolContext {
  server: McpServer;
  client: PinterestClient;
  /** Resolves the token for the current call (per-session for HTTP, static for stdio). */
  resolveToken: () => string | undefined;
}

export type ToolModule = (context: ToolContext) => void;

export interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
  // The SDK's CallToolResult carries an open index signature; matching it here
  // keeps handler return types assignable without casting at every call site.
  [key: string]: unknown;
}

/** Renders a successful payload as pretty JSON — the shape agents parse most reliably. */
export function ok(payload: unknown): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
  };
}

export function fail(message: string): ToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

/**
 * Wraps a tool body so an API failure becomes a readable tool error rather than a
 * transport-level exception. Agents can act on the former; the latter just aborts.
 */
export async function run(body: () => Promise<ToolResult>): Promise<ToolResult> {
  try {
    return await body();
  } catch (error) {
    if (error instanceof PinterestApiError) {
      return fail(
        `${error.message}\n\n${hint(error)}\n\nFull response:\n${JSON.stringify(error.body, null, 2)}`,
      );
    }
    return fail(error instanceof Error ? error.message : String(error));
  }
}

/** Maps the failures users actually hit onto the fix, so the agent can self-correct. */
function hint(error: PinterestApiError): string {
  switch (error.status) {
    case 401:
      return "The access token is missing, expired or malformed. Refresh it with pinterest_refresh_access_token, or re-run the OAuth flow via pinterest_build_oauth_url.";
    case 403:
      return "The token is valid but lacks the scope for this endpoint, or the app is still in trial access. Check the scopes granted at authorization time against the scope listed in this tool's description.";
    case 404:
      return "The resource does not exist, or it belongs to an account this token cannot see. Confirm the id, and for business accounts confirm ad_account_id.";
    case 429:
      return "Rate limited by Pinterest after retries. Wait before retrying, or reduce page_size / request frequency.";
    default:
      return "See the full response below for the Pinterest error code.";
  }
}

/** Shared pagination inputs for the v5 collection endpoints. */
export const paginationShape = {
  page_size: z
    .number()
    .int()
    .min(1)
    .max(250)
    .optional()
    .describe("Results per page, 1-250. Pinterest defaults to 25."),
  bookmark: z
    .string()
    .optional()
    .describe("Opaque cursor from a previous response's `bookmark` field. Omit for the first page."),
};

/** Present on every business endpoint that can act on behalf of an ad account. */
export const adAccountShape = {
  ad_account_id: z
    .string()
    .optional()
    .describe("Act on behalf of this ad account. Required only for business accounts operating on a shared asset."),
};

export const DATE_DESCRIPTION =
  "Date as YYYY-MM-DD. Must be within the last 90 days and no later than today.";
