import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import {
  type AssistantMessage,
  type FauxProviderHandle,
  type FauxResponseFactory,
  fauxAssistantMessage,
  fauxToolCall,
  getSystemMessageText,
  type Message,
} from "@earendil-works/pi-ai";
import { type JsonObject, ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { expect, test } from "vitest";
import type { Daemon } from "../src/kernel/boot.ts";
import { MemoryDoc } from "../src/kernel/memory/state.ts";
import { shouldConsolidate } from "../src/kernel/memory/trigger.ts";
import { bootTest, waitFor } from "./helpers.ts";
import { ask, call, held, idle, reported, say, textOf, texts } from "./jobs-helpers.ts";

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

test("consolidation saves memory and resets the CoS context to the handoff", async () => {
  const { daemon, faux } = await bootTest();
  const requests = route(faux, (system) => {
    if (system.startsWith("You consolidate")) {
      return save({
        facts: [{ op: "add", text: "Ada prefers short answers" }],
        loops: [{ op: "add", text: "Send Ada the plan" }],
        episode: "Ada introduced herself.",
        handoff: "Ada asked for short answers.",
      });
    }
  });
  await ask(daemon, "I'm Ada, I prefer short answers");
  await daemon.consolidate();

  const saved = await memory(daemon);
  expect(saved.facts.map((f) => f.text)).toEqual(["Ada prefers short answers"]);
  expect(saved.loops.map((l) => l.text)).toEqual(["Send Ada the plan"]);
  expect(saved.episodes.map((e) => e.text)).toEqual(["Ada introduced herself."]);

  await ask(daemon, "What's next?");
  const next = requests.at(-1)!;
  expect(next.filter((m) => m.role !== "system").map(textOf)).toEqual(["Ada asked for short answers.", "What's next?"]);
  expect(systemOf(next)).toMatch(
    /about-you[\s\S]*- Ada prefers short answers[\s\S]*open-loops[\s\S]*- Send Ada the plan/,
  );
  expect(await texts(daemon.root, "user")).toEqual([
    "I'm Ada, I prefer short answers",
    "Ada asked for short answers.",
    "What's next?",
  ]);
  await daemon.close();
});

test("a consolidation overtaken by new messages is discarded", async () => {
  const { daemon, faux } = await bootTest();
  const answer = held();
  route(faux, (system, _text, signal) => {
    if (system.startsWith("You consolidate")) {
      const args = { facts: [{ op: "add", text: "Ada likes tea" }], loops: [], episode: "e", handoff: "h" };
      return answer.wait(save(args), signal);
    }
  });
  await ask(daemon, "hello");
  const before = await memory(daemon);
  const done = daemon.consolidate();
  await waitFor(answer.started);
  await ask(daemon, "one more thing");
  answer.release();
  await done;

  expect({ ...(await memory(daemon)), consolidating: undefined }).toEqual(before);
  expect(await texts(daemon.root, "user")).toEqual(["hello", "one more thing"]);
  await daemon.close();
});

/** Boots, has one exchange, and consolidates with `respond` answering every consolidation-model request. */
async function consolidated(respond: Respond, settings = {}) {
  const { daemon, faux } = await bootTest(settings);
  const prompts: string[] = [];
  route(faux, (system, text, signal) => {
    if (!system.startsWith("You consolidate") && !system.startsWith("Shorten") && !system.startsWith("Merge")) return;
    prompts.push(system.split(" ")[0]!);
    return respond(system, text, signal);
  });
  await ask(daemon, "hello");
  await daemon.consolidate();
  return { daemon, prompts };
}

const LONG = "word ".repeat(60).trim();
const facts = (...ops: object[]) => ({ facts: ops, loops: [], episode: "e", handoff: "h" });

test("a too-long fact is shortened", async () => {
  const { daemon, prompts } = await consolidated((system) =>
    system.startsWith("Shorten")
      ? save({ facts: [{ op: "add", text: "Ada writes a lot" }] })
      : save(facts({ op: "add", text: LONG })),
  );
  expect(prompts).toEqual(["You", "Shorten"]);
  expect(await factTexts(daemon)).toEqual(["Ada writes a lot"]);
  await daemon.close();
});

test("a fact still too long after shortening is dropped", async () => {
  const { daemon } = await consolidated((system) =>
    system.startsWith("Shorten")
      ? save({ facts: [{ op: "add", text: `${LONG} more` }] })
      : save(facts({ op: "add", text: LONG })),
  );
  expect(await factTexts(daemon)).toEqual([]);
  await daemon.close();
});

test("facts over the cap are merged", async () => {
  const added = ["Ada likes tea", "Ada runs marathons", "Ada lives in Oslo", "Ada has two cats"];
  const { daemon, prompts } = await consolidated(
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

test("a consolidation that faults does not block the next one", async () => {
  let calls = 0;
  // `save` without its fields makes the phase throw, which faults the task
  const { daemon } = await consolidated(() =>
    calls++ === 0 ? save({}) : save(facts({ op: "add", text: "Ada likes tea" })),
  );
  await daemon.consolidate();
  expect(await factTexts(daemon)).toEqual(["Ada likes tea"]);
  await daemon.close();
});

test("a job finished before a reset stays on the board until the next reset", async () => {
  const { daemon, faux } = await bootTest();
  const requests = route(faux, (system, text) => {
    if (system.startsWith("You consolidate")) return save(facts());
    if (text === "start") return call("job_start", { title: "Report", brief: "Write the report" });
    if (text === "Write the report") return call("job_complete", { summary: "Revenue grew" });
  });
  await ask(daemon, "start");
  await waitFor(async () => (await reported(daemon)).length > 0 && (await idle(daemon)));

  await daemon.consolidate();
  await ask(daemon, "next");
  expect(systemOf(requests.at(-1)!)).toMatch(/- 1 "Report" done: Revenue grew/);

  await daemon.consolidate();
  await ask(daemon, "next");
  expect(systemOf(requests.at(-1)!)).not.toMatch(/"Report"/);
  await daemon.close();
});

const HOUR = 3_600_000;
test.each([
  ["busy", { busy: true, windowTokens: 30000, lastUserAt: 0, now: 3 * HOUR }, false],
  ["an empty window", { busy: false, windowTokens: 0, lastUserAt: 0, now: 3 * HOUR }, false],
  ["over the token limit", { busy: false, windowTokens: 20001, lastUserAt: 0, now: 0 }, true],
  ["idle past the hours limit", { busy: false, windowTokens: 10, lastUserAt: 0, now: 2 * HOUR + 1 }, true],
  ["neither", { busy: false, windowTokens: 10, lastUserAt: 0, now: 2 * HOUR }, false],
])("shouldConsolidate: %s", (_name, inputs, expected) => {
  expect(shouldConsolidate(inputs, { resetTokens: 20000, idleResetHours: 2, toolResultTokens: 2000 })).toBe(expected);
});

test("checkConsolidation consolidates a window over the token limit", async () => {
  const { daemon, faux } = await bootTest({ context: { resetTokens: 10 } });
  route(faux, (system) => (system.startsWith("You consolidate") ? save(facts()) : undefined));
  await ask(daemon, "hello, here is a fairly long message");
  await daemon.checkConsolidation();
  expect((await memory(daemon)).episodes).toHaveLength(1);
  await daemon.close();
});

test("checkConsolidation leaves a fresh exchange alone", async () => {
  const { daemon, faux } = await bootTest();
  route(faux, (system) => (system.startsWith("You consolidate") ? save(facts()) : undefined));
  await ask(daemon, "hello");
  await daemon.checkConsolidation();
  expect((await memory(daemon)).episodes).toHaveLength(0);
  await daemon.close();
});
