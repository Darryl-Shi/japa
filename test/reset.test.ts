import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import {
  type FauxProviderHandle,
  type FauxResponseFactory,
  fauxAssistantMessage,
  fauxToolCall,
  getSystemMessageText,
  type Message,
} from "@earendil-works/pi-ai";
import { type EntryRecord, InboxDoc, ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { expect, test } from "vitest";
import { boot } from "../src/kernel/boot.ts";
import { MemoryDoc } from "../src/kernel/memory/state.ts";
import { lastExchange, resetRoot } from "../src/kernel/reset.ts";
import { defineJapaExtension, defineTool, Type } from "../src/sdk.ts";
import { bootTest, carryOver, NO_BWRAP, REPO_EXTENSIONS, tempHome, testKit, waitFor } from "./helpers.ts";
import { ask, call, held, idle, reported, say, script, textOf, texts } from "./jobs-helpers.ts";

const entry = (kind: string, message?: object, extra: object = {}) =>
  ({ id: 1, conversationId: 1, kind, model: message && [message], ...extra }) as unknown as EntryRecord;
const userEntry = (text: string) => entry("pi.user", { role: "user", content: text });
const assistantEntry = (text: string) => entry("pi.assistant", { role: "assistant", content: [{ type: "text", text }] });

/** Answers every request with "ok"; returns every request's messages. */
function route(faux: FauxProviderHandle): Message[][] {
  const requests: Message[][] = [];
  const step: FauxResponseFactory = ({ messages }) => {
    requests.push(messages);
    return say("ok");
  };
  faux.setResponses(Array.from({ length: 20 }, () => step));
  return requests;
}

/** Answers reflection requests with an empty `save`; returns their prompts. */
function reflections(faux: FauxProviderHandle): string[] {
  const prompts: string[] = [];
  script(faux, (_role, text) => {
    if (!text.startsWith("Turns since")) return;
    prompts.push(text);
    return fauxAssistantMessage([fauxToolCall("save", { facts: [], episode: "e" })], { stopReason: "toolUse" });
  });
  return prompts;
}

test("the carry-over is the inputs and the final answer only", () => {
  expect(
    lastExchange([
      entry("pi.reset", { role: "user", content: "[Your last exchange]\nuser: older" }, { head: 1 }),
      userEntry("fix the build"),
      entry("pi.assistant", { role: "assistant", content: [{ type: "toolCall", id: "1", name: "read", arguments: {} }] }),
      entry("pi.tool-result", { role: "toolResult", toolName: "read", content: [{ type: "text", text: "FILE" }] }),
      entry("pi.assistant", {
        role: "assistant",
        content: [{ type: "thinking", thinking: "hm" }, { type: "text", text: "Done." }],
      }),
    ]),
  ).toBe("[Your last exchange]\nuser: fix the build\nyou: Done.");
});

test("every input of the run is carried over and an image becomes a note", () => {
  const text = lastExchange([
    userEntry("look at this"),
    entry("pi.user", { role: "user", content: [{ type: "image", data: "...", mimeType: "image/png" }] }),
    assistantEntry("Nice."),
  ]);
  expect(text).toBe("[Your last exchange]\nuser: look at this\nuser: [image]\nyou: Nice.");
});

test("an exchange over 2 000 tokens is cut in the middle of its longest part", () => {
  const text = lastExchange([userEntry("hi"), assistantEntry("y".repeat(20000))])!;
  expect(text.length).toBe(8000);
  expect(text.startsWith("[Your last exchange]\nuser: hi\nyou: yyy")).toBe(true);
  expect(text).toContain("[…]");
  expect(text.endsWith("yyy")).toBe(true);
});

test("a run with neither an input nor an answer has no carry-over", () => {
  expect(lastExchange([entry("pi.reset", undefined, { head: 1 })])).toBeUndefined();
});

test("a settled turn ends with the last exchange, and the next turn sees it", async () => {
  const { daemon, faux } = await bootTest();
  const requests = route(faux);
  await ask(daemon, "I'm Ada");
  expect(await carryOver(daemon)).toBe("[Your last exchange]\nuser: I'm Ada\nyou: ok");

  await daemon.root.commit(async (tx) => {
    (await tx.doc(MemoryDoc, ROOT_CONVERSATION_ID)).facts.push({ id: "1", text: "Ada likes tea", updatedAt: 0 });
  }, ctx);
  await ask(daemon, "What's next?");
  const last = requests.at(-1)!;
  expect(last.filter((m) => m.role !== "system").map(textOf)).toEqual([
    "[Your last exchange]\nuser: I'm Ada\nyou: ok",
    "What's next?",
  ]);
  expect(last.flatMap((m) => (m.role === "system" ? [getSystemMessageText(m)] : [])).join("\n")).toMatch(/about-you/);
  expect(await texts(daemon.root, "user")).toEqual([
    "I'm Ada",
    "[Your last exchange]\nuser: I'm Ada\nyou: ok",
    "What's next?",
  ]);
  await daemon.close();
});

test("the reset makes no model call", async () => {
  const { daemon, faux } = await bootTest();
  script(faux, () => undefined);
  const before = faux.state.callCount;
  await ask(daemon, "hi");
  await carryOver(daemon);
  expect(faux.state.callCount).toBe(before + 1);
  await daemon.close();
});

test("no reset while the run is still going", async () => {
  const { daemon, faux } = await bootTest();
  const hold = held();
  script(faux, (_role, _text, signal) => hold.wait(say("ok"), signal));
  await daemon.root.submit({ type: "input", content: "hi" }, ctx);
  await waitFor(() => hold.started());
  expect(await resetRoot(daemon.root)).toBe(false);

  hold.release();
  expect(await carryOver(daemon)).toBe("[Your last exchange]\nuser: hi\nyou: ok");
  await daemon.close();
});

test("no reset while an input is queued", async () => {
  const { daemon } = await bootTest();
  // An idle root whose turn has not reset, with an input still queued, as a run that ended without a boundary leaves.
  const written = { kind: "pi.user", model: [{ role: "user" as const, content: "hi", timestamp: 0 }] };
  await (await daemon.root.submit({ type: "write", entry: written }, ctx)).wait(ctx);
  await daemon.root.commit(async (tx) => {
    const queued = await tx.createSubmission({ conversationId: ROOT_CONVERSATION_ID, type: "input", status: "queued" });
    (await tx.doc(InboxDoc, ROOT_CONVERSATION_ID)).items.push({ id: queued.id, mode: "followUp", content: "next" });
  }, ctx);
  expect(await resetRoot(daemon.root)).toBe(false);

  await daemon.root.commit(async (tx) => void (await tx.doc(InboxDoc, ROOT_CONVERSATION_ID)).items.pop(), ctx);
  expect(await resetRoot(daemon.root)).toBe(true);
  await daemon.close();
});

test("a second reset for the same turn does nothing", async () => {
  const { daemon, faux } = await bootTest();
  script(faux, () => undefined);
  await ask(daemon, "hi");
  await carryOver(daemon);
  expect(await resetRoot(daemon.root)).toBe(false);
  await daemon.close();
});

test("a steered chain resets once, after the chain settles", async () => {
  const { daemon, faux } = await bootTest();
  const hold = held();
  script(faux, (_role, text, signal) => (text === "first" ? hold.wait(say("ok"), signal) : undefined));
  await daemon.root.submit({ type: "input", content: "first" }, ctx);
  await waitFor(() => hold.started());
  await daemon.root.submit({ type: "input", content: "also this", whenBusy: "steer" }, ctx);
  hold.release();

  const carry = "[Your last exchange]\nuser: first\nuser: also this\nyou: ok";
  expect(await carryOver(daemon)).toBe(carry);
  expect(await texts(daemon.root, "user")).toEqual(["first", "also this", carry]);
  await daemon.close();
});

test.skipIf(NO_BWRAP)("a job report resets the context like any other turn", async () => {
  const { daemon, faux } = await bootTest();
  const hold = held(); // the job reports after the turn that started it has settled and reset
  script(faux, (_role, text, signal) => {
    if (text === "report") return call("job_start", { title: "Report", brief: "Say hi" });
    if (text === "Say hi") return hold.wait(call("job_complete", { summary: "hi" }), signal);
  });
  await ask(daemon, "report");
  await carryOver(daemon);

  hold.release();
  await waitFor(async () => (await reported(daemon)).length > 0);
  await waitFor(() => idle(daemon));
  expect(await carryOver(daemon)).toMatch(/^\[Your last exchange\]\nuser: \[job 1 "Report" done\] /);
  await daemon.close();
});

test("a turn with no answer resets without an answer line", async () => {
  const { daemon, faux } = await bootTest();
  const hold = held();
  script(faux, (_role, _text, signal) => hold.wait(say("ok"), signal));
  await daemon.root.submit({ type: "input", content: "hi" }, ctx);
  await waitFor(() => hold.started());
  await daemon.root.abort(ctx);
  expect(await carryOver(daemon)).toBe("[Your last exchange]\nuser: hi");
  await daemon.close();
});

test("reflection runs after the 5th unreflected turn", async () => {
  const { daemon, faux } = await bootTest();
  const prompts = reflections(faux);
  for (const t of ["1", "2", "3", "4", "5"]) {
    await ask(daemon, t);
    await carryOver(daemon);
  }
  await waitFor(() => prompts.length > 0);
  await daemon.close();
});

test("boot reflects the turns left unreflected", async () => {
  const kit = testKit();
  const home = tempHome({ models: { cos: kit.model } }); // default storage: sqlite, so the turn survives the restart
  const first = await boot({ home, extensionDirs: [REPO_EXTENSIONS], extensions: [kit.extension] });
  script(kit.faux, () => undefined);
  await ask(first, "hello");
  await carryOver(first);
  await first.close();

  const prompts = reflections(kit.faux);
  const reopened = await boot({ home, extensionDirs: [REPO_EXTENSIONS], extensions: [kit.extension] });
  await waitFor(() => prompts.length > 0); // one unreflected turn is enough at boot
  await reopened.close();
});

const bulky = defineJapaExtension({
  name: "bulky",
  summary: "A tool with a long result",
  examples: ["bulky"],
  docs: "Bulky.",
  provides: {
    tool: [
      defineTool({
        name: "bulky",
        description: "Return a lot of text",
        parameters: Type.Object({}),
        execute: async () => ({ content: [{ type: "text", text: "x".repeat(20_000) }] }),
      }),
    ],
  },
});

test("a long single turn compacts the root instead of overflowing", { timeout: 30_000 }, async () => {
  const kit = testKit({ models: [{ id: "wide", contextWindow: 40_000 }] });
  const { daemon, faux } = await bootTest({}, [bulky], kit);
  let calls = 0;
  script(faux, (role) => {
    if (role === "user" || role === "toolResult") return calls++ < 8 ? call("bulky", {}) : say("done");
  });
  await ask(daemon, "work");

  const page = await daemon.root.entries({}, 200, undefined, ctx);
  expect(page.items.some((e) => e.kind === "pi.compaction")).toBe(true);
  await daemon.close();
});
