// Files in and out of the web UI, handled by the surface's own server ahead of SvelteKit: the download endpoint
// (`GET /api/files/<id>`, resolved only through the live hub's table) and the multipart `POST /api/submit`.
import { constants } from "node:fs";
import { open, realpath, stat } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join, sep } from "node:path";
import type { IncomingFile } from "japa/sdk";
import { MAX_FILES, MAX_FILES_BYTES, type SubmitMode } from "./app/src/lib/protocol.ts";
import type { FileRef } from "./transcript.ts";

/** The cap on a multipart submit's whole body: the files' cap plus room for the text and the multipart framing. */
export const MAX_SUBMIT_BODY = MAX_FILES_BYTES + 1024 * 1024;
const MAX_TEXT = 100_000;
const ID = /^[A-Za-z0-9_-]{8,64}$/;

/** The only types served as themselves and inline: raster images and PDFs (none of them can run script). */
const INLINE = new Set(["image/jpeg", "image/png", "image/gif", "image/webp", "application/pdf"]);

/** A multipart message, checked, for the surface to convert (`ctx.input`) and submit. */
export type FilesMessage = { id: string; text: string; mode: SubmitMode; files: IncomingFile[] };

function json(res: ServerResponse, status: number, body: object) {
  res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(body));
}

/** `Content-Disposition` for `name`: RFC 5987 `filename*` (UTF-8), with an ASCII-only `filename` for old clients. */
export function contentDisposition(type: "inline" | "attachment", name: string): string {
  // Printable ASCII without quotes and backslashes (control and non-ASCII characters are dropped).
  const ascii = name.replace(/[^\x20-\x7e]|["\\]/g, "").trim() || "download";
  const encoded = encodeURIComponent(name).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`,
  );
  return `${type}; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

const isMissing = (error: unknown) => {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "ENOTDIR" || code === "ELOOP";
};

/**
 * `GET|HEAD /api/files/<id>`: the transcript file `ref` (undefined: not in the transcript), read from disk now and
 * streamed. A person's upload must still resolve inside `<home>/attachments/`. Only raster images and PDFs go out as
 * themselves (inline unless `download`); anything else is an `application/octet-stream` attachment.
 */
export async function serveFile(
  req: IncomingMessage,
  res: ServerResponse,
  ref: FileRef | undefined,
  home: string | undefined,
  download: boolean,
): Promise<void> {
  res.setHeader("Cache-Control", "private");
  const notFound = () => json(res, 404, { error: "Not found" });
  if (ref === undefined) return notFound();
  const missing = () => json(res, 404, { error: `${ref.name} no longer exists on japa's host` });
  let path = ref.path;
  try {
    if (ref.upload) {
      if (home === undefined) return notFound();
      const root = await realpath(join(home, "attachments"));
      const real = await realpath(path);
      if (!real.startsWith(root + sep)) return notFound();
      path = real;
    }
    // Checked before opening, so a FIFO or a device is never opened.
    if (!(await stat(path)).isFile()) return missing();
  } catch (error) {
    return isMissing(error) ? missing() : notFound();
  }
  let handle;
  try {
    // O_NONBLOCK: a path swapped for a FIFO since the check doesn't hang the open (the fstat below refuses it).
    handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
  } catch (error) {
    return isMissing(error) ? missing() : notFound();
  }
  try {
    const info = await handle.stat();
    if (!info.isFile()) {
      await handle.close();
      return missing();
    }
    const type = ref.mimeType.split(";")[0]!.trim().toLowerCase();
    const inline = INLINE.has(type);
    res.writeHead(200, {
      "Content-Type": inline ? type : "application/octet-stream",
      "Content-Length": String(info.size),
      "Content-Disposition": contentDisposition(inline && !download ? "inline" : "attachment", ref.name),
    });
    if (req.method === "HEAD") {
      await handle.close();
      res.end();
      return;
    }
    const stream = handle.createReadStream({ end: Math.max(0, info.size - 1), autoClose: true });
    if (info.size === 0) {
      stream.destroy();
      res.end();
      return;
    }
    stream.on("error", () => res.destroy());
    res.on("close", () => stream.destroy());
    stream.pipe(res);
  } catch (error) {
    await handle.close().catch(() => {});
    throw error;
  }
}

/** The ids of multipart messages accepted in this process, and those being accepted: a retry saves nothing again. */
const accepted = new Set<string>();
const accepting = new Map<string, Promise<void>>();

/** Whether `req` is a multipart form (a file message to `POST /api/submit`). */
export const isMultipart = (req: IncomingMessage) =>
  /^multipart\/form-data\s*(;|$)/i.test(req.headers["content-type"] ?? "");

/** How long the rest of a refused body is discarded, so the client reads the 413 rather than a reset connection. */
const LINGER_MS = 5000;

/**
 * Discards the rest of `req`'s body (nothing is kept) for a while after the response, then closes the connection if
 * the body is still coming: closing at once would reset it, and the client would never see the response.
 */
function linger(req: IncomingMessage, res: ServerResponse) {
  req.resume();
  if (req.complete) return;
  res.once("finish", () => {
    if (req.complete) return;
    const timer = setTimeout(() => req.socket.destroy(), LINGER_MS);
    timer.unref();
    req.once("end", () => {
      clearTimeout(timer);
      // Its body discarded, the connection isn't reused.
      req.socket.end();
    });
    req.socket.once("close", () => clearTimeout(timer));
  });
}

/**
 * The body, read up to `limit` bytes; "too large" as soon as it's over (the rest isn't buffered).
 */
function readCapped(req: IncomingMessage, limit: number): Promise<Buffer | "too large"> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const onData = (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        req.off("data", onData).off("end", onEnd).off("error", onError);
        chunks.length = 0;
        resolve("too large");
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = () => resolve(Buffer.concat(chunks));
    const onError = (error: Error) => reject(error);
    req.on("data", onData).on("end", onEnd).on("error", onError);
  });
}

/**
 * The multipart `POST /api/submit`: fields `text`, `mode`, `id`, a `file` part per file. Checked, then handed to
 * `submit` (once per id for the process's lifetime). 204, or `{ error }`: 400 malformed or invalid, 413 over a cap,
 * 409 when `submit` throws.
 */
export async function submitMultipart(
  req: IncomingMessage,
  res: ServerResponse,
  submit: (message: FilesMessage) => Promise<void>,
  limit = MAX_SUBMIT_BODY,
): Promise<void> {
  const tooLarge = () => {
    linger(req, res);
    json(res, 413, { error: `Too large: the files may total at most ${MAX_FILES_BYTES / 1024 / 1024} MB` });
  };
  const declared = Number(req.headers["content-length"]);
  if (req.headers["content-length"] !== undefined && (!Number.isFinite(declared) || declared > limit)) return tooLarge();
  const body = await readCapped(req, limit);
  if (body === "too large") return tooLarge();

  let form: FormData;
  try {
    const headers = { "content-type": req.headers["content-type"]! };
    const request = new Request("http://localhost/", { method: "POST", headers, body: body as Uint8Array<ArrayBuffer> });
    form = await request.formData();
  } catch {
    return json(res, 400, { error: "Malformed multipart body" });
  }
  const text = form.get("text") ?? "";
  const mode = form.get("mode");
  const id = form.get("id");
  const parts = form.getAll("file");
  if (typeof text !== "string") return json(res, 400, { error: "text must be a field" });
  if (text.length > MAX_TEXT) return json(res, 400, { error: `Message is too long (max ${MAX_TEXT} characters)` });
  if (mode !== "steer" && mode !== "followUp") return json(res, 400, { error: 'mode must be "steer" or "followUp"' });
  if (typeof id !== "string" || !ID.test(id)) return json(res, 400, { error: "Invalid message id" });
  if (parts.some((p) => typeof p === "string")) return json(res, 400, { error: "Each file part must be a file" });
  const blobs = parts as File[];
  if (blobs.length > MAX_FILES) return json(res, 400, { error: `Too many files (max ${MAX_FILES})` });
  if (blobs.reduce((n, f) => n + f.size, 0) > MAX_FILES_BYTES) return tooLarge();
  if (text.trim() === "" && blobs.length === 0) return json(res, 400, { error: "Message is empty" });

  if (accepted.has(id)) return void res.writeHead(204).end();
  let pending = accepting.get(id);
  if (pending === undefined) {
    pending = (async () => {
      const files: IncomingFile[] = await Promise.all(
        blobs.map(async (f) => ({
          data: new Uint8Array(await f.arrayBuffer()),
          mimeType: f.type || "application/octet-stream",
          ...(f.name !== "" && { name: f.name }),
        })),
      );
      await submit({ id, text, mode, files });
      accepted.add(id);
    })().finally(() => accepting.delete(id));
    accepting.set(id, pending);
  }
  try {
    await pending;
  } catch (e) {
    return json(res, 409, { error: e instanceof Error ? e.message : "Couldn't send the message" });
  }
  res.writeHead(204).end();
}
