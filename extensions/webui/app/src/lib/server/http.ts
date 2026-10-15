// Small helpers shared by the API endpoints.
import type { SettingsBridge } from "$lib/protocol";

export function jsonError(status: number, error: string): Response {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

export function noContent(): Response {
  return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
}

/** The request's JSON object body, or undefined when it isn't one. */
export async function readJsonObject(request: Request): Promise<Record<string, unknown> | undefined> {
  try {
    const body: unknown = await request.json();
    return typeof body === "object" && body !== null && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

export const REQUEST_ID = /^[A-Za-z0-9_-]{1,128}$/;

/** A JSON response, never cached. */
export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

/** An error's user-facing message. */
export const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** The Settings bridge, or the 503 to answer without one (the surface has no admin context). */
export function settingsOf(locals: App.Locals): SettingsBridge | Response {
  return locals.webui.settings ?? jsonError(503, "Settings aren't available");
}

/**
 * Runs `op` on the Settings bridge: its result as JSON (204 for undefined), its error as `status` with its message.
 * Never pass a secret value in an error message: the kernel's never carry one.
 */
export async function withSettings<T>(
  locals: App.Locals,
  op: (settings: SettingsBridge) => Promise<T> | T,
  status = 500,
): Promise<Response> {
  const settings = settingsOf(locals);
  if (settings instanceof Response) return settings;
  try {
    const result = await op(settings);
    return result === undefined ? noContent() : json(result);
  } catch (error) {
    return jsonError(status, messageOf(error));
  }
}

/** A non-empty string of at most `max` characters, else undefined. */
export function text(value: unknown, max = 256): string | undefined {
  return typeof value === "string" && value !== "" && value.length <= max ? value : undefined;
}

/** A settings or extension name: letters, digits, `.`, `_`, `-`. */
export const NAME = /^[A-Za-z0-9._-]{1,128}$/;
/** A git commit sha. */
export const SHA = /^[0-9a-f]{7,64}$/;
