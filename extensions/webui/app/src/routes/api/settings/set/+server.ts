import type { RequestHandler } from "./$types";
import { jsonError, NAME, readJsonObject, withSettings } from "$lib/server/http";
import type { Json } from "$lib/protocol";

// `{ path, value? }`: an absent value unsets the path. The kernel validates the value (`Not changed: …`).
export const POST: RequestHandler = async ({ locals, request }) => {
  const body = await readJsonObject(request);
  if (body === undefined) return jsonError(400, "Expected a JSON object");
  const { path, value } = body;
  if (typeof path !== "string" || !NAME.test(path)) return jsonError(400, "Invalid settings path");
  return withSettings(locals, async (s) => ({ reply: await s.set(path, value as Json | undefined) }));
};
