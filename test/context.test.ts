import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { type ConversationId, type EntryId, ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { expect, test, vi } from "vitest";
import type { Job } from "../src/kernel/jobs/state.ts";
import { buildContext } from "../src/kernel/memory/context.ts";
import { MemoryDoc } from "../src/kernel/memory/state.ts";
import type { HistoryMessage } from "../src/kernel/memory/transcript.ts";
import { bootTest } from "./helpers.ts";
import { ask, call, say, script, texts } from "./jobs-helpers.ts";

/** When set, every history refresh rejects. */
const broken = vi.hoisted(() => ({ on: false }));
vi.mock("../src/kernel/memory/history.ts", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/kernel/memory/history.ts")>();
  return {
    ...real,
    createHistory: () => {
      const history = real.createHistory();
      return {
        attach: history.attach,
        refresh: (context: Parameters<typeof history.refresh>[0]) =>
          broken.on ? Promise.reject(new Error("history is broken")) : history.refresh(context),
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
