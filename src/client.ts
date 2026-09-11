/**
 * Thin, typed wrapper over the Pinterest API v5.
 *
 * Deliberately minimal: it owns auth, URL building, pagination params,
 * rate-limit retries and error shaping. Endpoint knowledge lives in the
 * tool modules so that new endpoints cost one function, not one class.
 */

export const PRODUCTION_BASE_URL = "https://api.pinterest.com/v5";
export const SANDBOX_BASE_URL = "https://api-sandbox.pinterest.com/v5";

/** Pinterest returns these on a non-2xx; `message` is the human-readable part. */
export interface PinterestErrorBody {
  code?: number;
  message?: string;
  [key: string]: unknown;
}

export class PinterestApiError extends Error {
  readonly status: number;
  readonly code: number | undefined;
  readonly endpoint: string;
  readonly body: unknown;

  constructor(status: number, endpoint: string, body: unknown) {
    const parsed = (body ?? {}) as PinterestErrorBody;
    const detail =
      typeof parsed.message === "string" && parsed.message.length > 0
        ? parsed.message
        : typeof body === "string" && body.length > 0
          ? body
          : "no error message returned";
    super(`Pinterest API ${status} on ${endpoint}: ${detail}`);
    this.name = "PinterestApiError";
    this.status = status;
    this.code = typeof parsed.code === "number" ? parsed.code : undefined;
    this.endpoint = endpoint;
    this.body = body;
  }
}

export type QueryValue = string | number | boolean | string[] | undefined | null;

export interface RequestOptions {
  method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  query?: Record<string, QueryValue>;
  body?: unknown;
  /** Overrides the client's default token for this one call. */
  accessToken?: string;
}

export interface PinterestClientOptions {
  accessToken?: string;
  baseUrl?: string;
  /** Total attempts for retryable failures (429 / 5xx). Default 3. */
  maxRetries?: number;
  /** Injected in tests. */
  fetchImpl?: typeof fetch;
}

/** Pinterest caps page_size at 250 across the v5 collection endpoints. */
export const MAX_PAGE_SIZE = 250;

export class PinterestClient {
  private readonly defaultToken: string | undefined;
  private readonly baseUrl: string;
  private readonly maxRetries: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: PinterestClientOptions = {}) {
    this.defaultToken = options.accessToken;
    this.baseUrl = (options.baseUrl ?? PRODUCTION_BASE_URL).replace(/\/+$/, "");
    this.maxRetries = options.maxRetries ?? 3;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
  }

  hasToken(explicit?: string): boolean {
    return Boolean(explicit ?? this.defaultToken);
  }

  async request<T = unknown>(path: string, options: RequestOptions = {}): Promise<T> {
    const token = options.accessToken ?? this.defaultToken;
    if (!token) {
      throw new Error(
        "No Pinterest access token available. Set PINTEREST_ACCESS_TOKEN, or pass one per request " +
          "via the Authorization header when running the HTTP transport.",
      );
    }

    const url = this.buildUrl(path, options.query);
    const method = options.method ?? "GET";
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    };
    if (options.body !== undefined) {
      headers["Content-Type"] = "application/json";
    }

    let lastError: unknown;
    for (let attempt = 1; attempt <= this.maxRetries; attempt += 1) {
      let response: Response;
      try {
        response = await this.fetchImpl(url, {
          method,
          headers,
          body: options.body === undefined ? undefined : JSON.stringify(options.body),
        });
      } catch (error) {
        // Network-level failure: worth one more try, but surface it if it persists.
        lastError = error;
        if (attempt === this.maxRetries) throw error;
        await delay(backoffMs(attempt));
        continue;
      }

      if (response.ok) {
        return (await parseBody(response)) as T;
      }

      const body = await parseBody(response);
      const retryable = response.status === 429 || response.status >= 500;
      if (retryable && attempt < this.maxRetries) {
        await delay(retryAfterMs(response) ?? backoffMs(attempt));
        lastError = new PinterestApiError(response.status, path, body);
        continue;
      }
      throw new PinterestApiError(response.status, path, body);
    }

    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  private buildUrl(path: string, query?: Record<string, QueryValue>): string {
    const url = new URL(`${this.baseUrl}${path.startsWith("/") ? path : `/${path}`}`);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value === undefined || value === null || value === "") continue;
      // Pinterest expects repeated list params as a comma-joined single value.
      url.searchParams.set(key, Array.isArray(value) ? value.join(",") : String(value));
    }
    return url.toString();
  }
}

async function parseBody(response: Response): Promise<unknown> {
  if (response.status === 204) return { ok: true };
  const text = await response.text();
  if (text.length === 0) return { ok: true };
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function retryAfterMs(response: Response): number | undefined {
  const header = response.headers.get("retry-after");
  if (!header) return undefined;
  const seconds = Number(header);
  // Cap the honoured wait so a hostile header can't stall a tool call indefinitely.
  return Number.isFinite(seconds) ? Math.min(seconds, 30) * 1000 : undefined;
}

function backoffMs(attempt: number): number {
  return Math.min(2 ** (attempt - 1) * 500, 8000);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
