/**
 * Browser-based OAuth flow for obtaining a Pinterest access token.
 *
 * Without this, getting a token means calling a tool to build a URL, opening it,
 * copying a `code` out of the address bar and pasting it into a second tool. Here
 * the user clicks a link, approves on Pinterest, and lands on a page holding the
 * finished token and the exact command to install it.
 *
 * Pinterest is the only identity provider — there is no "sign in with Google" for
 * the Pinterest API. A Google-linked Pinterest account still works: the sign-in
 * happens on Pinterest's own consent screen, which is not ours to control.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { Router, type Request, type Response } from "express";
import type { ServerConfig } from "./config.js";
import { DEFAULT_SCOPES, KNOWN_SCOPES } from "./tools/oauth.js";

const AUTHORIZE_URL = "https://www.pinterest.com/oauth/";

/**
 * CSRF state is signed rather than stored, so the flow survives a restart or a
 * second replica without needing shared session storage.
 */
function signState(nonce: string, secret: string): string {
  const mac = createHmac("sha256", secret).update(nonce).digest("base64url");
  return `${nonce}.${mac}`;
}

function verifyState(state: string | undefined, secret: string): boolean {
  if (!state) return false;
  const [nonce, mac] = state.split(".");
  if (!nonce || !mac) return false;
  const expected = createHmac("sha256", secret).update(nonce).digest("base64url");
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** The redirect URI must match what is registered on the Pinterest app exactly. */
function resolveRedirectUri(req: Request, config: ServerConfig): string {
  if (config.redirectUri) return config.redirectUri;
  const configured = process.env.PUBLIC_BASE_URL;
  const base = configured ?? `${req.protocol}://${req.get("host")}`;
  return `${base.replace(/\/+$/, "")}/auth/callback`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => {
    switch (char) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&#39;";
    }
  });
}

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  :root { color-scheme: light dark; --bg:#fff; --fg:#111; --muted:#666; --line:#e3e3e3; --accent:#e60023; --code:#f6f6f7; }
  @media (prefers-color-scheme: dark) { :root { --bg:#16181c; --fg:#f2f2f3; --muted:#a0a0a8; --line:#2c2f36; --code:#1f2229; } }
  * { box-sizing: border-box; }
  body { margin:0; padding:32px 16px; background:var(--bg); color:var(--fg);
         font:15px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif; }
  main { max-width: 640px; margin: 0 auto; }
  h1 { font-size: 22px; margin: 0 0 4px; }
  p.sub { color: var(--muted); margin: 0 0 28px; }
  .card { border:1px solid var(--line); border-radius:12px; padding:20px; margin-bottom:16px; }
  .card h2 { font-size:13px; text-transform:uppercase; letter-spacing:.06em; color:var(--muted); margin:0 0 10px; }
  code, pre { background:var(--code); border-radius:8px; font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:13px; }
  pre { padding:14px; overflow-x:auto; margin:0; white-space:pre-wrap; word-break:break-all; }
  a.btn { display:inline-block; background:var(--accent); color:#fff; text-decoration:none;
          padding:12px 22px; border-radius:999px; font-weight:600; }
  button { font:inherit; padding:8px 14px; border-radius:8px; border:1px solid var(--line);
           background:transparent; color:var(--fg); cursor:pointer; margin-top:10px; }
  ul { padding-left: 20px; } li { margin-bottom: 6px; }
  .warn { border-left:3px solid var(--accent); padding-left:12px; color:var(--muted); font-size:13px; }
</style></head><body><main>${body}</main>
<script>
function copyText(id, btn) {
  const el = document.getElementById(id);
  navigator.clipboard.writeText(el.innerText).then(function () {
    const old = btn.innerText; btn.innerText = "Copied";
    setTimeout(function () { btn.innerText = old; }, 1500);
  });
}
</script></body></html>`;
}

export function createOAuthRouter(config: ServerConfig): Router {
  const router = Router();

  const missingCredentials = (req: Request, res: Response): void => {
    // Show the real callback URL for this deployment — it has to be pasted into
    // Pinterest verbatim, so a placeholder here just creates a failed exchange later.
    const callback = resolveRedirectUri(req, config);
    res.status(503).send(
      page(
        "Setup required",
        `<h1>Web login is not configured</h1>
         <p class="sub">This deployment has no Pinterest app credentials, so it cannot run the OAuth flow yet.</p>

         <div class="card"><h2>1 &middot; Create the app</h2>
           <p>Pinterest requires a <strong>business account</strong>, and every app goes through a
           short review before it hands over credentials — requests are reviewed each business day,
           so expect a wait rather than instant access.</p>
           <p style="margin-bottom:0"><a class="btn" href="https://developers.pinterest.com/apps/" target="_blank" rel="noopener">Open Pinterest&nbsp;&rarr;&nbsp;My apps</a></p>
         </div>

         <div class="card"><h2>2 &middot; Register this exact redirect URI</h2>
           <p>Manage &rarr; Configure &rarr; Redirect URIs. It must match character for character.</p>
           <pre id="cb">${escapeHtml(callback)}</pre>
           <button onclick="copyText('cb', this)">Copy redirect URI</button>
         </div>

         <div class="card"><h2>3 &middot; Set the credentials here</h2>
           <pre>PINTEREST_APP_ID=...
PINTEREST_APP_SECRET=...</pre>
           <p class="warn">Once approved, the app id and secret appear on the My apps page. After
           setting them the service restarts and this page becomes the login button.</p>
         </div>

         <p class="warn">Prefer not to put the secret on a public host? Run the same flow locally:
         <code>PINTEREST_APP_ID=... PINTEREST_APP_SECRET=... npm run start:http</code>, then open
         <code>localhost:3000/auth</code> and register that callback instead.</p>`,
      ),
    );
  };

  router.get("/auth/login", (req: Request, res: Response) => {
    if (!config.appId || !config.appSecret) return missingCredentials(req, res);

    const requested = typeof req.query.scopes === "string" ? req.query.scopes.split(",") : undefined;
    const scopes = (requested ?? DEFAULT_SCOPES).filter((scope) =>
      (KNOWN_SCOPES as readonly string[]).includes(scope.trim()),
    );

    const url = new URL(AUTHORIZE_URL);
    url.searchParams.set("client_id", config.appId);
    url.searchParams.set("redirect_uri", resolveRedirectUri(req, config));
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", (scopes.length > 0 ? scopes : DEFAULT_SCOPES).join(","));
    url.searchParams.set("state", signState(randomBytes(16).toString("base64url"), config.appSecret));

    res.redirect(url.toString());
  });

  /** A friendly landing page, so the bare host is not a dead end. */
  router.get("/auth", (req: Request, res: Response) => {
    if (!config.appId || !config.appSecret) return missingCredentials(req, res);
    res.send(
      page(
        "Connect Pinterest",
        `<h1>Connect your Pinterest account</h1>
         <p class="sub">You will approve access on Pinterest, then land back here with a ready-to-use token.</p>
         <div class="card">
           <p><a class="btn" href="/auth/login">Continue with Pinterest</a></p>
           <p class="warn" style="margin-top:18px">Pinterest is the only sign-in option for its API. If your Pinterest
           account uses Google or Facebook, choose that on Pinterest's own screen.</p>
         </div>
         <div class="card"><h2>Scopes requested</h2>
           <pre>${escapeHtml(DEFAULT_SCOPES.join("\n"))}</pre>
           <p class="warn">Need secret boards too? Add <code>?scopes=</code> with a comma-separated list.</p>
         </div>`,
      ),
    );
  });

  router.get("/auth/callback", async (req: Request, res: Response) => {
    if (!config.appId || !config.appSecret) return missingCredentials(req, res);

    const { code, state, error, error_description: errorDescription } = req.query;

    if (typeof error === "string") {
      res.status(400).send(
        page(
          "Authorization declined",
          `<h1>Authorization was not completed</h1>
           <p class="sub">Pinterest returned: ${escapeHtml(String(errorDescription ?? error))}</p>
           <p><a class="btn" href="/auth">Try again</a></p>`,
        ),
      );
      return;
    }

    if (!verifyState(typeof state === "string" ? state : undefined, config.appSecret)) {
      res.status(400).send(
        page(
          "Invalid state",
          `<h1>That link did not come from here</h1>
           <p class="sub">The state parameter failed verification, so the request was rejected. Start the flow again.</p>
           <p><a class="btn" href="/auth">Start over</a></p>`,
        ),
      );
      return;
    }

    if (typeof code !== "string" || code.length === 0) {
      res.status(400).send(
        page("Missing code", `<h1>No authorization code</h1><p><a class="btn" href="/auth">Start over</a></p>`),
      );
      return;
    }

    try {
      const credentials = Buffer.from(`${config.appId}:${config.appSecret}`).toString("base64");
      const response = await fetch(`${config.baseUrl.replace(/\/+$/, "")}/oauth/token`, {
        method: "POST",
        headers: {
          Authorization: `Basic ${credentials}`,
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
        },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          redirect_uri: resolveRedirectUri(req, config),
        }).toString(),
      });

      const payload = (await response.json()) as Record<string, unknown>;
      if (!response.ok) {
        res.status(502).send(
          page(
            "Token exchange failed",
            `<h1>Pinterest rejected the exchange</h1>
             <p class="sub">HTTP ${response.status}</p>
             <div class="card"><pre>${escapeHtml(JSON.stringify(payload, null, 2))}</pre></div>
             <p class="warn">The usual cause is a redirect URI that does not exactly match the one registered on the app.</p>`,
          ),
        );
        return;
      }

      const accessToken = String(payload.access_token ?? "");
      const refreshToken = String(payload.refresh_token ?? "");
      const command = `claude mcp add pinterest --scope user --env PINTEREST_ACCESS_TOKEN=${accessToken} -- npx -y pinterest-mcp`;

      res.send(
        page(
          "Connected",
          `<h1>Connected to Pinterest</h1>
           <p class="sub">Your token is below. It is shown only now — nothing is stored on this server.</p>

           <div class="card"><h2>Add it to Claude Code</h2>
             <pre id="cmd">${escapeHtml(command)}</pre>
             <button onclick="copyText('cmd', this)">Copy command</button>
           </div>

           <div class="card"><h2>Access token</h2>
             <pre id="at">${escapeHtml(accessToken)}</pre>
             <button onclick="copyText('at', this)">Copy token</button>
             <p class="warn" style="margin-top:14px">Expires in about 30 days.</p>
           </div>

           ${
             refreshToken
               ? `<div class="card"><h2>Refresh token</h2>
                    <pre id="rt">${escapeHtml(refreshToken)}</pre>
                    <button onclick="copyText('rt', this)">Copy refresh token</button>
                    <p class="warn" style="margin-top:14px">Lasts about a year. Store it somewhere safe — it mints new access tokens.</p>
                  </div>`
               : ""
           }

           <div class="card"><h2>Granted scopes</h2>
             <pre>${escapeHtml(String(payload.scope ?? "not reported"))}</pre>
           </div>

           <p class="warn">Treat both tokens like passwords: anyone holding them can act on your Pinterest account.</p>`,
        ),
      );
    } catch (caught) {
      res.status(500).send(
        page(
          "Exchange failed",
          `<h1>Could not reach Pinterest</h1>
           <div class="card"><pre>${escapeHtml(caught instanceof Error ? caught.message : String(caught))}</pre></div>
           <p><a class="btn" href="/auth">Try again</a></p>`,
        ),
      );
    }
  });

  return router;
}
