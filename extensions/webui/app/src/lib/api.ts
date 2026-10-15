// Fetch helpers for the JSON endpoints: same-origin, never cached; a 401 sends the page to sign-in; an error body
// `{ error }` becomes the thrown ApiError's message.
import { API } from "$lib/protocol";

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/** The session is gone: back to the sign-in page. */
export function toLogin(): void {
  location.href = API.login;
}

async function request<T>(url: string, init: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, { ...init, cache: "no-store", credentials: "same-origin" });
  } catch {
    throw new ApiError("Couldn't reach japa.", 0);
  }
  if (res.status === 401) {
    toLogin();
    throw new ApiError("Signed out.", 401);
  }
  if (!res.ok) {
    let message = `Request failed (${res.status}).`;
    try {
      const body = (await res.json()) as { error?: unknown };
      if (typeof body.error === "string" && body.error !== "") message = body.error;
    } catch {
      // not JSON
    }
    throw new ApiError(message, res.status);
  }
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  return (text === "" ? undefined : JSON.parse(text)) as T;
}

/** GET `url` as JSON. */
export function getJson<T>(url: string): Promise<T> {
  return request<T>(url, { method: "GET" });
}

/** POST `body` as JSON to `url`; the JSON reply (undefined for a 204). */
export function postJson<T = void>(url: string, body: unknown = {}): Promise<T> {
  return request<T>(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** A thrown value's message, for showing inline. */
export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
