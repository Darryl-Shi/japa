import type { RequestHandler } from "./$types";
import { jsonError, messageOf, noContent, readJsonObject, REQUEST_ID, settingsOf } from "$lib/server/http";

// The answer (a secret, perhaps) is passed straight to the flow: never logged, echoed or put in an error message.
export const POST: RequestHandler = async ({ locals, params, request }) => {
  const settings = settingsOf(locals);
  if (settings instanceof Response) return settings;
  if (!REQUEST_ID.test(params.id) || settings.flow(params.id) === undefined) return jsonError(404, "No such sign-in");
  const body = await readJsonObject(request);
  if (body === undefined) return jsonError(400, "Expected a JSON object");
  const { promptId, value } = body;
  if (typeof promptId !== "string" || !REQUEST_ID.test(promptId)) return jsonError(400, "Invalid prompt id");
  if (typeof value !== "string" || value.length > 16_384) return jsonError(400, "Invalid answer");
  try {
    settings.answer(params.id, promptId, value);
  } catch (error) {
    return jsonError(409, messageOf(error));
  }
  return noContent();
};
