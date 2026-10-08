import { afterEach, beforeEach, expect, test } from "vitest";
import { backoff } from "../extensions/telegram/api.ts";
import { toHtml } from "../extensions/telegram/html.ts";
import type { Dispose } from "../src/kernel/contracts.ts";
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
const params = (method: string) => fake.calls.filter((c) => c.method === method).map((c) => c.params);
const sends = () => params("sendMessage");

test.each([
  ["**bold**, *it* and ~~gone~~", "<b>bold</b>, <i>it</i> and <s>gone</s>"],
  ["a < b & c > d", "a &lt; b &amp; c &gt; d"],
  ["use `x<y`", "use <code>x&lt;y</code>"],
  ["```ts\nif (a < b) {}\n```", '<pre><code class="language-ts">if (a &lt; b) {}</code></pre>'],
  ["[site](https://e.com/?a=1&b=2)", '<a href="https://e.com/?a=1&amp;b=2">site</a>'],
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
