import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import {
  type FauxProviderHandle,
  type FauxResponseFactory,
  fauxAssistantMessage,
  fauxToolCall,
  getSystemMessageText,
  type Message,
} from "@earendil-works/pi-ai";
import { type ConversationId, InboxDoc, ResetEntry, ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { expect, test } from "vitest";
import { boot } from "../src/kernel/boot.ts";
import { DAY, JobsDoc } from "../src/kernel/jobs/state.ts";
import { MemoryDoc } from "../src/kernel/memory/state.ts";
import { resetRoot } from "../src/kernel/reset.ts";
import { defineJapaExtension, defineTool, Type } from "../src/sdk.ts";
import { bootTest, NO_BWRAP, REPO_EXTENSIONS, resetDone, tempHome, testKit, waitFor } from "./helpers.ts";
import { ask, call, held, idle, reported, say, script, textOf, texts } from "./jobs-helpers.ts";

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

/** The injected context of `request`: its first non-system message, when it is one. */
const injected = (request: Message[]) => textOf(request.find((m) => m.role !== "system")!);

test("a settled turn ends with a reset that carries nothing", async () => {
  const { daemon, faux } = await bootTest();
  route(faux);
  await ask(daemon, "I'm Ada");
  await resetDone(daemon);
  const newest = (await daemon.root.entries({}, 1, undefined, ctx)).items[0]!;
  expect(newest.kind).toBe(ResetEntry.kind);
  expect(newest.model).toBeUndefined();
  await daemon.close();
});

test("the next turn sees the conversation so far", async () => {
  const { daemon, faux } = await bootTest();
  const requests = route(faux);
  await ask(daemon, "I'm Ada");
  await resetDone(daemon);

  await daemon.root.commit(async (tx) => {
    (await tx.doc(MemoryDoc, ROOT_CONVERSATION_ID)).facts.push({ id: "1", text: "Ada likes tea", updatedAt: 0 });
  }, ctx);
  await ask(daemon, "What's next?");
  const last = requests.at(-1)!;
  const sent = last.filter((m) => m.role !== "system").map(textOf);
  expect(sent).toHaveLength(2);
  expect(sent[0]!.startsWith("[Conversation so far]")).toBe(true);
  expect(sent[0]).toContain("I'm Ada");
  expect(sent[1]).toBe("What's next?");
  expect(last.flatMap((m) => (m.role === "system" ? [getSystemMessageText(m)] : [])).join("\n")).toMatch(/about-you/);
  expect(await texts(daemon.root, "user")).toEqual(["I'm Ada", "What's next?"]); // the context isn't stored
  await daemon.close();
});

test("the context is built once per run", async () => {
  const { daemon, faux } = await bootTest();
  const requests: Message[][] = [];
  let rounds = 0;
  const step: FauxResponseFactory = async ({ messages }) => {
    requests.push(messages);
    const final = messages.findLast((m) => m.role !== "system")!;
    const last = textOf(final);
    if (last === "deploy the widget") {
      // A job that recall would find, finished while the run is going: a rebuilt context would show it.
      await daemon.root.commit(async (tx) => {
        const doc = await tx.doc(JobsDoc, ROOT_CONVERSATION_ID);
        doc.jobs["9"] = {
          id: "9",
          title: "Widget",
          brief: "b",
          status: "done",
          conversationId: 99 as ConversationId,
          result: "the widget deploy runbook is ready",
          createdAt: Date.now(),
          updatedAt: Date.now(),
          seq: 1,
          reported: [],
        };
      }, ctx);
    }
    if (final.role === "user" && last === "deploy the widget") return call("memory_facts", {});
    if (final.role === "toolResult" && rounds++ < 1) return call("memory_facts", {});
    return say("ok");
  };
  faux.setResponses(Array.from({ length: 20 }, () => step));
  await ask(daemon, "I'm Ada");
  await resetDone(daemon);
  const from = requests.length;
  await ask(daemon, "deploy the widget");

  const run = requests.slice(from);
  expect(run).toHaveLength(3); // two tool rounds, then the answer
  const first = injected(run[0]!);
  expect(first.startsWith("[Conversation so far]")).toBe(true);
  for (const request of run) expect(injected(request)).toBe(first);
  expect(first).not.toContain("runbook");
  await daemon.close();
});

test("the WhatsApp replay", async () => {
  const { daemon, faux } = await bootTest();
  const requests = route(faux);
  await ask(daemon, "+65 91466066");
  await resetDone(daemon);
  await ask(daemon, "[whatsapp] WhatsApp was unlinked; send the new pairing code to link it again.");
  await resetDone(daemon);
  await ask(daemon, "new code pls");
  expect(injected(requests.at(-1)!)).toContain("+65 91466066");
  await daemon.close();
});

test("the jellyfin replay", async () => {
  const { daemon, faux } = await bootTest();
  const requests = route(faux);
  await ask(daemon, "jellyfin and maria can go");
  await resetDone(daemon);
  await ask(daemon, '[job 68 "Cleanup" done] Server 1 cleanup is done: disk use went from 74 GB to 45 GB.');
  await resetDone(daemon);
  await ask(daemon, "what's wrong with mariadb and jellyfin");
  const text = injected(requests.at(-1)!);
  expect(text).toContain("jellyfin and maria can go");
  expect(text).toContain("job 68 report");
  expect(text.indexOf("jellyfin and maria can go")).toBeLessThan(text.indexOf("job 68 report"));
  await daemon.close();
});

test("an old discussion comes back through recall", async () => {
  const { daemon, faux } = await bootTest();
  const requests = route(faux);
  const old = { role: "user" as const, content: "superpowers is too much ceremony", timestamp: Date.now() - 2 * DAY };
  await (await daemon.root.submit({ type: "write", entry: { kind: "pi.user", model: [old] } }, ctx)).wait(ctx);
  await ask(daemon, "hello"); // today's conversation starts: the old message is out of the window
  await resetDone(daemon);
  await ask(daemon, "my complaint about superpowers");
  const text = injected(requests.at(-1)!);
  expect(text).toContain("[From earlier");
  expect(text).toContain("too much ceremony");
  await daemon.close();
});

test("a brand-new root's first turn has nothing injected", async () => {
  const { daemon, faux } = await bootTest();
  const requests = route(faux);
  await ask(daemon, "hi");
  expect(requests.at(-1)!.filter((m) => m.role !== "system").map(textOf)).toEqual(["hi"]);
  await daemon.close();
});

test("the reset makes no model call", async () => {
  const { daemon, faux } = await bootTest();
  script(faux, () => undefined);
  const before = faux.state.callCount;
  await ask(daemon, "hi");
  await resetDone(daemon);
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
  await resetDone(daemon);
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
  await resetDone(daemon);
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

  await resetDone(daemon);
  await waitFor(() => idle(daemon));
  const entries = (await daemon.root.entries({}, 200, undefined, ctx)).items;
  expect(entries.filter((e) => e.kind === ResetEntry.kind)).toHaveLength(1);
  expect(await texts(daemon.root, "user")).toEqual(["first", "also this"]);
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
  await resetDone(daemon);

  hold.release();
  await waitFor(async () => (await reported(daemon)).length > 0);
  await waitFor(() => idle(daemon));
  await resetDone(daemon);
  const entries = (await daemon.root.entries({}, 200, undefined, ctx)).items.toReversed();
  const resets = entries.flatMap((e, i) => (e.kind === ResetEntry.kind ? [i] : []));
  expect(resets).toHaveLength(2);
  const report = entries.findIndex((e) => e.model?.some((m) => m.role === "user" && textOf(m).startsWith('[job 1 "Report" done]')));
  expect(report).toBeGreaterThan(resets[0]!); // the report's turn is the second one
  await daemon.close();
});

test("a turn with no answer still resets", async () => {
  const { daemon, faux } = await bootTest();
  const hold = held();
  script(faux, (_role, _text, signal) => hold.wait(say("ok"), signal));
  await daemon.root.submit({ type: "input", content: "hi" }, ctx);
  await waitFor(() => hold.started());
  await daemon.root.abort(ctx);
  await resetDone(daemon);
  await daemon.close();
});

test("reflection runs after the 5th unreflected turn", async () => {
  const { daemon, faux } = await bootTest();
  const prompts = reflections(faux);
  for (const t of ["1", "2", "3", "4", "5"]) {
    await ask(daemon, t);
    await resetDone(daemon);
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
  await resetDone(first);
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
