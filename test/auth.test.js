import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { TokenCipher, SpentCodes, verifyPkce } from "../dist/auth/tokens.js";

/* ------------------------------------------------------------------ */
/* Sealed-envelope primitives                                          */
/* ------------------------------------------------------------------ */

test("a sealed envelope round-trips", () => {
  const cipher = new TokenCipher("a".repeat(40));
  const sealed = cipher.seal("access", { access_token: "pinterest_tok" }, 60);
  assert.equal(cipher.open("access", sealed).access_token, "pinterest_tok");
});

test("an envelope cannot be opened with the wrong purpose", () => {
  const cipher = new TokenCipher("a".repeat(40));
  const code = cipher.seal("code", { access_token: "x" }, 60);
  assert.equal(cipher.open("access", code), null, "a code must not work as an access token");
  assert.equal(cipher.open("refresh", code), null);
});

test("an envelope cannot be opened with a different secret", () => {
  const mint = new TokenCipher("a".repeat(40));
  const other = new TokenCipher("b".repeat(40));
  assert.equal(other.open("access", mint.seal("access", { access_token: "x" }, 60)), null);
});

test("tampering with an envelope invalidates it", () => {
  const cipher = new TokenCipher("a".repeat(40));
  const sealed = cipher.seal("access", { access_token: "secret" }, 60);
  const bytes = Buffer.from(sealed, "base64url");
  bytes[bytes.length - 1] ^= 0xff;
  assert.equal(cipher.open("access", bytes.toString("base64url")), null);
});

test("an expired envelope is refused", () => {
  const cipher = new TokenCipher("a".repeat(40));
  assert.equal(cipher.open("access", cipher.seal("access", { a: 1 }, -1)), null);
});

test("garbage never throws, it just fails to open", () => {
  const cipher = new TokenCipher("a".repeat(40));
  for (const junk of ["", "!!!!", "short", randomBytes(80).toString("base64url")]) {
    assert.equal(cipher.open("access", junk), null);
  }
});

test("an authorization code can only be claimed once", () => {
  const spent = new SpentCodes();
  assert.equal(spent.claim("code-1", 60), true);
  assert.equal(spent.claim("code-1", 60), false, "replay must be refused");
  assert.equal(spent.claim("code-2", 60), true);
});

test("PKCE accepts the matching verifier and rejects others", () => {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  assert.equal(verifyPkce(verifier, challenge), true);
  assert.equal(verifyPkce("wrong-verifier", challenge), false);
});

/* ------------------------------------------------------------------ */
/* Full OAuth flow against a stubbed Pinterest                         */
/* ------------------------------------------------------------------ */

/** Stands in for Pinterest's /oauth/token so the flow can run offline. */
async function startPinterestStub() {
  const calls = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      calls.push({ url: req.url, body, auth: req.headers.authorization });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          access_token: "pinterest_access_abc",
          refresh_token: "pinterest_refresh_xyz",
          scope: "boards:read,pins:read",
        }),
      );
    });
  });
  server.listen(0);
  await once(server, "listening");
  return {
    calls,
    baseUrl: `http://127.0.0.1:${server.address().port}/v5`,
    async stop() {
      server.close();
      await once(server, "close").catch(() => {});
    },
  };
}

async function startServer(env = {}) {
  const port = 3600 + Math.floor(Math.random() * 300);
  const child = spawn(process.execPath, ["dist/http.js"], {
    env: {
      ...process.env,
      PORT: String(port),
      PINTEREST_ACCESS_TOKEN: "",
      PINTEREST_APP_ID: "stub_app",
      PINTEREST_APP_SECRET: "stub_secret",
      MCP_AUTH_SECRET: "unit-test-secret-that-is-long-enough-to-pass",
      PUBLIC_BASE_URL: `http://127.0.0.1:${port}`,
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("server did not start")), 15000);
    child.stdout.on("data", (chunk) => {
      if (chunk.toString().includes("listening on")) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.once("error", reject);
  });

  return {
    base: `http://127.0.0.1:${port}`,
    url: (path) => `http://127.0.0.1:${port}${path}`,
    async stop() {
      child.kill();
      await once(child, "exit").catch(() => {});
    },
  };
}

test("advertises protected-resource and authorization-server metadata", async () => {
  const server = await startServer();
  try {
    const prm = await (await fetch(server.url("/.well-known/oauth-protected-resource"))).json();
    assert.equal(prm.resource, `${server.base}/mcp`);
    assert.deepEqual(prm.authorization_servers, [server.base]);

    const asm = await (await fetch(server.url("/.well-known/oauth-authorization-server"))).json();
    assert.equal(asm.issuer, server.base);
    assert.equal(asm.authorization_endpoint, `${server.base}/authorize`);
    assert.equal(asm.token_endpoint, `${server.base}/token`);
    assert.deepEqual(asm.code_challenge_methods_supported, ["S256"]);
    assert.equal(asm.authorization_response_iss_parameter_supported, true);
  } finally {
    await server.stop();
  }
});

test("an unauthenticated /mcp call points the client at the metadata", async () => {
  const server = await startServer();
  try {
    const response = await fetch(server.url("/mcp"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    assert.equal(response.status, 401);
    assert.match(
      response.headers.get("www-authenticate"),
      /resource_metadata="http:\/\/127\.0\.0\.1:\d+\/\.well-known\/oauth-protected-resource"/,
    );
  } finally {
    await server.stop();
  }
});

test("registers a client and refuses unsafe redirect URIs", async () => {
  const server = await startServer();
  try {
    const good = await fetch(server.url("/register"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        redirect_uris: ["http://127.0.0.1:7777/callback"],
        client_name: "test client",
      }),
    });
    assert.equal(good.status, 201);
    const registered = await good.json();
    assert.ok(registered.client_id);
    assert.equal(registered.token_endpoint_auth_method, "none");

    for (const bad of [{}, { redirect_uris: [] }, { redirect_uris: ["http://evil.example/cb"] }]) {
      const response = await fetch(server.url("/register"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(bad),
      });
      assert.equal(response.status, 400, `should reject ${JSON.stringify(bad)}`);
    }
  } finally {
    await server.stop();
  }
});

test("authorize demands PKCE and a redirect URI belonging to the client", async () => {
  const server = await startServer();
  try {
    const registered = await (
      await fetch(server.url("/register"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ redirect_uris: ["http://127.0.0.1:7777/callback"] }),
      })
    ).json();
    const clientId = encodeURIComponent(registered.client_id);
    const redirect = encodeURIComponent("http://127.0.0.1:7777/callback");

    // No PKCE at all.
    let response = await fetch(
      server.url(`/authorize?response_type=code&client_id=${clientId}&redirect_uri=${redirect}`),
      { redirect: "manual" },
    );
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error, "invalid_request");

    // PKCE downgraded to plain.
    response = await fetch(
      server.url(
        `/authorize?response_type=code&client_id=${clientId}&redirect_uri=${redirect}&code_challenge=abc&code_challenge_method=plain`,
      ),
      { redirect: "manual" },
    );
    assert.equal(response.status, 400, "plain PKCE must be refused");

    // A redirect URI the client never registered.
    response = await fetch(
      server.url(
        `/authorize?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent("https://evil.example/steal")}&code_challenge=abc&code_challenge_method=S256`,
      ),
      { redirect: "manual" },
    );
    assert.equal(response.status, 400, "must not redirect to an unregistered URI");

    // A client id that was never issued.
    response = await fetch(
      server.url(
        `/authorize?response_type=code&client_id=made-up&redirect_uri=${redirect}&code_challenge=abc&code_challenge_method=S256`,
      ),
      { redirect: "manual" },
    );
    assert.equal((await response.json()).error, "invalid_client");
  } finally {
    await server.stop();
  }
});

test("completes the whole flow and serves MCP with the issued token", async () => {
  const pinterest = await startPinterestStub();
  const server = await startServer({ PINTEREST_API_BASE_URL: pinterest.baseUrl });
  try {
    // 1. Register.
    const registered = await (
      await fetch(server.url("/register"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ redirect_uris: ["http://127.0.0.1:7777/callback"] }),
      })
    ).json();

    // 2. Authorize — should bounce the user to Pinterest.
    const verifier = randomBytes(32).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const authorize = await fetch(
      server.url(
        `/authorize?response_type=code&client_id=${encodeURIComponent(registered.client_id)}` +
          `&redirect_uri=${encodeURIComponent("http://127.0.0.1:7777/callback")}` +
          `&code_challenge=${challenge}&code_challenge_method=S256&state=client-state&scope=boards:read pins:read`,
      ),
      { redirect: "manual" },
    );
    assert.equal(authorize.status, 302);
    const toPinterest = new URL(authorize.headers.get("location"));
    assert.equal(toPinterest.origin + toPinterest.pathname, "https://www.pinterest.com/oauth/");
    assert.equal(toPinterest.searchParams.get("client_id"), "stub_app");
    assert.equal(toPinterest.searchParams.get("scope"), "boards:read,pins:read");
    const pendingState = toPinterest.searchParams.get("state");

    // 3. Pinterest sends the user back to us.
    const callback = await fetch(
      server.url(`/oauth/pinterest/callback?code=pinterest_code&state=${encodeURIComponent(pendingState)}`),
      { redirect: "manual" },
    );
    assert.equal(callback.status, 302);
    const backToClient = new URL(callback.headers.get("location"));
    assert.equal(backToClient.origin + backToClient.pathname, "http://127.0.0.1:7777/callback");
    assert.equal(backToClient.searchParams.get("state"), "client-state");
    assert.equal(backToClient.searchParams.get("iss"), server.base, "RFC 9207 iss must be present");
    const ourCode = backToClient.searchParams.get("code");
    assert.ok(ourCode);

    // 4. Redeem the code.
    const tokenResponse = await fetch(server.url("/token"), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: ourCode,
        code_verifier: verifier,
        client_id: registered.client_id,
        redirect_uri: "http://127.0.0.1:7777/callback",
      }),
    });
    assert.equal(tokenResponse.status, 200);
    const tokens = await tokenResponse.json();
    assert.equal(tokens.token_type, "Bearer");
    assert.ok(tokens.access_token);
    assert.ok(tokens.refresh_token);
    assert.ok(
      !JSON.stringify(tokens).includes("pinterest_access_abc"),
      "the raw Pinterest token must never be handed to the client",
    );

    // 5. The issued token authenticates a real MCP call.
    const mcp = await fetch(server.url("/mcp"), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${tokens.access_token}`,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    assert.equal(mcp.status, 200);
    assert.equal((await mcp.json()).result.tools.length, 35);

    // 6. The code cannot be replayed.
    const replay = await fetch(server.url("/token"), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: ourCode,
        code_verifier: verifier,
      }),
    });
    assert.equal(replay.status, 400);
    assert.equal((await replay.json()).error, "invalid_grant");
  } finally {
    await server.stop();
    await pinterest.stop();
  }
});

test("a wrong PKCE verifier cannot redeem a code", async () => {
  const pinterest = await startPinterestStub();
  const server = await startServer({ PINTEREST_API_BASE_URL: pinterest.baseUrl });
  try {
    const registered = await (
      await fetch(server.url("/register"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ redirect_uris: ["http://127.0.0.1:7777/callback"] }),
      })
    ).json();

    const challenge = createHash("sha256").update("the-real-verifier").digest("base64url");
    const authorize = await fetch(
      server.url(
        `/authorize?response_type=code&client_id=${encodeURIComponent(registered.client_id)}` +
          `&redirect_uri=${encodeURIComponent("http://127.0.0.1:7777/callback")}` +
          `&code_challenge=${challenge}&code_challenge_method=S256`,
      ),
      { redirect: "manual" },
    );
    const pendingState = new URL(authorize.headers.get("location")).searchParams.get("state");
    const callback = await fetch(
      server.url(`/oauth/pinterest/callback?code=c&state=${encodeURIComponent(pendingState)}`),
      { redirect: "manual" },
    );
    const code = new URL(callback.headers.get("location")).searchParams.get("code");

    const response = await fetch(server.url("/token"), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        code_verifier: "an-attacker-guess",
      }),
    });
    assert.equal(response.status, 400);
    assert.match((await response.json()).error_description, /PKCE/);
  } finally {
    await server.stop();
    await pinterest.stop();
  }
});
