// Files on the japa host: downloads and attachments saved under `<home>/attachments/google/<date>/`, and the files
// the user asks to upload or attach.
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { GoogleError } from "./api.ts";

const TYPES: Record<string, string> = {
  txt: "text/plain",
  md: "text/markdown",
  csv: "text/csv",
  tsv: "text/tab-separated-values",
  html: "text/html",
  htm: "text/html",
  css: "text/css",
  ics: "text/calendar",
  vcf: "text/vcard",
  json: "application/json",
  xml: "application/xml",
  js: "text/javascript",
  pdf: "application/pdf",
  rtf: "application/rtf",
  zip: "application/zip",
  gz: "application/gzip",
  tar: "application/x-tar",
  "7z": "application/x-7z-compressed",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  odt: "application/vnd.oasis.opendocument.text",
  ods: "application/vnd.oasis.opendocument.spreadsheet",
  odp: "application/vnd.oasis.opendocument.presentation",
  epub: "application/epub+zip",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  heic: "image/heic",
  bmp: "image/bmp",
  tif: "image/tiff",
  tiff: "image/tiff",
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  wav: "audio/wav",
  ogg: "audio/ogg",
  mp4: "video/mp4",
  mov: "video/quicktime",
  webm: "video/webm",
};

/** The content type of a file by its extension; application/octet-stream when unknown. */
export function mimeType(name: string): string {
  return TYPES[extname(name).slice(1).toLowerCase()] ?? "application/octet-stream";
}

/** Today's local date as YYYY-MM-DD. */
const today = () => {
  const now = new Date();
  return [now.getFullYear(), now.getMonth() + 1, now.getDate()].map((n) => String(n).padStart(2, "0")).join("-");
};

/** A name from Google (an attachment's, a file's) as a single path segment in the folder. */
const safeName = (name: string) => {
  const cleaned = name.replace(/[/\\\0-\x1f\x7f]/g, "_").trim();
  return cleaned === "" || cleaned === "." || cleaned === ".." ? "file" : cleaned;
};

/** Saves `data` as `<home>/attachments/google/<date>/<name>`, as `name (1).ext` and so on if taken; its path. */
export function saveFile(home: string, name: string, data: Buffer, date = today()): string {
  const dir = join(home, "attachments", "google", date);
  mkdirSync(dir, { recursive: true });
  const file = safeName(name);
  const ext = extname(file);
  const stem = file.slice(0, file.length - ext.length);
  for (let n = 0; ; n++) {
    const path = join(dir, n === 0 ? file : `${stem} (${n})${ext}`);
    try {
      writeFileSync(path, data, { flag: "wx" }); // never clobbers, even against a concurrent save
      return path;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
}

/** A file on the japa host to upload or attach: its name, content type and bytes. */
export function readUpload(path: string): { name: string; type: string; data: Buffer } {
  let file;
  try {
    file = statSync(path);
  } catch {
    throw new GoogleError(`No such file: ${path}`);
  }
  if (!file.isFile()) throw new GoogleError(`Not a file: ${path}`);
  const name = basename(path);
  return { name, type: mimeType(name), data: readFileSync(path) };
}
