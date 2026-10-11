import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { type ConversationId, type EntryId, ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { expect, test, vi } from "vitest";
import type { Job } from "../src/kernel/jobs/state.ts";
import { buildContext } from "../src/kernel/memory/context.ts";
import { MemoryDoc } from "../src/kernel/memory/state.ts";
import type { HistoryMessage } from "../src/kernel/memory/transcript.ts";
import { transcriptMessages } from "../src/kernel/memory/transcript.ts";
import { bootTest, waitFor } from "./helpers.ts";
import { auto, reply, you } from "./history-helpers.ts";
import { ask, call, say, script, texts } from "./jobs-helpers.ts";

/** When set, every history refresh rejects; `refreshes` counts them. */
const broken = vi.hoisted(() => ({ on: false, refreshes: 0 }));
vi.mock("../src/kernel/memory/history.ts", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/kernel/memory/history.ts")>();
  return {
    ...real,
    createHistory: () => {
      const history = real.createHistory();
      return {
        attach: history.attach,
        refresh: (context: Parameters<typeof history.refresh>[0]) => {
          broken.refreshes++;
          return broken.on ? Promise.reject(new Error("history is broken")) : history.refresh(context);
        },
      };
    },
  };
});

const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const NOW = Date.UTC(2026, 9, 11, 12, 0);
const id = (n: number) => n as EntryId;
const message = (n: number, kind: HistoryMessage["kind"], text: string, at: number, job?: string): HistoryMessage => ({
  id: id(n),
  kind,
  text,
  at,
  ...(job === undefined ? {} : { job }),
});
const job = (n: string, title: string, result: string, origin: number, at: number): Job => ({
  id: n,
  title,
  brief: "b",
  status: "done",
  conversationId: 99 as ConversationId,
  result,
  createdAt: at,
  updatedAt: at,
  seq: 1,
  reported: [],
  origin: id(origin),
});
const empty = { memory: { nextId: 1, facts: [] }, pad: { nextId: 1, pages: [] } };
const HOUR = 60 * MIN;
/** The "[Conversation so far]" block of `text`. */
const windowOf = (text: string) => text.split("\n\n[From earlier")[0]!;

test("a schedule every 20 minutes keeps an automated run's window within 2,000 tokens", () => {
  const start = NOW - 3 * HOUR - 5 * MIN;
  const before = transcriptMessages([
    you(1, "keep an eye on the backups", start),
    ...reply(2, `Will do. ${"plan ".repeat(300)}`, start + MIN),
    ...Array.from({ length: 9 }, (_, i) => [
      auto(10 + 2 * i, `[schedule 3 "Backup check"] check the backups (run ${i})`, start + (i + 1) * 20 * MIN),
      ...reply(11 + 2 * i, `Backups OK, run ${i}: ${"detail ".repeat(200)}`, start + (i + 1) * 20 * MIN + 1000),
    ]).flat(),
  ]);
  const input = (kind: "you" | "auto", text: string) => ({
    messages: [...before, message(101, kind, text, NOW)],
    lastReset: id(100),
    ...empty,
    jobs: {},
    now: NOW,
  });
  const automated = windowOf(buildContext(input("auto", '[schedule 3 "Backup check"] check the backups (run 9)'))!);
  expect(automated.startsWith("[Conversation so far]")).toBe(true);
  expect(automated.length).toBeLessThanOrEqual(2000 * 4);
  expect(automated).toContain("Backups OK, run 8"); // the newest exchange is there

  // The user's own run gets the whole 8,000 tokens.
  const yours = windowOf(buildContext(input("you", "are the backups fine?"))!);
  expect(yours.length).toBeGreaterThan(2000 * 4);
  expect(yours).toContain("keep an eye on the backups");
});

test("after a 40-minute pause with a schedule firing in it, the user's question is in view when they answer", () => {
  const messages = [
    ...transcriptMessages([
      you(1, "should we keep jellyfin?", NOW - 80 * MIN),
      ...reply(2, "It's your call: it uses 30 GB. Keep it or drop it?", NOW - 79 * MIN),
      auto(3, '[schedule 3 "Backup"] run the nightly backup', NOW - 40 * MIN),
      ...reply(4, "Started the backup.", NOW - 39 * MIN),
    ]),
    message(6, "you", "drop it", NOW),
  ];
  const text = buildContext({ messages, lastReset: id(5), ...empty, jobs: {}, now: NOW })!;
  const window = windowOf(text);
  expect(window).toContain("should we keep jellyfin?");
  expect(window).toContain("Keep it or drop it?");
  expect(window.indexOf("should we keep jellyfin?")).toBeLessThan(window.indexOf("run the nightly backup"));
});

test("a job report the window shows isn't recalled as its job's result", () => {
  const text = buildContext({
    messages: [
      message(1, "you", "deploy the widget", NOW - 10 * MIN),
      message(2, "japa", "Started job 7.", NOW - 10 * MIN),
      message(3, "auto", '[job 7 "Widget" needs_input] which environment?', NOW - 5 * MIN, "7"),
      message(4, "japa", "Job 7 asks which environment.", NOW - 5 * MIN),
      message(6, "you", "staging, and send me the runbook", NOW),
    ],
    lastReset: id(5),
    ...empty,
    jobs: { "7": job("7", "Widget", "the staging runbook is ready", 1, NOW - MIN) },
    now: NOW,
  })!;
  expect(text).toContain("job 7 report");
  expect(text).not.toContain("[From earlier");
});

test("recall shows a job's report or its result, not both", () => {
  const context = (result: string) =>
    buildContext({
      messages: [
        message(1, "you", "write the quarterly report", NOW - 2 * DAY),
        message(2, "auto", '[job 7 "Report" done] quarterly revenue grew 12 percent', NOW - 2 * DAY, "7"),
        message(3, "you", "hello", NOW - 10 * MIN),
        message(4, "japa", "hi", NOW - 10 * MIN),
        message(6, "you", "what was the quarterly revenue?", NOW),
      ],
      lastReset: id(5),
      ...empty,
      jobs: { "7": job("7", "Report", result, 1, NOW - 2 * DAY) },
      now: NOW,
    })!;
  const same = context("quarterly revenue grew 12 percent");
  expect(same).toContain("job 7 report \u00b7 2 d ago \u00b7 #2: quarterly revenue grew 12 percent");
  expect(same).not.toContain('job 7 "Report"');

  // A newer result than the report is still found.
  expect(context("quarterly revenue grew 15 percent after the correction")).toContain('job 7 "Report"');
});

test("boot warms the history mirror", async () => {
  const before = broken.refreshes;
  const { daemon } = await bootTest();
  try {
    await waitFor(() => broken.refreshes > before);
  } finally {
    await daemon.close();
  }
});

test("a job report's run doesn't recall that job's own result", () => {
  const result = "the widget deploy runbook is ready";
  const text = buildContext({
    messages: [
      message(1, "you", "deploy the widget", NOW - 2 * DAY),
      message(2, "japa", "Started job 7.", NOW - 2 * DAY),
      message(3, "you", "hello", NOW - 10 * MIN), // today's conversation: the job's start is out of the window
      message(4, "japa", "hi", NOW - 10 * MIN),
      message(6, "auto", `[job 7 "Widget" done] ${result}`, NOW - MIN, "7"),
    ],
    lastReset: id(5),
    ...empty,
    jobs: { "7": job("7", "Widget", result, 1, NOW - MIN) },
    now: NOW,
  });
  expect(text).toContain("you asked"); // the origin, out of the window, still comes first
  expect(text).toContain("deploy the widget");
  expect(text).not.toContain('job 7 "Widget"');
});

test("an origin the window already shows isn't repeated in recall", () => {
  const text = buildContext({
    messages: [
      message(1, "you", "deploy the widget", NOW - 10 * MIN),
      message(2, "japa", "Started job 7.", NOW - 10 * MIN),
      message(4, "auto", '[job 7 "Widget" done] the widget deploy runbook is ready', NOW - MIN, "7"),
    ],
    lastReset: id(3),
    ...empty,
    jobs: { "7": job("7", "Widget", "the widget deploy runbook is ready", 1, NOW - MIN) },
    now: NOW,
  })!;
  expect(text.startsWith("[Conversation so far]")).toBe(true);
  expect(text).toContain("deploy the widget");
  expect(text).not.toContain("you asked");
  expect(text).not.toContain("[From earlier");
});

test("a context that can't be built leaves the turn to run without it, tool results still capped", async () => {
  const { daemon, faux } = await bootTest({ context: { toolResultTokens: 10 } });
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    await daemon.root.commit(async (tx) => {
      const doc = await tx.doc(MemoryDoc, ROOT_CONVERSATION_ID);
      doc.facts.push({ id: "1", text: "Ada ".repeat(50), updatedAt: 0 });
    }, ctx);
    const sent: string[] = [];
    script(faux, (role, text) => {
      sent.push(text);
      return role === "user" ? call("memory_facts", {}) : say("still here");
    });
    broken.on = true;
    await ask(daemon, "hi");
    expect(sent[0]).toBe("hi"); // nothing injected
    expect(sent[1]).toContain("[Truncated");
    expect((await texts(daemon.root, "assistant")).at(-1)).toBe("still here");
    expect(errors.mock.calls.some(([line]) => String(line).startsWith("japa.context"))).toBe(true);
  } finally {
    broken.on = false;
    errors.mockRestore();
    await daemon.close();
  }
});
