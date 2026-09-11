import { z } from "zod";
import { adAccountShape, ok, paginationShape, run, type ToolModule } from "./shared.js";

export const registerSearchTools: ToolModule = ({ server, client }) => {
  server.registerTool(
    "pinterest_search_my_pins",
    {
      title: "Search my pins",
      description:
        "Full-text search across the authenticated user's own pins. This does NOT search Pinterest globally — the v5 API exposes no public discovery search. Scope: pins:read.",
      inputSchema: {
        query: z
          .string()
          .min(1)
          .describe("Search terms matched against the user's own pin titles and descriptions."),
        ...paginationShape,
        ...adAccountShape,
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (query) => run(async () => ok(await client.request("/search/pins", { query }))),
  );

  server.registerTool(
    "pinterest_search_my_boards",
    {
      title: "Search my boards",
      description:
        "Full-text search across the authenticated user's own boards. Scope: boards:read.",
      inputSchema: {
        query: z
          .string()
          .min(1)
          .describe("Search terms matched against the user's own board names and descriptions."),
        ...paginationShape,
        ...adAccountShape,
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (query) => run(async () => ok(await client.request("/search/boards", { query }))),
  );
};
