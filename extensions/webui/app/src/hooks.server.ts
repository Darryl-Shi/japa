import type { Handle } from "@sveltejs/kit";
import { BRIDGE_KEY, type WebuiBridge } from "$lib/protocol";

// The surface sets the bridge on every start(), so a reload rebinds it; read it per request.
export const handle: Handle = async ({ event, resolve }) => {
  const bridge = (globalThis as Record<symbol, WebuiBridge | undefined>)[Symbol.for(BRIDGE_KEY)];
  if (bridge === undefined) {
    return new Response(JSON.stringify({ error: "japa's web UI is not running" }), {
      status: 503,
      headers: { "content-type": "application/json" },
    });
  }
  event.locals.webui = bridge;
  return resolve(event);
};
