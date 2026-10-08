import { setTimeout as sleep } from "node:timers/promises";

/** The wait before retry `attempt` (from 0): 1 s doubling to 60 s. */
export const backoff = (attempt: number) => Math.min(1000 * 2 ** attempt, 60_000);

/** A Bot API error response. */
export class ApiError extends Error {
  code: number;
  retryAfter?: number;
  constructor(code: number, description: string, retryAfter?: number) {
    super(description);
    this.code = code;
    this.retryAfter = retryAfter;
  }
}

export type BotApi = {
  /** Calls `method` once. */
  once<T>(method: string, params?: object): Promise<T>;
  /** Calls `method`, retrying on 429, 5xx and network errors until the 60 s wait has failed too. */
  call<T>(method: string, params?: object): Promise<T>;
  download(path: string): Promise<Uint8Array>;
};

type Answer<T> = { ok: true; result: T } | { ok: false; error_code: number; description: string; parameters?: { retry_after?: number } };

export function botApi(base: string, token: string, signal: AbortSignal): BotApi {
  const once = async <T>(method: string, params: object = {}) => {
    const response = await fetch(`${base}/bot${token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(params),
      signal,
    });
    const body = (await response.json()) as Answer<T>;
    if (!body.ok) throw new ApiError(body.error_code, body.description, body.parameters?.retry_after);
    return body.result;
  };
  return {
    once,
    call: async <T>(method: string, params?: object) => {
      for (let attempt = 0; ; attempt++) {
        try {
          return await once<T>(method, params);
        } catch (error) {
          const api = error instanceof ApiError;
          if ((api && error.code !== 429 && error.code < 500) || attempt === 7) throw error;
          await sleep(api && error.code === 429 ? error.retryAfter! * 1000 : backoff(attempt), undefined, { signal });
        }
      }
    },
    download: async (path) => {
      const response = await fetch(`${base}/file/bot${token}/${path}`, { signal });
      if (!response.ok) throw new ApiError(response.status, `Couldn't download ${path}: ${response.statusText}`);
      return new Uint8Array(await response.arrayBuffer());
    },
  };
}
