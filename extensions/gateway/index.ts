import { existsSync, unlinkSync } from "node:fs";
import { createConnection, createServer, type Socket } from "node:net";
import { defineJapaExtension, type Surface, type SurfaceContext } from "../../src/sdk.ts";
import { type ClientMessage, readMessages, socketPath, writeMessage } from "./protocol.ts";

async function start(ctx: SurfaceContext) {
  const path = socketPath(ctx.home);
  if (existsSync(path)) {
    const live = await new Promise<boolean>((resolve) => {
      const probe = createConnection(path, () => {
        probe.end();
        resolve(true);
      });
      probe.on("error", () => resolve(false));
    });
    if (live) throw new Error(`Another japa daemon owns ${path}`);
    unlinkSync(path);
  }

  const sockets = new Set<Socket>();
  const closing: Promise<void>[] = [];
  const server = createServer((socket) => {
    sockets.add(socket);
    let stop: (() => Promise<void>) | undefined;
    const handle = async (m: ClientMessage | undefined) => {
      switch (m?.type) {
        case "attach": {
          const stream = await ctx.root.events((events) => writeMessage(socket, { type: "events", events: [...events] }));
          stop = stream.stop;
          writeMessage(socket, { type: "snapshot", snapshot: stream.snapshot });
          break;
        }
        case "submit":
          return ctx.root.submit(m.text, m.mode);
        case "abort":
          return ctx.root.abort();
        case "status":
          return writeMessage(socket, { type: "status", status: ctx.status() });
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
      closing.push(queue.then(() => stop?.()));
    });
  });
  await new Promise<void>((resolve, reject) => server.once("error", reject).listen(path, resolve));

  return async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve)); // also unlinks the socket file
    await Promise.all(closing);
  };
}

const gateway: Surface = { name: "gateway", start };

export default defineJapaExtension({
  name: "gateway",
  summary: "Lets you chat with japa from the terminal (japa chat)",
  provides: { surface: [gateway] },
});
