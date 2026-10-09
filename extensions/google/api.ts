// The authorized REST client every Google tool goes through: the bearer token, one refresh on 401, one retry on
// 429/5xx, and Google's failures turned into replies the CoS can act on (spec §5).
import { randomBytes } from "node:crypto";
import { NotSignedIn } from "./auth.ts";

export type Query = Record<string, string | number | boolean | string[] | undefined>;

/** A failure whose message is the user-facing reply. */
export class GoogleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GoogleError";
  }
}

type Method = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";

export type Api = {
  /** A JSON request; its parsed reply (undefined for 204 or an empty body). */
  json<T = any>(method: Method, url: string, opts?: { query?: Query; body?: unknown }): Promise<T>;
  /** A download: the bytes and their content type. */
  bytes(url: string, query?: Query): Promise<{ data: Buffer; type: string }>;
  /** A multipart/related upload of `metadata` and `data`; its parsed reply. */
  upload(url: string, metadata: object, data: Buffer, type: string, query?: Query): Promise<any>;
  /** Any request, with its status and body: throws only for sign-in problems and network errors. */
  raw(method: string, url: string, opts?: { query?: Query; body?: unknown }): Promise<{ status: number; body: string }>;
};

type Tokens = { access(): Promise<string>; refresh(): Promise<string> };

const TIMEOUT_MS = 60_000;
/** Uploads and downloads can be large: a slow link needs longer than a JSON request. */
const TRANSFER_TIMEOUT_MS = 5 * 60_000;
const LIBRARY = "https://console.cloud.google.com/apis/library";
const CONNECT = 'connect({ extension: "google" })';
const NO_CLIENT =
  "Google isn't set up: ask the user for google.clientId and google.clientSecret with secret_request " +
  `(a Desktop app OAuth client; see japa's README), then ${CONNECT}.`;
const EXPIRED = `Not signed in to Google (or the sign-in expired): call ${CONNECT}.`;
const NO_SCOPE = `japa lacks access for this; reconnect to grant it: ${CONNECT}.`;

export const MAX = 50_000;

export const truncate = (text: string) =>
  text.length > MAX ? `${text.slice(0, MAX)}\n[truncated: ${text.length - MAX} more characters]` : text;

const reply = (text: string) => ({ content: [{ type: "text" as const, text }] });

/** Node's fetch reports "fetch failed" with the reason in `cause`. */
const reason = (error: unknown) => ((error as Error).cause as Error | undefined)?.message ?? (error as Error).message;

/** Runs a handler and turns its text, a GoogleError, NotSignedIn or any error into a tool reply. */
export async function respond(run: () => Promise<string>) {
  try {
    return reply(truncate(await run()));
  } catch (error) {
    if (error instanceof NotSignedIn) return reply(error.reason === "no_client" ? NO_CLIENT : EXPIRED);
    return reply(error instanceof Error ? error.message : String(error));
  }
}

function withQuery(url: string, query: Query = {}): string {
  const target = new URL(url);
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined) continue;
    for (const one of Array.isArray(value) ? value : [value]) target.searchParams.append(key, String(one));
  }
  return target.toString();
}

type ErrorBody = {
  error?: {
    message?: string;
    errors?: { reason?: string }[];
    details?: { reason?: string; metadata?: Record<string, string> }[];
  };
};

/** The reply for a failed request, from its status and Google's error body. */
function failure(url: string, status: number, text: string): GoogleError {
  let body: ErrorBody = {};
  try {
    body = JSON.parse(text) as ErrorBody;
  } catch {}
  const error = typeof body?.error === "object" && body.error !== null ? body.error : {};
  const reasons = new Set([...(error.errors ?? []), ...(error.details ?? [])].map((e) => e?.reason));
  const any = (...names: string[]) => names.some((name) => reasons.has(name));
  if (status === 403 && any("accessNotConfigured", "SERVICE_DISABLED")) {
    const meta = error.details?.find((d) => d?.metadata?.service || d?.metadata?.activationUrl)?.metadata ?? {};
    // Titles already end in "API" ("Gmail API"), which the sentence supplies.
    const api = (meta.serviceTitle || meta.service || "Google").replace(/\s+API$/i, "");
    const where = meta.activationUrl || LIBRARY;
    return new GoogleError(`The ${api} API isn't enabled for this Google project. Enable it at ${where}, then try again.`);
  }
  if (status === 403 && any("insufficientPermissions", "ACCESS_TOKEN_SCOPE_INSUFFICIENT")) {
    return new GoogleError(NO_SCOPE);
  }
  if (status === 404) {
    const segments = new URL(url).pathname.split("/").filter(Boolean);
    return new GoogleError(`Not found: ${decodeURIComponent(segments.at(-1) ?? url)}`);
  }
  // Not every failure is Google's JSON (an HTML error page, say): then a little of the text, if any.
  const message = error.message ?? text.trim().slice(0, 200);
  return new GoogleError(`Google replied HTTP ${status}${message ? `: ${message}` : ""}`);
}

/** Seconds from `Retry-After` (default 1, capped at 10), in milliseconds. */
function retryAfter(response: Response): number {
  const seconds = Number(response.headers.get("retry-after") ?? "1");
  return Math.min(Number.isFinite(seconds) && seconds >= 0 ? seconds : 1, 10) * 1000;
}

const sleeping = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function createApi(tokens: Tokens, opts: { sleep?: (ms: number) => Promise<void> } = {}): Api {
  const sleep = opts.sleep ?? sleeping;

  /**
   * Sends a request with the bearer token: refreshes once on 401 (a second 401 means the sign-in is gone) and retries
   * once on 429/5xx. Returns the final response with its body read.
   */
  async function send(
    method: string,
    url: string,
    init: { body?: string | Uint8Array<ArrayBuffer>; type?: string; binary?: boolean; timeout?: number } = {},
  ): Promise<{ response: Response; text: string; data: Buffer }> {
    let token = await tokens.access();
    let refreshed = false;
    let retried = false;
    for (;;) {
      const headers: Record<string, string> = { authorization: `Bearer ${token}` };
      if (init.type) headers["content-type"] = init.type;
      let response: Response;
      let data: Buffer;
      try {
        // The timeout covers reading the body as well as the reply's arrival.
        response = await fetch(url, {
          method,
          headers,
          body: init.body,
          signal: AbortSignal.timeout(init.timeout ?? TIMEOUT_MS),
        });
        data = Buffer.from(await response.arrayBuffer());
      } catch (error) {
        throw new GoogleError(`Google request failed: ${reason(error)}`);
      }
      if (response.status === 401) {
        if (refreshed) throw new NotSignedIn("expired");
        refreshed = true;
        token = await tokens.refresh();
        continue;
      }
      if ((response.status === 429 || response.status >= 500) && !retried) {
        retried = true;
        await sleep(retryAfter(response));
        continue;
      }
      return { response, data, text: init.binary && response.ok ? "" : data.toString("utf8") };
    }
  }

  const jsonBody = (body: unknown) =>
    body === undefined ? {} : { body: JSON.stringify(body), type: "application/json" };

  const parse = (url: string, { response, text }: { response: Response; text: string }) => {
    if (!response.ok) throw failure(url, response.status, text);
    if (response.status === 204 || text.trim() === "") return undefined;
    try {
      return JSON.parse(text);
    } catch {
      throw new GoogleError(`Google's reply wasn't JSON: ${text.trim().slice(0, 200)}`);
    }
  };

  return {
    json: async (method, url, { query, body } = {}) => {
      const target = withQuery(url, query);
      return parse(target, await send(method, target, jsonBody(body)));
    },

    bytes: async (url, query) => {
      const target = withQuery(url, query);
      const { response, data, text } = await send("GET", target, { binary: true, timeout: TRANSFER_TIMEOUT_MS });
      if (!response.ok) throw failure(target, response.status, text);
      return { data, type: response.headers.get("content-type") ?? "application/octet-stream" };
    },

    upload: async (url, metadata, data, type, query) => {
      const target = withQuery(url, { uploadType: "multipart", ...query });
      const boundary = `japa-${randomBytes(16).toString("hex")}`;
      const body = Buffer.concat([
        Buffer.from(
          `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n` +
            `--${boundary}\r\nContent-Type: ${type}\r\n\r\n`,
        ),
        data,
        Buffer.from(`\r\n--${boundary}--\r\n`),
      ]);
      const contentType = `multipart/related; boundary=${boundary}`;
      return parse(target, await send("POST", target, { body, type: contentType, timeout: TRANSFER_TIMEOUT_MS }));
    },

    raw: async (method, url, { query, body } = {}) => {
      const { response, text } = await send(method.toUpperCase(), withQuery(url, query), jsonBody(body));
      return { status: response.status, body: text };
    },
  };
}
