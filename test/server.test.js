import test from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

/** Boots the real server over stdio, exactly as an MCP client would. */
async function connect(env = {}) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["dist/index.js"],
    env: { ...process.env, PINTEREST_ACCESS_TOKEN: "test_token", ...env },
  });
  const client = new Client({ name: "test-harness", version: "0.0.0" });
  await client.connect(transport);
  return client;
}

test("starts and completes an MCP handshake", async () => {
  const client = await connect();
  try {
    const info = client.getServerVersion();
    assert.equal(info.name, "pinterest-mcp");
    assert.ok(client.getInstructions().includes("Pinterest API v5"));
  } finally {
    await client.close();
  }
});

test("advertises the full tool surface with usable schemas", async () => {
  const client = await connect();
  try {
    const { tools } = await client.listTools();
    const names = tools.map((tool) => tool.name);

    for (const expected of [
      "pinterest_get_user_account",
      "pinterest_list_boards",
      "pinterest_create_board",
      "pinterest_delete_board",
      "pinterest_list_pins",
      "pinterest_create_pin",
      "pinterest_save_pin",
      "pinterest_get_user_analytics",
      "pinterest_get_top_pins",
      "pinterest_search_my_pins",
      "pinterest_build_oauth_url",
      "pinterest_api_request",
    ]) {
      assert.ok(names.includes(expected), `missing tool ${expected}`);
    }

    for (const tool of tools) {
      assert.ok(tool.description?.length > 20, `${tool.name} needs a real description`);
      assert.equal(tool.inputSchema.type, "object", `${tool.name} needs an object schema`);
    }
  } finally {
    await client.close();
  }
});

test("marks deletes as destructive so clients can gate them", async () => {
  const client = await connect();
  try {
    const { tools } = await client.listTools();
    const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]));

    assert.equal(byName.pinterest_delete_board.annotations.destructiveHint, true);
    assert.equal(byName.pinterest_delete_pin.annotations.destructiveHint, true);
    assert.equal(byName.pinterest_list_boards.annotations.readOnlyHint, true);
  } finally {
    await client.close();
  }
});

test("builds an OAuth URL without any network access", async () => {
  const client = await connect();
  try {
    const result = await client.callTool({
      name: "pinterest_build_oauth_url",
      arguments: {
        app_id: "1234567",
        redirect_uri: "https://example.com/callback",
        scopes: ["boards:read", "pins:read"],
        state: "xyz",
      },
    });

    const payload = JSON.parse(result.content[0].text);
    const url = new URL(payload.authorization_url);
    assert.equal(url.origin + url.pathname, "https://www.pinterest.com/oauth/");
    assert.equal(url.searchParams.get("client_id"), "1234567");
    assert.equal(url.searchParams.get("scope"), "boards:read,pins:read");
    assert.equal(url.searchParams.get("state"), "xyz");
    assert.equal(url.searchParams.get("response_type"), "code");
  } finally {
    await client.close();
  }
});

test("reports a missing token as a tool error rather than crashing", async () => {
  const client = await connect({ PINTEREST_ACCESS_TOKEN: "" });
  try {
    const result = await client.callTool({
      name: "pinterest_get_user_account",
      arguments: {},
    });

    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /No Pinterest access token/);
  } finally {
    await client.close();
  }
});

test("rejects input that violates a tool schema", async () => {
  const client = await connect();
  try {
    const result = await client.callTool({
      name: "pinterest_create_board",
      arguments: { name: "ok", privacy: "NOT_A_REAL_PRIVACY" },
    });
    assert.equal(result.isError, true);
  } finally {
    await client.close();
  }
});
