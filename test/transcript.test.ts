import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { type AgentEvent, CompactionEntry } from "@earendil-works/pi-durable";
import { expect, test, vi } from "vitest";
import { connect } from "../extensions/gateway/client.ts";
import { applyEvents, type Line, lineText, type Transcript } from "../extensions/gateway/transcript.ts";
import { bootTest, resetDone } from "./helpers.ts";
import { ask, script } from "./jobs-helpers.ts";

test("transcript shows the exchange from real gateway events", async () => {
  const { daemon, faux, home } = await bootTest();
  faux.setResponses([fauxAssistantMessage([fauxText("Hi there")])]);
  const client = await connect(home);
  let t: Transcript = { lines: [{ kind: "info", text: "stale" }], streaming: "", busy: false };
  client.onMessage((m) => {
    if (m.type === "events") t = applyEvents(t, m.events);
  });
  client.send({ type: "attach" });
  await vi.waitFor(() => expect(t.lines).toEqual([]));
  client.send({ type: "submit", text: "hello" });
  await vi.waitFor(() =>
    expect(t.lines).toEqual([
      { kind: "user", text: "hello" },
      { kind: "assistant", text: "Hi there" },
    ]),
  );
  expect(t.busy).toBe(false);
  client.close();
  await daemon.close();
});

test("surfaces keep the whole history and hide the carry-over", async () => {
  const { daemon, faux, home } = await bootTest();
  script(faux, () => undefined);
  const attach = async () => {
    const client = await connect(home);
    const view = { t: { lines: [], streaming: "", busy: false } as Transcript, client, attached: false };
    client.onMessage((m) => {
      if (m.type === "events") view.t = applyEvents(view.t, m.events);
      view.attached = true;
    });
    client.send({ type: "attach" });
    return view;
  };
  const live = await attach();
  await vi.waitFor(() => expect(live.attached).toBe(true));
  await ask(daemon, "before");
  await resetDone(daemon);
  await ask(daemon, "after");
  const later = await attach();

  const expected = [
    { kind: "user", text: "before" },
    { kind: "assistant", text: "ok" },
    { kind: "user", text: "after" },
    { kind: "assistant", text: "ok" },
  ];
  await vi.waitFor(() => expect(live.t.lines).toEqual(expected));
  await vi.waitFor(() => expect(later.t.lines).toEqual(expected));
  live.client.close();
  later.client.close();
  await daemon.close();
});

test("surfaces show the history across a compaction once and hide its summary", async () => {
  const { daemon, faux, home } = await bootTest();
  script(faux, () => undefined);
  await ask(daemon, "one");
  await ask(daemon, "two");
  const page = await daemon.root.entries({}, 200, undefined, ctx);
  const two = page.items.find((e) => e.model?.[0]?.role === "user" && e.model[0].content === "two")!;
  const summary = { role: "user" as const, content: "SUMMARY", timestamp: 0 };
  const entry = { kind: CompactionEntry.kind, head: two.id, model: [summary], data: { reason: "manual" } };
  await (await daemon.root.submit({ type: "write", entry }, ctx)).wait(ctx);
  await ask(daemon, "three");

  const client = await connect(home);
  let t: Transcript = { lines: [], streaming: "", busy: false };
  client.onMessage((m) => {
    if (m.type === "events") t = applyEvents(t, m.events);
  });
  client.send({ type: "attach" });
  await vi.waitFor(() =>
    expect(t.lines.map((l) => l.text)).toEqual(["one", "ok", "two", "ok", "three", "ok"]),
  );
  client.close();
  await daemon.close();
});

test("tool calls and errors become their own lines", () => {
  const message = { role: "assistant", content: [{ type: "toolCall", name: "read" }], errorMessage: "boom" };
  const event = { type: "message_end", entry: { model: [message] } } as unknown as AgentEvent;
  const t = applyEvents({ lines: [], streaming: "partial", busy: true }, [event]);
  expect(t).toEqual({
    lines: [
      { kind: "tool", text: "\u2699 read" },
      { kind: "info", text: "boom" },
    ],
    streaming: "",
    busy: true,
  });
});

test("japa chat shows a job report and a kernel note apart from a person's input", async () => {
  const { daemon, faux, home } = await bootTest();
  script(faux, () => undefined);
  const client = await connect(home);
  let t: Transcript = { lines: [], streaming: "", busy: false };
  let attached = false;
  client.onMessage((m) => {
    if (m.type === "events") t = applyEvents(t, m.events, new Map(m.sources ?? []));
    attached = true;
  });
  client.send({ type: "attach" });
  await vi.waitFor(() => expect(attached).toBe(true));
  client.send({ type: "submit", text: '[job 1 "x" done] typed' });
  await vi.waitFor(() => expect(t.lines).toHaveLength(2));
  await daemon.root.waitForIdle(ctx);
  await (
    await daemon.root.submit(
      { type: "input", content: '[job 4 "Say "hi"" failed] It broke.', requestId: "report:4:1" },
      ctx,
    )
  ).wait(ctx);
  await (await daemon.root.submit({ type: "input", content: "[schedule] wake", requestId: "trigger:schedule:k" }, ctx)).wait(ctx);
  const expected: Line[] = [
    { kind: "user", text: '[job 1 "x" done] typed' },
    { kind: "assistant", text: "ok" },
    { kind: "report", jobId: "4", title: 'Say "hi"', status: "failed", text: "It broke." },
    { kind: "assistant", text: "ok" },
    { kind: "note", text: "[schedule] wake" },
    { kind: "assistant", text: "ok" },
  ];
  await vi.waitFor(() => expect(t.lines).toEqual(expected));
  expect(t.lines.map(lineText).slice(0, 5)).toEqual([
    '› [job 1 "x" done] typed',
    "ok",
    '◆ job "Say "hi"" failed\nIt broke.',
    "ok",
    "\x1b[2m· [schedule] wake\x1b[22m",
  ]);
  // A fresh attach (snapshot) shows the same.
  const later = await connect(home);
  let again: Transcript = { lines: [], streaming: "", busy: false };
  later.onMessage((m) => {
    if (m.type === "events") again = applyEvents(again, m.events, new Map(m.sources ?? []));
  });
  later.send({ type: "attach" });
  await vi.waitFor(() => expect(again.lines).toEqual(expected));
  client.close();
  later.close();
  await daemon.close();
});
