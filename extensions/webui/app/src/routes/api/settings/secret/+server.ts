import type { RequestHandler } from "./$types";
import { jsonError, NAME, readJsonObject, withSettings } from "$lib/server/http";

// The value is passed straight to the bridge: never logged, echoed or put in an error message.
export const POST: RequestHandler = async ({ locals, request }) => {
  const body = await readJsonObject(request);
  if (body === undefined) return jsonError(400, "Expected a JSON object");
  const { extension, name, value } = body;
  if (typeof extension !== "string" || !NAME.test(extension)) return jsonError(400, "Invalid extension");
  if (typeof name !== "string" || !NAME.test(name)) return jsonError(400, "Invalid secret name");
  if (typeof value !== "string" || value === "") return jsonError(400, "The value is empty");
  return withSettings(locals, async (s) => ({ reply: await s.setSecret(extension, name, value) }));
};
