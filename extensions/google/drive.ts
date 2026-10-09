// The `drive` tool: search, read files as text, download and upload, folders, moving, renaming, sharing and trashing
// (spec §4.4).
import { StringEnum, type Static } from "@earendil-works/pi-ai";
import { extname } from "node:path";
import { Type } from "../../src/sdk.ts";
import { type Api, GoogleError } from "./api.ts";
import { readUpload, saveFile } from "./files.ts";

const BASE = "https://www.googleapis.com/drive/v3/files";
const UPLOAD = "https://www.googleapis.com/upload/drive/v3/files";

const GOOGLE = "application/vnd.google-apps.";
const DOC = `${GOOGLE}document`;
const SHEET = `${GOOGLE}spreadsheet`;
const SLIDES = `${GOOGLE}presentation`;
const FOLDER = `${GOOGLE}folder`;

export const DRIVE_ACTIONS = [
  "search",
  "read",
  "download",
  "upload",
  "create_folder",
  "move",
  "rename",
  "share",
  "trash",
] as const;

export const driveParameters = Type.Object({
  action: StringEnum(DRIVE_ACTIONS),
  query: Type.Optional(Type.String({ description: "plain words, or Drive query syntax" })),
  max: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, description: "results (default 10)" })),
  id: Type.Optional(Type.String({ description: "file or folder id" })),
  path: Type.Optional(Type.String({ description: "file path on the japa host" })),
  folder: Type.Optional(Type.String({ description: "folder id" })),
  name: Type.Optional(Type.String()),
  convert: Type.Optional(Type.Boolean({ description: "upload as a Google Doc, Sheet or Slides" })),
  email: Type.Optional(Type.String()),
  role: Type.Optional(StringEnum(["reader", "commenter", "writer"] as const)),
});

export type DriveArgs = Static<typeof driveParameters>;

export const DRIVE_DESCRIPTION = [
  "The user's Google Drive. Actions:",
  "search { query, max? = 10 } — plain words search file contents; Drive query syntax (name contains 'x', " +
    "'<folder id>' in parents, mimeType = '…') passes through; names, types and ids",
  "read { id } — a file as text: Docs as markdown, Sheets as CSV (first sheet), Slides as plain text, text files " +
    "as they are; anything else is saved to a file",
  "download { id } — saves the file and returns its path (Google Docs, Sheets and Slides as PDF)",
  "upload { path, folder?, name?, convert? } — path is a file on the japa host; convert makes docx/txt/md a Doc, " +
    "xlsx/csv a Sheet, pptx Slides",
  "create_folder { name, folder? }",
  "move { id, folder }",
  "rename { id, name }",
  "share { id, email, role } — role is reader, commenter or writer; Google emails them",
  "trash { id }",
  "Ids come from earlier search results; folder is a folder's id.",
].join("\n");

type File = { id: string; name: string; mimeType: string; modifiedTime?: string; webViewLink?: string };

const path = (...segments: string[]) => [BASE, ...segments.map(encodeURIComponent)].join("/");

const SHORT: Record<string, string> = {
  document: "doc",
  spreadsheet: "sheet",
  presentation: "slides",
  folder: "folder",
  form: "form",
  drawing: "drawing",
};

const isGoogle = (type: string) => type.startsWith(GOOGLE);
const shortType = (type: string) => (isGoogle(type) ? SHORT[type.slice(GOOGLE.length)] : undefined) ?? type;

const FIELD = "name|fullText|mimeType|modifiedTime|createdTime|viewedByMeTime|trashed|starred|sharedWithMe|" +
  "properties|appProperties|visibility";
/** A field compared ("name contains 'x'", "starred = true") or a membership ("'id' in parents"). */
const TERM = new RegExp(`\\b(${FIELD})\\s*(contains|=|!=|<=|>=|<|>)|'[^']*'\\s+in\\s+(parents|owners|writers|readers)`);
/** Nothing but boolean fields joined by and/or/not: "sharedWithMe or starred". */
const FLAGS = /^\s*(not\s+)?(trashed|starred|sharedWithMe)(\s+(and|or)\s+(not\s+)?(trashed|starred|sharedWithMe))*\s*$/;

/** Drive's own query syntax, as opposed to plain words to look for (which may well contain "and" or "in"). */
const isDriveQuery = (query: string) => TERM.test(query) || FLAGS.test(query);

/** The exported text format of the Google types `read` can show. */
const EXPORTS: Record<string, string> = { [DOC]: "text/markdown", [SHEET]: "text/csv", [SLIDES]: "text/plain" };

const isText = (type: string) => /^text\//i.test(type) || /[/+](json|xml)$/i.test(type);

/** The Google type `upload` converts a file to, by its extension. */
const CONVERT: Record<string, string> = {
  docx: DOC,
  txt: DOC,
  md: DOC,
  xlsx: SHEET,
  csv: SHEET,
  pptx: SLIDES,
};

/** "<name> (id <id>) <link>", the link when Drive gives one. */
const named = (file: Partial<File>) => [`${file.name} (id ${file.id})`, file.webViewLink].filter(Boolean).join(" ");

async function search(api: Api, args: DriveArgs): Promise<string> {
  if (!args.query) throw new GoogleError("search needs query");
  const query = args.query;
  const q = isDriveQuery(query)
    ? `(${query}) and trashed = false`
    : `fullText contains '${query.replace(/[\\']/g, "\\$&")}' and trashed = false`;
  const found = await api.json<{ files?: File[] }>("GET", BASE, {
    query: { q, fields: "files(id,name,mimeType,modifiedTime,webViewLink)", pageSize: args.max ?? 10 },
  });
  const files = found?.files ?? [];
  if (files.length === 0) return "No files.";
  return files
    .map((f, i) => {
      const line = `${i + 1}. ${f.name} (${shortType(f.mimeType)}) — modified ${(f.modifiedTime ?? "").slice(0, 10)}`;
      return `${line}\n   id ${f.id}${f.webViewLink ? ` ${f.webViewLink}` : ""}`;
    })
    .join("\n");
}

const metadata = (api: Api, id: string) =>
  api.json<File>("GET", path(id), { query: { fields: "id,name,mimeType,size" } });

/** Saves a file: Google types exported as PDF, anything else as it is. Its path. */
async function save(api: Api, home: string, file: File): Promise<string> {
  if (isGoogle(file.mimeType)) {
    const { data } = await api.bytes(path(file.id, "export"), { mimeType: "application/pdf" });
    return saveFile(home, `${file.name}.pdf`, data);
  }
  const { data } = await api.bytes(path(file.id), { alt: "media" });
  return saveFile(home, file.name, data);
}

async function read(api: Api, home: string, id: string | undefined): Promise<string> {
  if (!id) throw new GoogleError("read needs id");
  const file = await metadata(api, id);
  const as = EXPORTS[file.mimeType];
  if (as) return (await api.bytes(path(id, "export"), { mimeType: as })).data.toString("utf8");
  if (isGoogle(file.mimeType)) return `Can't read ${shortType(file.mimeType)}; use download.`;
  if (isText(file.mimeType)) return (await api.bytes(path(id), { alt: "media" })).data.toString("utf8");
  return `Not text; saved to ${await save(api, home, file)}`;
}

async function download(api: Api, home: string, id: string | undefined): Promise<string> {
  if (!id) throw new GoogleError("download needs id");
  return `Saved to ${await save(api, home, await metadata(api, id))}`;
}

async function upload(api: Api, args: DriveArgs): Promise<string> {
  if (!args.path) throw new GoogleError("upload needs path");
  const file = readUpload(args.path);
  const target = args.convert ? CONVERT[extname(file.name).slice(1).toLowerCase()] : undefined;
  const meta = {
    name: args.name ?? file.name,
    ...(args.folder ? { parents: [args.folder] } : {}),
    ...(target ? { mimeType: target } : {}),
  };
  const done = await api.upload(UPLOAD, meta, file.data, file.type, {
    uploadType: "multipart",
    fields: "id,name,webViewLink",
  });
  return `Uploaded ${named(done)}`;
}

async function createFolder(api: Api, args: DriveArgs): Promise<string> {
  if (!args.name) throw new GoogleError("create_folder needs name");
  const body = { name: args.name, mimeType: FOLDER, ...(args.folder ? { parents: [args.folder] } : {}) };
  const made = await api.json<File>("POST", BASE, { query: { fields: "id,name,webViewLink" }, body });
  return `Created folder ${named(made)}`;
}

async function move(api: Api, args: DriveArgs): Promise<string> {
  const { id, folder } = args;
  if (!id || !folder) throw new GoogleError("move needs id and folder");
  const found = await api.json<{ parents?: string[] }>("GET", path(id), { query: { fields: "parents" } });
  // A file shared with the user may have no parent the user can see: then there is nothing to remove.
  const parents = found?.parents ?? [];
  const removeParents = parents.length > 0 ? parents.join(",") : undefined;
  await api.json("PATCH", path(id), { query: { addParents: folder, removeParents, fields: "id,parents" }, body: {} });
  return `Moved ${id} to folder ${folder}.`;
}

async function rename(api: Api, args: DriveArgs): Promise<string> {
  const { id, name } = args;
  if (!id || !name) throw new GoogleError("rename needs id and name");
  await api.json("PATCH", path(id), { body: { name } });
  return `Renamed ${id} to ${name}.`;
}

async function share(api: Api, args: DriveArgs): Promise<string> {
  const { id, email, role } = args;
  if (!id || !email || !role) throw new GoogleError("share needs id, email and role");
  // Google's default notification email is left on: the person learns it was shared.
  await api.json("POST", path(id, "permissions"), { body: { type: "user", role, emailAddress: email } });
  return `Shared ${id} with ${email} as ${role}.`;
}

async function trash(api: Api, id: string | undefined): Promise<string> {
  if (!id) throw new GoogleError("trash needs id");
  await api.json("PATCH", path(id), { body: { trashed: true } });
  return `Trashed ${id}.`;
}

/** Runs one drive action; throws GoogleError with the reply for a request it can't make. */
export async function drive(api: Api, home: string, args: DriveArgs): Promise<string> {
  switch (args.action) {
    case "search":
      return search(api, args);
    case "read":
      return read(api, home, args.id);
    case "download":
      return download(api, home, args.id);
    case "upload":
      return upload(api, args);
    case "create_folder":
      return createFolder(api, args);
    case "move":
      return move(api, args);
    case "rename":
      return rename(api, args);
    case "share":
      return share(api, args);
    case "trash":
      return trash(api, args.id);
    default:
      throw new GoogleError(`Unknown action: ${String(args.action)}`);
  }
}
