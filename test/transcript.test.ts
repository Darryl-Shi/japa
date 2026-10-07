import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import type { AgentEvent } from "@earendil-works/pi-durable";
import { expect, test, vi } from "vitest";
import { connect } from "../extensions/gateway/client.ts";
import { applyEvents, type Transcript } from "../extensions/gateway/transcript.ts";
import { bootTest } from "./helpers.ts";
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

test("surfaces keep the history from before a reset and hide the handoff", async () => {
  const { daemon, faux, home } = await bootTest();
  script(faux, (_role, text) => {
    if (text.startsWith("Conversation since")) {
      const args = { facts: [], loops: [], episode: "e", handoff: "HANDOFF" };
      return fauxAssistantMessage([fauxToolCall("save", args)], { stopReason: "toolUse" });
    }
  });
  const attach = async () => {
    const client = await connect(home);
    const view = { t: { lines: [], streaming: "", busy: false } as Transcript, client };
    client.onMessage((m) => {
      if (m.type === "events") view.t = applyEvents(view.t, m.events);
    });
    client.send({ type: "attach" });
    return view;
  };
  const live = await attach();
  await ask(daemon, "before");
  await daemon.consolidate();
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
