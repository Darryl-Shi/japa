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

/** A file to upload in a multipart call: its form field, file name, MIME type and bytes. */
export type Upload = { field: string; name: string; mimeType: string; data: Uint8Array<ArrayBuffer> };

export type BotApi = {
  /** Calls `method` once. */
  once<T>(method: string, params?: object): Promise<T>;
  /** Calls `method`, retrying on 429, 5xx and network errors until the 60 s wait has failed too. */
  call<T>(method: string, params?: object): Promise<T>;
  /** Calls `method` once as multipart/form-data, with `params` as fields (objects JSON-encoded) and `file` uploaded. */
  onceForm<T>(method: string, params: object, file: Upload): Promise<T>;
  /** `onceForm` with `call`'s retries. */
  callForm<T>(method: string, params: object, file: Upload): Promise<T>;
  download(path: string): Promise<Uint8Array>;
};

type Answer<T> = { ok: true; result: T } | { ok: false; error_code: number; description: string; parameters?: { retry_after?: number } };

/** `params` and `file` as a multipart form; undefined fields are left out. */
function form(params: object, file: Upload): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue;
    data.append(key, typeof value === "object" ? JSON.stringify(value) : String(value));
  }
  data.append(file.field, new Blob([file.data], { type: file.mimeType }), file.name);
  return data;
}

export function botApi(base: string, token: string, signal: AbortSignal): BotApi {
  const request = async <T>(method: string, init: { headers?: Record<string, string>; body: string | FormData }) => {
    const response = await fetch(`${base}/bot${token}/${method}`, { method: "POST", ...init, signal });
    const body = (await response.json()) as Answer<T>;
    if (!body.ok) throw new ApiError(body.error_code, body.description, body.parameters?.retry_after);
    return body.result;
  };
  const retrying = async <T>(attempt: () => Promise<T>) => {
    for (let n = 0; ; n++) {
      try {
        return await attempt();
      } catch (error) {
        const api = error instanceof ApiError;
        if ((api && error.code !== 429 && error.code < 500) || n === 7) throw error;
        await sleep(api && error.code === 429 ? error.retryAfter! * 1000 : backoff(n), undefined, { signal });
      }
    }
  };
  const once = <T>(method: string, params: object = {}) =>
    request<T>(method, { headers: { "content-type": "application/json" }, body: JSON.stringify(params) });
  const onceForm = <T>(method: string, params: object, file: Upload) =>
    request<T>(method, { body: form(params, file) }); // fetch sets the multipart content-type with its boundary
  return {
    once,
    call: <T>(method: string, params?: object) => retrying(() => once<T>(method, params)),
    onceForm,
    callForm: <T>(method: string, params: object, file: Upload) => retrying(() => onceForm<T>(method, params, file)),
    download: async (path) => {
      const response = await fetch(`${base}/file/bot${token}/${path}`, { signal });
      if (!response.ok) throw new ApiError(response.status, `Couldn't download ${path}: ${response.statusText}`);
      return new Uint8Array(await response.arrayBuffer());
    },
  };
}
