import type { AgentEvent } from "@earendil-works/pi-durable";
import type { Socket } from "node:net";
import { join } from "node:path";
import type { Job, Status } from "../../src/sdk.ts";

export type ClientMessage =
  | { type: "attach" }
  | { type: "submit"; text: string; mode?: "steer" | "followUp" }
  | { type: "abort" }
  | { type: "status" };

export type ServerMessage =
  | { type: "events"; events: AgentEvent[] }
  | { type: "jobs"; jobs: Job[] }
  | { type: "status"; status: Status }
  | { type: "error"; message: string };

export function socketPath(home: string): string {
  return join(home, "japa.sock");
}

/** Sends one message as a JSON line. */
export function writeMessage(socket: Socket, message: ClientMessage | ServerMessage): void {
  socket.write(`${JSON.stringify(message)}\n`);
}

/** Calls `onMessage` per JSON line received; lines that fail to parse arrive as `undefined`. */
export function readMessages(socket: Socket, onMessage: (m: unknown) => void): void {
  let buffer = "";
  socket.setEncoding("utf8");
  socket.on("data", (chunk: string) => {
    const lines = (buffer + chunk).split("\n");
    buffer = lines.pop()!;
    for (const line of lines) {
      if (line === "") continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        parsed = undefined;
      }
      onMessage(parsed);
    }
  });
}
