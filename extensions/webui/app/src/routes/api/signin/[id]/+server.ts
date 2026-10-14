import type { RequestHandler } from "./$types";
import { jsonError, REQUEST_ID, settingsOf, json } from "$lib/server/http";

export const GET: RequestHandler = ({ locals, params }) => {
  const settings = settingsOf(locals);
  if (settings instanceof Response) return settings;
  const flow = REQUEST_ID.test(params.id) ? settings.flow(params.id) : undefined;
  return flow === undefined ? jsonError(404, "No such sign-in") : json(flow);
};
