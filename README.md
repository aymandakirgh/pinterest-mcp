# pinterest-mcp

[![CI](https://github.com/aymandakirgh/pinterest-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/aymandakirgh/pinterest-mcp/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

A [Model Context Protocol](https://modelcontextprotocol.io) server for the **Pinterest API v5**. It gives an AI assistant 35 typed tools over boards, pins, analytics, search and OAuth — runnable as a local stdio subprocess or as a hosted HTTP endpoint.

## What it can do

| Area | Tools |
| --- | --- |
| **Account** | Read the authenticated profile, followers, following, claimed websites |
| **Boards** | List, get, create, update, delete; sections; pins within a board or section |
| **Pins** | List, get, create, update, delete, save (repin); video upload registration |
| **Analytics** | Account-level daily metrics, top pins, top video pins, single- and multi-pin analytics |
| **Search** | Full-text search over the account's own pins and boards |
| **OAuth** | Build a consent URL, exchange the code, refresh an expired token |
| **Escape hatch** | `pinterest_api_request` for any v5 endpoint not wrapped above |

### What the Pinterest API cannot do

Worth knowing before you plan a workflow around it:

- **No public discovery search.** Everything is scoped to the authenticated account. `pinterest_search_my_pins` searches *your* pins, not Pinterest at large.
- **Analytics reach back 90 days.** Longer windows are rejected by Pinterest, not by this server.
- **Video pins take three steps** — register the upload, PUT the file, then create the pin referencing the media id.
- **Trial access is limited.** A new Pinterest app can only act on its own account until it is approved for Standard access. Everything here works under Trial for your own account; letting *other people* connect needs Standard.

## Install

```bash
npx pinterest-mcp
```

Or from source:

```bash
git clone https://github.com/aymandakirgh/pinterest-mcp.git
cd pinterest-mcp
npm install
npm run build   # compiles to dist/
npm test
```

## Getting a token

### Fastest: a test token from the dashboard

Once your app is approved for Trial access, you can generate a token straight from the Pinterest dashboard and skip OAuth entirely — the quickest way to get this server working against your own account:

> [developers.pinterest.com/apps](https://developers.pinterest.com/apps/) → Manage → **Configure** → Generate Access Token → pick **Production** (or Sandbox) → Generate

```bash
claude mcp add pinterest --env PINTEREST_ACCESS_TOKEN=your_token -- npx -y pinterest-mcp
```

Then ask the assistant to call `pinterest_get_user_account` to confirm the token and its scopes.

### In the browser (easiest)

Run the HTTP transport with your app credentials set and open **`/auth`**:

```bash
PINTEREST_APP_ID=... PINTEREST_APP_SECRET=... npm run start:http
# then open http://localhost:3000/auth
```

Click through, approve on Pinterest, and the callback page hands you the access token, the refresh token and the exact `claude mcp add` command to paste. Nothing is stored server-side — the tokens are shown once and never written to disk.

Register `<your-host>/auth/callback` as a redirect URI on the Pinterest app first; it must match character for character.

> Pinterest is the only sign-in option for its API — there is no "connect with Google" for third-party apps. If your Pinterest account itself uses Google or Facebook, pick that on Pinterest's own consent screen.

### From the tools

If you would rather stay in the assistant:

1. Create an app at [developers.pinterest.com/apps](https://developers.pinterest.com/apps/) and note the app id, secret and a registered redirect URI.
2. Set `PINTEREST_APP_ID`, `PINTEREST_APP_SECRET` and `PINTEREST_REDIRECT_URI`.
3. Ask the assistant to call `pinterest_build_oauth_url`, open the URL, approve.
4. Copy the `code` from the redirect and call `pinterest_exchange_oauth_code`.
5. Put the returned `access_token` in `PINTEREST_ACCESS_TOKEN`.

Access tokens last roughly 30 days; refresh tokens roughly a year. When calls start returning 401, use `pinterest_refresh_access_token`.

### Scopes

Request only what you need — Pinterest shows the list on the consent screen.

| Scope | Needed for |
| --- | --- |
| `user_accounts:read` | Profile, followers, following, account analytics |
| `boards:read` / `boards:write` | Reading / modifying boards and sections |
| `boards:read_secret` / `boards:write_secret` | The same, for secret boards |
| `pins:read` / `pins:write` | Reading / modifying pins, and pin analytics |
| `pins:read_secret` / `pins:write_secret` | The same, for pins on secret boards |

The OAuth tool defaults to `user_accounts:read, boards:read, boards:write, pins:read, pins:write`.

## Use it with Claude Code

```bash
claude mcp add pinterest --env PINTEREST_ACCESS_TOKEN=your_token -- npx -y pinterest-mcp
```

## Use it with Claude Desktop

Add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "pinterest": {
      "command": "npx",
      "args": ["-y", "pinterest-mcp"],
      "env": {
        "PINTEREST_ACCESS_TOKEN": "your_token_here"
      }
    }
  }
}
```

## Let anyone connect their own account (OAuth)

Run with app credentials and the server becomes a **remote MCP server with OAuth 2.1**. A user adds the URL in their client, clicks Connect, approves on Pinterest, and is done — no token ever passes through their hands.

```bash
PINTEREST_APP_ID=... PINTEREST_APP_SECRET=... \
MCP_AUTH_SECRET=$(openssl rand -hex 32) \
PUBLIC_BASE_URL=https://your-host \
npm run start:http
```

Register `https://your-host/oauth/pinterest/callback` as a redirect URI on the Pinterest app, then point a client at `https://your-host/mcp`.

The client never receives a Pinterest token. It gets one minted here, with the Pinterest credential sealed inside it, so a single deployment can serve many people's accounts without any of them seeing another's.

<details>
<summary>What the server implements</summary>

| Endpoint | Purpose |
| --- | --- |
| `/.well-known/oauth-protected-resource` | RFC 9728 — names the authorization server |
| `/.well-known/oauth-authorization-server` | RFC 8414 — endpoints, scopes, PKCE support |
| `/register` | RFC 7591 dynamic client registration |
| `/authorize` | Starts the flow; hands off to Pinterest |
| `/oauth/pinterest/callback` | Where Pinterest returns |
| `/token` | `authorization_code` and `refresh_token` grants |

PKCE (S256) is mandatory, `plain` is refused. Authorization codes are single-use and live ten minutes. The `iss` parameter is returned per RFC 9207 so clients can detect an authorization-server mix-up. An unauthenticated `POST /mcp` answers `401` with a `WWW-Authenticate` header pointing at the resource metadata, which is what triggers a client to begin the flow.

Every token — codes, access, refresh, even client ids — is an AES-256-GCM envelope carrying its own payload and expiry, so there is no session store or database. The tradeoff: revocation means rotating `MCP_AUTH_SECRET`, which invalidates everything at once.
</details>

> **This needs Pinterest Standard access.** Under Trial access, Pinterest only authorizes the app owner's own account, so the flow works but nobody else can complete it. Standard access requires an approved Trial app, compliance with the Developer Guidelines, and a video of the app using the API — see [access tiers](https://developers.pinterest.com/docs/getting-started/access-tiers/).

## Run it hosted

A live instance runs on Railway:

```
https://pinterest-mcp-http-production.up.railway.app/mcp
```

It holds **no credentials of its own** — every caller supplies their own Pinterest token per request, and `GET /health` reports `default_token_configured: false` to prove it. Treat it as a convenience for trying the server out; run your own instance for anything that matters.

The HTTP transport turns the same server into a remote MCP endpoint:

```bash
npm run start:http     # POST /mcp, GET /health
```

It is **stateless** — each request builds its own server, transport and API client, then tears them down. Callers pass their own Pinterest token per request, so one deployment can serve several accounts without a caller's credentials leaking into another's session:

```bash
curl -X POST https://your-host/mcp \
  -H 'Authorization: Bearer <pinterest_access_token>' \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

`X-Pinterest-Access-Token` works too, for clients that already use `Authorization` for their own gateway. If neither is present the server falls back to `PINTEREST_ACCESS_TOKEN`, and returns `401` if that is unset as well.

### Docker

```bash
docker build -t pinterest-mcp .
docker run -p 3000:3000 -e PINTEREST_ACCESS_TOKEN=your_token pinterest-mcp
```

The image is a two-stage build running as the unprivileged `node` user.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `PINTEREST_ACCESS_TOKEN` | — | Token the server acts with. Optional: without it only the OAuth tools work. |
| `PINTEREST_APP_ID` | — | App id, for the OAuth tools. |
| `PINTEREST_APP_SECRET` | — | App secret, for the OAuth tools. |
| `PINTEREST_REDIRECT_URI` | — | Must match a URI registered on the app exactly. |
| `PINTEREST_SANDBOX` | `0` | Set to `1` to target the Pinterest sandbox. |
| `PINTEREST_API_BASE_URL` | production v5 | Override the API root outright. |
| `PINTEREST_MAX_RETRIES` | `3` | Attempts for retryable failures (429 / 5xx). |
| `PORT` | `3000` | HTTP transport only. |
| `PUBLIC_BASE_URL` | derived from the request | Absolute origin of the deployment. Used for OAuth metadata and callback URLs; set it behind a proxy. |
| `MCP_AUTH_SECRET` | random per boot | Seals the OAuth tokens this server issues. Required for a hosted deployment — without it, issued tokens die on restart. |

The server starts whether or not a token is present, so an assistant can always reach the OAuth tools to obtain one.

## Design notes

- **Errors are tool results, not exceptions.** A Pinterest failure comes back as an `isError` result carrying the status, Pinterest's own message, and a hint naming the likely fix — a missing scope, an expired token, a bad id. Agents can act on that; a thrown exception just aborts the turn.
- **429s and 5xx are retried** with exponential backoff, honouring `Retry-After` up to a 30-second cap so a hostile header cannot stall a call.
- **Destructive tools are annotated.** `pinterest_delete_board` and `pinterest_delete_pin` carry `destructiveHint`, so clients can gate them behind confirmation. Deleting a board deletes its pins too.
- **Media shapes are a discriminated union**, so the model is told which fields go together rather than discovering it from a 400.

## Development

```bash
npm run build       # compile
npm run dev         # compile in watch mode
npm run typecheck   # types only, no emit
npm test            # unit tests + a real MCP handshake over stdio
```

Tests cover the client (auth, query building, retries, error shaping) and boot the actual server over stdio to assert the tool surface, schemas and annotations. No network access required.

## Contributing

Issues and pull requests are welcome. Adding an endpoint is usually one function in the relevant `src/tools/*.ts` module.

## License

[MIT](LICENSE)
