import { randomUUID } from "node:crypto";
import type { Origin } from "./contracts.ts";

/** `surface:<surface>:<chat>:<id>`, each part URI-encoded; `id` defaults to a fresh UUID. */
export function requestIdFor(origin: { surface: string; chat?: string; id?: string }): string {
  const parts = [origin.surface, origin.chat ?? "", origin.id ?? randomUUID()];
  return `surface:${parts.map(encodeURIComponent).join(":")}`;
}

/** Where an input came from: its surface and chat, `"proactive"` for kernel inputs, the gateway when it has no requestId. */
export function originOf(requestId: string | undefined): Origin {
  if (requestId === undefined) return { surface: "gateway" };
  const match = /^surface:([^:]*):([^:]*):/.exec(requestId);
  if (!match) return "proactive";
  const surface = decodeURIComponent(match[1]!);
  return match[2] ? { surface, chat: decodeURIComponent(match[2]) } : { surface };
}
