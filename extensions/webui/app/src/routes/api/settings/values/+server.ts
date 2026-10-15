import type { RequestHandler } from "./$types";
import { withSettings } from "$lib/server/http";

export const GET: RequestHandler = ({ locals }) => withSettings(locals, (s) => s.values());
