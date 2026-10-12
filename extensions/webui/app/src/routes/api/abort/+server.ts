import type { RequestHandler } from "./$types";
import { jsonError, noContent } from "$lib/server/http";

export const POST: RequestHandler = async ({ locals }) => {
  try {
    await locals.webui.abort();
  } catch (e) {
    return jsonError(409, e instanceof Error ? e.message : "Couldn't stop the reply");
  }
  return noContent();
};
