import type { RequestHandler } from "./$types";
import { jsonError, NAME, readJsonObject, withSettings } from "$lib/server/http";

export const POST: RequestHandler = async ({ locals, request }) => {
  const body = await readJsonObject(request);
  if (body === undefined) return jsonError(400, "Expected a JSON object");
  const { extension } = body;
  if (typeof extension !== "string" || !NAME.test(extension)) return jsonError(400, "Invalid extension");
  return withSettings(locals, async (s) => ({ reply: await s.rollback(extension) }));
};
