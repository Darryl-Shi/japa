import type { RequestHandler } from "./$types";
import { jsonError, NAME, withSettings } from "$lib/server/http";

export const GET: RequestHandler = ({ locals, url }) => {
  const provider = url.searchParams.get("provider") ?? "";
  if (!NAME.test(provider)) return jsonError(400, "Invalid provider");
  return withSettings(locals, (s) => s.models(provider));
};
