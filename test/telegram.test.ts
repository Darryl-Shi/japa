import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { backoff } from "../extensions/telegram/api.ts";
import { toHtml } from "../extensions/telegram/html.ts";
import telegram from "../extensions/telegram/index.ts";
import type { Dispose, Incoming, MessagingAdapter } from "../src/kernel/contracts.ts";
import { SecretRequestsDoc } from "../src/kernel/secret-requests.ts";
import { bootTest, waitFor } from "./helpers.ts";
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
])("toHtml(%j)", (md, html) => expect(toHtml(md)).toBe(html));

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

test("HTML Telegram can't parse is resent as plain text", async () => {
  const adapter = await connect();
  fake.fail("sendMessage", 400, { ok: false, error_code: 400, description: "Bad Request: can't parse entities: x" }, 1);
  await adapter.send("42", { markdown: "**hi**" });
  expect(sends().at(-1)).toEqual({ chat_id: "42", text: "**hi**" });
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
  expect(received[0]).toMatchObject({ text: "trip", images: [{ data: L_BYTES, mimeType: "image/jpeg" }] });
  expect(received[1]!.images).toEqual([{ data: new Uint8Array([4]), mimeType: "image/jpeg" }]);
  expect(params("getFile").map((p) => p.file_id)).toEqual(["l", "l2"]);
});

test("an image document is read with its type; other documents and messages are refused", async () => {
  fake.file("d", new Uint8Array([9]));
  const received = await listen();
  fake.push(
    media(100, { document: { file_id: "d", mime_type: "image/png" } }),
    media(101, { document: { file_id: "p", mime_type: "application/pdf" } }),
    media(102, { sticker: { file_id: "x" } }),
  );
  await vi.waitFor(() => expect(sends()).toHaveLength(2));
  expect(received).toMatchObject([{ id: "100", images: [{ data: new Uint8Array([9]), mimeType: "image/png" }] }]);
  expect(sends().map((s) => [s.chat_id, s.text])).toEqual([
    ["42", "I can only read text and images here."],
    ["42", "I can only read text and images here."],
  ]);
});

test("a file over 20 MB is refused without downloading", async () => {
  const received = await listen();
  fake.push(media(100, { photo: [{ file_id: "big", file_size: 20 * 1024 * 1024 + 1 }] }));
  await vi.waitFor(() => expect(sends()).toHaveLength(1));
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
  expect(daemon.status().errors).toEqual([]);
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
