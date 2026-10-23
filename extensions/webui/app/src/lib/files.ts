// File helpers shared by the composer, the transcript's file chips/cards and Live. Pure TS (type-only imports), so
// vitest and the root tsc can import it directly; the constants mirror $lib/protocol (a test checks they match).
import type { FileView } from "./protocol.ts";

/** protocol.ts's MAX_FILES / MAX_FILES_BYTES / API.files (value imports of a `.ts` path don't typecheck in the app). */
export const FILES_LIMIT = 10;
export const FILES_BYTES_LIMIT = 50 * 1024 * 1024;
export const FILES_PATH = "/api/files";

/** The kernel's longest kept file name (src/kernel/messaging/attachments.ts MAX_NAME_CHARS). */
const MAX_NAME_CHARS = 120;

/** A byte count for people: "512 B", "1.5 KB", "12 MB" (as src/kernel/files.ts humanSize). */
export function humanSize(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  if (unit === 0) return `${bytes} B`;
  const shown = value < 10 ? value.toFixed(1).replace(/\.0$/, "") : String(Math.round(value));
  return `${shown} ${units[unit]}`;
}

/**
 * The name the kernel saves an uploaded file under (without its message-id prefix), as its sanitiseName: the
 * basename, control characters stripped, trimmed, leading dots removed, long names shortened keeping the extension.
 * "" when nothing is left (the kernel then names the file after the message id).
 */
export function sanitiseName(name: string): string {
  const base = name.split(/[/\\]/).at(-1) ?? "";
  const clean = base
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, "")
    .trim()
    .replace(/^\.+/, "")
    .trim();
  if (clean.length <= MAX_NAME_CHARS) return clean;
  const dot = clean.lastIndexOf(".");
  const ext = dot > 0 && clean.length - dot <= 16 ? clean.slice(dot) : "";
  return clean.slice(0, MAX_NAME_CHARS - ext.length) + ext;
}

/**
 * Whether the files a line lists are the ones a pending message sent, in order (by sanitised name; a name that
 * sanitises to "" matches anything, since the kernel names such a file after the message id).
 */
export function sameFileNames(sent: readonly { name: string }[], shown: readonly { name: string }[]): boolean {
  if (sent.length !== shown.length) return false;
  return sent.every((file, i) => {
    const name = sanitiseName(file.name);
    return name === "" || name === sanitiseName(shown[i]!.name);
  });
}

/** Which limit `files` break, as a message for the composer; undefined when within both. */
export function checkFiles(files: readonly { size: number }[]): string | undefined {
  if (files.length > FILES_LIMIT) return `At most ${FILES_LIMIT} files per message`;
  const total = files.reduce((sum, f) => sum + f.size, 0);
  if (total > FILES_BYTES_LIMIT) return `At most ${humanSize(FILES_BYTES_LIMIT)} of files per message`;
  return undefined;
}

/** `GET /api/files/<id>`, optionally forcing a download. */
export function fileUrl(id: string, download = false): string {
  return `${FILES_PATH}/${encodeURIComponent(id)}${download ? "?download=1" : ""}`;
}

const baseMime = (mime: string) => (mime.split(";")[0] ?? "").trim().toLowerCase();

const RASTER = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

/** A raster image the server serves inline (and so an `<img>` can show): jpeg, png, gif, webp. */
export function isImage(mime: string): boolean {
  return RASTER.has(baseMime(mime));
}

/** Served inline with its own type (so Open makes sense): raster images and PDFs. */
export function inlineType(mime: string): boolean {
  return isImage(mime) || baseMime(mime) === "application/pdf";
}

export type FileIcon = "image" | "pdf" | "text" | "archive" | "audio" | "video" | "file";

const ARCHIVES = new Set([
  "application/zip",
  "application/x-zip-compressed",
  "application/gzip",
  "application/x-gzip",
  "application/x-tar",
  "application/x-7z-compressed",
  "application/x-rar-compressed",
  "application/vnd.rar",
  "application/x-bzip2",
  "application/x-xz",
]);

const TEXTS = new Set([
  "application/json",
  "application/xml",
  "application/javascript",
  "application/x-yaml",
  "application/yaml",
  "application/rtf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.oasis.opendocument.text",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
]);

/** Which icon a file gets, by its MIME type. */
export function fileIcon(mime: string): FileIcon {
  const m = baseMime(mime);
  if (m.startsWith("image/")) return "image";
  if (m === "application/pdf") return "pdf";
  if (m.startsWith("audio/")) return "audio";
  if (m.startsWith("video/")) return "video";
  if (ARCHIVES.has(m)) return "archive";
  if (m.startsWith("text/") || TEXTS.has(m)) return "text";
  return "file";
}

/** A chip's size label: the human size, or "" when unknown. */
export function sizeLabel(file: Pick<FileView, "size">): string {
  return file.size === undefined ? "" : humanSize(file.size);
}

/** Server error text of a JSON `{ error }` body, else undefined. */
export function errorOf(body: unknown): string | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const error = (body as { error?: unknown }).error;
  return typeof error === "string" && error !== "" ? error : undefined;
}
