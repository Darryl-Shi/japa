import type { RequestHandler } from "./$types";
import { jsonError, noContent, readJsonObject, REQUEST_ID } from "$lib/server/http";

export const POST: RequestHandler = async ({ locals, request }) => {
  const body = await readJsonObject(request);
  if (body === undefined) return jsonError(400, "Expected a JSON object");
  const { requestId } = body;
  if (typeof requestId !== "string" || !REQUEST_ID.test(requestId)) return jsonError(400, "Invalid request id");
  try {
    await locals.webui.decline(requestId);
  } catch {
    return jsonError(404, "No such request");
  }
  return noContent();
};
