import { createConnection } from "node:net";
import { type ClientMessage, readMessages, type ServerMessage, socketPath, writeMessage } from "./protocol.ts";

export type Client = {
  send(m: ClientMessage): void;
  onMessage(cb: (m: ServerMessage) => void): void;
  close(): void;
  onClose(cb: () => void): void;
};

/** Connects to the daemon running in `home`. */
export function connect(home: string): Promise<Client> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath(home));
    socket.once("error", (err: NodeJS.ErrnoException) => {
      const notRunning = err.code === "ENOENT" || err.code === "ECONNREFUSED";
      reject(notRunning ? new Error("japa is not running. Start it with: japa daemon") : err);
    });
    socket.once("connect", () =>
      resolve({
        send: (m) => writeMessage(socket, m),
        onMessage: (cb) => readMessages(socket, (m) => cb(m as ServerMessage)),
        close: () => socket.end(),
        onClose: (cb) => socket.on("close", cb),
      }),
    );
  });
}
