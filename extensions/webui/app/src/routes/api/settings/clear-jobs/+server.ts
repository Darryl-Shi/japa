import type { RequestHandler } from "./$types";
import { withSettings } from "$lib/server/http";

export const POST: RequestHandler = ({ locals }) => withSettings(locals, async (s) => ({ reply: await s.clearFinishedJobs() }));
