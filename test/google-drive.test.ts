import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { type Api, GoogleError } from "../extensions/google/api.ts";
import { DRIVE_ACTIONS, DRIVE_DESCRIPTION, drive, driveParameters } from "../extensions/google/drive.ts";
import { schemaProblems } from "../src/kernel/tool-schema.ts";

const BASE = "https://www.googleapis.com/drive/v3/files";
const UPLOAD = "https://www.googleapis.com/upload/drive/v3/files";

type Call = [string, string, unknown];
type Route = unknown | ((opts: any) => unknown);

const rel = (url: string) => (url === BASE ? "files" : url.replace(BASE + "/", "files/"));

/**
 * An Api answering from `routes`, keyed "METHOD path" for json, "BYTES path" for downloads and "UPLOAD" for uploads
 * (paths relative to the Drive base, as "files/…"); it records every call.
 */
function fake(routes: Record<string, Route>) {
  const calls: Call[] = [];
  const answer = (key: string, opts: unknown) => {
    if (!(key in routes)) throw new Error(`unexpected request: ${key}`);
    const route = routes[key];
    if (route instanceof Error) throw route;
    return typeof route === "function" ? route(opts) : route;
  };
  const api = {
    json: async (method: string, url: string, opts?: unknown) => {
      calls.push([method, rel(url), opts]);
      return answer(`${method} ${rel(url)}`, opts);
    },
    bytes: async (url: string, query?: unknown) => {
      calls.push(["BYTES", rel(url), query]);
      return answer(`BYTES ${rel(url)}`, query);
    },
    upload: async (url: string, metadata: object, data: Buffer, type: string, query?: unknown) => {
      expect(url).toBe(UPLOAD);
      const opts = { metadata, data: data.toString("utf8"), type, query };
      calls.push(["UPLOAD", "upload", opts]);
      return answer("UPLOAD", opts);
    },
    raw: async () => {
      throw new Error("unexpected raw");
    },
  } as unknown as Api;
  return { api, calls };
}

const home = () => mkdtempSync(join(tmpdir(), "japa-drive-"));
const bytes = (data: string | Buffer, type = "application/octet-stream") => ({ data: Buffer.from(data), type });

test("the parameters are a portable schema with every action", () => {
  expect(schemaProblems(driveParameters)).toEqual([]);
  expect(DRIVE_ACTIONS).toEqual([
    "search",
    "read",
    "download",
    "upload",
    "create_folder",
    "move",
    "rename",
    "share",
    "trash",
  ]);
  for (const action of DRIVE_ACTIONS) expect(DRIVE_DESCRIPTION).toContain(action);
});

const FIELDS = "files(id,name,mimeType,modifiedTime,webViewLink)";

test("search: plain words become a fullText query; lines carry name, short type, date, id and link", async () => {
  const { api, calls } = fake({
    "GET files": {
      files: [
        {
          id: "d1",
          name: "Budget",
          mimeType: "application/vnd.google-apps.spreadsheet",
          modifiedTime: "2026-10-01T12:00:00.000Z",
          webViewLink: "https://docs.google.com/spreadsheets/d/d1",
        },
        {
          id: "d2",
          name: "Notes",
          mimeType: "application/vnd.google-apps.document",
          modifiedTime: "2026-09-30T08:00:00.000Z",
          webViewLink: "https://docs.google.com/document/d/d2",
        },
        {
          id: "d3",
          name: "scan.pdf",
          mimeType: "application/pdf",
          modifiedTime: "2026-09-29T08:00:00.000Z",
          webViewLink: "https://drive.google.com/file/d/d3",
        },
      ],
    },
  });
  const out = await drive(api, home(), { action: "search", query: "budget 2026", max: 3 });
  expect(calls).toEqual([
    [
      "GET",
      "files",
      { query: { q: "fullText contains 'budget 2026' and trashed = false", fields: FIELDS, pageSize: 3 } },
    ],
  ]);
  expect(out).toBe(
    "1. Budget (sheet) — modified 2026-10-01\n   id d1 https://docs.google.com/spreadsheets/d/d1\n" +
      "2. Notes (doc) — modified 2026-09-30\n   id d2 https://docs.google.com/document/d/d2\n" +
      "3. scan.pdf (application/pdf) — modified 2026-09-29\n   id d3 https://drive.google.com/file/d/d3",
  );
});

test("search escapes backslashes and quotes in plain words and defaults to 10 results", async () => {
  const { api, calls } = fake({ "GET files": { files: [] } });
  expect(await drive(api, home(), { action: "search", query: "Bob's c:\\temp" })).toBe("No files.");
  expect(calls).toEqual([
    [
      "GET",
      "files",
      { query: { q: "fullText contains 'Bob\\'s c:\\\\temp' and trashed = false", fields: FIELDS, pageSize: 10 } },
    ],
  ]);
});

test("search: plain words with and, or, in or = are still words", async () => {
  const queries = ["Dana and Joe contract", "notes from the offsite in Lisbon", "budget or forecast", "x=1 notes"];
  for (const query of queries) {
    const { api, calls } = fake({ "GET files": {} });
    expect(await drive(api, home(), { action: "search", query })).toBe("No files.");
    expect((calls[0]![2] as { query: { q: string } }).query.q).toBe(`fullText contains '${query}' and trashed = false`);
  }
});

test("search passes Drive q syntax through, wrapped, and still excludes trashed files", async () => {
  const queries = [
    "name contains 'plan'",
    "mimeType = 'application/vnd.google-apps.folder'",
    "'f1' in parents",
    "starred and modifiedTime > '2026-01-01'",
    "sharedWithMe or starred",
    "fullText contains 'x' and not trashed",
    "'me' in owners",
    "viewedByMeTime >= '2026-01-01T00:00:00'",
  ];
  for (const query of queries) {
    const { api, calls } = fake({ "GET files": {} });
    expect(await drive(api, home(), { action: "search", query })).toBe("No files.");
    expect((calls[0]![2] as { query: { q: string } }).query.q).toBe(`(${query}) and trashed = false`);
  }
});

test("search short types: slides, folder, form, drawing", async () => {
  const file = (id: string, kind: string) => ({
    id,
    name: id,
    mimeType: `application/vnd.google-apps.${kind}`,
    modifiedTime: "2026-10-01T00:00:00Z",
    webViewLink: `https://x/${id}`,
  });
  const { api } = fake({
    "GET files": { files: ["presentation", "folder", "form", "drawing", "map"].map((k, i) => file(`f${i}`, k)) },
  });
  const out = await drive(api, home(), { action: "search", query: "x" });
  expect(out.split("\n").filter((line) => !line.startsWith("   "))).toEqual([
    "1. f0 (slides) — modified 2026-10-01",
    "2. f1 (folder) — modified 2026-10-01",
    "3. f2 (form) — modified 2026-10-01",
    "4. f3 (drawing) — modified 2026-10-01",
    "5. f4 (application/vnd.google-apps.map) — modified 2026-10-01",
  ]);
});

test("search needs a query", async () => {
  const { api } = fake({});
  await expect(drive(api, home(), { action: "search" })).rejects.toThrow(new GoogleError("search needs query"));
});

const META = { query: { fields: "id,name,mimeType,size" } };
const meta = (id: string, name: string, mimeType: string) => ({ id, name, mimeType });

test("read exports each Google type in its text format", async () => {
  const cases = [
    ["application/vnd.google-apps.document", "text/markdown", "# Title\n\nBody"],
    ["application/vnd.google-apps.spreadsheet", "text/csv", "a,b\n1,2"],
    ["application/vnd.google-apps.presentation", "text/plain", "Slide one"],
  ];
  for (const [type, exportType, text] of cases) {
    const { api, calls } = fake({
      "GET files/g%2F1": meta("g/1", "Thing", type!),
      "BYTES files/g%2F1/export": bytes(text!, exportType),
    });
    expect(await drive(api, home(), { action: "read", id: "g/1" })).toBe(text);
    expect(calls).toEqual([
      ["GET", "files/g%2F1", META],
      ["BYTES", "files/g%2F1/export", { mimeType: exportType }],
    ]);
  }
});

test("read refuses other Google types", async () => {
  const { api, calls } = fake({ "GET files/f1": meta("f1", "Survey", "application/vnd.google-apps.form") });
  expect(await drive(api, home(), { action: "read", id: "f1" })).toBe("Can't read form; use download.");
  expect(calls).toHaveLength(1);
});

test("read returns text, JSON and XML files as text", async () => {
  for (const type of ["text/plain", "text/markdown", "application/json", "application/xml"]) {
    const { api, calls } = fake({
      "GET files/t1": meta("t1", "file", type),
      "BYTES files/t1": bytes("café", type),
    });
    expect(await drive(api, home(), { action: "read", id: "t1" })).toBe("café");
    expect(calls[1]).toEqual(["BYTES", "files/t1", { alt: "media" }]);
  }
});

test("read saves anything else to a file", async () => {
  const dir = home();
  const { api, calls } = fake({
    "GET files/p1": meta("p1", "photo.png", "image/png"),
    "BYTES files/p1": bytes(Buffer.from([137, 80, 78, 71]), "image/png"),
  });
  const out = await drive(api, dir, { action: "read", id: "p1" });
  expect(calls[1]).toEqual(["BYTES", "files/p1", { alt: "media" }]);
  expect(out).toMatch(/^Not text; saved to .*\/attachments\/google\/\d{4}-\d{2}-\d{2}\/photo\.png$/);
  const path = out.replace(/^Not text; saved to /, "");
  expect(path.startsWith(dir)).toBe(true);
  expect([...readFileSync(path)]).toEqual([137, 80, 78, 71]);
});

test("read needs an id", async () => {
  const { api } = fake({});
  await expect(drive(api, home(), { action: "read" })).rejects.toThrow(new GoogleError("read needs id"));
});

test("download exports a Google file as PDF named <name>.pdf", async () => {
  const dir = home();
  const { api, calls } = fake({
    "GET files/d1": meta("d1", "Notes", "application/vnd.google-apps.document"),
    "BYTES files/d1/export": bytes("%PDF-1.7", "application/pdf"),
  });
  const out = await drive(api, dir, { action: "download", id: "d1" });
  expect(calls).toEqual([
    ["GET", "files/d1", META],
    ["BYTES", "files/d1/export", { mimeType: "application/pdf" }],
  ]);
  expect(out).toMatch(/^Saved to .*\/attachments\/google\/\d{4}-\d{2}-\d{2}\/Notes\.pdf$/);
  expect(readFileSync(out.replace(/^Saved to /, ""), "utf8")).toBe("%PDF-1.7");
});

test("download saves other files as they are, suffixing a taken name", async () => {
  const dir = home();
  const { api, calls } = fake({
    "GET files/z1": meta("z1", "report.pdf", "application/pdf"),
    "BYTES files/z1": bytes("one"),
  });
  const first = await drive(api, dir, { action: "download", id: "z1" });
  const second = await drive(api, dir, { action: "download", id: "z1" });
  expect(calls[1]).toEqual(["BYTES", "files/z1", { alt: "media" }]);
  expect(first).toMatch(/^Saved to .*\/attachments\/google\/\d{4}-\d{2}-\d{2}\/report\.pdf$/);
  expect(second).toMatch(/\/report \(1\)\.pdf$/);
});

test("download needs an id", async () => {
  const { api } = fake({});
  await expect(drive(api, home(), { action: "download" })).rejects.toThrow(new GoogleError("download needs id"));
});

const UPLOADED = { id: "u1", name: "notes.txt", webViewLink: "https://drive.google.com/file/d/u1" };
const UPLOAD_QUERY = { uploadType: "multipart", fields: "id,name,webViewLink" };

test("upload sends the file with its name and type", async () => {
  const dir = home();
  const file = join(dir, "notes.txt");
  writeFileSync(file, "hello");
  const { api, calls } = fake({ UPLOAD: UPLOADED });
  const out = await drive(api, dir, { action: "upload", path: file });
  expect(out).toBe("Uploaded notes.txt (id u1) https://drive.google.com/file/d/u1");
  expect(calls).toEqual([
    ["UPLOAD", "upload", { metadata: { name: "notes.txt" }, data: "hello", type: "text/plain", query: UPLOAD_QUERY }],
  ]);
});

test("upload into a folder under another name", async () => {
  const dir = home();
  const file = join(dir, "notes.txt");
  writeFileSync(file, "hello");
  const { api, calls } = fake({ UPLOAD: { ...UPLOADED, name: "Renamed.txt" } });
  const out = await drive(api, dir, { action: "upload", path: file, folder: "f1", name: "Renamed.txt" });
  expect(out).toBe("Uploaded Renamed.txt (id u1) https://drive.google.com/file/d/u1");
  expect((calls[0]![2] as { metadata: object }).metadata).toEqual({ name: "Renamed.txt", parents: ["f1"] });
});

test("upload with convert sets the Google type by extension", async () => {
  const dir = home();
  const cases: [string, string | undefined][] = [
    ["a.docx", "application/vnd.google-apps.document"],
    ["a.txt", "application/vnd.google-apps.document"],
    ["a.md", "application/vnd.google-apps.document"],
    ["a.xlsx", "application/vnd.google-apps.spreadsheet"],
    ["a.CSV", "application/vnd.google-apps.spreadsheet"],
    ["a.pptx", "application/vnd.google-apps.presentation"],
    ["a.pdf", undefined],
  ];
  for (const [name, target] of cases) {
    const file = join(dir, name);
    writeFileSync(file, "x");
    const { api, calls } = fake({ UPLOAD: { id: "u", name } });
    await drive(api, dir, { action: "upload", path: file, convert: true });
    const metadata = (calls[0]![2] as { metadata: object }).metadata;
    expect(metadata).toEqual(target ? { name, mimeType: target } : { name });
  }
});

test("upload without convert leaves the type alone", async () => {
  const dir = home();
  const file = join(dir, "sheet.csv");
  writeFileSync(file, "a,b");
  const { api, calls } = fake({ UPLOAD: { id: "u", name: "sheet.csv" } });
  expect(await drive(api, dir, { action: "upload", path: file })).toBe("Uploaded sheet.csv (id u)");
  expect(calls[0]![2]).toEqual({ metadata: { name: "sheet.csv" }, data: "a,b", type: "text/csv", query: UPLOAD_QUERY });
});

test("upload needs a path that exists", async () => {
  const { api, calls } = fake({});
  await expect(drive(api, home(), { action: "upload" })).rejects.toThrow(new GoogleError("upload needs path"));
  await expect(drive(api, home(), { action: "upload", path: "/no/such/file" })).rejects.toThrow(
    new GoogleError("No such file: /no/such/file"),
  );
  expect(calls).toEqual([]);
});

test("create_folder creates a folder, inside another when given", async () => {
  const { api, calls } = fake({ "POST files": { id: "f9", name: "Taxes", webViewLink: "https://x/f9" } });
  expect(await drive(api, home(), { action: "create_folder", name: "Taxes", folder: "f1" })).toBe(
    "Created folder Taxes (id f9) https://x/f9",
  );
  expect(calls).toEqual([
    [
      "POST",
      "files",
      {
        query: { fields: "id,name,webViewLink" },
        body: { name: "Taxes", mimeType: "application/vnd.google-apps.folder", parents: ["f1"] },
      },
    ],
  ]);
});

test("create_folder at the top level; needs a name", async () => {
  const { api, calls } = fake({ "POST files": { id: "f9", name: "Taxes" } });
  expect(await drive(api, home(), { action: "create_folder", name: "Taxes" })).toBe("Created folder Taxes (id f9)");
  expect((calls[0]![2] as { body: object }).body).toEqual({
    name: "Taxes",
    mimeType: "application/vnd.google-apps.folder",
  });
  await expect(drive(api, home(), { action: "create_folder" })).rejects.toThrow(
    new GoogleError("create_folder needs name"),
  );
});

test("move adds the new folder and removes the old ones", async () => {
  const { api, calls } = fake({
    "GET files/x1": { parents: ["p1", "p2"] },
    "PATCH files/x1": { id: "x1", parents: ["f2"] },
  });
  expect(await drive(api, home(), { action: "move", id: "x1", folder: "f2" })).toBe("Moved x1 to folder f2.");
  expect(calls).toEqual([
    ["GET", "files/x1", { query: { fields: "parents" } }],
    ["PATCH", "files/x1", { query: { addParents: "f2", removeParents: "p1,p2", fields: "id,parents" }, body: {} }],
  ]);
});

test("move of a file with no parents only adds; needs id and folder", async () => {
  const { api, calls } = fake({ "GET files/x1": {}, "PATCH files/x1": { id: "x1" } });
  await drive(api, home(), { action: "move", id: "x1", folder: "f2" });
  expect((calls[1]![2] as { query: object }).query).toEqual({
    addParents: "f2",
    removeParents: undefined,
    fields: "id,parents",
  });
  await expect(drive(api, home(), { action: "move", id: "x1" })).rejects.toThrow(
    new GoogleError("move needs id and folder"),
  );
});

test("rename patches the name", async () => {
  const { api, calls } = fake({ "PATCH files/x1": { id: "x1", name: "New" } });
  expect(await drive(api, home(), { action: "rename", id: "x1", name: "New" })).toBe("Renamed x1 to New.");
  expect(calls).toEqual([["PATCH", "files/x1", { body: { name: "New" } }]]);
  await expect(drive(api, home(), { action: "rename", id: "x1" })).rejects.toThrow(
    new GoogleError("rename needs id and name"),
  );
});

test("share adds a user permission with the role", async () => {
  const { api, calls } = fake({ "POST files/x1/permissions": { id: "perm1" } });
  const out = await drive(api, home(), { action: "share", id: "x1", email: "ann@x.com", role: "commenter" });
  expect(out).toBe("Shared x1 with ann@x.com as commenter.");
  expect(calls).toEqual([
    ["POST", "files/x1/permissions", { body: { type: "user", role: "commenter", emailAddress: "ann@x.com" } }],
  ]);
  await expect(drive(api, home(), { action: "share", id: "x1", email: "ann@x.com" })).rejects.toThrow(
    new GoogleError("share needs id, email and role"),
  );
});

test("trash moves the file to the trash", async () => {
  const { api, calls } = fake({ "PATCH files/x1": { id: "x1", trashed: true } });
  expect(await drive(api, home(), { action: "trash", id: "x1" })).toBe("Trashed x1.");
  expect(calls).toEqual([["PATCH", "files/x1", { body: { trashed: true } }]]);
  await expect(drive(api, home(), { action: "trash" })).rejects.toThrow(new GoogleError("trash needs id"));
});

test("a 404 from Drive is passed on", async () => {
  const { api } = fake({ "GET files/gone": new GoogleError("Not found: gone") });
  await expect(drive(api, home(), { action: "read", id: "gone" })).rejects.toThrow("Not found: gone");
});
