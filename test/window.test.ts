import type { EntryId } from "@earendil-works/pi-durable";
import { expect, test } from "vitest";
import { type HistoryMessage, transcriptMessages } from "../src/kernel/memory/transcript.ts";
import { ago, conversation, cut, renderWindow } from "../src/kernel/memory/window.ts";
import { auto, reply, you } from "./history-helpers.ts";

const MIN = 60_000;
const HOUR = 60 * MIN;
const NOW = Date.UTC(2026, 9, 11, 12);

const msg = (id: number, kind: HistoryMessage["kind"], text: string, at: number, extra: object = {}): HistoryMessage =>
  ({ id: id as EntryId, kind, text, at, ...extra }) as HistoryMessage;

/** The rendered lines after the header. */
const body = (text: string | undefined) => text!.split("\n").slice(1);

test("ago is relative, and a date after a week", () => {
  expect(ago(NOW - 30_000, NOW)).toBe("just now");
  expect(ago(NOW - 41 * MIN, NOW)).toBe("41 min ago");
  expect(ago(NOW - 3 * HOUR - 5 * MIN, NOW)).toBe("3 h ago");
  expect(ago(NOW - 50 * HOUR, NOW)).toBe("2 d ago");
  expect(ago(Date.UTC(2026, 8, 1, 9), NOW)).toBe("2026-09-01");
});

test("cut shortens the middle", () => {
  expect(cut("abcdefghij", 5)).toBe("a[…]j");
  expect(cut("abc", 5)).toBe("[…]");
});

test("the conversation runs back to the first gap over 30 minutes", () => {
  const before = transcriptMessages([
    you(1, "old topic", NOW - 3 * HOUR),
    ...reply(2, "Old answer.", NOW - 3 * HOUR + MIN),
    you(3, "new topic", NOW - 50 * MIN),
    ...reply(4, "New answer.", NOW - 49 * MIN),
    you(5, "more", NOW - 20 * MIN),
    ...reply(6, "Sure.", NOW - 19 * MIN),
  ]);
  expect(conversation(before, NOW).map((m) => m.id)).toEqual([3, 4, 5, 6]);
  expect(renderWindow(before, NOW)).toBe(
    [
      "[Conversation so far]",
      "you · 50 min ago · #3: new topic",
      "japa · 49 min ago: New answer.",
      "you · 20 min ago · #5: more",
      "japa · 19 min ago: Sure.",
    ].join("\n"),
  );
});

test("after a pause, only the previous exchange is shown, with its age", () => {
  const before = transcriptMessages([
    you(1, "first", NOW - 3 * HOUR - 4 * MIN),
    ...reply(2, "One.", NOW - 3 * HOUR - 3 * MIN),
    you(3, "second", NOW - 3 * HOUR - 2 * MIN),
    ...reply(4, "Two.", NOW - 3 * HOUR - MIN),
  ]);
  expect(conversation(before, NOW).map((m) => m.id)).toEqual([3, 4]);
  expect(body(renderWindow(before, NOW))).toEqual(["you · 3 h ago · #3: second", "japa · 3 h ago: Two."]);
});

test("automated arrivals are one headline with a pointer", () => {
  const report = `[job 68 "Cleanup" done] Server 1 cleanup is done: ${"x".repeat(5000)}\nsecond line`;
  const before = transcriptMessages([you(1, "clean up", NOW - 10 * MIN), auto(2, report, NOW - 2 * MIN)]);
  const lines = body(renderWindow(before, NOW));
  expect(lines).toHaveLength(2);
  const line = lines[1]!;
  expect(line.startsWith("job 68 report · 2 min ago · #2: Server 1 cleanup is done: xxx")).toBe(true);
  expect(line.endsWith("(full: job_transcript 68)")).toBe(true);
  const headline = line.slice(line.indexOf(": ") + 2, line.lastIndexOf(" (full: "));
  expect(headline.length).toBeLessThanOrEqual(200);
  expect(line).not.toContain("second line");

  const other = transcriptMessages([auto(7, "[whatsapp] WhatsApp was unlinked\nmore", NOW - MIN)]);
  expect(body(renderWindow(other, NOW))).toEqual([
    "[whatsapp] · 1 min ago · #7: WhatsApp was unlinked (full: history_read 7)",
  ]);
});

test("did lines follow the reply", () => {
  const before = transcriptMessages([
    you(1, "go", NOW - 5 * MIN),
    ...reply(2, "Started.", NOW - 4 * MIN, [
      { name: "job_start", args: { title: "Clean\nup" }, result: "Started job 68." },
    ]),
  ]);
  expect(body(renderWindow(before, NOW))).toEqual([
    "you · 5 min ago · #1: go",
    "japa · 4 min ago: Started.",
    "  did: job_start Clean up (job 68)",
  ]);
});

test("the WhatsApp replay", () => {
  const before = transcriptMessages([
    you(1, "+65 91466066", NOW - 5 * MIN),
    ...reply(2, "Your pairing code is ABCD-1234.", NOW - 4 * MIN),
    auto(3, "[whatsapp] WhatsApp was unlinked; the pairing failed.", NOW - 3 * MIN),
    ...reply(4, "WhatsApp didn't stay linked. Want a new code?", NOW - 2 * MIN),
  ]);
  const text = renderWindow(before, NOW)!;
  expect(text).toContain("+65 91466066");
  expect(body(text)).toEqual([
    "you · 5 min ago · #1: +65 91466066",
    "japa · 4 min ago: Your pairing code is ABCD-1234.",
    "[whatsapp] · 3 min ago · #3: WhatsApp was unlinked; the pairing failed. (full: history_read 3)",
    "japa · 2 min ago: WhatsApp didn't stay linked. Want a new code?",
  ]);
});

test("older messages are shortened before any are dropped", () => {
  const before = Array.from({ length: 40 }, (_, i) =>
    msg(i + 1, i % 2 === 0 ? "you" : "japa", `${i + 1}:${"z".repeat(1500 - String(i + 1).length - 1)}`, NOW - (40 - i) * MIN),
  );
  const text = renderWindow(before, NOW)!;
  expect(text.length).toBeLessThanOrEqual(32000);
  expect(text).not.toContain("earlier messages");
  const lines = body(text);
  expect(lines).toHaveLength(40);
  const texts = lines.map((l) => l.slice(l.indexOf(": ") + 2));
  // the newest exchange is intact
  expect(texts.slice(-2)).toEqual([before[38]!.text, before[39]!.text]);
  // older messages are shortened oldest first, to at most 200 characters
  const older = texts.slice(0, -2);
  const shortened = older.filter((t) => t.length <= 200).length;
  expect(shortened).toBeGreaterThan(0);
  older.forEach((t, i) => {
    if (i < shortened) {
      expect(t.length).toBeLessThanOrEqual(200);
      expect(t.startsWith(`${i + 1}:zzz`)).toBe(true);
    } else expect(t).toBe(before[i]!.text);
  });
});

test("the newest exchange is cut to 2,000 tokens in the middle of its longest part", () => {
  const before = [msg(1, "you", "hi", NOW - 2 * MIN), msg(2, "japa", `start${"y".repeat(20000)}end`, NOW - MIN)];
  const text = renderWindow(before, NOW)!;
  const exchange = body(text).join("\n");
  expect(exchange.length).toBe(8000);
  expect(exchange.startsWith("you · 2 min ago · #1: hi\njapa · 1 min ago: startyyy")).toBe(true);
  expect(exchange).toContain("[…]");
  expect(exchange.endsWith("yyyend")).toBe(true);
});

test("drops leave a pointer line", () => {
  const before = Array.from({ length: 400 }, (_, i) =>
    msg(1000 + i, i % 2 === 0 ? "you" : "japa", `message ${i} ${"w".repeat(90)}`, NOW - (400 - i) * 1000),
  );
  const text = renderWindow(before, NOW)!;
  expect(text.length).toBeLessThanOrEqual(32000);
  const lines = text.split("\n");
  expect(lines[0]).toBe("[Conversation so far]");
  const match = /^\[(\d+) earlier messages in this conversation: history_read 1000\]$/.exec(lines[1]!);
  expect(match).not.toBeNull();
  const dropped = Number(match![1]);
  expect(lines).toHaveLength(2 + 400 - dropped);
  expect(lines[2]).toContain(`#${1000 + dropped}: message ${dropped} `);
  expect(lines.at(-1)).toContain("message 399 ");
  // nothing more is dropped than needed
  expect(text.length + lines[2]!.length + 1).toBeGreaterThan(32000);
});

test("a steered run shows every input and no reply line when there was no reply", () => {
  const unanswered = [
    msg(1, "you", "hello", NOW - 10 * MIN),
    msg(2, "japa", "Hi.", NOW - 9 * MIN),
    msg(3, "you", "fix the server", NOW - 2 * MIN),
    msg(4, "you", "and the mail too", NOW - MIN),
  ];
  expect(body(renderWindow(unanswered, NOW))).toEqual([
    "you · 10 min ago · #1: hello",
    "japa · 9 min ago: Hi.",
    "you · 2 min ago · #3: fix the server",
    "you · 1 min ago · #4: and the mail too",
  ]);

  // after a pause, a steer chain with no reply is still shown whole
  const paused = unanswered.map((m) => ({ ...m, at: m.at - 5 * HOUR }));
  expect(body(renderWindow(paused, NOW))).toEqual([
    "you · 5 h ago · #3: fix the server",
    "you · 5 h ago · #4: and the mail too",
  ]);

  // a long reply to a steer chain is cut, and every input stays intact
  const steered = [
    msg(1, "you", "fix the server", NOW - 3 * MIN),
    msg(2, "you", "and the mail too", NOW - 2 * MIN),
    msg(3, "japa", "r".repeat(20000), NOW - MIN),
  ];
  const lines = body(renderWindow(steered, NOW));
  expect(lines.slice(0, 2)).toEqual(["you · 3 min ago · #1: fix the server", "you · 2 min ago · #2: and the mail too"]);
  expect(lines[2]).toContain("[…]");
  expect(lines.join("\n").length).toBe(8000);
});

test("an image-only input renders as you", () => {
  const before = [msg(1, "you", "[image saved to /tmp/a.png]", NOW - MIN)];
  expect(body(renderWindow(before, NOW))).toEqual(["you · 1 min ago · #1: [image saved to /tmp/a.png]"]);
});

test("an empty history renders nothing", () => {
  expect(renderWindow([], NOW)).toBeUndefined();
  expect(conversation([], NOW)).toEqual([]);
});
