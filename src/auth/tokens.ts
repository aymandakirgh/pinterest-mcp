/**
 * Stateless token minting for the MCP authorization server.
 *
 * Everything this server issues — authorization codes, access tokens, refresh
 * tokens, dynamic client ids — is an AEAD-encrypted envelope carrying its own
 * payload. Nothing is looked up, so there is no session store to provision, no
 * database to lose, and horizontal scaling needs no shared state.
 *
 * The tradeoff is that a token cannot be revoked by deleting a row. Two things
 * bound the damage: every envelope carries its own expiry, and rotating
 * MCP_AUTH_SECRET invalidates every envelope ever issued.
 */
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12;
const TAG_BYTES = 16;

/** Distinct keys per purpose, so a code can never be replayed as an access token. */
export type Purpose = "code" | "access" | "refresh" | "client";

export class TokenCipher {
  private readonly keys = new Map<Purpose, Buffer>();

  constructor(secret: string) {
    const master = createHash("sha256").update(secret).digest();
    for (const purpose of ["code", "access", "refresh", "client"] as const) {
      this.keys.set(
        purpose,
        Buffer.from(hkdfSync("sha256", master, Buffer.alloc(0), `pinterest-mcp:${purpose}`, 32)),
      );
    }
  }

  seal(purpose: Purpose, payload: Record<string, unknown>, ttlSeconds: number): string {
    const body = JSON.stringify({
      ...payload,
      exp: Math.floor(Date.now() / 1000) + ttlSeconds,
    });
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGORITHM, this.key(purpose), iv);
    const encrypted = Buffer.concat([cipher.update(body, "utf8"), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString("base64url");
  }

  /** Returns null for anything tampered with, minted for another purpose, or expired. */
  open<T extends Record<string, unknown>>(purpose: Purpose, token: string): T | null {
    let raw: Buffer;
    try {
      raw = Buffer.from(token, "base64url");
    } catch {
      return null;
    }
    if (raw.length <= IV_BYTES + TAG_BYTES) return null;

    try {
      const decipher = createDecipheriv(ALGORITHM, this.key(purpose), raw.subarray(0, IV_BYTES));
      decipher.setAuthTag(raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
      const plain = Buffer.concat([
        decipher.update(raw.subarray(IV_BYTES + TAG_BYTES)),
        decipher.final(),
      ]).toString("utf8");

      const parsed = JSON.parse(plain) as T & { exp?: number };
      if (typeof parsed.exp !== "number" || parsed.exp < Math.floor(Date.now() / 1000)) {
        return null;
      }
      return parsed;
    } catch {
      // Any auth-tag mismatch or malformed payload lands here. Never distinguish
      // the cases to a caller: that difference is an oracle.
      return null;
    }
  }

  private key(purpose: Purpose): Buffer {
    const key = this.keys.get(purpose);
    if (!key) throw new Error(`no key for purpose ${purpose}`);
    return key;
  }
}

/**
 * Authorization codes must be single-use, which is the one thing an encrypted
 * envelope cannot enforce by itself. Codes live ten minutes, so remembering the
 * spent ones costs little and the set self-prunes.
 */
export class SpentCodes {
  private readonly seen = new Map<string, number>();

  /** True when this code had not been redeemed before. */
  claim(code: string, ttlSeconds: number): boolean {
    this.prune();
    const fingerprint = createHash("sha256").update(code).digest("base64url");
    if (this.seen.has(fingerprint)) return false;
    this.seen.set(fingerprint, Date.now() + ttlSeconds * 1000);
    return true;
  }

  private prune(): void {
    const now = Date.now();
    for (const [key, expiry] of this.seen) {
      if (expiry < now) this.seen.delete(key);
    }
  }
}

/** OAuth 2.1 requires PKCE; this server only accepts S256, never plain. */
export function verifyPkce(codeVerifier: string, codeChallenge: string): boolean {
  const computed = createHash("sha256").update(codeVerifier).digest("base64url");
  const a = Buffer.from(computed);
  const b = Buffer.from(codeChallenge);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * A missing secret must not silently become a weak one, but it also should not
 * stop the server booting — an operator running locally shouldn't need ceremony.
 * An ephemeral key means tokens simply do not survive a restart.
 */
export function resolveAuthSecret(configured: string | undefined): {
  secret: string;
  ephemeral: boolean;
} {
  if (configured && configured.length >= 32) return { secret: configured, ephemeral: false };
  return { secret: randomBytes(32).toString("hex"), ephemeral: true };
}
