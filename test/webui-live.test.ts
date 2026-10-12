import type { AgentEvent } from "@earendil-works/pi-durable";
import { expect, test } from "vitest";
import type { LiveEvent } from "../extensions/webui/app/src/lib/protocol.ts";
import { createHub, startLive } from "../extensions/webui/live.ts";
import type { Job } from "../src/kernel/jobs/state.ts";

const user = (text: string) => ({ kind: "pi.message", model: [{ role: "user", content: text }] });
const assistant = (text: string, tools: string[] = []) => ({
  kind: "pi.message",
  model: [
    {
      role: "assistant",
      content: [{ type: "text", text }, ...tools.map((name) => ({ type: "toolCall", name, id: name, arguments: {} }))],
    },
  ],
});
const snapshot = (entries: object[], run?: object) => ({ type: "snapshot", entries, run }) as unknown as AgentEvent;
const delta = (text: string) => ({ type: "message_update", changes: [{ type: "text_delta", delta: text }] }) as unknown as AgentEvent;
const end = (entry: object) => ({ type: "message_end", entry }) as unknown as AgentEvent;
const ev = (type: string, extra: object = {}) => ({ type, ...extra }) as unknown as AgentEvent;

function subscribed() {
  const hub = createHub();
  const seen: LiveEvent[] = [];
  let closed = 0;
  const unsubscribe = hub.subscribe((e) => seen.push(e), () => closed++);
  return { hub, seen, closed: () => closed, unsubscribe };
}

test("a subscriber gets a snapshot at once", () => {
  const hub = createHub();
  hub.events([snapshot([user("hi"), assistant("hello")])]);
  const seen: LiveEvent[] = [];
  hub.subscribe((e) => seen.push(e), () => {});
  expect(seen).toEqual([
    {
      type: "snapshot",
      state: {
        lines: [
          { kind: "user", text: "hi" },
          { kind: "assistant", text: "hello" },
        ],
        streaming: "",
        busy: false,
        jobs: [],
        secrets: [],
        connected: true,
      },
    },
  ]);
});

test("reset handoffs and compaction summaries are hidden; tools and errors are lines", () => {
  const { hub, seen } = subscribed();
  hub.events([
    snapshot(
      [
        user("a"),
        { kind: "pi.reset", model: [{ role: "user", content: "handoff" }] },
        { kind: "pi.compaction", model: [{ role: "user", content: "summary" }] },
        assistant("done", ["web_search"]),
        { kind: "pi.message", model: [{ role: "assistant", content: [], errorMessage: "boom" }] },
        { kind: "pi.message", model: [{ role: "toolResult", content: [{ type: "text", text: "raw" }] }] },
      ],
      { id: "r" },
    ),
  ]);
  expect(seen.at(-1)).toEqual({
    type: "transcript",
    lines: [
      { kind: "user", text: "a" },
      { kind: "assistant", text: "done" },
      { kind: "tool", text: "⚙ web_search" },
      { kind: "info", text: "boom" },
    ],
    streaming: "",
    busy: true,
  });
  expect(JSON.stringify(seen)).not.toMatch(/handoff|summary|raw/);
});

test("updates are minimal: busy, delta, lines and a cleared stream", () => {
  const { hub, seen } = subscribed();
  hub.events([snapshot([])]);
  seen.length = 0;
  hub.events([ev("run_start"), end(user("q"))]);
  expect(seen).toEqual([
    { type: "lines", lines: [{ kind: "user", text: "q" }] },
    { type: "busy", busy: true },
  ]);
  seen.length = 0;
  hub.events([delta("Hel")]);
  hub.events([delta("lo")]);
  expect(seen).toEqual([
    { type: "delta", text: "Hel" },
    { type: "delta", text: "lo" },
  ]);
  seen.length = 0;
  hub.events([end(assistant("Hello")), ev("run_end")]);
  expect(seen).toEqual([
    { type: "lines", lines: [{ kind: "assistant", text: "Hello" }] },
    { type: "streaming", text: "" },
    { type: "busy", busy: false },
  ]);
  seen.length = 0;
  hub.events([ev("auto_retry_start", { errorMessage: "overloaded" })]);
  expect(seen).toEqual([{ type: "lines", lines: [{ kind: "info", text: "retrying: overloaded" }] }]);
});

test("a stream that restarts is replaced, and a fresh snapshot rewrites the transcript", () => {
  const { hub, seen } = subscribed();
  hub.events([snapshot([user("q")])]);
  hub.events([delta("first")]);
  seen.length = 0;
  hub.events([end(assistant("first")), delta("sec")]);
  expect(seen).toEqual([
    { type: "lines", lines: [{ kind: "assistant", text: "first" }] },
    { type: "streaming", text: "sec" },
  ]);
  seen.length = 0;
  hub.events([snapshot([user("other")])]);
  expect(seen).toEqual([{ type: "transcript", lines: [{ kind: "user", text: "other" }], streaming: "", busy: false }]);
  hub.events([]);
  expect(seen).toHaveLength(1);
});

test("jobs and secrets are sent whole when they change, as views", () => {
  const { hub, seen } = subscribed();
  const job = {
    id: "1",
    title: "Sum",
    brief: "Add",
    status: "running",
    conversationId: "c",
    progress: "half",
    createdAt: 1,
    updatedAt: 2,
    seq: 0,
    reported: [],
  } as unknown as Job;
  hub.jobs([job]);
  hub.jobs([job]);
  expect(seen.slice(1)).toEqual([
    {
      type: "jobs",
      jobs: [{ id: "1", title: "Sum", brief: "Add", status: "running", progress: "half", createdAt: 1, updatedAt: 2 }],
    },
  ]);
  hub.secrets([{ id: "s1", name: "svc.token", why: "to sync", at: 3 }]);
  expect(seen.at(-1)).toEqual({ type: "secrets", pending: [{ id: "s1", name: "svc.token", why: "to sync", at: 3 }] });
  expect(hub.snapshot().jobs).toHaveLength(1);
});

test("a subscriber whose send throws is dropped; unsubscribe stops updates", () => {
  const hub = createHub();
  let calls = 0;
  hub.subscribe(
    (e) => {
      calls++;
      if (e.type !== "snapshot") throw new Error("gone");
    },
    () => {},
  );
  const { seen, unsubscribe } = (() => {
    const seen: LiveEvent[] = [];
    return { seen, unsubscribe: hub.subscribe((e) => seen.push(e), () => {}) };
  })();
  hub.events([ev("run_start")]);
  hub.events([ev("run_end")]);
  expect(calls).toBe(2);
  expect(seen).toHaveLength(3);
  unsubscribe();
  hub.events([ev("run_start")]);
  expect(seen).toHaveLength(3);
});

test("close calls every subscriber's close, and later subscribers are closed at once", () => {
  const { hub, closed } = subscribed();
  hub.close();
  expect(closed()).toBe(1);
  let late = 0;
  hub.subscribe(() => {}, () => late++);
  expect(late).toBe(1);
});

test("startLive watches the context and stop ends the watches", async () => {
  const listeners: { events?: (e: readonly AgentEvent[]) => void } = {};
  let stopped = 0;
  const watch = { stop: async () => void stopped++ };
  const live = await startLive({
    root: {
      events: async (l: (e: readonly AgentEvent[]) => void) => {
        listeners.events = l;
        l([snapshot([user("hi")])]);
        return watch;
      },
    } as never,
    jobs: async (l) => {
      l([]);
      return watch;
    },
    secrets: { pending: async (l: (p: never[]) => void) => (l([]), watch) } as never,
  });
  expect(live.snapshot().lines).toEqual([{ kind: "user", text: "hi" }]);
  let closed = 0;
  live.subscribe(() => {}, () => closed++);
  await live.stop();
  expect(stopped).toBe(3);
  expect(closed).toBe(1);
});

test("text carried on message_start shows in the stream", () => {
  const { hub, seen } = subscribed();
  hub.events([snapshot([])]);
  seen.length = 0;
  const start = ev("message_start", { message: { role: "assistant", content: [{ type: "text", text: "# Ti" }] } });
  hub.events([start, delta("tle")]);
  expect(hub.snapshot().streaming).toBe("# Title");
  hub.events([ev("message_start", { message: { role: "user", content: "q" } })]);
  expect(hub.snapshot().streaming).toBe("# Title");
});
