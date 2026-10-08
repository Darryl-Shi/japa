import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import {
  type AssistantMessage,
  type FauxProviderHandle,
  type FauxResponseFactory,
  fauxAssistantMessage,
  fauxText,
  fauxToolCall,
  getSystemMessageText,
  type Message,
} from "@earendil-works/pi-ai";
import { type JsonObject, ResetEntry, ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { expect, test } from "vitest";
import { boot, type Daemon } from "../src/kernel/boot.ts";
import { reflectDelay, unreflectedTurns } from "../src/kernel/memory/reflect.ts";
import { MemoryDoc } from "../src/kernel/memory/state.ts";
import { bootTest, carryOver, tempHome, testKit, waitFor } from "./helpers.ts";
import { ask, say, textOf, texts } from "./jobs-helpers.ts";

type Respond = (
  system: string,
  text: string,
  signal?: AbortSignal,
) => AssistantMessage | Promise<AssistantMessage> | undefined;

const systemOf = (messages: Message[]) =>
  messages.flatMap((m) => (m.role === "system" ? [getSystemMessageText(m)] : [])).join("\n");

/** Answers each request with `respond(system prompt, last message text)`, or "ok"; returns every request's messages. */
function route(faux: FauxProviderHandle, respond: Respond) {
  const requests: Message[][] = [];
  const step: FauxResponseFactory = ({ messages }, options) => {
    requests.push(messages);
    const last = messages.findLast((m) => m.role !== "system")!;
    return respond(systemOf(messages), textOf(last), options?.signal) ?? say("ok");
  };
  faux.setResponses(Array.from({ length: 50 }, () => step));
  return requests;
}

const save = (args: object) =>
  fauxAssistantMessage([fauxToolCall("save", args as JsonObject)], { stopReason: "toolUse" });
const memory = async (daemon: Daemon) => (await daemon.harness.snapshot(MemoryDoc, ROOT_CONVERSATION_ID, ctx))!;
const factTexts = async (daemon: Daemon) => (await memory(daemon)).facts.map((f) => f.text);
const facts = (...ops: object[]) => ({ facts: ops, episode: "e" });

test("reflection saves facts and an episode and advances the cursor", async () => {
  const { daemon, faux } = await bootTest();
  route(faux, (system) => {
    if (system.startsWith("You reflect")) {
      return save({ facts: [{ op: "add", text: "Ada prefers short answers" }], episode: "Ada introduced herself." });
    }
  });
  await ask(daemon, "I'm Ada, I prefer short answers");
  await carryOver(daemon);
  await daemon.reflect();

  const saved = await memory(daemon);
  expect(saved.facts.map((f) => f.text)).toEqual(["Ada prefers short answers"]);
  expect(saved.episodes.map((e) => e.text)).toEqual(["Ada introduced herself."]);
  expect(saved.reflectedThrough).toBe((await daemon.root.entries({}, 1, undefined, ctx)).items[0]!.id);
  await daemon.close();
});

test("reflection reads only the turns after the cursor", async () => {
  const { daemon, faux } = await bootTest();
  const prompts: string[] = [];
  route(faux, (system, text) => {
    if (system.startsWith("You reflect")) {
      prompts.push(text);
      return save(facts());
    }
  });
  await ask(daemon, "first");
  await daemon.reflect();
  await ask(daemon, "third");
  await daemon.reflect();

  expect(prompts[1]).toContain("third");
  expect(prompts[1]).not.toContain("first");
  await daemon.close();
});

test("reflection does not change the root's context", async () => {
  const { daemon, faux } = await bootTest();
  route(faux, (system) => (system.startsWith("You reflect") ? save(facts()) : undefined));
  await ask(daemon, "hello");
  await carryOver(daemon);
  const before = (await daemon.root.context(ctx)).messages.length;
  await daemon.reflect();
  expect((await daemon.root.context(ctx)).messages.length).toBe(before);
  await daemon.close();
});

test("a long range is reflected in chunks, oldest first", async () => {
  const kit = testKit({ models: [{ id: "narrow", contextWindow: 4000 }] });
  const { daemon, faux } = await bootTest({}, [], kit);
  const prompts: string[] = [];
  route(faux, (system, text) => {
    if (system.startsWith("You reflect")) {
      prompts.push(text);
      return save(facts());
    }
  });
  await ask(daemon, `A ${"x".repeat(5000)}`);
  await carryOver(daemon);
  await ask(daemon, `B ${"y".repeat(5000)}`);
  await carryOver(daemon);
  await daemon.reflect();

  expect(prompts).toHaveLength(2);
  expect(prompts[0]!.includes("A ")).toBe(true);
  expect(prompts[0]!.includes("B ")).toBe(false);
  expect((await memory(daemon)).reflectedThrough).toBe((await daemon.root.entries({}, 1, undefined, ctx)).items[0]!.id);
  expect((await memory(daemon)).episodes).toHaveLength(2);
  await daemon.close();
});

test("a reflection that faults leaves the cursor and is retried", async () => {
  const { daemon, faux } = await bootTest();
  let calls = 0;
  // `save` without its fields makes the phase throw, which faults the task
  route(faux, (system) => {
    if (!system.startsWith("You reflect")) return;
    return calls++ === 0 ? save({}) : save(facts({ op: "add", text: "Ada likes tea" }));
  });
  await ask(daemon, "hello");
  await daemon.reflect().catch(() => {});
  expect((await memory(daemon)).reflectedThrough).toBeUndefined();
  await daemon.reflect();
  expect(await factTexts(daemon)).toEqual(["Ada likes tea"]);
  await daemon.close();
});

/** Boots, has one exchange, and reflects with `respond` answering every reflection-model request. */
async function reflected(respond: Respond, settings = {}) {
  const { daemon, faux } = await bootTest(settings);
  const prompts: string[] = [];
  route(faux, (system, text, signal) => {
    if (!system.startsWith("You reflect") && !system.startsWith("Shorten") && !system.startsWith("Merge")) return;
    prompts.push(system.split(" ")[0]!);
    return respond(system, text, signal);
  });
  await ask(daemon, "hello");
  await daemon.reflect();
  return { daemon, prompts };
}

const LONG = "word ".repeat(60).trim();

test("a too-long fact is shortened", async () => {
  const { daemon, prompts } = await reflected((system) =>
    system.startsWith("Shorten")
      ? save({ facts: [{ op: "add", text: "Ada writes a lot" }] })
      : save(facts({ op: "add", text: LONG })),
  );
  expect(prompts).toEqual(["You", "Shorten"]);
  expect(await factTexts(daemon)).toEqual(["Ada writes a lot"]);
  await daemon.close();
});

test("a fact still too long after shortening is dropped", async () => {
  const { daemon } = await reflected((system) =>
    system.startsWith("Shorten")
      ? save({ facts: [{ op: "add", text: `${LONG} more` }] })
      : save(facts({ op: "add", text: LONG })),
  );
  expect(await factTexts(daemon)).toEqual([]);
  await daemon.close();
});

test("facts over the cap are merged", async () => {
  const added = ["Ada likes tea", "Ada runs marathons", "Ada lives in Oslo", "Ada has two cats"];
  const { daemon, prompts } = await reflected(
    (system) =>
      system.startsWith("Merge")
        ? save({
            facts: [
              { op: "delete", id: "1" },
              { op: "delete", id: "2" },
              { op: "add", text: "Ada is sporty and likes tea" },
            ],
          })
        : save(facts(...added.map((text) => ({ op: "add", text })))),
    { memory: { maxFacts: 3 } },
  );
  expect(prompts).toEqual(["You", "Merge"]);
  expect(await factTexts(daemon)).toEqual(["Ada lives in Oslo", "Ada has two cats", "Ada is sporty and likes tea"]);
  await daemon.close();
});

test.each([[0, undefined], [1, 900_000], [4, 900_000], [5, 0], [12, 0]])(
  "reflectDelay(%i) is %s",
  (turns, expected) => expect(reflectDelay(turns)).toBe(expected),
);

test("unreflectedTurns counts the resets after the cursor", async () => {
  const { daemon } = await bootTest();
  const reset = () =>
    daemon.root.submit({ type: "write", entry: { kind: ResetEntry.kind, head: "self" } }, ctx).then((s) => s.wait(ctx));
  await reset();
  await reset();
  expect(await unreflectedTurns(daemon.harness, daemon.root)).toBe(2);
  await daemon.close();
});

test("boot reflects when turns are unreflected", async () => {
  const kit = testKit();
  const home = tempHome({ models: { cos: kit.model } }); // default storage: sqlite
  const daemon = await boot({ home, extensions: [kit.extension] });
  kit.faux.setResponses([fauxAssistantMessage([fauxText("ok")])]);
  await (await daemon.root.submit({ type: "input", content: "hello" }, ctx)).wait(ctx);
  for (let i = 0; i < 5; i++) {
    await (await daemon.root.submit({ type: "write", entry: { kind: ResetEntry.kind, head: "self" } }, ctx)).wait(ctx);
  }
  await daemon.close();

  // Queue reflect's responses before the second boot, since it starts reflecting on its own.
  const prompts: string[] = [];
  route(kit.faux, (system, text) => {
    if (system.startsWith("You reflect")) {
      prompts.push(text);
      return save(facts());
    }
  });
  const reopened = await boot({ home, extensions: [kit.extension] });
  await waitFor(() => prompts.length > 0);
  await reopened.close();
});

test("a version 1 memory drops its loops and keeps its facts", () => {
  const fact = { id: "1", text: "Ada likes tea", updatedAt: 5 };
  expect(
    MemoryDoc.definition.migrate!(
      {
        nextId: 4,
        facts: [fact],
        loops: [{ id: "3", text: "call the bank", createdAt: 1 }],
        episodes: [],
        lastResetAt: 7,
        previousResetAt: 2,
        consolidating: 9,
      },
      1,
    ),
  ).toEqual({ nextId: 4, facts: [fact], episodes: [], upgraded: { loops: ["call the bank"] } });
});

test("the upgrade notice is delivered once and sets the cursor", async () => {
  const kit = testKit();
  const home = tempHome({ models: { cos: kit.model } }); // default storage: sqlite
  const first = await boot({ home, extensions: [kit.extension] });
  kit.faux.setResponses([fauxAssistantMessage([fauxText("ok")])]);
  await (await first.root.submit({ type: "input", content: "hi" }, ctx)).wait(ctx);
  await first.root.commit(async (tx) => {
    Object.assign(await tx.doc(MemoryDoc, ROOT_CONVERSATION_ID), { upgraded: { loops: ["call the bank"] } });
  }, ctx);
  await first.close();

  const d = await boot({ home, extensions: [kit.extension] });
  expect((await texts(d.root, "user")).filter((t) => t.startsWith("[japa] Open loops"))).toEqual([
    "[japa] Open loops are no longer kept for you; your context is cleared after every reply. If any of these still matter, back it with a schedule or a job:\n- call the bank",
  ]);
  expect((await memory(d)).upgraded).toBeUndefined();
  expect((await memory(d)).reflectedThrough).toBeDefined();
  await d.close();

  const third = await boot({ home, extensions: [kit.extension] });
  // History persists across boots: the notice posted on the second boot is still there, but no second one joins it.
  expect((await texts(third.root, "user")).filter((t) => t.startsWith("[japa] Open loops"))).toHaveLength(1);
  await third.close();
});

test("leftover context settings are ignored", async () => {
  const { daemon } = await bootTest({ context: { resetTokens: 20000, idleResetHours: 2 } });
  expect(daemon.status().errors).toEqual([]);
  await daemon.close();
});
