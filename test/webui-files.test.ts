import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, expect, test } from "vitest";
import { MAX_FILES, MAX_FILES_BYTES } from "../extensions/webui/app/src/lib/protocol.ts";
import { sessionCookie } from "../extensions/webui/auth.ts";
import { contentDisposition, type FilesMessage, MAX_SUBMIT_BODY } from "../extensions/webui/files.ts";
import { DEFAULT_CSP, type Handler, type PipelineDeps, pipeline } from "../extensions/webui/server.ts";
import type { FileRef } from "../extensions/webui/transcript.ts";
import { hashPassword, newStamp, type WebuiUser } from "../extensions/webui/users.ts";

const KEY = randomBytes(32).toString("base64url");
let alice: WebuiUser;
let server: Server | undefined;

beforeAll(async () => {
  alice = { name: "alice", createdAt: new Date().toISOString(), password: await hashPassword("pw-alice"), stamp: newStamp() };
});

afterEach(async () => {
  server?.closeAllConnections();
  await new Promise((resolve) => server?.close(resolve) ?? resolve(undefined));
  server = undefined;
});

/** The pipeline over a fake app, with `deps`; its base URL, a session cookie and what the app and submit saw. */
async function serve(deps: Partial<PipelineDeps> = {}) {
  const seen = { app: [] as string[], submitted: [] as FilesMessage[] };
  const handler: Handler = (req, res) => {
    seen.app.push(`${req.method} ${req.url}`);
    res.end("app");
  };
  server = createServer(
    pipeline({
      bind: "127.0.0.1",
      users: async () => ({ ok: true, users: [alice] }),
      sessionKey: async () => KEY,
      handler,
      submitFiles: async (m) => void seen.submitted.push(m),
      ...deps,
    }),
  );
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const cookie = sessionCookie(KEY, alice, Date.now()).split(";")[0]!;
  return { base: `http://127.0.0.1:${port}`, port, cookie, seen };
}

/** A home with an attachments dir holding `report.pdf`, and files elsewhere; the table naming them. */
function home() {
  const dir = mkdtempSync(join(tmpdir(), "japa-webui-files-"));
  const day = join(dir, "attachments", "2025-01-01");
  mkdirSync(day, { recursive: true });
  const outbox = join(dir, "outbox");
  mkdirSync(outbox);
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
  writeFileSync(join(day, "m1-report.pdf"), "%PDF-1.4 fake");
  writeFileSync(join(outbox, "chart.png"), png);
  writeFileSync(join(outbox, "page.html"), "<script>alert(1)</script>");
  writeFileSync(join(outbox, "logo.svg"), "<svg/>");
  writeFileSync(join(dir, "secret.txt"), "secret");
  symlinkSync(join(dir, "secret.txt"), join(day, "m2-link.txt"));
  const table = new Map<string, FileRef>([
    ["1-0", { path: join(day, "m1-report.pdf"), name: "report.pdf", mimeType: "application/pdf", upload: true }],
    ["2-0", { path: join(outbox, "chart.png"), name: "chart.png", mimeType: "image/png", upload: false }],
    ["3-0", { path: join(outbox, "page.html"), name: "page.html", mimeType: "text/html", upload: false }],
    ["4-0", { path: join(outbox, "logo.svg"), name: "logo.svg", mimeType: "image/svg+xml", upload: false }],
    ["5-0", { path: join(dir, "secret.txt"), name: "secret.txt", mimeType: "text/plain", upload: true }],
    ["6-0", { path: join(day, "m2-link.txt"), name: "link.txt", mimeType: "text/plain", upload: true }],
    ["7-0", { path: join(outbox, "gone.csv"), name: "gone.csv", mimeType: "text/csv", upload: false }],
    ["8-0", { path: join(day, "m3-gone.pdf"), name: "gone.pdf", mimeType: "application/pdf", upload: true }],
    ["9-0", { path: join(outbox, "chart.png"), name: "Ünïcode \"résumé\"\\ 'x'.png", mimeType: "image/png", upload: false }],
  ]);
  return { dir, png, table, file: (id: string) => table.get(id) };
}

test("GET /api/files/<id> needs a session, and resolves only ids in the table", async () => {
  const h = home();
  const { base, cookie, seen } = await serve({ file: h.file, home: h.dir });
  const none = await fetch(`${base}/api/files/2-0`);
  expect(none.status).toBe(401);
  expect(await none.json()).toEqual({ error: "Not signed in" });
  for (const id of ["nope", "2-1", "..%2F2-0", "2-0%2Fx"]) {
    const res = await fetch(`${base}/api/files/${id}`, { headers: { cookie } });
    expect(res.status, id).toBe(404);
    expect(await res.json()).toEqual({ error: "Not found" });
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  }
  expect(seen.app).toEqual([]);
  // Without a table, nothing is served.
  server?.close();
  const bare = await serve({ home: h.dir });
  expect((await fetch(`${bare.base}/api/files/2-0`, { headers: { cookie: bare.cookie } })).status).toBe(404);
});

test("raster images and PDFs are inline with their type; ?download=1 makes them attachments", async () => {
  const h = home();
  const { base, cookie } = await serve({ file: h.file, home: h.dir });
  const png = await fetch(`${base}/api/files/2-0`, { headers: { cookie } });
  expect(png.status).toBe(200);
  expect(Buffer.from(await png.arrayBuffer())).toEqual(h.png);
  expect(Object.fromEntries(["content-type", "content-length", "content-disposition", "cache-control", "x-content-type-options", "content-security-policy"].map((n) => [n, png.headers.get(n)]))).toEqual({
    "content-type": "image/png",
    "content-length": String(h.png.length),
    "content-disposition": `inline; filename="chart.png"; filename*=UTF-8''chart.png`,
    "cache-control": "private",
    "x-content-type-options": "nosniff",
    "content-security-policy": DEFAULT_CSP,
  });
  const pdf = await fetch(`${base}/api/files/1-0`, { headers: { cookie } });
  expect(pdf.headers.get("content-type")).toBe("application/pdf");
  expect(pdf.headers.get("content-disposition")).toMatch(/^inline; filename="report.pdf"/);
  expect(await pdf.text()).toBe("%PDF-1.4 fake");
  const forced = await fetch(`${base}/api/files/2-0?download=1`, { headers: { cookie } });
  expect(forced.headers.get("content-type")).toBe("image/png");
  expect(forced.headers.get("content-disposition")).toMatch(/^attachment; filename="chart.png"/);
});

test("HTML, SVG and any other type are octet-stream attachments, nosniff, with the default CSP", async () => {
  const h = home();
  const { base, cookie } = await serve({ file: h.file, home: h.dir });
  for (const [id, name] of [["3-0", "page.html"], ["4-0", "logo.svg"]]) {
    const res = await fetch(`${base}/api/files/${id}`, { headers: { cookie } });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/octet-stream");
    expect(res.headers.get("content-disposition")).toBe(`attachment; filename="${name}"; filename*=UTF-8''${name}`);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-security-policy")).toBe(DEFAULT_CSP);
    expect(res.headers.get("cache-control")).toBe("private");
  }
});

test("an upload must resolve inside <home>/attachments; a missing file says so by name", async () => {
  const h = home();
  const { base, cookie } = await serve({ file: h.file, home: h.dir });
  for (const id of ["5-0", "6-0"]) {
    const res = await fetch(`${base}/api/files/${id}`, { headers: { cookie } });
    expect(res.status, id).toBe(404);
    expect(await res.json()).toEqual({ error: "Not found" });
  }
  for (const [id, name] of [["7-0", "gone.csv"], ["8-0", "gone.pdf"]]) {
    const res = await fetch(`${base}/api/files/${id}`, { headers: { cookie } });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: `${name} no longer exists on japa's host` });
  }
  // Deleted after it was listed: read at request time.
  rmSync(join(h.dir, "outbox", "chart.png"));
  const gone = await fetch(`${base}/api/files/2-0`, { headers: { cookie } });
  expect(await gone.json()).toEqual({ error: "chart.png no longer exists on japa's host" });
});

test("names are encoded per RFC 5987 with an ASCII fallback", async () => {
  expect(contentDisposition("attachment", "a b.txt")).toBe(`attachment; filename="a b.txt"; filename*=UTF-8''a%20b.txt`);
  expect(contentDisposition("inline", "\u0001\n日本.pdf")).toBe(`inline; filename=".pdf"; filename*=UTF-8''%01%0A%E6%97%A5%E6%9C%AC.pdf`);
  expect(contentDisposition("attachment", "日本")).toBe(`attachment; filename="download"; filename*=UTF-8''%E6%97%A5%E6%9C%AC`);
  const h = home();
  const { base, cookie } = await serve({ file: h.file, home: h.dir });
  const res = await fetch(`${base}/api/files/9-0`, { headers: { cookie } });
  expect(res.headers.get("content-disposition")).toBe(
    `inline; filename="ncode rsum 'x'.png"; filename*=UTF-8''%C3%9Cn%C3%AFcode%20%22r%C3%A9sum%C3%A9%22%5C%20%27x%27.png`,
  );
});

test("HEAD gives the headers and no body", async () => {
  const h = home();
  const { port, cookie } = await serve({ file: h.file, home: h.dir });
  const res = await new Promise<{ status: number; headers: Record<string, unknown>; body: string }>((resolve, reject) => {
    request({ port, host: "127.0.0.1", path: "/api/files/2-0", method: "HEAD", headers: { cookie } }, (r) => {
      let body = "";
      r.on("data", (c) => (body += c));
      r.on("end", () => resolve({ status: r.statusCode!, headers: r.headers, body }));
    })
      .on("error", reject)
      .end();
  });
  expect(res.status).toBe(200);
  expect(res.headers["content-length"]).toBe(String(h.png.length));
  expect(res.headers["content-type"]).toBe("image/png");
  expect(res.body).toBe("");
});

test("POST to /api/files is refused", async () => {
  const h = home();
  const { base, cookie } = await serve({ file: h.file, home: h.dir });
  const res = await fetch(`${base}/api/files/2-0`, { method: "POST", headers: { cookie, origin: base } });
  expect(res.status).toBe(405);
});

// ---- multipart submit ----

const newId = () => `id-${randomBytes(8).toString("hex")}`;

function message(fields: Record<string, string>, files: { name: string; type?: string; data: Uint8Array<ArrayBuffer> | string }[] = []) {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  for (const f of files) form.append("file", new Blob([f.data], f.type === undefined ? {} : { type: f.type }), f.name);
  return form;
}

const post = (base: string, cookie: string, body: FormData | string, headers: Record<string, string> = {}) =>
  fetch(`${base}/api/submit`, { method: "POST", headers: { cookie, origin: base, ...headers }, body });

test("a multipart submit hands its text, mode, id and files to submitFiles", async () => {
  const { base, cookie, seen } = await serve();
  const id = newId();
  const res = await post(
    base,
    cookie,
    message({ text: "summarise this", mode: "followUp", id }, [
      { name: "report.pdf", type: "application/pdf", data: "%PDF" },
      { name: "notes", data: new Uint8Array([1, 2, 3]) },
    ]),
  );
  expect(res.status).toBe(204);
  expect(seen.app).toEqual([]);
  expect(seen.submitted).toHaveLength(1);
  const [m] = seen.submitted;
  expect({ ...m, files: undefined }).toEqual({ id, text: "summarise this", mode: "followUp", files: undefined });
  expect(m!.files.map((f) => ({ ...f, data: Buffer.from(f.data).toString("hex") }))).toEqual([
    { name: "report.pdf", mimeType: "application/pdf", data: Buffer.from("%PDF").toString("hex") },
    { name: "notes", mimeType: "application/octet-stream", data: "010203" },
  ]);
  // Files only, no text.
  expect((await post(base, cookie, message({ mode: "steer", id: newId() }, [{ name: "a.png", type: "image/png", data: "x" }]))).status).toBe(204);
  expect(seen.submitted[1]).toMatchObject({ text: "", mode: "steer" });
});

test("a retried id is accepted again without a second submission, even while the first is in flight", async () => {
  let calls = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const { base, cookie } = await serve({
    submitFiles: async () => {
      calls++;
      await gate;
    },
  });
  const id = newId();
  const body = () => message({ text: "x", mode: "followUp", id }, [{ name: "a.txt", data: "a" }]);
  const first = post(base, cookie, body());
  const second = post(base, cookie, body());
  await new Promise((resolve) => setTimeout(resolve, 100));
  release();
  expect([(await first).status, (await second).status]).toEqual([204, 204]);
  expect((await post(base, cookie, body())).status).toBe(204);
  expect(calls).toBe(1);
});

test("a failed submit is 409 with its message, and a retry tries again", async () => {
  let calls = 0;
  const { base, cookie } = await serve({
    submitFiles: async () => {
      if (++calls === 1) throw new Error("The CoS isn't running");
    },
  });
  const id = newId();
  const body = () => message({ text: "x", mode: "followUp", id }, [{ name: "a.txt", data: "a" }]);
  const res = await post(base, cookie, body());
  expect(res.status).toBe(409);
  expect(await res.json()).toEqual({ error: "The CoS isn't running" });
  expect((await post(base, cookie, body())).status).toBe(204);
  expect(calls).toBe(2);
});

test("invalid multipart messages are 400", async () => {
  const { base, cookie, seen } = await serve();
  const files = Array.from({ length: MAX_FILES + 1 }, (_, i) => ({ name: `f${i}.txt`, data: "x" }));
  const cases: [FormData | string, string, Record<string, string>?][] = [
    [message({ text: "x", mode: "followUp", id: newId() }, files), `Too many files (max ${MAX_FILES})`],
    [message({ text: "x", mode: "later", id: newId() }), 'mode must be "steer" or "followUp"'],
    [message({ text: "x", mode: "followUp", id: "short" }), "Invalid message id"],
    [message({ text: "x", mode: "followUp" }), "Invalid message id"],
    [message({ text: "  ", mode: "followUp", id: newId() }), "Message is empty"],
    [message({ text: "x".repeat(100_001), mode: "followUp", id: newId() }), "Message is too long (max 100000 characters)"],
    ["--b\r\nnot a part", "Malformed multipart body", { "content-type": "multipart/form-data; boundary=b" }],
    ["whatever", "Malformed multipart body", { "content-type": "multipart/form-data" }],
  ];
  for (const [body, error, headers] of cases) {
    const res = await post(base, cookie, body, headers);
    expect(res.status, error).toBe(400);
    expect(await res.json()).toEqual({ error });
  }
  const textPart = message({ text: "x", mode: "followUp", id: newId(), file: "not a file" });
  expect((await post(base, cookie, textPart)).status).toBe(400);
  expect(seen.submitted).toEqual([]);
  expect(seen.app).toEqual([]);
});

test("a multipart submit needs a session and the same Origin", async () => {
  const { base, cookie, seen } = await serve();
  const body = () => message({ text: "x", mode: "followUp", id: newId() });
  expect((await fetch(`${base}/api/submit`, { method: "POST", headers: { origin: base }, body: body() })).status).toBe(401);
  expect((await fetch(`${base}/api/submit`, { method: "POST", headers: { cookie }, body: body() })).status).toBe(403);
  expect(seen.submitted).toEqual([]);
});

/** A raw POST to /api/submit on `port`: writes `head` then up to `total` bytes in chunks, until the response. */
function rawPost(port: number, cookie: string, headers: Record<string, string>, total: number) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = request(
      { port, host: "127.0.0.1", path: "/api/submit", method: "POST", headers: { cookie, origin: `http://127.0.0.1:${port}`, ...headers } },
      (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve({ status: res.statusCode!, body }));
        res.on("error", () => resolve({ status: res.statusCode!, body }));
      },
    );
    let done = false;
    req.on("response", () => (done = true));
    req.on("error", (e) => (done ? undefined : reject(e)));
    const chunk = Buffer.alloc(256 * 1024, 0x61);
    let sent = 0;
    const pump = () => {
      while (!done && sent < total) {
        sent += chunk.length;
        if (!req.write(chunk)) return void req.once("drain", pump);
      }
      if (!done) req.end();
    };
    if (total === 0) req.flushHeaders();
    else pump();
  });
}

test("a Content-Length over the cap is 413 at once; nothing is submitted", async () => {
  const { port, cookie, seen } = await serve();
  const res = await rawPost(
    port,
    cookie,
    { "content-type": "multipart/form-data; boundary=b", "content-length": String(MAX_SUBMIT_BODY + 1) },
    0,
  );
  expect(res.status).toBe(413);
  expect(JSON.parse(res.body).error).toMatch(/^Too large/);
  expect(seen.submitted).toEqual([]);
});

test("a chunked body over the cap is 413; nothing is submitted", async () => {
  const { port, cookie, seen } = await serve({ maxSubmitBytes: 1024 * 1024 });
  const res = await rawPost(port, cookie, { "content-type": "multipart/form-data; boundary=b" }, 64 * 1024 * 1024);
  expect(res.status).toBe(413);
  expect(seen.submitted).toEqual([]);
});

test("files over the total cap are 413", async () => {
  const { base, cookie, seen } = await serve({ maxSubmitBytes: MAX_SUBMIT_BODY });
  const big = new Uint8Array(MAX_FILES_BYTES / 2 + 1);
  const res = await post(base, cookie, message({ text: "x", mode: "followUp", id: newId() }, [
    { name: "a.bin", data: big },
    { name: "b.bin", data: big },
  ]));
  expect(res.status).toBe(413);
  expect(seen.submitted).toEqual([]);
});

test("a JSON submit still goes to the app", async () => {
  const { base, cookie, seen } = await serve();
  const res = await post(base, cookie, JSON.stringify({ text: "hi", mode: "followUp", id: newId() }), {
    "content-type": "application/json",
  });
  expect(await res.text()).toBe("app");
  expect(seen.app).toEqual(["POST /api/submit"]);
  expect(seen.submitted).toEqual([]);
});
