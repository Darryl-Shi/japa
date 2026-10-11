import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import {
  type AssistantMessage,
  type FauxProviderHandle,
  type FauxResponseFactory,
  fauxAssistantMessage,
  fauxToolCall,
  getSystemMessageText,
} from "@earendil-works/pi-ai";
import { type JsonObject, ROOT_CONVERSATION_ID, UserEntry } from "@earendil-works/pi-durable";
import { expect, onTestFinished, test, vi } from "vitest";
import type { Daemon } from "../src/kernel/boot.ts";
import { ScratchpadDoc } from "../src/kernel/memory/scratchpad.ts";
import { MemoryDoc } from "../src/kernel/memory/state.ts";
import { defineJapaExtension, defineTool, Type } from "../src/sdk.ts";
import { bootTest, NO_BWRAP, resetDone, waitFor } from "./helpers.ts";
import { ask, call, idle, reported, say, textOf, texts } from "./jobs-helpers.ts";

/** Answers each request with `respond(role, text)` of its last non-system message, or "ok"; returns the system prompts. */
function run(faux: FauxProviderHandle, respond: (role: string, text: string) => AssistantMessage | undefined) {
  const prompts: string[] = [];
  const step: FauxResponseFactory = ({ messages }) => {
    prompts.push(messages.flatMap((m) => (m.role === "system" ? [getSystemMessageText(m)] : [])).join("\n"));
    const last = messages.findLast((m) => m.role !== "system")!;
    return respond(last.role, textOf(last)) ?? say("ok");
  };
  faux.setResponses(Array.from({ length: 50 }, () => step));
  return prompts;
}

const DAY = 86_400_000;
const facts = async (daemon: Daemon) => (await daemon.harness.snapshot(MemoryDoc, ROOT_CONVERSATION_ID, ctx))!.facts;
const lastResult = async (daemon: Daemon) => (await texts(daemon.root, "toolResult")).at(-1);

test("a remembered fact reaches the about-you section; forget removes it", async () => {
  const { daemon, faux } = await bootTest();
  const prompts = run(faux, (_role, text) => {
    if (text === "remember") return call("memory_remember", { text: "Dana prefers tea over coffee" });
    if (text === "forget") return call("memory_forget", { id: "1" });
  });
  await ask(daemon, "remember");
  expect(await lastResult(daemon)).toBe("Remembered.");
  expect(prompts.at(-1)).toMatch(/about-you[\s\S]*- Dana prefers tea over coffee/);

  await ask(daemon, "forget");
  expect(await lastResult(daemon)).toBe("Forgot: Dana prefers tea over coffee");
  expect(await facts(daemon)).toEqual([]);
  await daemon.close();
});

test("memory_remember refuses a path with the filter copy", async () => {
  const { daemon, faux } = await bootTest();
  const remember = daemon.registry.snapshot().tools().find((t) => t.tool.name === "memory_remember")!.tool;
  expect(remember.description).toBe(
    "Remember something lasting about the user (not project or system details), in at most 30 words.",
  );
  run(faux, (_role, text) => {
    if (text === "path") return call("memory_remember", { text: "Dana keeps her notes in ~/notes/dana.md" });
    if (text === "ip") return call("memory_remember", { text: "Dana's server is at 192.168.0.32" });
  });
  await ask(daemon, "path");
  expect(await lastResult(daemon)).toBe("Not about the user (a file path): put it on a scratchpad page instead.");
  await ask(daemon, "ip");
  expect(await lastResult(daemon)).toBe("Not about the user (an IP address): put it on a scratchpad page instead.");
  expect(await facts(daemon)).toEqual([]);
  await daemon.close();
});

test("a fact over 30 words is refused", async () => {
  const { daemon, faux } = await bootTest();
  run(faux, (_role, text) => {
    if (text === "long") return call("memory_remember", { text: "word ".repeat(31) });
  });
  await ask(daemon, "long");
  expect(await lastResult(daemon)).toBe("Too long — keep it to 30 words.");
  expect(await facts(daemon)).toEqual([]);
  await daemon.close();
});

test("a duplicate fact is refused", async () => {
  const { daemon, faux } = await bootTest();
  run(faux, (_role, text) => {
    if (text === "tea") return call("memory_remember", { text: "Dana prefers tea over coffee" });
    if (text === "tea again") return call("memory_remember", { text: "Dana prefers tea over coffee!" });
  });
  await ask(daemon, "tea");
  await ask(daemon, "tea again");
  expect(await lastResult(daemon)).toBe("Already remembered: Dana prefers tea over coffee");
  expect((await facts(daemon)).map((f) => f.text)).toEqual(["Dana prefers tea over coffee"]);
  await daemon.close();
});

test("page_write then page_read round-trips and the index appears in the system prompt", async () => {
  const { daemon, faux } = await bootTest();
  const prompts = run(faux, (_role, text) => {
    if (text === "remember") return call("memory_remember", { text: "Dana prefers tea over coffee" });
    if (text === "create") return call("page_write", { title: "Factory", text: "Runs on hermes.\nOpen: the CI." });
    if (text === "update") return call("page_write", { title: " factory ", text: "Runs on hermes.\nCI is done." });
    if (text === "read") return call("page_read", { title: "FACTORY" });
    if (text === "fuzzy") return call("page_read", { title: "hermes" });
    if (text === "missing") return call("page_read", { title: "Garden" });
  });
  await ask(daemon, "remember");
  await ask(daemon, "create");
  expect(await lastResult(daemon)).toBe('Created page "Factory".');
  await ask(daemon, "update");
  expect(await lastResult(daemon)).toBe('Saved page "Factory".');
  await ask(daemon, "read");
  expect(await lastResult(daemon)).toBe("# Factory (updated just now)\nRuns on hermes.\nCI is done.");
  const prompt = prompts.at(-1)!;
  expect(prompt).toMatch(/about-you[\s\S]*- Dana prefers tea over coffee[\s\S]*scratchpad[\s\S]*- Factory \(updated just now\)/);
  await ask(daemon, "fuzzy");
  expect(await lastResult(daemon)).toBe('No page "hermes"; closest: # Factory (updated just now)\nRuns on hermes.\nCI is done.');
  await ask(daemon, "missing");
  expect(await lastResult(daemon)).toBe('No page "Garden".');
  await daemon.close();
});

test("page_write over 1,500 tokens is refused with the copy", async () => {
  const { daemon, faux } = await bootTest();
  run(faux, (_role, text) => {
    if (text === "write") return call("page_write", { title: "Big", text: "x".repeat(6004) });
    if (text === "read") return call("page_read", { title: "Big" });
  });
  await ask(daemon, "write");
  expect(await lastResult(daemon)).toBe(
    "Page too long (1,501 tokens; max 1,500): condense it to the current state and write it again.",
  );
  await ask(daemon, "read");
  expect(await lastResult(daemon)).toBe('No page "Big".');
  expect((await daemon.harness.snapshot(ScratchpadDoc, ROOT_CONVERSATION_ID, ctx))!.pages).toEqual([]);
  await daemon.close();
});

/** Today's date (UTC), `offset` days on. */
const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

test("history_search finds an earlier message by keyword", async () => {
  const { daemon, faux } = await bootTest();
  run(faux, (_role, text) => {
    if (text === "search") return call("history_search", { query: "NUX" });
    if (text === "search since") return call("history_search", { query: "NUX", since: day(0) });
    if (text === "search until") return call("history_search", { query: "NUX", until: day(0) });
    if (text === "search later") return call("history_search", { query: "NUX", since: day(1) });
    if (text === "search earlier") return call("history_search", { query: "NUX", until: day(-1) });
    if (text === "search bad") return call("history_search", { query: "NUX", since: "last week" });
    if (text === "search none") return call("history_search", { query: "theremin" });
  });
  await ask(daemon, "the drum monitor is NUX");
  const found = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2} you #\d+: the drum monitor is NUX$/;
  for (const q of ["search", "search since", "search until"]) {
    await resetDone(daemon);
    await ask(daemon, q);
    expect([q, await lastResult(daemon)]).toEqual([q, expect.stringMatching(found)]);
  }
  for (const q of ["search later", "search earlier", "search none"]) {
    await resetDone(daemon);
    await ask(daemon, q);
    expect([q, await lastResult(daemon)]).toEqual([q, "Nothing found."]);
  }
  await resetDone(daemon);
  await ask(daemon, "search bad");
  expect(await lastResult(daemon)).toBe('Invalid since "last week": use an ISO date or datetime, e.g. 2026-10-11 or 2026-10-11T14:30.');
  await daemon.close();
});

test.skipIf(NO_BWRAP)("history_search finds a done job's result", async () => {
  const { daemon, faux } = await bootTest();
  run(faux, (_role, text) => {
    if (text === "start") return call("job_start", { title: "Report", brief: "Write the report" });
    if (text === "Write the report") return call("job_complete", { summary: "Quarterly revenue grew 12 percent" });
    if (text === "search") return call("history_search", { query: "quarterly" });
  });
  await ask(daemon, "start");
  await waitFor(async () => (await reported(daemon)).length > 0 && (await idle(daemon)));
  await resetDone(daemon);
  await ask(daemon, "search");
  expect(await lastResult(daemon)).toMatch(
    /^\d{4}-\d{2}-\d{2} \d{2}:\d{2} job #job:1: "Report": Quarterly revenue grew 12 percent$/m,
  );
  await daemon.close();
});

/** The id of the root's user entry with `text`. */
async function inputId(daemon: Daemon, text: string): Promise<number> {
  const { items } = await daemon.root.entries({}, 200, undefined, ctx);
  return items.find((e) => e.kind === UserEntry.kind && e.model?.some((m) => m.role === "user" && textOf(m) === text))!.id;
}

test("history_read returns the messages around an id", async () => {
  const { daemon, faux } = await bootTest();
  let read: JsonObject = {};
  run(faux, (role, text) => {
    if (text === "read") return fauxAssistantMessage([fauxToolCall("history_read", read)], { stopReason: "toolUse" });
    if (role === "user" && !text.startsWith("[")) return say(`re ${text.slice(0, 10)}`);
  });
  for (const text of ["one", "two", "three", "four", "x".repeat(20_000)]) {
    await ask(daemon, text);
    await resetDone(daemon);
  }
  const one = await inputId(daemon, "one");
  const two = await inputId(daemon, "two");
  const three = await inputId(daemon, "three");

  read = { id: three, before: 1, after: 1 };
  await ask(daemon, "read");
  expect(await lastResult(daemon)).toBe(`japa · just now: re two\nyou · just now · #${three}: three\njapa · just now: re three`);

  await resetDone(daemon);
  read = { id: two };
  await ask(daemon, "read");
  const lines = (await lastResult(daemon))!.split("\n");
  // the 2 messages before it (all there are), the message, and 4 after
  expect(lines).toEqual([
    `you · just now · #${one}: one`,
    "japa · just now: re one",
    `you · just now · #${two}: two`,
    "japa · just now: re two",
    `you · just now · #${three}: three`,
    "japa · just now: re three",
    `you · just now · #${await inputId(daemon, "four")}: four`,
  ]);

  await resetDone(daemon);
  const long = await inputId(daemon, "x".repeat(20_000));
  read = { id: long, before: 0, after: 0 };
  await ask(daemon, "read");
  const result = (await lastResult(daemon))!;
  expect(result.length).toBe(16_000);
  expect(result).toMatch(new RegExp(`^you · just now · #${long}: x+\\[…\\]x+$`));

  await resetDone(daemon);
  read = { id: 99_999 };
  await ask(daemon, "read");
  expect(await lastResult(daemon)).toBe("No message #99999.");
  await daemon.close();
});

const big = defineJapaExtension({
  name: "big",
  summary: "A tool with a large result",
  examples: ["big"],
  docs: "Big.",
  provides: {
    tool: [
      defineTool({
        name: "big_output",
        description: "Returns 20 000 characters",
        parameters: Type.Object({}),
        execute: async () => ({ content: [{ type: "text", text: "x".repeat(20000) }] }),
      }),
    ],
  },
});

test.skipIf(NO_BWRAP)("tool results are capped in the CoS's requests only", async () => {
  const { daemon, faux } = await bootTest({}, [big]);
  const seen: string[] = [];
  run(faux, (role, text) => {
    if (text === "big" || text === "go big") return call("big_output", {});
    if (text === "start") return call("job_start", { title: "Big", brief: "go big" });
    if (role === "toolResult" && text.startsWith("x")) seen.push(text);
  });
  await ask(daemon, "big");
  expect(seen[0]).toBe(`${"x".repeat(8000)}\n[Truncated 12000 characters. Start a job if you need the full output.]`);
  expect(await lastResult(daemon)).toBe("x".repeat(20000));

  await ask(daemon, "start");
  await waitFor(async () => (await reported(daemon)).length > 0 && (await idle(daemon)));
  expect(seen[1]).toBe("x".repeat(20000));
  await daemon.close();
});

test("the hourly prune archives stale pages and drops expired legacy episodes", async () => {
  const intervals = vi.spyOn(globalThis, "setInterval");
  onTestFinished(() => intervals.mockRestore());
  const { daemon } = await bootTest();
  const now = Date.now();
  await daemon.root.commit(async (tx) => {
    const pad = await tx.doc(ScratchpadDoc, ROOT_CONVERSATION_ID);
    pad.pages.push({ id: "1", title: "Old", text: "x", updatedAt: now - 15 * DAY });
    pad.pages.push({ id: "2", title: "Gone", text: "y", updatedAt: 0, archivedAt: now - 91 * DAY });
    pad.pages.push({ id: "3", title: "Fresh", text: "z", updatedAt: now });
    const memory = await tx.doc(MemoryDoc, ROOT_CONVERSATION_ID);
    memory.legacyEpisodes = [{ id: "4", at: 0, text: "an old episode" }];
    memory.legacyUntil = now - 1;
  }, ctx);
  const hourly = intervals.mock.calls.find(([, ms]) => ms === 3_600_000)![0] as () => void;
  hourly();
  const pad = async () => (await daemon.harness.snapshot(ScratchpadDoc, ROOT_CONVERSATION_ID, ctx))!.pages;
  await waitFor(async () => (await pad()).length === 2);
  expect((await pad()).map((p) => [p.title, p.archivedAt !== undefined])).toEqual([["Old", true], ["Fresh", false]]);
  expect((await daemon.harness.snapshot(MemoryDoc, ROOT_CONVERSATION_ID, ctx))!.legacyEpisodes).toBeUndefined();
  await daemon.close();
});
