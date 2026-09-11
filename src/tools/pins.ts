import { z } from "zod";
import { adAccountShape, ok, paginationShape, run, type ToolModule } from "./shared.js";

/**
 * Pinterest accepts several media shapes when creating a pin. Modelling them as a
 * discriminated union means the agent gets told which fields go together instead of
 * discovering it from a 400.
 */
const mediaSource = z
  .discriminatedUnion("source_type", [
    z.object({
      source_type: z.literal("image_url"),
      url: z.string().url().describe("Publicly reachable image URL. Pinterest fetches it server-side."),
      is_standard: z.boolean().optional(),
    }),
    z.object({
      source_type: z.literal("image_base64"),
      content_type: z
        .enum(["image/jpeg", "image/png", "image/gif"])
        .describe("MIME type of the encoded image."),
      data: z.string().describe("Base64-encoded image bytes, without a data: prefix."),
      is_standard: z.boolean().optional(),
    }),
    z.object({
      source_type: z.literal("multiple_image_urls"),
      items: z
        .array(
          z.object({
            url: z.string().url(),
            title: z.string().optional(),
            description: z.string().optional(),
            link: z.string().url().optional(),
          }),
        )
        .min(2)
        .max(5)
        .describe("Carousel slides, 2-5 images."),
      index: z.number().int().optional().describe("Zero-based index of the cover slide."),
    }),
    z.object({
      source_type: z.literal("video_id"),
      media_id: z
        .string()
        .describe("Media id from pinterest_register_media, uploaded and in status 'succeeded'."),
      cover_image_url: z.string().url().optional().describe("Publicly reachable cover image URL."),
      cover_image_content_type: z.enum(["image/jpeg", "image/png", "image/gif"]).optional(),
      cover_image_data: z.string().optional().describe("Base64 cover image, paired with cover_image_content_type."),
    }),
  ])
  .describe("The pin's media. Pick the variant matching what you have: a URL, base64 bytes, a carousel, or an uploaded video.");

export const registerPinTools: ToolModule = ({ server, client }) => {
  server.registerTool(
    "pinterest_list_pins",
    {
      title: "List pins",
      description:
        "List the authenticated user's pins, newest first. Scope: pins:read (plus pins:read_secret for pins on secret boards).",
      inputSchema: {
        ...paginationShape,
        ...adAccountShape,
        pin_filter: z
          .enum(["exclude_native", "exclude_repins", "has_been_promoted"])
          .optional()
          .describe("Restrict to a subset of the account's pins."),
        include_protected_pins: z.boolean().optional(),
        pin_type: z.enum(["PRIVATE"]).optional(),
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
          .optional(),
        pin_metrics: z.boolean().optional().describe("Include 90-day and lifetime metrics per pin."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) => run(async () => ok(await client.request("/pins", { query: args }))),
  );

  server.registerTool(
    "pinterest_get_pin",
    {
      title: "Get pin",
      description: "Fetch a single pin by id, including its media, link and board. Scope: pins:read.",
      inputSchema: {
        pin_id: z.string().describe("The numeric pin id."),
        ...adAccountShape,
        pin_metrics: z.boolean().optional().describe("Include 90-day and lifetime metrics."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ pin_id, ...query }) =>
      run(async () => ok(await client.request(`/pins/${encodeURIComponent(pin_id)}`, { query }))),
  );

  server.registerTool(
    "pinterest_create_pin",
    {
      title: "Create pin",
      description:
        "Create a pin on one of the authenticated user's boards. Requires a board_id and a media_source. Scope: pins:write (pins:write_secret for secret boards).",
      inputSchema: {
        board_id: z.string().describe("Board to save the pin to."),
        media_source: mediaSource,
        title: z.string().max(100).optional().describe("Pin title, up to 100 characters."),
        description: z.string().max(800).optional().describe("Pin description, up to 800 characters."),
        link: z.string().url().optional().describe("Destination URL opened when the pin is clicked."),
        alt_text: z.string().max(500).optional().describe("Accessibility text describing the image."),
        board_section_id: z.string().optional().describe("Section within the board."),
        dominant_color: z
          .string()
          .regex(/^#[0-9a-fA-F]{6}$/)
          .optional()
          .describe("Hex colour like '#6E7874'. Only for non-video pins."),
        note: z.string().max(500).optional().describe("Private note, visible only to the owner."),
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
        ok(await client.request("/pins", { method: "POST", body, query: { ad_account_id } })),
      ),
  );

  server.registerTool(
    "pinterest_update_pin",
    {
      title: "Update pin",
      description:
        "Update a pin's text fields, link or board placement. Media cannot be changed after creation. Scope: pins:write.",
      inputSchema: {
        pin_id: z.string().describe("The pin id to update."),
        title: z.string().max(100).optional(),
        description: z.string().max(800).optional(),
        link: z.string().url().optional(),
        alt_text: z.string().max(500).optional(),
        board_id: z.string().optional().describe("Move the pin to this board."),
        board_section_id: z.string().optional().describe("Move the pin to this section."),
        note: z.string().max(500).optional(),
        ...adAccountShape,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ pin_id, ad_account_id, ...body }) =>
      run(async () =>
        ok(
          await client.request(`/pins/${encodeURIComponent(pin_id)}`, {
            method: "PATCH",
            body,
            query: { ad_account_id },
          }),
        ),
      ),
  );

  server.registerTool(
    "pinterest_delete_pin",
    {
      title: "Delete pin",
      description: "Permanently delete a pin. This cannot be undone. Scope: pins:write.",
      inputSchema: {
        pin_id: z.string().describe("The pin id to delete permanently."),
        ...adAccountShape,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ pin_id, ...query }) =>
      run(async () => {
        await client.request(`/pins/${encodeURIComponent(pin_id)}`, { method: "DELETE", query });
        return ok({ deleted: true, pin_id });
      }),
  );

  server.registerTool(
    "pinterest_save_pin",
    {
      title: "Save (repin) a pin",
      description:
        "Save an existing pin to one of the authenticated user's boards — the API equivalent of a repin. Scope: pins:write.",
      inputSchema: {
        pin_id: z.string().describe("The pin to save."),
        board_id: z.string().describe("Destination board."),
        board_section_id: z.string().optional().describe("Destination section within the board."),
        ...adAccountShape,
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ pin_id, ad_account_id, ...body }) =>
      run(async () =>
        ok(
          await client.request(`/pins/${encodeURIComponent(pin_id)}/save`, {
            method: "POST",
            body,
            query: { ad_account_id },
          }),
        ),
      ),
  );

  server.registerTool(
    "pinterest_register_media",
    {
      title: "Register a video upload",
      description:
        "Step 1 of video pin creation: register an upload and receive one-time S3 form fields. POST the video to `upload_url` with those `upload_parameters` as multipart form fields, poll pinterest_get_media until status is 'succeeded', then pass the media_id to pinterest_create_pin with source_type 'video_id'. Scope: pins:write.",
      inputSchema: {
        media_type: z.literal("video").describe("Only 'video' is supported by the v5 media endpoint."),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (body) =>
      run(async () => ok(await client.request("/media", { method: "POST", body }))),
  );

  server.registerTool(
    "pinterest_get_media",
    {
      title: "Get media upload status",
      description:
        "Check a registered upload. Status moves registered -> processing -> succeeded (or failed). Scope: pins:read.",
      inputSchema: { media_id: z.string().describe("Media id from pinterest_register_media.") },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ media_id }) =>
      run(async () => ok(await client.request(`/media/${encodeURIComponent(media_id)}`))),
  );

  server.registerTool(
    "pinterest_list_media",
    {
      title: "List media uploads",
      description: "List the account's registered media uploads and their statuses. Scope: pins:read.",
      inputSchema: { ...paginationShape },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (query) => run(async () => ok(await client.request("/media", { query }))),
  );
};
