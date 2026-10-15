import type { RequestHandler } from "./$types";
import { jsonError, noContent, REQUEST_ID, settingsOf } from "$lib/server/http";

export const POST: RequestHandler = ({ locals, params }) => {
  const settings = settingsOf(locals);
  if (settings instanceof Response) return settings;
  if (!REQUEST_ID.test(params.id) || settings.flow(params.id) === undefined) return jsonError(404, "No such sign-in");
  settings.cancel(params.id);
  return noContent();
};
