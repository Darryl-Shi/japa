import type { EntryId } from "@earendil-works/pi-durable";
import { expect, test } from "vitest";
import { type HistoryMessage, transcriptMessages } from "../src/kernel/memory/transcript.ts";
import { ago, conversation, cut, renderWindow, windowView } from "../src/kernel/memory/window.ts";
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

test("the conversation is measured on the user's messages; automated arrivals don't extend it", () => {
  // A schedule every 20 minutes would chain the old topic to the new one if every message counted.
  const before = transcriptMessages([
    you(1, "old topic", NOW - 3 * HOUR),
    ...reply(2, "Old answer.", NOW - 3 * HOUR + MIN),
    ...Array.from({ length: 8 }, (_, i) => [
      auto(10 + 2 * i, `[schedule 3 "Check"] tick ${i}`, NOW - 3 * HOUR + (i + 1) * 20 * MIN),
      ...reply(11 + 2 * i, `Checked ${i}.`, NOW - 3 * HOUR + (i + 1) * 20 * MIN + 1000),
    ]).flat(),
    you(40, "new topic", NOW - 10 * MIN),
    ...reply(41, "New answer.", NOW - 9 * MIN),
    auto(42, '[schedule 3 "Check"] tick 8', NOW - 5 * MIN),
    ...reply(43, "Checked 8.", NOW - 5 * MIN + 1000),
  ]);
  expect(conversation(before, NOW).map((m) => m.id)).toEqual([40, 41, 42, 43]);

  // Two user messages 40 minutes apart, an arrival between them: the conversation starts at the second.
  const split = transcriptMessages([
    you(1, "first", NOW - 50 * MIN),
    ...reply(2, "One.", NOW - 49 * MIN),
    auto(3, "[whatsapp] linked", NOW - 30 * MIN),
    ...reply(4, "WhatsApp is linked.", NOW - 29 * MIN),
    you(5, "second", NOW - 10 * MIN),
    ...reply(6, "Two.", NOW - 9 * MIN),
  ]);
  expect(conversation(split, NOW).map((m) => m.id)).toEqual([5, 6]);

  // Within 30 minutes of each other, the user's messages chain, with everything between them.
  const chained = transcriptMessages([
    you(1, "first", NOW - 50 * MIN),
    ...reply(2, "One.", NOW - 49 * MIN),
    auto(3, "[whatsapp] linked", NOW - 30 * MIN),
    you(5, "second", NOW - 25 * MIN),
    ...reply(6, "Two.", NOW - 24 * MIN),
  ]);
  expect(conversation(chained, NOW).map((m) => m.id)).toEqual([1, 2, 3, 5, 6]);
});

test("after a pause, the user's last exchange is shown with the arrivals after it", () => {
  const before = transcriptMessages([
    you(1, "earlier", NOW - 2 * HOUR),
    ...reply(2, "Sure.", NOW - 2 * HOUR + MIN),
    you(3, "should we keep jellyfin?", NOW - 80 * MIN),
    ...reply(4, "It's your call: it uses 30 GB. Keep it or drop it?", NOW - 79 * MIN),
    auto(5, '[schedule 3 "Backup"] run the nightly backup', NOW - 40 * MIN),
    ...reply(6, "Started the backup.", NOW - 39 * MIN),
  ]);
  expect(conversation(before, NOW).map((m) => m.id)).toEqual([3, 4, 5, 6]);
  expect(body(renderWindow(before, NOW))).toEqual([
    "you · 1 h ago · #3: should we keep jellyfin?",
    "japa · 1 h ago: It's your call: it uses 30 GB. Keep it or drop it?",
    '[schedule 3 "Backup"] · 40 min ago · #5: run the nightly backup (full: history_read 5)',
    "japa · 39 min ago: Started the backup.",
  ]);

  // The exchange starts at its first input, automated or not.
  const steered = transcriptMessages([
    auto(1, "[whatsapp] unlinked", NOW - 2 * HOUR),
    you(2, "relink it", NOW - 2 * HOUR + 1000),
    ...reply(3, "Here's a code.", NOW - 2 * HOUR + MIN),
  ]);
  expect(conversation(steered, NOW).map((m) => m.id)).toEqual([1, 2, 3]);
});

test("with no user message, the last exchange is shown", () => {
  const before = transcriptMessages([
    auto(1, "[whatsapp] unlinked", NOW - 20 * MIN),
    ...reply(2, "WhatsApp is unlinked.", NOW - 19 * MIN),
    auto(3, '[schedule 3 "Check"] tick', NOW - 10 * MIN),
    ...reply(4, "Checked.", NOW - 9 * MIN),
  ]);
  expect(conversation(before, NOW).map((m) => m.id)).toEqual([3, 4]);
});

test("a smaller budget holds the whole window, the newest exchange included", () => {
  const before = [
    ...Array.from({ length: 20 }, (_, i) =>
      msg(i + 1, i % 2 === 0 ? "you" : "japa", `${i + 1}:${"z".repeat(1500)}`, NOW - (40 - i) * MIN),
    ),
    msg(21, "you", "hi", NOW - 2 * MIN),
    msg(22, "japa", `start${"y".repeat(20000)}end`, NOW - MIN),
  ];
  const text = renderWindow(before, NOW, { budget: 2000 })!;
  expect(text.length).toBeLessThanOrEqual(8000);
  const lines = text.split("\n");
  expect(lines[0]).toBe("[Conversation so far]");
  expect(lines[1]!.startsWith("you · 40 min ago · #1: 1:zzz")).toBe(true); // the user's first message, pinned
  expect(lines[2]).toMatch(/^\[19 messages not shown: history_read 2\]$/);
  expect(lines[3]).toBe("you · 2 min ago · #21: hi");
  expect(lines[4]!.startsWith("japa · 1 min ago: startyyy")).toBe(true);
  expect(lines[4]!.endsWith("yyyend")).toBe(true);

  // The default is 8,000 tokens.
  expect(renderWindow(before, NOW)!.length).toBeGreaterThan(8000);
  expect(renderWindow(before, NOW, { budget: 8000 })).toBe(renderWindow(before, NOW));
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
  expect(text).not.toContain("not shown");
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
  expect(lines[1]).toBe(`you · 6 min ago · #1000: ${before[0]!.text}`); // the user's first message, pinned
  const match = /^\[(\d+) messages not shown: history_read 1001\]$/.exec(lines[2]!);
  expect(match).not.toBeNull();
  const dropped = Number(match![1]);
  expect(lines).toHaveLength(3 + 399 - dropped);
  expect(lines[3]).toContain(`: message ${1 + dropped} `);
  expect(lines.at(-1)).toContain("message 399 ");
  // nothing more is dropped than needed
  const last = before[dropped]!; // the newest dropped message
  const label = last.kind === "you" ? `you \u00b7 ${ago(last.at, NOW)} \u00b7 #${last.id}` : `japa \u00b7 ${ago(last.at, NOW)}`;
  const line = `${label}: ${last.text}`;
  expect(text.length + line.length + 1).toBeGreaterThan(32000);
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

test("a long run of job reports with no reply stays within budget", () => {
  const before = transcriptMessages([
    you(1, "check every server", NOW - 20 * MIN),
    ...reply(2, "Started 150 jobs.", NOW - 19 * MIN),
    ...Array.from({ length: 150 }, (_, i) =>
      auto(10 + i, `[job ${100 + i} "Check ${i}" done] ${"r".repeat(300)}`, NOW - (150 - i) * 5000),
    ),
  ]);
  const text = renderWindow(before, NOW)!;
  expect(text.length).toBeLessThanOrEqual(32000);
  const lines = text.split("\n");
  expect(lines.at(-1)).toContain("#159: ");
  expect(lines.at(-1)!.endsWith("(full: job_transcript 249)")).toBe(true);
  // the newest exchange is held to 2,000 tokens by dropping its oldest reports, counted in the pointer line
  // the user's ask stays pinned above the pointer
  expect(lines[1]).toBe("you · 20 min ago · #1: check every server");
  const match = /^\[(\d+) messages not shown: history_read 2\]$/.exec(lines[2]!);
  expect(match).not.toBeNull();
  expect(lines).toHaveLength(3 + 151 - Number(match![1]));
  expect(lines.slice(3).join("\n").length).toBeLessThanOrEqual(8000);
});

test("a long run of inputs with no reply stays within budget, and keeps the last input whole", () => {
  const before = Array.from({ length: 1000 }, (_, i) => msg(i + 1, "you", `line ${i} ${"v".repeat(90)}`, NOW - (1000 - i) * 1000));
  const text = renderWindow(before, NOW)!;
  expect(text.length).toBeLessThanOrEqual(32000);
  const lines = text.split("\n");
  expect(lines[1]).toBe(`you · 16 min ago · #1: ${before[0]!.text}`); // the first input, pinned
  expect(lines[2]).toMatch(/^\[\d+ messages not shown: history_read 2\]$/);
  expect(lines.at(-1)).toBe(`you · just now · #1000: ${before[999]!.text}`);
  expect(text).not.toContain("[…]");
});

test("automated labels are at most 60 characters", () => {
  const label = `[${"x".repeat(5000)}]`;
  const before = transcriptMessages([
    you(1, "hi", NOW - 10 * MIN),
    ...Array.from({ length: 100 }, (_, i) => auto(10 + i, `${label} event ${i}`, NOW - (100 - i) * 1000)),
  ]);
  const text = renderWindow(before, NOW)!;
  expect(text.length).toBeLessThanOrEqual(32000);
  const last = text.split("\n").at(-1)!;
  expect(last).toBe(`[${"x".repeat(57)}…] · just now · #109: event 99 (full: history_read 109)`);
  expect(last.indexOf(" · ")).toBe(60);
});

test("the output is within budget even when nothing more can be cut or dropped", () => {
  const did = `did: ${"d".repeat(155)}`;
  const before = [
    msg(1, "you", "go", NOW - 10 * MIN),
    ...Array.from({ length: 300 }, (_, i) => msg(2 + i, "japa", "x".repeat(100), NOW - 5 * MIN, { did })),
  ];
  const text = renderWindow(before, NOW)!;
  expect(text.length).toBe(32000);
  expect(text.startsWith("[Conversation so far]\nyou · 10 min ago · #1: go\n")).toBe(true);
  // the lines lost in the cut aren't shown
  const { shown } = windowView(before, NOW)!;
  expect(shown).toContain(1);
  expect(shown).toContain(301);
  expect(shown.length).toBeLessThan(301);
});

test("a whole-bracket arrival is its own headline", () => {
  const before = transcriptMessages([auto(5, "[secret X provided]", NOW - MIN)]);
  expect(body(renderWindow(before, NOW))).toEqual([
    "[secret X provided] · 1 min ago · #5: secret X provided (full: history_read 5)",
  ]);
});

test("a job title holding brackets and quotes is stripped whole", () => {
  const before = transcriptMessages([auto(5, '[job 7 "fix [a] and "b]" failed] It broke.', NOW - MIN)]);
  expect(body(renderWindow(before, NOW))).toEqual(["job 7 report · 1 min ago · #5: It broke. (full: job_transcript 7)"]);
});

test("an image-only input renders as you", () => {
  const before = [msg(1, "you", "[image saved to /tmp/a.png]", NOW - MIN)];
  expect(body(renderWindow(before, NOW))).toEqual(["you · 1 min ago · #1: [image saved to /tmp/a.png]"]);
});

test("the user's first message stays pinned above the pointer when later ones are dropped", () => {
  const ask = "clean up the server: jellyfin and maria can go";
  const before = [
    msg(1, "you", ask, NOW - 25 * MIN),
    msg(2, "japa", "Started job 68.", NOW - 25 * MIN),
    ...Array.from({ length: 8 }, (_, i) =>
      msg(3 + i, i % 2 === 0 ? "you" : "japa", `${3 + i}:${"z".repeat(1500)}`, NOW - (20 - i) * MIN),
    ),
    msg(11, "you", "what should I plant in the garden?", NOW - 2 * MIN),
    msg(12, "japa", `plan${"g".repeat(20000)}end`, NOW - MIN),
  ];
  const view = windowView(before, NOW, { budget: 2000 })!;
  expect(view.text.length).toBeLessThanOrEqual(8000);
  const lines = view.text.split("\n");
  expect(lines[1]).toBe(`you · 25 min ago · #1: ${ask}`);
  const match = /^\[(\d+) messages not shown: history_read 2\]$/.exec(lines[2]!);
  expect(match).not.toBeNull();
  expect(lines.at(-2)).toBe("you · 2 min ago · #11: what should I plant in the garden?");
  // only what's on screen counts as shown: the pinned line yes, the dropped messages no
  const dropped = Number(match![1]);
  expect(view.shown).toEqual([1, ...Array.from({ length: 11 - dropped }, (_, i) => 2 + dropped + i)]);
  expect(view.shown).not.toContain(2);
  expect(view.text).toBe(renderWindow(before, NOW, { budget: 2000 }));

  // A long first message is pinned as its headline.
  const long = [msg(1, "you", `${"q".repeat(5000)}\nmore`, NOW - 25 * MIN), ...before.slice(1)];
  const pinned = windowView(long, NOW, { budget: 2000 })!;
  const first = pinned.text.split("\n")[1]!;
  expect(first.startsWith("you · 25 min ago · #1: qqq")).toBe(true);
  expect(first.slice(first.indexOf(": ") + 2).length).toBeLessThanOrEqual(200);
  expect(pinned.text.split("\n")[2]).toMatch(/^\[\d+ messages not shown: history_read 2\]$/);
  expect(pinned.shown[0]).toBe(1);
});

test("shown lists every message on screen, shortened ones included", () => {
  const before = Array.from({ length: 40 }, (_, i) =>
    msg(i + 1, i % 2 === 0 ? "you" : "japa", `${i + 1}:${"z".repeat(1500)}`, NOW - (40 - i) * MIN),
  );
  const view = windowView(before, NOW)!;
  expect(view.text).not.toContain("not shown");
  expect(view.shown).toEqual(before.map((m) => m.id));
  expect(windowView([], NOW)).toBeUndefined();
});

test("an empty history renders nothing", () => {
  expect(renderWindow([], NOW)).toBeUndefined();
  expect(conversation([], NOW)).toEqual([]);
});
