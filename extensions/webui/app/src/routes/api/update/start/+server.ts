import type { RequestHandler } from "./$types";
import { jsonError, readJsonObject, SHA, withSettings } from "$lib/server/http";

// 409 with the kernel's message when an update already runs (or can't be started).
export const POST: RequestHandler = async ({ locals, request }) => {
  const body = await readJsonObject(request);
  if (body === undefined) return jsonError(400, "Expected a JSON object");
  const { to } = body;
  if (typeof to !== "string" || !SHA.test(to)) return jsonError(400, "Invalid commit");
  return withSettings(locals, (s) => s.startUpdate(to), 409);
};
