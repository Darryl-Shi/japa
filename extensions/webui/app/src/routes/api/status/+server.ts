import type { RequestHandler } from "./$types";

export const GET: RequestHandler = ({ locals }) =>
  new Response(JSON.stringify(locals.webui.status()), {
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
