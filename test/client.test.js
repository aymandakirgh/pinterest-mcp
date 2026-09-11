import test from "node:test";
import assert from "node:assert/strict";
import { PinterestClient, PinterestApiError } from "../dist/client.js";

/** Builds a fetch stand-in that replays queued responses and records the calls. */
function fakeFetch(responses) {
  const calls = [];
  const queue = [...responses];
  const impl = async (url, init) => {
    calls.push({ url, init });
    const next = queue.shift();
    if (!next) throw new Error("fakeFetch ran out of queued responses");
    const status = next.status ?? 200;
    // 204/205/304 are null-body statuses; the Response constructor rejects any body.
    const body = [204, 205, 304].includes(status)
      ? null
      : typeof next.body === "string"
        ? next.body
        : JSON.stringify(next.body ?? {});
    return new Response(body, { status, headers: next.headers ?? {} });
  };
  impl.calls = calls;
  return impl;
}

test("sends a bearer token and parses JSON", async () => {
  const impl = fakeFetch([{ body: { username: "acme" } }]);
  const client = new PinterestClient({ accessToken: "tok_123", fetchImpl: impl });

  const result = await client.request("/user_account");

  assert.deepEqual(result, { username: "acme" });
  assert.equal(impl.calls[0].init.headers.Authorization, "Bearer tok_123");
  assert.equal(impl.calls[0].url, "https://api.pinterest.com/v5/user_account");
});

test("omits empty query params and comma-joins arrays", async () => {
  const impl = fakeFetch([{ body: {} }]);
  const client = new PinterestClient({ accessToken: "t", fetchImpl: impl });

  await client.request("/pins/analytics", {
    query: {
      pin_ids: ["1", "2"],
      page_size: 25,
      bookmark: undefined,
      ad_account_id: "",
    },
  });

  const url = new URL(impl.calls[0].url);
  assert.equal(url.searchParams.get("pin_ids"), "1,2");
  assert.equal(url.searchParams.get("page_size"), "25");
  assert.equal(url.searchParams.has("bookmark"), false);
  assert.equal(url.searchParams.has("ad_account_id"), false);
});

test("refuses to call the API without a token", async () => {
  const client = new PinterestClient({ fetchImpl: fakeFetch([]) });
  await assert.rejects(() => client.request("/user_account"), /No Pinterest access token/);
});

test("surfaces the Pinterest message on an error status", async () => {
  const impl = fakeFetch([
    { status: 403, body: { code: 3, message: "Missing scope: boards:write" } },
  ]);
  const client = new PinterestClient({ accessToken: "t", fetchImpl: impl, maxRetries: 1 });

  await assert.rejects(
    () => client.request("/boards", { method: "POST", body: { name: "x" } }),
    (error) => {
      assert.ok(error instanceof PinterestApiError);
      assert.equal(error.status, 403);
      assert.equal(error.code, 3);
      assert.match(error.message, /Missing scope: boards:write/);
      return true;
    },
  );
});

test("retries a 429 and then succeeds", async () => {
  const impl = fakeFetch([
    { status: 429, body: { message: "rate limited" }, headers: { "retry-after": "0" } },
    { body: { items: [] } },
  ]);
  const client = new PinterestClient({ accessToken: "t", fetchImpl: impl, maxRetries: 3 });

  const result = await client.request("/boards");

  assert.deepEqual(result, { items: [] });
  assert.equal(impl.calls.length, 2, "should have retried exactly once");
});

test("gives up after maxRetries and throws the last error", async () => {
  const impl = fakeFetch([
    { status: 500, body: { message: "boom" } },
    { status: 500, body: { message: "boom" } },
  ]);
  const client = new PinterestClient({ accessToken: "t", fetchImpl: impl, maxRetries: 2 });

  await assert.rejects(() => client.request("/boards"), /Pinterest API 500/);
  assert.equal(impl.calls.length, 2);
});

test("treats 204 as a successful empty result", async () => {
  const impl = fakeFetch([{ status: 204, body: "" }]);
  const client = new PinterestClient({ accessToken: "t", fetchImpl: impl });

  assert.deepEqual(await client.request("/boards/1", { method: "DELETE" }), { ok: true });
});

test("honours a custom base URL for the sandbox", async () => {
  const impl = fakeFetch([{ body: {} }]);
  const client = new PinterestClient({
    accessToken: "t",
    baseUrl: "https://api-sandbox.pinterest.com/v5",
    fetchImpl: impl,
  });

  await client.request("/user_account");

  assert.equal(impl.calls[0].url, "https://api-sandbox.pinterest.com/v5/user_account");
});
