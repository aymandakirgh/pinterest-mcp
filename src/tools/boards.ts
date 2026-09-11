import { z } from "zod";
import { adAccountShape, ok, paginationShape, run, type ToolModule } from "./shared.js";

export const registerBoardTools: ToolModule = ({ server, client }) => {
  server.registerTool(
    "pinterest_list_boards",
    {
      title: "List boards",
      description:
        "List the authenticated user's boards, newest first. Scope: boards:read (plus boards:read_secret to include secret boards). Returns a `bookmark` cursor when more pages exist.",
      inputSchema: {
        ...paginationShape,
        ...adAccountShape,
        privacy: z
          .enum(["ALL", "PROTECTED", "PUBLIC", "SECRET", "PUBLIC_AND_SECRET"])
          .optional()
          .describe("Board privacy filter. SECRET requires the boards:read_secret scope."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) => run(async () => ok(await client.request("/boards", { query: args }))),
  );

  server.registerTool(
    "pinterest_get_board",
    {
      title: "Get board",
      description:
        "Fetch a single board by id, including its pin and follower counts. Scope: boards:read.",
      inputSchema: {
        board_id: z.string().describe("The numeric board id returned by pinterest_list_boards."),
        ...adAccountShape,
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ board_id, ...query }) =>
      run(async () =>
        ok(await client.request(`/boards/${encodeURIComponent(board_id)}`, { query })),
      ),
  );

  server.registerTool(
    "pinterest_create_board",
    {
      title: "Create board",
      description:
        "Create a new board on the authenticated account. Scope: boards:write (boards:write_secret for SECRET boards).",
      inputSchema: {
        name: z.string().min(1).max(180).describe("Board name, as shown on the profile."),
        description: z.string().max(500).optional().describe("Board description."),
        privacy: z
          .enum(["PUBLIC", "PROTECTED", "SECRET"])
          .optional()
          .describe("Defaults to PUBLIC. SECRET boards are visible only to the owner."),
        ...adAccountShape,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ ad_account_id, ...body }) =>
      run(async () =>
        ok(await client.request("/boards", { method: "POST", body, query: { ad_account_id } })),
      ),
  );

  server.registerTool(
    "pinterest_update_board",
    {
      title: "Update board",
      description:
        "Update a board's name, description or privacy. Only the fields you pass are changed. Scope: boards:write.",
      inputSchema: {
        board_id: z.string().describe("The board id to update."),
        name: z.string().min(1).max(180).optional(),
        description: z.string().max(500).optional(),
        privacy: z.enum(["PUBLIC", "PROTECTED", "SECRET"]).optional(),
        ...adAccountShape,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ board_id, ad_account_id, ...body }) =>
      run(async () =>
        ok(
          await client.request(`/boards/${encodeURIComponent(board_id)}`, {
            method: "PATCH",
            body,
            query: { ad_account_id },
          }),
        ),
      ),
  );

  server.registerTool(
    "pinterest_delete_board",
    {
      title: "Delete board",
      description:
        "Permanently delete a board AND every pin saved to it. This cannot be undone. Scope: boards:write.",
      inputSchema: {
        board_id: z.string().describe("The board id to delete permanently."),
        ...adAccountShape,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ board_id, ...query }) =>
      run(async () => {
        await client.request(`/boards/${encodeURIComponent(board_id)}`, {
          method: "DELETE",
          query,
        });
        return ok({ deleted: true, board_id });
      }),
  );

  server.registerTool(
    "pinterest_list_board_pins",
    {
      title: "List pins on a board",
      description: "List the pins saved to a board. Scope: pins:read and boards:read.",
      inputSchema: {
        board_id: z.string().describe("The board id whose pins to list."),
        ...paginationShape,
        ...adAccountShape,
        creative_types: z
          .array(
            z.enum([
              "REGULAR",
              "VIDEO",
              "SHOPPING",
              "CAROUSEL",
              "MAX_VIDEO",
              "SHOP_THE_PIN",
              "COLLECTION",
              "IDEA",
            ]),
          )
          .optional()
          .describe("Filter to these pin creative types."),
        pin_metrics: z
          .boolean()
          .optional()
          .describe("Include 90-day and lifetime metrics on each pin."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ board_id, ...query }) =>
      run(async () =>
        ok(await client.request(`/boards/${encodeURIComponent(board_id)}/pins`, { query })),
      ),
  );

  server.registerTool(
    "pinterest_list_board_sections",
    {
      title: "List board sections",
      description: "List the sections within a board. Scope: boards:read.",
      inputSchema: {
        board_id: z.string().describe("The board id whose sections to list."),
        ...paginationShape,
        ...adAccountShape,
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ board_id, ...query }) =>
      run(async () =>
        ok(await client.request(`/boards/${encodeURIComponent(board_id)}/sections`, { query })),
      ),
  );

  server.registerTool(
    "pinterest_create_board_section",
    {
      title: "Create board section",
      description: "Add a section to a board. Scope: boards:write.",
      inputSchema: {
        board_id: z.string().describe("The board to add a section to."),
        name: z.string().min(1).describe("Section name."),
        ...adAccountShape,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ board_id, name, ad_account_id }) =>
      run(async () =>
        ok(
          await client.request(`/boards/${encodeURIComponent(board_id)}/sections`, {
            method: "POST",
            body: { name },
            query: { ad_account_id },
          }),
        ),
      ),
  );

  server.registerTool(
    "pinterest_update_board_section",
    {
      title: "Rename board section",
      description: "Rename an existing board section. Scope: boards:write.",
      inputSchema: {
        board_id: z.string(),
        section_id: z.string(),
        name: z.string().min(1).describe("The new section name."),
        ...adAccountShape,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ board_id, section_id, name, ad_account_id }) =>
      run(async () =>
        ok(
          await client.request(
            `/boards/${encodeURIComponent(board_id)}/sections/${encodeURIComponent(section_id)}`,
            { method: "PATCH", body: { name }, query: { ad_account_id } },
          ),
        ),
      ),
  );

  server.registerTool(
    "pinterest_delete_board_section",
    {
      title: "Delete board section",
      description:
        "Delete a board section. Pins in the section move back to the board root rather than being deleted. Scope: boards:write.",
      inputSchema: {
        board_id: z.string(),
        section_id: z.string(),
        ...adAccountShape,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ board_id, section_id, ...query }) =>
      run(async () => {
        await client.request(
          `/boards/${encodeURIComponent(board_id)}/sections/${encodeURIComponent(section_id)}`,
          { method: "DELETE", query },
        );
        return ok({ deleted: true, board_id, section_id });
      }),
  );

  server.registerTool(
    "pinterest_list_board_section_pins",
    {
      title: "List pins in a board section",
      description:
        "List the pins saved inside one section of a board. Scope: pins:read and boards:read.",
      inputSchema: {
        board_id: z.string(),
        section_id: z.string(),
        ...paginationShape,
        ...adAccountShape,
        pin_metrics: z.boolean().optional().describe("Include per-pin metrics."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ board_id, section_id, ...query }) =>
      run(async () =>
        ok(
          await client.request(
            `/boards/${encodeURIComponent(board_id)}/sections/${encodeURIComponent(section_id)}/pins`,
            { query },
          ),
        ),
      ),
  );
};
