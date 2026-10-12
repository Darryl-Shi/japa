import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, relative } from "node:path";
import { expect, onTestFinished, test } from "vitest";
import { MAX_SEND_BYTES, sendFile } from "../src/kernel/send-file.ts";

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "japa-send-file-"));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

async function send(path: string, caption?: string) {
  const args = caption === undefined ? { path } : { path, caption };
  const result = await sendFile.execute(args, {} as never, ctx);
  const text = (result.content ?? []).map((p) => (p.type === "text" ? p.text : "")).join("");
  return { text, details: result.details };
}

test("a file is recorded in the details, with its name, MIME type, size and caption; nothing is sent", async () => {
  const dir = scratch();
  const path = join(dir, "Report.PDF");
  writeFileSync(path, "x".repeat(2048));
  expect(await send(path, "The **report**")).toEqual({
    text: "Sending Report.PDF (2 KB).",
    details: { file: { path, name: "Report.PDF", mimeType: "application/pdf", size: 2048, caption: "The **report**" } },
  });
  const plain = join(dir, "notes");
  writeFileSync(plain, "n");
  expect(await send(plain)).toEqual({
    text: "Sending notes (1 B).",
    details: { file: { path: plain, name: "notes", mimeType: "application/octet-stream", size: 1 } },
  });
});

test("the path is resolved: ~/ is the user's home, and dot segments go", async () => {
  const dir = mkdtempSync(join(homedir(), ".japa-send-file-"));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, "a.png"), "png");
  const tilde = `~/${relative(homedir(), dir)}/a.png`;
  const { text, details } = await send(tilde);
  expect(text).toBe("Sending a.png (3 B).");
  expect(details).toEqual({ file: { path: join(dir, "a.png"), name: "a.png", mimeType: "image/png", size: 3 } });
  expect((await send(`${dir}/sub/../a.png`)).details).toEqual(details);
});

test("a relative path is refused", async () => {
  const { text, details } = await send("outbox/a.png");
  expect(text).toBe("The path must be absolute or start with ~/: outbox/a.png.");
  expect(details).toBeUndefined();
  expect((await send("~a.png")).details).toBeUndefined();
});

test("a missing file, a directory, an unreadable or too large file is refused", async () => {
  const dir = scratch();
  const gone = join(dir, "gone.txt");
  expect(await send(gone)).toEqual({ text: `No file at ${gone}.`, details: undefined });
  mkdirSync(join(dir, "folder"));
  expect(await send(join(dir, "folder"))).toEqual({ text: `Not a file: ${join(dir, "folder")}.`, details: undefined });

  const big = join(dir, "big.bin");
  writeFileSync(big, "");
  truncateSync(big, MAX_SEND_BYTES + 1); // sparse
  expect(MAX_SEND_BYTES).toBe(50 * 1024 * 1024);
  expect(await send(big)).toEqual({ text: `Too large: ${MAX_SEND_BYTES + 1} bytes (max 50 MB).`, details: undefined });
  truncateSync(big, 60 * 1024 * 1024);
  expect((await send(big)).text).toBe("Too large: 60 MB (max 50 MB).");
  truncateSync(big, MAX_SEND_BYTES);
  expect((await send(big)).details).toMatchObject({ file: { size: MAX_SEND_BYTES } });

  if (process.getuid?.() !== 0) {
    const locked = join(dir, "locked.txt");
    writeFileSync(locked, "secret");
    chmodSync(locked, 0o000);
    const { text, details } = await send(locked);
    expect(text).toMatch(/EACCES/);
    expect(details).toBeUndefined();
  }
});
