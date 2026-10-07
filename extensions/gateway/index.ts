import { rmSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { defineJapaExtension, type Surface, type SurfaceContext } from "../../src/sdk.ts";
import { type ClientMessage, readMessages, socketPath, writeMessage } from "./protocol.ts";

async function start(ctx: SurfaceContext) {
  const path = socketPath(ctx.home);
  rmSync(path, { force: true }); // stale: the daemon lock guarantees one daemon per home

  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    const streams: { stop(): Promise<void> }[] = [];
    const handle = async (m: ClientMessage | undefined) => {
      switch (m?.type) {
        case "attach": {
          streams.push(await ctx.root.events((events) => writeMessage(socket, { type: "events", events: [...events] })));
          streams.push(await ctx.jobs((jobs) => writeMessage(socket, { type: "jobs", jobs })));
          break;
        }
        case "abort":
          return ctx.root.abort();
        case "status":
          return writeMessage(socket, { type: "status", status: ctx.status() });
        case "submit":
          if (typeof m.text === "string") return ctx.root.submit(m.text, m.mode);
        // falls through: a submit without text is invalid
        default:
          return writeMessage(socket, { type: "error", message: "Invalid message" });
      }
    };
    // Messages are handled one at a time, in order.
    let queue = Promise.resolve();
    readMessages(socket, (m) => {
      queue = queue
        .then(() => handle(m as ClientMessage | undefined))
        .catch((err: Error) => writeMessage(socket, { type: "error", message: err.message }));
    });
    socket.on("error", () => {});
    socket.on("close", () => {
      sockets.delete(socket);
      queue.then(() => Promise.all(streams.map((s) => s.stop()))).catch(() => {});
    });
  });
  await new Promise<void>((resolve, reject) => server.once("error", reject).listen(path, resolve));

  return async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve)); // also unlinks the socket file
  };
}

const gateway: Surface = { name: "gateway", start };

export default defineJapaExtension({
  name: "gateway",
  summary: "Lets you chat with japa from the terminal (japa chat)",
  provides: { surface: [gateway] },
});
