import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import type { AgentEvent } from "@earendil-works/pi-durable";
import { expect, test, vi } from "vitest";
import { connect } from "../extensions/gateway/client.ts";
import { applyEvents, type Transcript } from "../extensions/gateway/transcript.ts";
import { bootTest } from "./helpers.ts";

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
