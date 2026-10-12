import type { UserInput } from "@earendil-works/pi-durable";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getDocumentProxy, extractText } from "unpdf";
import type { IncomingFile } from "../contracts.ts";
import { extensionOf, humanSize } from "../files.ts";
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
