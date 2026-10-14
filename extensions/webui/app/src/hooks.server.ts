import type { Handle } from "@sveltejs/kit";
import { BRIDGE_KEY, REQUEST_KEY, type WebuiBridge, type WebuiRequest } from "$lib/protocol";

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
  // What the surface's session gate found for this request (adapter-node's platform carries the Node request).
  const info = (event.platform?.req as unknown as Record<symbol, WebuiRequest | undefined> | undefined)?.[
    Symbol.for(REQUEST_KEY)
  ];
  event.locals.user = info?.user;
  event.locals.users = info?.users ?? "some";
  return resolve(event);
};
