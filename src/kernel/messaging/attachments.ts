import type { UserInput } from "@earendil-works/pi-durable";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, normalize, sep } from "node:path";
import { getDocumentProxy, extractText } from "unpdf";
import type { AttachedFile, IncomingFile } from "../contracts.ts";
import { extensionOf, humanSize, mimeFromName } from "../files.ts";
import { message } from "../loader.ts";

/** How long a PDF's text extraction may take before it is given up. */
export const PDF_TIMEOUT_MS = 30_000;
/** The longest sanitised original name a file is saved under (its extension kept). */
export const MAX_NAME_CHARS = 120;

/** MIME types that say nothing about the content: a `.pdf` name with one of these is taken as a PDF. */
const GENERIC = new Set(["", "application/octet-stream", "binary/octet-stream", "application/x-pdf", "application/unknown"]);

/** The image types models take inline; other images are saved and noted only. */
const INLINE_IMAGES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

/** A message to convert: its id (used in the saved file names), text and files. */
export type InputMessage = { id: string; text?: string; files?: IncomingFile[] };

/**
 * `name` made safe as a file name: its basename only, without control characters or leading dots, capped at
 * `MAX_NAME_CHARS` (keeping a short extension); `""` when nothing is left.
 */
export function sanitiseName(name: string): string {
  const base = name.split(/[/\\]/).at(-1) ?? "";
  const clean = base.replace(/[\u0000-\u001f\u007f-\u009f]/g, "").trim().replace(/^\.+/, "").trim();
  if (clean.length <= MAX_NAME_CHARS) return clean;
  const dot = clean.lastIndexOf(".");
  const ext = dot > 0 && clean.length - dot <= 16 ? clean.slice(dot) : "";
  return clean.slice(0, MAX_NAME_CHARS - ext.length) + ext;
}

const baseMime = (mimeType: string) => mimeType.split(";")[0]!.trim().toLowerCase();

/** Whether `file` is a PDF: `application/pdf`, or a `.pdf` name with a generic MIME type. */
function isPdf(file: IncomingFile): boolean {
  const mime = baseMime(file.mimeType);
  if (mime === "application/pdf") return true;
  return file.name !== undefined && /\.pdf$/i.test(file.name.trim()) && GENERIC.has(mime);
}

/** Writes `data` to `dir/<file>`, never overwriting: a taken name gets `-2`, `-3`… before its extension. */
function saveNew(dir: string, file: string, data: Uint8Array): string {
  mkdirSync(dir, { recursive: true });
  const dot = file.lastIndexOf(".");
  const [stem, ext] = dot > 0 ? [file.slice(0, dot), file.slice(dot)] : [file, ""];
  for (let n = 1; ; n++) {
    const path = join(dir, n === 1 ? file : `${stem}-${n}${ext}`);
    try {
      writeFileSync(path, data, { flag: "wx" });
      return path;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
}

/** The text of the PDF `data` and its page count, extracted in-process; rejects after `timeoutMs`. */
export async function pdfText(data: Uint8Array, timeoutMs = PDF_TIMEOUT_MS): Promise<{ pages: number; text: string }> {
  let pdf: Awaited<ReturnType<typeof getDocumentProxy>> | undefined;
  const work = (async () => {
    pdf = await getDocumentProxy(new Uint8Array(data), { verbosity: 0 }); // a copy: pdf.js may detach the buffer
    const { totalPages, text } = await extractText(pdf, { mergePages: true });
    return { pages: totalPages, text };
  })();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${Math.round(timeoutMs / 1000)} s`)), timeoutMs);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
    void work.catch(() => {}).finally(() => pdf?.loadingTask.destroy().catch(() => {}));
  }
}

/** The lines inlined after a saved PDF's note: its text (the first `inlineChars` characters), or why there is none. */
async function pdfLines(path: string, data: Uint8Array, inlineChars: number, timeoutMs: number): Promise<string[]> {
  let extracted: { pages: number; text: string };
  try {
    extracted = await pdfText(data, timeoutMs);
  } catch (error) {
    return [`[PDF text could not be extracted: ${message(error)}]`];
  }
  const text = extracted.text.trim();
  if (text === "") return ["[PDF has no extractable text]"];
  const txt = `${path}.txt`;
  let unsaved: string | undefined;
  try {
    writeFileSync(txt, text);
  } catch (error) {
    unsaved = message(error);
  }
  const lines = [`[PDF text, ${extracted.pages} pages]`, text.slice(0, Math.max(0, inlineChars))];
  if (text.length > inlineChars) {
    lines.push(unsaved === undefined ? `[Truncated; full text at ${txt}]` : `[Truncated; full text could not be saved: ${unsaved}]`);
  }
  return lines;
}

/**
 * The CoS input for `messages`, merged: their texts, then a note per file. Each file is saved (never overwriting) to
 * `<home>/attachments/<date>/<id>-<sanitised name>`, or `<id>[-<n>].<ext>` without a name; a PDF's text is extracted
 * (bounded by `timeoutMs`), written next to it as `<path>.txt` and its first `inlineChars` characters inlined. Saved
 * images are sent along as image parts when the model has `vision`, else a note says it cannot see them.
 */
export async function inputOf(
  home: string,
  messages: InputMessage[],
  vision: boolean,
  inlineChars: number,
  timeoutMs = PDF_TIMEOUT_MS,
): Promise<UserInput> {
  const texts = messages.flatMap((m) => (m.text === undefined ? [] : [m.text]));
  const files = messages.flatMap((m) =>
    (m.files ?? []).map((file, i) => {
      const name = file.name === undefined ? "" : sanitiseName(file.name);
      const saveAs =
        name === "" ? `${i === 0 ? m.id : `${m.id}-${i + 1}`}.${extensionOf(file.mimeType)}` : `${m.id}-${name}`;
      return { file, saveAs };
    }),
  );
  if (files.length === 0) return texts.join("\n\n");
  const dir = join(home, "attachments", new Date().toISOString().slice(0, 10));
  const images: IncomingFile[] = [];
  const lines: string[] = [];
  for (const { file, saveAs } of files) {
    let path: string;
    try {
      path = saveNew(dir, saveAs, file.data);
    } catch (error) {
      lines.push(`[file could not be saved: ${message(error)}]`);
      continue;
    }
    if (baseMime(file.mimeType).startsWith("image/")) {
      if (INLINE_IMAGES.has(baseMime(file.mimeType))) images.push(file);
      lines.push(`[image saved to ${path}]`);
      continue;
    }
    lines.push(`[file saved to ${path} (${file.mimeType || "application/octet-stream"}, ${humanSize(file.data.length)})]`);
    if (isPdf(file)) lines.push(...(await pdfLines(path, file.data, inlineChars, timeoutMs)));
  }
  const text = [...(texts.length > 0 ? [texts.join("\n\n")] : []), ...lines].join("\n");
  const noted = files.some(({ file }) => baseMime(file.mimeType).startsWith("image/"));
  if (!vision && noted) return `${text}\n(this model cannot see images)`;
  if (!vision || images.length === 0) return text;
  const parts = images.map((image) => ({
    type: "image" as const,
    data: Buffer.from(image.data).toString("base64"),
    mimeType: image.mimeType,
  }));
  return [{ type: "text", text }, ...parts];
}

const NO_VISION = "(this model cannot see images)";
const SIZE_UNITS = ["B", "KB", "MB", "GB", "TB"];
const FILE_NOTE = /^\[file saved to (.+) \((.*), (\d+(?:\.\d+)?) (B|KB|MB|GB|TB)\)\]$/;
const IMAGE_NOTE = /^\[image saved to (.+)\]$/;
const FAILED = /^\[file could not be saved: .*\]$/;
const PDF_TEXT = /^\[PDF text, \d+ pages\]$/;
const PDF_NONE = /^(?:\[PDF has no extractable text\]|\[PDF text could not be extracted: .*\])$/;
const TRUNCATED = /^\[Truncated; .*\]$/;

type Item = { file: AttachedFile } | { failed: string };

/**
 * The original name of the file saved at `path` (see `inputOf`): without the `<message id>-` prefix and a `-<n>`
 * collision suffix (stripped only when the unsuffixed sibling exists); an unnamed file (`<id>[-<i>].<ext>`) keeps its
 * saved name.
 */
function originalName(path: string, messageId: string | undefined, exists: (path: string) => boolean): string {
  const file = basename(path);
  let prefix: string;
  if (messageId !== undefined && messageId !== "" && file.startsWith(`${messageId}-`)) prefix = `${messageId}-`;
  else if (messageId !== undefined && messageId !== "" && file.startsWith(`${messageId}.`)) return file;
  else {
    const dash = file.indexOf("-");
    if (dash <= 0) return file;
    prefix = file.slice(0, dash + 1);
  }
  const rest = file.slice(prefix.length);
  if (/^\d+(?:-\d+)?\.[^.]+$/.test(rest)) return file; // unnamed: `<id>-<i>.<ext>`, maybe with a collision suffix
  const dot = file.lastIndexOf(".");
  const [stem, ext] = dot > 0 ? [file.slice(0, dot), file.slice(dot)] : [file, ""];
  const collision = /^(.*)-([1-9]\d*)$/.exec(stem);
  if (collision && Number(collision[2]) >= 2 && collision[1]!.length > prefix.length) {
    if (exists(join(dirname(path), collision[1]! + ext))) return collision[1]!.slice(prefix.length) + ext;
  }
  return rest;
}

/**
 * Parses `lines` as a whole note block (see `inputOf`): notes, each file's optional PDF text tail and failed-save lines,
 * then an optional no-vision line; `undefined` when they aren't one.
 */
function noteBlock(lines: string[], parseItem: (line: string) => Item | undefined): Item[] | undefined {
  const items: Item[] = [];
  let i = 0;
  const end = lines.length - (lines.at(-1) === NO_VISION ? 1 : 0);
  while (i < end) {
    const item = parseItem(lines[i]!);
    if (item === undefined) return undefined;
    items.push(item);
    i++;
    if (!("file" in item) || i >= end) continue;
    if (PDF_NONE.test(lines[i]!)) i++;
    else if (PDF_TEXT.test(lines[i]!)) {
      i++;
      while (i < end && parseItem(lines[i]!) === undefined && !TRUNCATED.test(lines[i]!)) i++;
      if (i < end && TRUNCATED.test(lines[i]!)) i++;
    }
  }
  return items;
}

/**
 * The inverse of `inputOf`'s notes: the typed text of an input's `text` and the files the kernel saved for it (under
 * `<home>/attachments/`). Notes are recognised only in the trailing note block and only with a path inside the
 * attachments dir; a failed save's line stays in the text, inlined PDF text and the no-vision line are dropped. Names
 * lose the `<messageId>-` prefix (or, without it, everything up to the first `-`) and a collision suffix.
 */
export function parseNotes(
  home: string,
  text: string,
  messageId?: string,
  exists: (path: string) => boolean = existsSync,
): { text: string; files: AttachedFile[] } {
  const root = join(home, "attachments") + sep;
  const inside = (path: string) => isAbsolute(path) && normalize(path) === path && path.startsWith(root);
  const parseItem = (line: string): Item | undefined => {
    if (FAILED.test(line)) return { failed: line };
    const note = FILE_NOTE.exec(line);
    if (note && inside(note[1]!)) {
      const [, path, mimeType, amount, unit] = note as unknown as [string, string, string, string, string];
      const size = Math.round(Number(amount) * 1024 ** SIZE_UNITS.indexOf(unit));
      return { file: { path, name: originalName(path, messageId, exists), mimeType, size } };
    }
    const image = IMAGE_NOTE.exec(line);
    if (image && inside(image[1]!)) {
      const path = image[1]!;
      return { file: { path, name: originalName(path, messageId, exists), mimeType: mimeFromName(path) } };
    }
    return undefined;
  };
  const lines = text.split("\n");
  for (let k = 0; k < lines.length; k++) {
    if (parseItem(lines[k]!) === undefined) continue;
    const items = noteBlock(lines.slice(k), parseItem);
    if (items === undefined) continue;
    const typed = lines.slice(0, k).join("\n");
    const failed = items.flatMap((item) => ("failed" in item ? [item.failed] : []));
    return {
      text: [...(typed === "" ? [] : [typed]), ...failed].join("\n"),
      files: items.flatMap((item) => ("file" in item ? [item.file] : [])),
    };
  }
  return { text, files: [] };
}
