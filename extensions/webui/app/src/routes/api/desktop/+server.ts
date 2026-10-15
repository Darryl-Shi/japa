import type { RequestHandler } from "./$types";
import { json, jsonError } from "$lib/server/http";

// Carries the VNC password: no-store, and only behind the session gate (the surface's server).
export const GET: RequestHandler = async ({ locals }) => {
  try {
    return json(await locals.webui.desktop());
  } catch {
    return jsonError(500, "Couldn't read the desktop's state");
  }
};
