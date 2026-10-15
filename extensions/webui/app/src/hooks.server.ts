import type { Handle } from "@sveltejs/kit";
import { BRIDGE_KEY, type WebuiBridge } from "$lib/protocol";

/**
 * `csp` with the same-origin websocket (the Desktop panel's `/api/desktop/ws`, at `ws://<host>`) added to its
 * `connect-src`: not every browser counts a websocket to the page's own host as `'self'`.
 */
function allowWebsocket(csp: string, host: string): string {
  const ws = `ws://${host}`;
  return csp
    .split(";")
    .map((directive) => {
      const d = directive.trim();
      return /^connect-src(\s|$)/i.test(d) && !d.split(/\s+/).includes(ws) ? `${d} ${ws}` : d;
    })
    .join("; ");
}

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
  const response = await resolve(event);
  const csp = response.headers.get("content-security-policy");
  if (csp !== null && /(^|;)\s*connect-src/i.test(csp)) {
    try {
      response.headers.set("content-security-policy", allowWebsocket(csp, event.url.host));
    } catch {
      // immutable headers (a fetched response): it carries no page
    }
  }
  return response;
};
