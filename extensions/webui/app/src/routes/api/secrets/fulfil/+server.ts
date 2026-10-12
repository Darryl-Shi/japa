import type { RequestHandler } from "./$types";
import { jsonError, noContent, readJsonObject, REQUEST_ID } from "$lib/server/http";

// The value is passed straight to the bridge: never logged, echoed or put in an error message.
export const POST: RequestHandler = async ({ locals, request }) => {
  const body = await readJsonObject(request);
  if (body === undefined) return jsonError(400, "Expected a JSON object");
  const { requestId, value } = body;
  if (typeof requestId !== "string" || !REQUEST_ID.test(requestId)) return jsonError(400, "Invalid request id");
  if (typeof value !== "string" || value === "") return jsonError(400, "The value is empty");
  try {
    await locals.webui.fulfil(requestId, value);
  } catch {
    return jsonError(404, "No such request");
  }
  return noContent();
};
