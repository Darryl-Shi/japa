import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, onTestFinished, test, vi } from "vitest";
import { defineJapaExtension, type JapaExtension, type Reply, type TriggerContext } from "../src/sdk.ts";
import { bootTest, probe, waitFor } from "./helpers.ts";
import { ask, held, say, script } from "./jobs-helpers.ts";

/** Boots with a probe surface; `respond` (default: `re: <text>` to each input) answers the CoS; collects `replies`. */
async function start(
  respond: Parameters<typeof script>[1] = (role, text) => (role === "user" ? say(`re: ${text}`) : undefined),
  extra: JapaExtension[] = [],
) {
  const { extension, surface } = probe();
  const { daemon, faux } = await bootTest({}, [extension, ...extra]);
  script(faux, respond);
  const replies: Reply[] = [];
  const watch = await surface().root.replies((r) => void replies.push(r));
  const close = async () => {
    await watch.stop();
    await daemon.close();
  };
  return { daemon, faux, surface, replies, close };
}

test("each assistant message with text is a reply, in order, without tool calls", async () => {
  const { daemon, replies, close } = await start((role, text) => {
    if (text === "go") {
      return fauxAssistantMessage([fauxText("Looking."), fauxToolCall("settings_get", {})], { stopReason: "toolUse" });
    }
    if (role === "toolResult") return say("Done.");
  });
  await ask(daemon, "go");
  await vi.waitFor(() => expect(replies.map((r) => r.text)).toEqual(["Looking.", "Done."]));
  expect(Number(replies[0]!.cursor)).toBeLessThan(Number(replies[1]!.cursor));
  await close();
});

test("a reply carries the origin of the input it answers", async () => {
  let emit!: TriggerContext["emit"];
  const tick = defineJapaExtension({
    name: "tick",
    summary: "Ticks",
    provides: {
      trigger: [
        {
          name: "tick",
          start: async (c: TriggerContext) => {
            emit = c.emit;
            return () => {};
          },
        },
      ],
    },
  });
  const { daemon, surface, replies, close } = await start(undefined, [tick]);
  await surface().root.submit("a", undefined, { surface: "fake", chat: "9" });
  await daemon.root.waitForIdle(ctx);
  await ask(daemon, "b");
  await emit({ key: "k", text: "c" });
  await vi.waitFor(() =>
    expect(replies.map((r) => [r.text, r.origin])).toEqual([
      ["re: a", { surface: "fake", chat: "9" }],
      ["re: b", { surface: "gateway" }],
      ["re: [tick] c", "proactive"],
    ]),
  );
  await close();
});

test.each(["steer", "followUp"] as const)("a %s takes over the run's origin", async (mode) => {
  const hold = held();
  const { daemon, surface, replies, close } = await start((role, text, signal) => {
    if (text === "first") return hold.wait(say("a1"), signal);
    if (text === "second") return say("a2");
  });
  await daemon.root.submit({ type: "input", content: "first" }, ctx);
  await waitFor(() => hold.started());
  await surface().root.submit("second", mode, { surface: "fake", chat: "9" });
  hold.release();
  await vi.waitFor(() =>
    expect(replies.map((r) => [r.text, r.origin])).toEqual([
      ["a1", { surface: "gateway" }],
      ["a2", { surface: "fake", chat: "9" }],
    ]),
  );
  await close();
});

test("replies resume after a cursor", async () => {
  const { daemon, surface, replies, close } = await start();
  for (const text of ["one", "two", "three"]) await ask(daemon, text);
  await vi.waitFor(() => expect(replies).toHaveLength(3));
  const again: Reply[] = [];
  const watch = await surface().root.replies((r) => void again.push(r), replies[0]!.cursor);
  await vi.waitFor(() => expect(again.map((r) => r.text)).toEqual([replies[1]!.text, replies[2]!.text]));
  await watch.stop();
  await close();
});

test("without a cursor, replies start from now", async () => {
  const { daemon, surface, close } = await start();
  await ask(daemon, "old");
  const later: Reply[] = [];
  const watch = await surface().root.replies((r) => void later.push(r));
  await ask(daemon, "new");
  await vi.waitFor(() => expect(later.map((r) => r.text)).toEqual(["re: new"]));
  await watch.stop();
  await close();
});

test("a model error reaches replies as its message", async () => {
  const { daemon, faux, replies, close } = await start();
  faux.setResponses([fauxAssistantMessage([], { stopReason: "error", errorMessage: "No API key for faux" })]);
  await ask(daemon, "hi");
  await vi.waitFor(() => expect(replies.at(-1)!.text).toBe("No API key for faux"));
  await close();
});

test("a sent file is a reply after the text before it, with the caption as text; a failed send isn't", async () => {
  const dir = mkdtempSync(join(tmpdir(), "japa-replies-"));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "chart.png");
  writeFileSync(path, "png");
  const { daemon, surface, replies, close } = await start((role, text) => {
    if (text === "go") {
      const send = fauxToolCall("send_file", { path, caption: "The chart" });
      return fauxAssistantMessage([fauxText("Here it is."), send], { stopReason: "toolUse" });
    }
    if (text === "plain") return fauxAssistantMessage([fauxToolCall("send_file", { path })], { stopReason: "toolUse" });
    if (text === "missing") {
      const send = fauxToolCall("send_file", { path: join(dir, "gone.png") });
      return fauxAssistantMessage([send], { stopReason: "toolUse" });
    }
    if (role === "toolResult") return say("Sent.");
  });
  await ask(daemon, "go");
  const file = { path, name: "chart.png", mimeType: "image/png", size: 3 };
  await vi.waitFor(() => expect(replies).toHaveLength(3));
  expect(replies.map(({ text, file }) => ({ text, file }))).toEqual([
    { text: "Here it is.", file: undefined },
    { text: "The chart", file: { ...file, caption: "The chart" } },
    { text: "Sent.", file: undefined },
  ]);
  const cursors = replies.map((r) => Number(r.cursor));
  expect(cursors).toEqual(cursors.toSorted((a, b) => a - b));
  expect(new Set(cursors).size).toBe(3);

  // Without a caption the text is empty; a failed send_file isn't a reply.
  await ask(daemon, "plain");
  await ask(daemon, "missing");
  await vi.waitFor(() => expect(replies).toHaveLength(6));
  expect(replies.slice(3).map(({ text, file }) => ({ text, file }))).toEqual([
    { text: "", file },
    { text: "Sent.", file: undefined },
    { text: "Sent.", file: undefined },
  ]);

  // Resuming after the text before the file delivers the file again; after the file, not.
  const again: Reply[] = [];
  const watch = await surface().root.replies((r) => void again.push(r), replies[0]!.cursor);
  await vi.waitFor(() => expect(again).toHaveLength(5));
  expect(again[0]!.file).toEqual({ ...file, caption: "The chart" });
  const after: Reply[] = [];
  const watch2 = await surface().root.replies((r) => void after.push(r), replies[1]!.cursor);
  await vi.waitFor(() => expect(after).toHaveLength(4));
  expect(after.filter((r) => r.file !== undefined)).toEqual([replies[3]]);
  await watch.stop();
  await watch2.stop();
  await close();
});
