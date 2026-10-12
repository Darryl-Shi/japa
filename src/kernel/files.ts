/** File helpers shared by inbound attachments and outbound `send_file`: sizes, MIME types and extensions. */

/** `bytes` for people: `512 B`, `1.5 KB`, `20 MB`, `1.2 GB` (1024-based, one decimal under 10). */
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

/** Extension (lower case, no dot) → MIME type. */
const BY_EXTENSION: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  svg: "image/svg+xml",
  heic: "image/heic",
  tif: "image/tiff",
  tiff: "image/tiff",
  ico: "image/x-icon",
  pdf: "application/pdf",
  ogg: "audio/ogg",
  oga: "audio/ogg",
  opus: "audio/ogg",
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  aac: "audio/aac",
  flac: "audio/flac",
  wav: "audio/wav",
  mp4: "video/mp4",
  m4v: "video/mp4",
  mov: "video/quicktime",
  webm: "video/webm",
  mkv: "video/x-matroska",
  avi: "video/x-msvideo",
  txt: "text/plain",
  md: "text/markdown",
  csv: "text/csv",
  tsv: "text/tab-separated-values",
  html: "text/html",
  htm: "text/html",
  css: "text/css",
  js: "text/javascript",
  json: "application/json",
  xml: "application/xml",
  yaml: "application/yaml",
  yml: "application/yaml",
  zip: "application/zip",
  gz: "application/gzip",
  tgz: "application/gzip",
  tar: "application/x-tar",
  "7z": "application/x-7z-compressed",
  rar: "application/vnd.rar",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  odt: "application/vnd.oasis.opendocument.text",
  ods: "application/vnd.oasis.opendocument.spreadsheet",
  rtf: "application/rtf",
  epub: "application/epub+zip",
  ics: "text/calendar",
  vcf: "text/vcard",
};

/** MIME type → the extension a nameless file of that type is saved with. */
const BY_MIME: Record<string, string> = {
  "image/jpeg": "jpg",
  "audio/mpeg": "mp3",
  "audio/mp4": "m4a",
  "audio/x-m4a": "m4a",
  "audio/m4a": "m4a",
  "text/plain": "txt",
  "text/markdown": "md",
  "application/gzip": "gz",
  "video/quicktime": "mov",
};
for (const [ext, mime] of Object.entries(BY_EXTENSION)) BY_MIME[mime] ??= ext;

/** The MIME type guessed from `name`'s extension; `application/octet-stream` when unknown. */
export function mimeFromName(name: string): string {
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return "application/octet-stream";
  return BY_EXTENSION[name.slice(dot + 1).toLowerCase()] ?? "application/octet-stream";
}

/** The extension (no dot) for a nameless file of `mimeType`; `bin` when unknown. */
export function extensionOf(mimeType: string): string {
  return BY_MIME[mimeType.split(";")[0]!.trim().toLowerCase()] ?? "bin";
}
