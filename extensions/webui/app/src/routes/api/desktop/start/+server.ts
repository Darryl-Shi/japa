import type { RequestHandler } from "./$types";
import { jsonError, noContent } from "$lib/server/http";

export const POST: RequestHandler = ({ locals }) =>
  locals.webui.startDesktop() ? noContent() : jsonError(404, "The desktop isn't available");
