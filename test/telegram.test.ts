import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { backoff } from "../extensions/telegram/api.ts";
import { toHtml, toPlain, visibleLength } from "../extensions/telegram/html.ts";
import telegram from "../extensions/telegram/index.ts";
import type { Dispose, Incoming, MessagingAdapter } from "../src/kernel/contracts.ts";
import { SecretRequestsDoc } from "../src/kernel/secret-requests.ts";
import { bootErrors, bootTest, waitFor } from "./helpers.ts";
import { texts } from "./jobs-helpers.ts";
import { sleep } from "./messaging-helpers.ts";
import { fakeBotApi, kernelStub, startTelegram } from "./telegram-helpers.ts";

let fake: Awaited<ReturnType<typeof fakeBotApi>>;
let stop: Dispose | undefined;

beforeEach(async () => {
  fake = await fakeBotApi();
});

afterEach(async () => {
  await stop?.();
  stop = undefined;
  await fake.close();
});

const connect = async (stub = kernelStub("T")) => {
  const telegram = await startTelegram(stub);
  stop = telegram.stop;
  return telegram.adapter;
};
/** Starts the adapter with `stub`; what it receives. */
const listen = async (stub = kernelStub("T"), receive?: (m: Incoming) => Promise<void>) => {
  const telegram = await startTelegram(stub, receive);
  stop = telegram.stop;
  return telegram.received;
};
const params = (method: string) => fake.calls.filter((c) => c.method === method).map((c) => c.params);
const sends = () => params("sendMessage");
const offsets = () => params("getUpdates").map((p) => p.offset);

test.each([
  ["**bold**, *it* and ~~gone~~", "<b>bold</b>, <i>it</i> and <s>gone</s>"],
  ["a < b & c > d", "a &lt; b &amp; c &gt; d"],
  ["use `x<y`", "use <code>x&lt;y</code>"],
  ["```ts\nif (a < b) {}\n```", '<pre><code class="language-ts">if (a &lt; b) {}</code></pre>'],
  ["[site](https://e.com/?a=1&b=2)", '<a href="https://e.com/?a=1&amp;b=2">site</a>'],
  ['[x](https://a"b)', '<a href="https://a&quot;b">x</a>'],
  ["> quoted\n> more", "<blockquote>quoted\nmore</blockquote>"],
  ["# Title", "<b>Title</b>"],
  ["snake_case_name stays", "snake_case_name stays"],
  ["***both***", "<b><i>both</i></b>"],
  ["**bold _nested_ here**", "<b>bold <i>nested</i> here</b>"],
  ["a **lone star", "a **lone star"],
  ["```\nunclosed", "<pre>unclosed</pre>"],
  ["- a\n  - b\n- c", "• a\n  • b\n• c"],
  ["1. a\n2. b", "1. a\n2. b"],
  ["- [ ] todo\n- [x] done", "☐ todo\n☑ done"],
  ["| a | bb |\n|---|---|\n| 1 | <2> |", "<pre>a | bb\n───────\n1 | &lt;2&gt;</pre>"],
  ["<script>x</script>", "&lt;script&gt;x&lt;/script&gt;"],
  ["||secret||", "<tg-spoiler>secret</tg-spoiler>"],
  ["![cat](https://e.com/c.png)", '<a href="https://e.com/c.png">cat</a>'],
  ["---", "———"],
  ["**`code`**", "<b>code</b>"],
  ["## `config.json`", "<b>config.json</b>"],
  ["[`code`](https://e.com)", '<a href="https://e.com">code</a>'],
  ["||`code`||", "<tg-spoiler>code</tg-spoiler>"],
  ["> a\n> > b", "<blockquote>a\n\nb</blockquote>"],
  ["> `c`\n>\n> ```\n> x\n> ```", "<blockquote>c\n\nx</blockquote>"],
])("toHtml(%j)", (md, html) => {
  const out = toHtml(md);
  expect(out).toBe(html);
  expect(balanced(out)).toBe(true);
  expect(telegramNesting(out)).toBe(true);
});

/** Whether every tag `html` opens is closed, in LIFO order, and nothing is closed that isn't open. */
function balanced(html: string): boolean {
  const open: string[] = [];
  for (const [, close, name] of html.matchAll(/<(\/?)([a-z-]+)[^>]*>/g)) {
    if (!close) open.push(name!);
    else if (open.pop() !== name) return false;
  }
  return open.length === 0;
}

/**
 * Whether `html` keeps Telegram's nesting rules: code and pre inside no other tag (but pre>code), nothing inside code
 * or pre (but that pair), and no blockquote inside a blockquote.
 */
function telegramNesting(html: string): boolean {
  const open: string[] = [];
  for (const [, close, name] of html.matchAll(/<(\/?)([a-z-]+)[^>]*>/g)) {
    if (close) {
      open.pop();
      continue;
    }
    const top = open.at(-1);
    const preCode = name === "code" && top === "pre" && open.length === 1;
    if ((name === "code" || name === "pre") && open.length > 0 && !preCode) return false;
    if ((top === "code" || top === "pre") && !preCode) return false;
    if (name === "blockquote" && open.includes("blockquote")) return false;
    open.push(name!);
  }
  return true;
}

test("telegramNesting rejects code inside tags, tags inside code, and nested blockquotes", () =>
  expect(
    [
      "<b><code>x</code></b>",
      "<code><b>x</b></code>",
      "<blockquote><pre>x</pre></blockquote>",
      "<blockquote><blockquote>x</blockquote></blockquote>",
      '<pre><code class="language-ts">x</code></pre>',
      "<blockquote><b><i>x</i></b></blockquote> <code>y</code>",
    ].map(telegramNesting),
  ).toEqual([false, false, false, false, true, true]));

test("balanced rejects misnested and unclosed tags", () =>
  expect(["<b><i>x</b></i>", "<b>x", "x</i>", "<b><i>x</i></b>"].map(balanced)).toEqual([false, false, false, true]));

test("a blockquote over 10 lines is expandable", () =>
  expect(toHtml(Array.from({ length: 11 }, (_, i) => `> ${i}`).join("\n"))).toMatch(/^<blockquote expandable>/));

test("a blockquote of 10 lines is not expandable", () =>
  expect(toHtml(Array.from({ length: 10 }, (_, i) => `> ${i}`).join("\n"))).toMatch(/^<blockquote>/));

test("toPlain drops markers and keeps link targets", () =>
  expect(toPlain("**a** [b](https://e.com) `c`")).toBe("a b (https://e.com) c"));

test("visibleLength counts text without tags, with entities decoded", () =>
  expect(visibleLength('<a href="x">a &amp; b</a> &lt;&gt;&quot;')).toBe(9));

test("backoff starts at 1 s and doubles to 60 s", () =>
  expect([0, 1, 2, 5, 6, 9].map(backoff)).toEqual([1000, 2000, 4000, 32000, 60000, 60000]));

test("send posts HTML with an inline keyboard and returns the message id", async () => {
  const adapter = await connect();
  expect(await adapter.send("42", { markdown: "**hi**", buttons: [[{ label: "A", action: "1" }]] })).toBe("1");
  expect(sends()).toEqual([
    {
      chat_id: "42",
      text: "<b>hi</b>",
      parse_mode: "HTML",
      reply_markup: { inline_keyboard: [[{ text: "A", callback_data: "1" }]] },
    },
  ]);
  expect(fake.calls[0]!.token).toBe("T");
});

const unparsable = { ok: false, error_code: 400, description: "Bad Request: can't parse entities: x" };

test("HTML Telegram can't parse is resent as plain text without markers", async () => {
  const adapter = await connect();
  fake.fail("sendMessage", 400, unparsable, 1);
  await adapter.send("42", { markdown: "**hi**" });
  expect(sends().at(-1)).toEqual({ chat_id: "42", text: "hi" });
});

test("the plain-text fallback keeps force_reply and its placeholder", async () => {
  const adapter = await connect();
  fake.fail("sendMessage", 400, unparsable, 1);
  await adapter.send("42", { markdown: "**hi**", input: { placeholder: "Paste svc.token" } });
  expect(sends().at(-1)).toEqual({
    chat_id: "42",
    text: "hi",
    reply_markup: { force_reply: true, input_field_placeholder: "Paste svc.token" },
  });
});

test("a part whose rendered text is over 4096 characters is sent as two messages", async () => {
  const adapter = await connect();
  // Two 30-row tables with one long cell per column, in different rows, so each padded row is about twice its markdown.
  const rows = [`| ${"k".repeat(58)} | v |`, ...Array.from({ length: 29 }, (_, i) => `| ${i % 10} | ${"v".repeat(58)} |`)];
  const table = `| a | b |\n|---|---|\n${rows.join("\n")}`;
  const markdown = `${table}\n\n${table}`;
  expect(markdown.length).toBeLessThanOrEqual(4096);
  expect(visibleLength(toHtml(markdown))).toBeGreaterThan(4096);
  const buttons = [[{ label: "A", action: "1" }]];
  expect(await adapter.send("42", { markdown, buttons })).toBe("2");
  expect(sends()).toHaveLength(2);
  for (const s of sends()) expect(visibleLength(s.text)).toBeLessThanOrEqual(4096);
  expect(sends().map((s) => s.reply_markup)).toEqual([undefined, { inline_keyboard: [[{ text: "A", callback_data: "1" }]] }]);
});

test("without a token, sending fails", async () => {
  const adapter = await connect(kernelStub());
  await expect(adapter.send("42", { markdown: "x" })).rejects.toThrow("Telegram is not connected");
});

test("a button action over 64 bytes is rejected before sending", async () => {
  const adapter = await connect();
  const buttons = [[{ label: "A", action: "a".repeat(65) }]];
  await expect(adapter.send("42", { markdown: "x", buttons })).rejects.toThrow("over 64 bytes");
  expect(sends()).toEqual([]);
});

test("a message with input is sent with force_reply and a placeholder cut to 64 characters", async () => {
  const adapter = await connect();
  await adapter.send("42", { markdown: "x", input: { placeholder: `Paste ${"k".repeat(70)}` } });
  const markup = sends()[0]!.reply_markup;
  expect(markup.force_reply).toBe(true);
  expect([...markup.input_field_placeholder]).toHaveLength(64);
  expect(markup.input_field_placeholder.endsWith("…")).toBe(true);
});

test("a short placeholder is sent as it is", async () => {
  const adapter = await connect();
  await adapter.send("42", { markdown: "x", input: { placeholder: "Paste svc.token" } });
  expect(sends()[0]!.reply_markup).toEqual({ force_reply: true, input_field_placeholder: "Paste svc.token" });
});

test("input together with buttons is rejected before sending", async () => {
  const adapter = await connect();
  const m = { markdown: "x", input: { placeholder: "p" }, buttons: [[{ label: "A", action: "1" }]] };
  await expect(adapter.send("42", m)).rejects.toThrow("input and buttons");
  expect(sends()).toEqual([]);
});

test("an edit with input is rejected before calling Telegram", async () => {
  const adapter = await connect();
  await expect(adapter.edit("42", "7", { markdown: "x", input: { placeholder: "p" } })).rejects.toThrow(
    "An edit can't carry an input",
  );
  expect(params("editMessageText")).toEqual([]);
});

test("a 429 waits retry_after seconds; a 5xx waits 1 s", async () => {
  const adapter = await connect();
  const tooMany = { ok: false, error_code: 429, description: "Too Many Requests", parameters: { retry_after: 1 } };
  fake.fail("sendMessage", 429, tooMany, 1);
  fake.fail("deleteMessage", 502, { ok: false, error_code: 502, description: "Bad Gateway" }, 1);
  await Promise.all([adapter.send("42", { markdown: "x" }), adapter.delete("42", "7")]);
  for (const method of ["sendMessage", "deleteMessage"]) {
    const [first, second] = fake.calls.filter((c) => c.method === method).map((c) => c.at);
    expect(second! - first!).toBeGreaterThanOrEqual(1000);
  }
});

test("edit, delete and typing call their methods", async () => {
  const adapter = await connect();
  await adapter.edit("42", "7", { markdown: "*x*" });
  await adapter.delete("42", "7");
  await adapter.typing("42");
  expect(params("editMessageText")).toEqual([{ chat_id: "42", message_id: 7, text: "<i>x</i>", parse_mode: "HTML" }]);
  expect(params("deleteMessage")).toEqual([{ chat_id: "42", message_id: 7 }]);
  expect(params("sendChatAction")).toEqual([{ chat_id: "42", action: "typing" }]);
});

/** A file `name` of `mimeType` holding `bytes`, written to a fresh temp dir, as an `OutgoingFile`. */
const outgoing = (name: string, mimeType: string, bytes: Uint8Array = new Uint8Array([1, 2, 3]), caption?: string) => {
  const path = join(mkdtempSync(join(tmpdir(), "japa-telegram-")), name);
  writeFileSync(path, bytes);
  return { path, name, mimeType, size: bytes.byteLength, ...(caption === undefined ? {} : { caption }) };
};
const uploads = () => fake.calls.filter((c) => c.params.multipart);

test("the adapter takes files up to 50 MB", async () =>
  expect((await connect()).maxFileBytes).toBe(50 * 1024 * 1024));

test.each([
  ["image/jpeg", "a.jpg", "sendPhoto", "photo", "upload_photo"],
  ["image/png", "a.png", "sendPhoto", "photo", "upload_photo"],
  ["image/webp", "a.webp", "sendPhoto", "photo", "upload_photo"],
  ["audio/ogg", "v.ogg", "sendVoice", "voice", "upload_voice"],
  ["audio/mpeg", "s.mp3", "sendAudio", "audio", "upload_voice"],
  ["audio/mp4", "s.m4a", "sendAudio", "audio", "upload_voice"],
  ["audio/x-m4a", "s.m4a", "sendAudio", "audio", "upload_voice"],
  ["audio/aac", "s.aac", "sendAudio", "audio", "upload_voice"],
  ["audio/flac", "s.flac", "sendAudio", "audio", "upload_voice"],
  ["video/mp4", "c.mp4", "sendVideo", "video", "upload_video"],
  ["image/gif", "a.gif", "sendDocument", "document", "upload_document"],
  ["text/markdown", "todo.md", "sendDocument", "document", "upload_document"],
  ["application/zip", "a.zip", "sendDocument", "document", "upload_document"],
  ["video/quicktime", "c.mov", "sendDocument", "document", "upload_document"],
])("a %s file is sent with %s as multipart, keeping its name", async (mimeType, name, method, field, action) => {
  const adapter = await connect();
  const bytes = new Uint8Array([5, 6, 7]);
  expect(await adapter.sendFile!("42", outgoing(name, mimeType, bytes))).toBe("1");
  expect(uploads().map((c) => c.method)).toEqual([method]);
  expect(uploads()[0]!.params).toEqual({ multipart: true, chat_id: "42", [field]: { name, type: mimeType, data: bytes } });
  await vi.waitFor(() => expect(params("sendChatAction")).toEqual([{ chat_id: "42", action }]));
  expect(sends()).toEqual([]);
});

test("the file is read when it is sent; a missing file fails without uploading", async () => {
  const adapter = await connect();
  const f = outgoing("n.txt", "text/plain", new Uint8Array([1]));
  writeFileSync(f.path, "later");
  await adapter.sendFile!("42", f);
  expect(new TextDecoder().decode(uploads()[0]!.params.document.data)).toBe("later");
  await expect(adapter.sendFile!("42", { ...f, path: `${f.path}.gone` })).rejects.toThrow("ENOENT");
  expect(uploads()).toHaveLength(1);
});

test("an image over 10 MB is sent as a document", async () => {
  const adapter = await connect();
  await adapter.sendFile!("42", outgoing("big.png", "image/png", new Uint8Array(10 * 1024 * 1024 + 1)));
  expect(uploads().map((c) => c.method)).toEqual(["sendDocument"]);
  expect(uploads()[0]!.params.document.name).toBe("big.png");
});

test("a photo Telegram rejects is sent as a document with its caption", async () => {
  const adapter = await connect();
  const invalid = { ok: false, error_code: 400, description: "Bad Request: PHOTO_INVALID_DIMENSIONS" };
  fake.fail("sendPhoto", 400, invalid, 1);
  const id = await adapter.sendFile!("42", outgoing("wide.png", "image/png", undefined, "**look**"));
  expect(id).toBe("1");
  expect(uploads().map((c) => c.method)).toEqual(["sendPhoto", "sendDocument"]);
  expect(uploads()[1]!.params).toMatchObject({
    chat_id: "42",
    caption: "<b>look</b>",
    parse_mode: "HTML",
    document: { name: "wide.png", type: "image/png" },
  });
});

test("other upload errors are not retried as documents", async () => {
  const adapter = await connect();
  fake.fail("sendVoice", 400, { ok: false, error_code: 400, description: "Bad Request: nope" }, 1);
  await expect(adapter.sendFile!("42", outgoing("v.ogg", "audio/ogg"))).rejects.toThrow("nope");
  expect(uploads().map((c) => c.method)).toEqual(["sendVoice"]);
});

test("a caption is sent as HTML, or as plain text when Telegram can't parse it", async () => {
  const adapter = await connect();
  await adapter.sendFile!("42", outgoing("a.md", "text/markdown", undefined, "**hi** `x`"));
  expect(uploads()[0]!.params).toMatchObject({ caption: "<b>hi</b> <code>x</code>", parse_mode: "HTML" });
  fake.fail("sendDocument", 400, unparsable, 1);
  expect(await adapter.sendFile!("42", outgoing("b.md", "text/markdown", undefined, "**hi**"))).toBe("2");
  const last = uploads().at(-1)!.params;
  expect(last.caption).toBe("hi");
  expect(last.parse_mode).toBeUndefined();
  expect(last.document.name).toBe("b.md");
});

test("a caption rendering over 1024 characters follows the file as its own message", async () => {
  const adapter = await connect();
  const caption = `**${"x".repeat(1025)}**`;
  expect(await adapter.sendFile!("42", outgoing("a.mp3", "audio/mpeg", undefined, caption))).toBe("1");
  expect(uploads()[0]!.params.caption).toBeUndefined();
  expect(sends()).toEqual([{ chat_id: "42", text: `<b>${"x".repeat(1025)}</b>`, parse_mode: "HTML" }]);
  const [file, message] = [uploads()[0]!, fake.calls.find((c) => c.method === "sendMessage")!];
  expect(fake.calls.indexOf(file)).toBeLessThan(fake.calls.indexOf(message));
});

test("a caption of exactly 1024 characters stays on the file", async () => {
  const adapter = await connect();
  await adapter.sendFile!("42", outgoing("a.mp3", "audio/mpeg", undefined, "y".repeat(1024)));
  expect(uploads()[0]!.params.caption).toBe("y".repeat(1024));
  expect(sends()).toEqual([]);
});

test("a multipart upload is retried after a 429 with the whole file", async () => {
  const adapter = await connect();
  const tooMany = { ok: false, error_code: 429, description: "Too Many Requests", parameters: { retry_after: 1 } };
  fake.fail("sendDocument", 429, tooMany, 1);
  const bytes = new Uint8Array([3, 1, 4]);
  expect(await adapter.sendFile!("42", outgoing("a.zip", "application/zip", bytes))).toBe("1");
  const [first, second] = uploads();
  expect(second!.at - first!.at).toBeGreaterThanOrEqual(1000);
  expect(second!.params.document).toEqual({ name: "a.zip", type: "application/zip", data: bytes });
});

test("a 401 on upload drops the token, so the next send reads it again", async () => {
  const stub = kernelStub("T");
  const adapter = await connect(stub);
  fake.fail("sendDocument", 401, { ok: false, error_code: 401, description: "Unauthorized" }, 1);
  await expect(adapter.sendFile!("42", outgoing("a.zip", "application/zip"))).rejects.toThrow("Unauthorized");
  stub.provide("NEW");
  await adapter.sendFile!("42", outgoing("a.zip", "application/zip"));
  expect(uploads().map((c) => c.token)).toEqual(["T", "NEW"]);
});

test("a failing chat action doesn't stop the upload", async () => {
  const adapter = await connect();
  fake.fail("sendChatAction", 400, { ok: false, error_code: 400, description: "Bad Request" });
  expect(await adapter.sendFile!("42", outgoing("v.ogg", "audio/ogg"))).toBe("1");
  await vi.waitFor(() => expect(params("sendChatAction")).toEqual([{ chat_id: "42", action: "upload_voice" }]));
});

const text = (id: number, t: string, extra = {}) => ({
  update_id: id,
  message: { message_id: id - 95, from: { id: 42 }, chat: { id: 42, type: "private" }, text: t, ...extra },
});
const media = (id: number, extra: object) => ({
  update_id: id,
  message: { message_id: id, from: { id: 42 }, chat: { id: 42, type: "private" }, ...extra },
});

test("updates are confirmed only after receive has taken them", async () => {
  let go = () => {};
  const taken = new Promise<void>((resolve) => (go = resolve));
  const received = await listen(kernelStub("T"), () => taken);
  fake.push(text(100, "hi"));
  await vi.waitFor(() => expect(received).toHaveLength(1));
  await sleep(300);
  expect(offsets()).not.toContain(101);
  go();
  await vi.waitFor(() => expect(offsets()).toContain(101));
});

test("texts, commands and button presses become Incoming messages", async () => {
  const received = await listen();
  fake.push(
    text(100, "hi"),
    text(101, "/jobs@japa_bot", { entities: [{ type: "bot_command", offset: 0, length: 14 }] }),
    {
      update_id: 102,
      callback_query: {
        id: "cb1",
        from: { id: 42 },
        message: { message_id: 7, chat: { id: 42, type: "private" } },
        data: "3",
      },
    },
  );
  await vi.waitFor(() =>
    expect(received).toEqual([
      { chat: "42", user: "42", messageId: "5", id: "100", text: "hi" },
      { chat: "42", user: "42", messageId: "6", id: "101", command: "jobs" },
      { chat: "42", user: "42", messageId: "7", id: "102", action: "3" },
    ]),
  );
  expect(params("answerCallbackQuery")).toEqual([{ callback_query_id: "cb1" }]);
});

test("a reply carries the id of the message it replies to", async () => {
  fake.file("p", new Uint8Array([1]));
  const received = await listen();
  fake.push(
    text(100, "s", { reply_to_message: { message_id: 7 } }),
    media(101, { photo: [{ file_id: "p", file_size: 1 }], reply_to_message: { message_id: 8 } }),
  );
  await vi.waitFor(() => expect(received).toHaveLength(2));
  expect(received[0]!.replyTo).toBe("7");
  expect(received[1]!.replyTo).toBe("8");
});

test("a photo is read at its largest size with its caption; an album is one Incoming per photo", async () => {
  const L_BYTES = new Uint8Array([1, 2, 3]);
  fake.file("l", L_BYTES);
  fake.file("l2", new Uint8Array([4]));
  const sizes = (large: string) => [
    { file_id: "s", file_size: 10 },
    { file_id: large, file_size: 100 },
  ];
  const received = await listen();
  fake.push(
    media(100, { media_group_id: "g", photo: sizes("l"), caption: "trip" }),
    media(101, { media_group_id: "g", photo: sizes("l2") }),
  );
  await vi.waitFor(() => expect(received).toHaveLength(2));
  expect(received[0]).toEqual({
    chat: "42",
    user: "42",
    messageId: "100",
    id: "100",
    text: "trip",
    files: [{ data: L_BYTES, mimeType: "image/jpeg" }],
  });
  expect(received[1]!.files).toEqual([{ data: new Uint8Array([4]), mimeType: "image/jpeg" }]);
  expect(received.some((m) => "images" in m)).toBe(false);
  expect(params("getFile").map((p) => p.file_id)).toEqual(["l", "l2"]);
});

test("an image document is read with its type and name", async () => {
  fake.file("d", new Uint8Array([9]));
  const received = await listen();
  fake.push(media(100, { document: { file_id: "d", mime_type: "image/png", file_name: "shot.png" } }));
  await vi.waitFor(() => expect(received).toHaveLength(1));
  expect(received[0]).toMatchObject({ id: "100", files: [{ data: new Uint8Array([9]), mimeType: "image/png", name: "shot.png" }] });
  expect(received[0]!.images).toBeUndefined();
  expect(sends()).toEqual([]);
});

test.each([
  ["a PDF document", { document: { file_id: "f", mime_type: "application/pdf", file_name: "r.pdf" } }, { mimeType: "application/pdf", name: "r.pdf" }],
  ["a document without a MIME type", { document: { file_id: "f", file_name: "a.zip" } }, { mimeType: "application/octet-stream", name: "a.zip" }],
  ["an audio file", { audio: { file_id: "f", mime_type: "audio/mpeg", file_name: "song.mp3" } }, { mimeType: "audio/mpeg", name: "song.mp3" }],
  ["a voice note", { voice: { file_id: "f", mime_type: "audio/ogg", duration: 2 } }, { mimeType: "audio/ogg", name: "voice.ogg" }],
  ["a video", { video: { file_id: "f", mime_type: "video/quicktime", file_name: "clip.mov" } }, { mimeType: "video/quicktime", name: "clip.mov" }],
  ["a video without a MIME type or name", { video: { file_id: "f" } }, { mimeType: "video/mp4" }],
  ["a video note", { video_note: { file_id: "f", length: 240 } }, { mimeType: "video/mp4", name: "video_note.mp4" }],
  ["an animation", { animation: { file_id: "f", mime_type: "video/mp4", file_name: "cat.mp4" } }, { mimeType: "video/mp4", name: "cat.mp4" }],
])("%s becomes a file with its type, name and caption", async (_, message, file) => {
  fake.file("f", new Uint8Array([7, 8]));
  const received = await listen();
  fake.push(media(100, { ...message, caption: "look", reply_to_message: { message_id: 3 } }));
  await vi.waitFor(() => expect(received).toHaveLength(1));
  expect(received[0]).toEqual({
    chat: "42",
    user: "42",
    messageId: "100",
    id: "100",
    replyTo: "3",
    text: "look",
    files: [{ data: new Uint8Array([7, 8]), ...file }],
  });
  expect(params("getFile")).toEqual([{ file_id: "f" }]);
  expect(sends()).toEqual([]);
});

test("stickers, locations, contacts and polls are refused", async () => {
  const received = await listen();
  fake.push(
    media(100, { sticker: { file_id: "x" } }),
    media(101, { location: { latitude: 1, longitude: 2 } }),
    media(102, { contact: { phone_number: "1", first_name: "A" } }),
    media(103, { poll: { id: "p", question: "q", options: [] } }),
  );
  await vi.waitFor(() => expect(sends()).toHaveLength(4));
  expect(sends().map((s) => [s.chat_id, s.text])).toEqual(Array(4).fill(["42", "I can read text and files here."]));
  expect(received).toEqual([]);
  expect(params("getFile")).toEqual([]);
});

test("a file over 20 MB is refused without downloading", async () => {
  const received = await listen();
  fake.push(
    media(100, { photo: [{ file_id: "big", file_size: 20 * 1024 * 1024 + 1 }] }),
    media(101, { voice: { file_id: "big2", file_size: 20 * 1024 * 1024 + 1 } }),
  );
  await vi.waitFor(() => expect(sends()).toHaveLength(2));
  expect(sends()[0]!.text).toBe("That file is too large: Telegram bots can only download files up to 20 MB.");
  expect(sends().at(-1)!.text).toBe("That file is too large: Telegram bots can only download files up to 20 MB.");
  expect(fake.calls.some((c) => c.method === "getFile")).toBe(false);
  expect(received).toEqual([]);
});

test("group chats are ignored", async () => {
  const received = await listen();
  fake.push(
    { update_id: 100, message: { message_id: 1, from: { id: 42 }, chat: { id: -5, type: "group" }, text: "all" } },
    text(101, "me"),
  );
  await vi.waitFor(() => expect(received).toHaveLength(1));
  expect(received[0]!.text).toBe("me");
  expect(sends()).toEqual([]);
});

test("a 401 stops polling and asks for a new token", async () => {
  const stub = kernelStub("BAD");
  fake.fail("getUpdates", 401, { ok: false, error_code: 401, description: "Unauthorized" });
  await listen(stub);
  await vi.waitFor(() =>
    expect(stub.requested).toEqual([
      { name: "telegram.botToken", why: "Telegram rejected the bot token. Send a new one from @BotFather." },
    ]),
  );
  const polls = params("getUpdates").length;
  await sleep(500);
  expect(params("getUpdates")).toHaveLength(polls);
  stub.provide("NEW");
  await vi.waitFor(() => expect(fake.calls.at(-1)!.token).toBe("NEW"));
});

test("without a token the bot waits, asking nothing, and starts once it is provided", async () => {
  const stub = kernelStub();
  await (telegram.provides!.messaging![0] as MessagingAdapter).commands([{ name: "jobs", description: "Jobs" }]);
  await listen(stub);
  await sleep(300);
  expect(fake.calls).toEqual([]);
  expect(stub.requested).toEqual([]);
  stub.provide("T");
  await vi.waitFor(() => expect(fake.calls.map((c) => c.method).slice(0, 2)).toEqual(["setMyCommands", "getUpdates"]));
  expect(params("setMyCommands")).toEqual([{ commands: [{ command: "jobs", description: "Jobs" }] }]);
  expect(params("getUpdates")[0]).toEqual({ timeout: 50, allowed_updates: ["message", "callback_query"] });
});

test("polling logs errors and carries on", async () => {
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  const received = await listen();
  fake.fail("getUpdates", 409, { ok: false, error_code: 409, description: "Conflict" }, 1);
  fake.push(text(100, "hi"));
  await vi.waitFor(() => expect(received).toHaveLength(1), { timeout: 5000 });
  expect(errors).toHaveBeenCalledWith("telegram: Conflict");
  errors.mockRestore();
});

test("a default install has Telegram dormant: no error, no pending secret request", async () => {
  const { daemon } = await bootTest();
  expect(daemon.status().extensions.map((e) => e.name)).toContain("telegram");
  expect(bootErrors(daemon)).toEqual([]);
  expect((await daemon.harness.snapshot(SecretRequestsDoc, ROOT_CONVERSATION_ID, ctx))!.pending).toEqual([]);
  expect(fake.calls).toEqual([]);
  await daemon.close();
});

test("a replayed update_id reaches the CoS once", async () => {
  const dir = mkdtempSync(join(tmpdir(), "japa-secrets-"));
  writeFileSync(join(dir, "telegram.botToken"), "T");
  const { daemon } = await bootTest({ secrets: { adapter: "file", dir }, extensions: { telegram: { owner: "42" } } });
  fake.push(text(7, "hi"));
  await waitFor(async () => (await texts(daemon.root, "user")).includes("hi"));
  await vi.waitFor(() => expect(offsets()).toContain(8), { timeout: 5000 });
  fake.replayOnce();
  await sleep(2000);
  expect((await texts(daemon.root, "user")).filter((t) => t === "hi")).toHaveLength(1);
  await daemon.close();
});
