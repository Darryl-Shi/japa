import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-durable";
import type { OutgoingFile } from "./contracts.ts";
import { humanSize, mimeFromName } from "./files.ts";

/** The kernel's cap on a file `send_file` accepts, in bytes. */
export const MAX_SEND_BYTES = 50 * 1024 * 1024;

const reply = (text: string) => ({ content: [{ type: "text" as const, text }] });

/** `path` resolved on japa's host: absolute, or `~/`-relative; undefined otherwise. */
function resolvePath(path: string): string | undefined {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return isAbsolute(path) ? resolve(path) : undefined;
}

/**
 * The CoS's tool to send the user a file on japa's host. It only validates and records the file in its details; the
 * reply stream delivers it (see `watchReplies`).
 */
export const sendFile = defineTool({
  name: "send_file",
  description:
    "Send the user a file on japa's host, such as a job's deliverable in ~/.japa/outbox/. " +
    "`path` is absolute or starts with ~/; `caption` (markdown) is optional. " +
    "Text you write before calling it is delivered first.",
  parameters: Type.Object({ path: Type.String(), caption: Type.Optional(Type.String()) }),
  execute: async ({ path, caption }) => {
    const resolved = resolvePath(path);
    if (resolved === undefined) return reply(`The path must be absolute or start with ~/: ${path}.`);
    let size: number;
    try {
      const info = await stat(resolved);
      if (!info.isFile()) return reply(`Not a file: ${path}.`);
      size = info.size;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return reply(`No file at ${path}.`);
      return reply((error as Error).message);
    }
    try {
      await access(resolved, constants.R_OK);
    } catch (error) {
      return reply((error as Error).message);
    }
    if (size > MAX_SEND_BYTES) {
      const shown = humanSize(size) === humanSize(MAX_SEND_BYTES) ? `${size} bytes` : humanSize(size);
      return reply(`Too large: ${shown} (max ${humanSize(MAX_SEND_BYTES)}).`);
    }
    const name = basename(resolved);
    const file: OutgoingFile = { path: resolved, name, mimeType: mimeFromName(name), size };
    if (caption !== undefined && caption !== "") file.caption = caption;
    return { ...reply(`Sending ${name} (${humanSize(size)}).`), details: { file } };
  },
});
