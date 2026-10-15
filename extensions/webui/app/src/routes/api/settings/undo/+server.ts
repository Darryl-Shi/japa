import type { RequestHandler } from "./$types";
import { jsonError, NAME, readJsonObject, withSettings } from "$lib/server/http";

export const POST: RequestHandler = async ({ locals, request }) => {
  const body = await readJsonObject(request);
  if (body === undefined) return jsonError(400, "Expected a JSON object");
  const { id } = body;
  if (typeof id !== "string" || !NAME.test(id)) return jsonError(400, "Invalid change id");
  return withSettings(locals, async (s) => ({ reply: await s.undo(id) }));
};
