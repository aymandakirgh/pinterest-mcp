import { z } from "zod";
import { ok, run, type ToolModule } from "./shared.js";

/**
 * Escape hatch for the parts of v5 this server does not wrap yet — ad accounts,
 * catalogs, audiences, conversion events. Authenticated the same way as every
 * other tool, so it grants no access the token does not already have.
 */
export const registerRawTool: ToolModule = ({ server, client }) => {
  server.registerTool(
    "pinterest_api_request",
    {
      title: "Call any Pinterest v5 endpoint",
      description:
        "Escape hatch: issue an arbitrary request against the Pinterest API v5 using the configured token. Use this only for endpoints no dedicated tool covers — ad accounts, catalogs, audiences, conversion events. Prefer the specific tools when one exists: they validate input and explain failures. Path is relative to https://api.pinterest.com/v5.",
      inputSchema: {
        path: z
          .string()
          .min(1)
          .describe("Path below the v5 root, e.g. '/ad_accounts' or '/catalogs/product_groups'."),
        method: z
          .enum(["GET", "POST", "PATCH", "PUT", "DELETE"])
          .optional()
          .describe("HTTP method. Defaults to GET."),
        query: z
          .record(z.union([z.string(), z.number(), z.boolean()]))
          .optional()
          .describe("Query string parameters."),
        body: z
          .record(z.unknown())
          .optional()
          .describe("JSON request body, for POST/PATCH/PUT."),
      },
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    async ({ path, method, query, body }) =>
      run(async () =>
        ok(
          await client.request(path, {
            method: method ?? "GET",
            query,
            body,
          }),
        ),
      ),
  );
};
