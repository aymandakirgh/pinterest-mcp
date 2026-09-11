import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";

/** Boots the HTTP transport on an ephemeral port and waits for it to listen. */
async function startServer(env = {}) {
  const port = 3400 + Math.floor(Math.random() * 500);
  const child = spawn(process.execPath, ["dist/http.js"], {
    env: { ...process.env, PORT: String(port), ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });

  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("server did not start in time")), 15000);
    child.stdout.on("data", (chunk) => {
      if (chunk.toString().includes("listening on")) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.once("error", reject);
  });
  await ready;

  return {
    url: (path) => `http://127.0.0.1:${port}${path}`,
    async stop() {
      child.kill();
      await once(child, "exit").catch(() => {});
    },
  };
}

const WITH_APP = {
  PINTEREST_APP_ID: "test_app",
  PINTEREST_APP_SECRET: "test_secret",
  PUBLIC_BASE_URL: "https://example.test",
  PINTEREST_ACCESS_TOKEN: "",
  PINTEREST_REDIRECT_URI: "",
};

test("web login is advertised only when app credentials exist", async () => {
  const bare = await startServer({ PINTEREST_APP_ID: "", PINTEREST_APP_SECRET: "" });
  try {
    const health = await (await fetch(bare.url("/health"))).json();
    assert.equal(health.web_login_available, false);
    assert.equal((await fetch(bare.url("/auth"), { redirect: "manual" })).status, 503);
  } finally {
    await bare.stop();
  }

  const configured = await startServer(WITH_APP);
  try {
    const health = await (await fetch(configured.url("/health"))).json();
    assert.equal(health.web_login_available, true);
    assert.equal(health.default_token_configured, false, "must not leak a server-side token");
  } finally {
    await configured.stop();
  }
});

test("redirects to Pinterest with the right client, scopes and a signed state", async () => {
  const server = await startServer(WITH_APP);
  try {
    const response = await fetch(server.url("/auth/login"), { redirect: "manual" });
    assert.equal(response.status, 302);

    const target = new URL(response.headers.get("location"));
    assert.equal(target.origin + target.pathname, "https://www.pinterest.com/oauth/");
    assert.equal(target.searchParams.get("client_id"), "test_app");
    assert.equal(target.searchParams.get("response_type"), "code");
    assert.equal(
      target.searchParams.get("redirect_uri"),
      "https://example.test/auth/callback",
      "redirect must match what is registered on the Pinterest app",
    );
    assert.match(target.searchParams.get("state"), /^[\w-]+\.[\w-]+$/, "state should be nonce.hmac");
    assert.ok(target.searchParams.get("scope").includes("boards:read"));
  } finally {
    await server.stop();
  }
});

test("only honours scopes it recognises", async () => {
  const server = await startServer(WITH_APP);
  try {
    const response = await fetch(server.url("/auth/login?scopes=pins:read,not_a_scope"), {
      redirect: "manual",
    });
    const scope = new URL(response.headers.get("location")).searchParams.get("scope");
    assert.equal(scope, "pins:read", "unknown scopes must be dropped, not forwarded");
  } finally {
    await server.stop();
  }
});

test("rejects a callback whose state was not signed by this server", async () => {
  const server = await startServer(WITH_APP);
  try {
    for (const query of [
      "?code=abc&state=forged.signature",
      "?code=abc&state=missing_dot",
      "?code=abc",
    ]) {
      const response = await fetch(server.url(`/auth/callback${query}`));
      assert.equal(response.status, 400, `expected rejection for ${query}`);
    }
  } finally {
    await server.stop();
  }
});

test("shows a readable page when the user declines on Pinterest", async () => {
  const server = await startServer(WITH_APP);
  try {
    const response = await fetch(
      server.url("/auth/callback?error=access_denied&error_description=User%20denied"),
    );
    assert.equal(response.status, 400);
    const body = await response.text();
    assert.match(body, /Authorization was not completed/);
    assert.match(body, /User denied/);
  } finally {
    await server.stop();
  }
});

test("escapes Pinterest-supplied text rather than injecting it into the page", async () => {
  const server = await startServer(WITH_APP);
  try {
    const injection = encodeURIComponent('<img src=x onerror="alert(1)">');
    const body = await (
      await fetch(server.url(`/auth/callback?error=bad&error_description=${injection}`))
    ).text();

    assert.ok(!body.includes("<img src=x"), "raw markup must not reach the document");
    assert.match(body, /&lt;img src=x/);
  } finally {
    await server.stop();
  }
});
