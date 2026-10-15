import type { RequestHandler } from "./$types";
import { jsonError, NAME, readJsonObject, withSettings } from "$lib/server/http";

const ACTIONS = ["pause", "resume", "remove"] as const;

export const POST: RequestHandler = async ({ locals, request }) => {
  const body = await readJsonObject(request);
  if (body === undefined) return jsonError(400, "Expected a JSON object");
  const { id, action } = body;
  if (typeof id !== "string" || !NAME.test(id)) return jsonError(400, "Invalid schedule id");
  const act = ACTIONS.find((a) => a === action);
  if (act === undefined) return jsonError(400, "Invalid action");
  return withSettings(locals, async (s) => ({ reply: await s.schedule(id, act) }));
};
