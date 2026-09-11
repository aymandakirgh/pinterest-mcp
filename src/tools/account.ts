import { z } from "zod";
import {
  DATE_DESCRIPTION,
  adAccountShape,
  ok,
  paginationShape,
  run,
  type ToolModule,
} from "./shared.js";

/**
 * Pinterest adds metric names over time, so these stay open strings with the
 * documented values in the description — an enum here would reject valid input
 * the day Pinterest ships a new metric.
 */
const metricTypes = z
  .array(z.string())
  .optional()
  .describe(
    "Metrics to return. Common values: ENGAGEMENT, IMPRESSION, PIN_CLICK, OUTBOUND_CLICK, SAVE, SAVE_RATE, TOTAL_AUDIENCE, ENGAGED_AUDIENCE, PROFILE_VISIT, USER_FOLLOW. Omit for all available.",
  );

const analyticsWindowShape = {
  start_date: z.string().describe(`Start of the window, inclusive. ${DATE_DESCRIPTION}`),
  end_date: z.string().describe(`End of the window, inclusive. ${DATE_DESCRIPTION}`),
  metric_types: metricTypes,
  app_types: z
    .enum(["ALL", "MOBILE", "TABLET", "WEB"])
    .optional()
    .describe("Restrict to a surface. Defaults to ALL."),
  ...adAccountShape,
};

export const registerAccountTools: ToolModule = ({ server, client }) => {
  server.registerTool(
    "pinterest_get_user_account",
    {
      title: "Get my account",
      description:
        "Fetch the authenticated user's account: username, id, account type, profile image and follower counts. The fastest way to verify a token works. Scope: user_accounts:read.",
      inputSchema: { ...adAccountShape },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (query) => run(async () => ok(await client.request("/user_account", { query }))),
  );

  server.registerTool(
    "pinterest_get_user_analytics",
    {
      title: "Get account analytics",
      description:
        "Daily account-level analytics over a date window of up to 90 days. Scope: user_accounts:read and pins:read.",
      inputSchema: {
        ...analyticsWindowShape,
        from_claimed_content: z
          .enum(["Other", "Claimed", "Both"])
          .optional()
          .describe("Filter by whether the content comes from a claimed domain."),
        pin_format: z
          .enum(["ALL", "PRODUCT", "REGULAR", "VIDEO"])
          .optional()
          .describe("Restrict to a pin format."),
        content_type: z
          .enum(["ALL", "ORGANIC", "PAID"])
          .optional()
          .describe("Organic, paid, or both."),
        source: z
          .enum(["ALL", "YOUR_PINS", "OTHER_PINS"])
          .optional()
          .describe("Whether the metrics cover your pins, others' pins of your content, or both."),
        split_field: z
          .string()
          .optional()
          .describe("Break results down by a dimension, e.g. PIN_FORMAT, CONTENT_TYPE, SOURCE."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (query) =>
      run(async () => ok(await client.request("/user_account/analytics", { query }))),
  );

  server.registerTool(
    "pinterest_get_top_pins",
    {
      title: "Get top performing pins",
      description:
        "Rank the account's pins by a metric over a date window — the tool to reach for when asked what is working. Scope: user_accounts:read and pins:read.",
      inputSchema: {
        ...analyticsWindowShape,
        sort_by: z
          .string()
          .optional()
          .describe("Metric to rank by, e.g. IMPRESSION, SAVE, PIN_CLICK, OUTBOUND_CLICK, ENGAGEMENT."),
        num_of_pins: z
          .number()
          .int()
          .min(1)
          .max(50)
          .optional()
          .describe("How many pins to return, 1-50. Defaults to 10."),
        created_in_last_n_days: z
          .number()
          .int()
          .optional()
          .describe("Only consider pins created in the last N days."),
        from_claimed_content: z.enum(["Other", "Claimed", "Both"]).optional(),
        pin_format: z.enum(["ALL", "PRODUCT", "REGULAR", "VIDEO"]).optional(),
        content_type: z.enum(["ALL", "ORGANIC", "PAID"]).optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (query) =>
      run(async () => ok(await client.request("/user_account/analytics/top_pins", { query }))),
  );

  server.registerTool(
    "pinterest_get_top_video_pins",
    {
      title: "Get top performing video pins",
      description:
        "Rank the account's video pins by a video metric over a date window. Scope: user_accounts:read and pins:read.",
      inputSchema: {
        ...analyticsWindowShape,
        sort_by: z
          .string()
          .optional()
          .describe("Video metric to rank by, e.g. VIDEO_MRC_VIEW, VIDEO_AVG_WATCH_TIME, VIDEO_V50_WATCH_TIME, QUARTILE_95_PERCENT_VIEW."),
        num_of_pins: z.number().int().min(1).max(50).optional(),
        created_in_last_n_days: z.number().int().optional(),
        from_claimed_content: z.enum(["Other", "Claimed", "Both"]).optional(),
        pin_format: z.enum(["ALL", "PRODUCT", "REGULAR", "VIDEO"]).optional(),
        content_type: z.enum(["ALL", "ORGANIC", "PAID"]).optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (query) =>
      run(async () =>
        ok(await client.request("/user_account/analytics/top_video_pins", { query })),
      ),
  );

  server.registerTool(
    "pinterest_get_pin_analytics",
    {
      title: "Get analytics for one pin",
      description:
        "Daily analytics for a single pin over a date window of up to 90 days. Scope: pins:read.",
      inputSchema: {
        pin_id: z.string().describe("The pin to analyse."),
        ...analyticsWindowShape,
        split_field: z
          .string()
          .optional()
          .describe("Break results down by a dimension, e.g. NO_SPLIT, NAMED_SPLIT."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ pin_id, ...query }) =>
      run(async () =>
        ok(await client.request(`/pins/${encodeURIComponent(pin_id)}/analytics`, { query })),
      ),
  );

  server.registerTool(
    "pinterest_get_multi_pin_analytics",
    {
      title: "Get analytics for several pins",
      description:
        "Analytics for up to 100 pins in one call — far cheaper than looping pinterest_get_pin_analytics. Scope: pins:read.",
      inputSchema: {
        pin_ids: z
          .array(z.string())
          .min(1)
          .max(100)
          .describe("Up to 100 pin ids to fetch together."),
        ...analyticsWindowShape,
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (query) => run(async () => ok(await client.request("/pins/analytics", { query }))),
  );

  server.registerTool(
    "pinterest_list_followers",
    {
      title: "List my followers",
      description: "List the accounts following the authenticated user. Scope: user_accounts:read.",
      inputSchema: { ...paginationShape },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (query) =>
      run(async () => ok(await client.request("/user_account/followers", { query }))),
  );

  server.registerTool(
    "pinterest_list_following",
    {
      title: "List who I follow",
      description:
        "List the users and boards the authenticated user follows. Scope: user_accounts:read.",
      inputSchema: {
        ...paginationShape,
        feed_type: z
          .enum(["ALL", "PIN", "BOARD", "USER"])
          .optional()
          .describe("Restrict to a kind of followed entity."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (query) =>
      run(async () => ok(await client.request("/user_account/following", { query }))),
  );

  server.registerTool(
    "pinterest_list_claimed_websites",
    {
      title: "List claimed websites",
      description:
        "List the websites claimed by the authenticated account, with their verification status. Scope: user_accounts:read.",
      inputSchema: { ...paginationShape },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (query) => run(async () => ok(await client.request("/user_account/websites", { query }))),
  );
};
