import type { RequestHandler } from "./$types";
import { jsonError, noContent, readJsonObject } from "$lib/server/http";

const MAX_TEXT = 100_000;
const ID = /^[A-Za-z0-9_-]{8,64}$/;

export const POST: RequestHandler = async ({ locals, request }) => {
  const body = await readJsonObject(request);
  if (body === undefined) return jsonError(400, "Expected a JSON object");
  const { text, mode, id } = body;
  if (typeof text !== "string" || text.trim() === "") return jsonError(400, "Message is empty");
  if (text.length > MAX_TEXT) return jsonError(400, `Message is too long (max ${MAX_TEXT} characters)`);
  if (mode !== "steer" && mode !== "followUp") return jsonError(400, 'mode must be "steer" or "followUp"');
  if (typeof id !== "string" || !ID.test(id)) return jsonError(400, "Invalid message id");
  try {
    await locals.webui.submit(text, mode, id);
  } catch (e) {
    return jsonError(409, e instanceof Error ? e.message : "Couldn't send the message");
  }
  return noContent();
};
