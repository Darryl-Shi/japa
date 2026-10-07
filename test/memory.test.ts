import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import {
  type AssistantMessage,
  type FauxProviderHandle,
  type FauxResponseFactory,
  getSystemMessageText,
} from "@earendil-works/pi-ai";
import { ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { expect, test } from "vitest";
import type { Daemon } from "../src/kernel/boot.ts";
import { MemoryDoc } from "../src/kernel/memory/state.ts";
import { defineJapaExtension, defineTool, Type } from "../src/sdk.ts";
import { bootTest, waitFor } from "./helpers.ts";
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

test("a too-long or duplicate fact is refused", async () => {
  const { daemon, faux } = await bootTest();
  run(faux, (_role, text) => {
    if (text === "long") return call("memory_remember", { text: "word ".repeat(51) });
    if (text === "tea") return call("memory_remember", { text: "Dana prefers tea over coffee" });
    if (text === "tea again") return call("memory_remember", { text: "Dana prefers tea over coffee!" });
  });
  await ask(daemon, "long");
  expect(await lastResult(daemon)).toBe("Too long — keep it to about two sentences (50 words).");
  await ask(daemon, "tea");
  await ask(daemon, "tea again");
  expect(await lastResult(daemon)).toBe("Already remembered: Dana prefers tea over coffee");
  expect((await facts(daemon)).map((f) => f.text)).toEqual(["Dana prefers tea over coffee"]);
  await daemon.close();
});

test("memory_search finds a done job's result", async () => {
  const { daemon, faux } = await bootTest();
  run(faux, (_role, text) => {
    if (text === "start") return call("job_start", { title: "Report", brief: "Write the report" });
    if (text === "Write the report") return call("job_complete", { summary: "Quarterly revenue grew 12 percent" });
    if (text === "search") return call("memory_search", { query: "revenue" });
  });
  await ask(daemon, "start");
  await waitFor(async () => (await reported(daemon)).length > 0 && (await idle(daemon)));
  await ask(daemon, "search");
  expect(await lastResult(daemon)).toMatch(/job 1 "Report": Quarterly revenue grew 12 percent$/);
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

test("tool results are capped in the CoS's requests only", async () => {
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
