import type { RequestHandler } from "./$types";
import type { LiveEvent } from "$lib/protocol";

const HEARTBEAT_MS = 20_000;

/** The live stream: a snapshot first, then every update, as Server-Sent Events. */
export const GET: RequestHandler = ({ locals, request }) => {
  const encoder = new TextEncoder();
  let cleanup = () => {};

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      let unsubscribe: (() => void) | undefined;
      let heartbeat: ReturnType<typeof setInterval> | undefined;
      const write = (chunk: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          finish();
        }
      };
      const finish = () => {
        if (closed) return;
        closed = true;
        if (heartbeat !== undefined) clearInterval(heartbeat);
        request.signal.removeEventListener("abort", onAbort);
        const u = unsubscribe;
        unsubscribe = undefined;
        u?.();
      };
      const onAbort = () => {
        finish();
        try {
          controller.close();
        } catch {
          // already closed
        }
      };
      cleanup = finish;

      write("retry: 2000\n\n");
      heartbeat = setInterval(() => write(": ping\n\n"), HEARTBEAT_MS);
      request.signal.addEventListener("abort", onAbort);
      // `close`: the surface is stopping; end the stream so the client reconnects to whatever comes next.
      const off = locals.webui.subscribe(
        (event: LiveEvent) => write(`data: ${JSON.stringify(event)}\n\n`),
        onAbort,
      );
      if (closed) off();
      else unsubscribe = off;
    },
    cancel() {
      cleanup();
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      "x-accel-buffering": "no",
    },
  });
};
