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
import { expect, test, vi } from "vitest";
import { boot, type Daemon } from "../src/kernel/boot.ts";
import { DELETE_AFTER, findPage, ScratchpadDoc, tidyPages } from "../src/kernel/memory/scratchpad.ts";
import { type Episode, expireLegacy, type Fact, MemoryDoc } from "../src/kernel/memory/state.ts";
import { bootTest, resetDone, tempHome, testKit, waitFor } from "./helpers.ts";
import { ask, call, say, textOf, texts } from "./jobs-helpers.ts";

type Respond = (system: string, text: string) => AssistantMessage | undefined;

const systemOf = (messages: Message[]) =>
  messages.flatMap((m) => (m.role === "system" ? [getSystemMessageText(m)] : [])).join("\n");

/** Answers each request with `respond(system prompt, last message text)`, or "ok"; returns the Sort prompts. */
function route(faux: FauxProviderHandle, respond: Respond) {
  const sorts: string[] = [];
  const step: FauxResponseFactory = ({ messages }) => {
    const system = systemOf(messages);
    const text = textOf(messages.findLast((m) => m.role !== "system")!);
    if (sorting(system)) sorts.push(text);
    return respond(system, text) ?? say("ok");
  };
  faux.setResponses(Array.from({ length: 50 }, () => step));
  return sorts;
}

const sorting = (system: string) => system.startsWith("You sort a chief-of-staff assistant's old memory");
const save = (args: object) =>
  fauxAssistantMessage([fauxToolCall("save", args as JsonObject)], { stopReason: "toolUse" });
const memory = async (daemon: Daemon) => (await daemon.harness.snapshot(MemoryDoc, ROOT_CONVERSATION_ID, ctx))!;
const pad = async (daemon: Daemon) =>
  (await daemon.harness.snapshot(ScratchpadDoc, ROOT_CONVERSATION_ID, ctx)) ?? { nextId: 1, pages: [] };

const FACTS: Fact[] = [
  { id: "1", text: "Lives at Kopar at Newton", updatedAt: 1 },
  { id: "2", text: "Factory settings: global defaults plus per-project overrides", updatedAt: 2 },
];
const EPISODE: Episode = { id: "3", at: Date.now() - 86_400_000, text: "Set up the software factory with per-project overrides" };

/** Makes the root's memory look like a migrated version 2 one: unsorted, with these facts and legacy episodes. */
async function asV2(daemon: Daemon, facts: Fact[] = FACTS, episodes: Episode[] = [EPISODE]) {
  await daemon.root.commit(async (tx) => {
    const doc = await tx.doc(MemoryDoc, ROOT_CONVERSATION_ID);
    delete doc.sorted;
    doc.nextId = 4;
    doc.facts = structuredClone(facts);
    doc.legacyEpisodes = structuredClone(episodes);
  }, ctx);
}

const SORTED = {
  profile: [{ op: "delete", id: "2" }],
  pages: [{ title: "Software factory", text: "Global defaults plus per-project overrides." }],
};

test("a v2 memory is sorted into profile and pages once", async () => {
  const { daemon, faux } = await bootTest();
  await asV2(daemon);
  const sorts = route(faux, (system) => (sorting(system) ? save(SORTED) : undefined));
  const before = Date.now();
  await daemon.sort();

  const sorted = await memory(daemon);
  expect(sorted.facts.map((f) => f.text)).toEqual(["Lives at Kopar at Newton"]);
  const page = findPage(await pad(daemon), "Software factory")!;
  expect(page.text).toBe("Global defaults plus per-project overrides.");
  // Written at the sort's time, not the episode's: the hourly tidy doesn't archive it at once.
  expect(page.updatedAt).toBeGreaterThanOrEqual(before);
  const tidied = structuredClone(await pad(daemon));
  tidyPages(tidied, Date.now() + 3_600_000);
  expect(findPage(tidied, "Software factory")?.archivedAt).toBeUndefined();
  expect(sorted.sorted).toBe(true);
  expect(sorted.legacyUntil).toBeGreaterThanOrEqual(before + DELETE_AFTER);
  // Kept, searchable until then; so is the deleted fact, which no profile item holds verbatim.
  expect(sorted.legacyEpisodes).toEqual([EPISODE, { id: "fact:2", at: 2, text: FACTS[1]!.text }]);
  expect(sorts).toHaveLength(1);
  expect(sorts[0]).toBe(
    "Facts:\n1 (1970-01-01): Lives at Kopar at Newton\n2 (1970-01-01): Factory settings: global defaults plus per-project overrides\n\n" +
      `Episodes (newest first):\n${new Date(EPISODE.at).toISOString().slice(0, 10)}: ${EPISODE.text}`,
  );

  await daemon.sort();
  expect(sorts).toHaveLength(1);
  await daemon.close();
});

test("the episodes are newest first and cut to half the context window", async () => {
  const kit = testKit({ models: [{ id: "narrow", contextWindow: 4000 }] });
  const { daemon, faux } = await bootTest({}, [], kit);
  const big = (id: string, at: number) => ({ id, at, text: `${id} ${"x".repeat(3000)}` });
  // 3 000 characters each: two fit in half of the 4 000-token window (8 000 characters), not three
  await asV2(daemon, [], [big("old", 1), big("newer", 2), big("newest", 3)]);
  const sorts = route(faux, (system) => (sorting(system) ? save({ profile: [], pages: [] }) : undefined));
  await daemon.sort();

  const episodes = sorts[0]!.split("Episodes (newest first):\n")[1]!.split("\n");
  expect(episodes.map((e) => e.split(" ")[1])).toEqual(["newest", "newer"]);
  await daemon.close();
});

test("the sort applies the caps but not the evidence check", async () => {
  const { daemon, faux } = await bootTest();
  await asV2(daemon);
  const pages = Array.from({ length: 17 }, (_, i) => ({ title: `P${i}`, text: `page ${i}` }));
  pages.splice(1, 0, { title: "Huge", text: "x".repeat(6004) }); // 1 501 tokens
  route(faux, (system) =>
    sorting(system)
      ? save({
          profile: [
            { op: "add", text: "Plays drums in a band" }, // no evidence needed
            { op: "add", text: "Keeps notes in ~/notes/today.md" }, // off scope
            { op: "add", text: "word ".repeat(31).trim() }, // too long
            { op: "update", id: "1", text: "Lives at Kopar at Newton, Singapore" },
            { bogus: true }, // malformed
          ],
          pages: [...pages, { title: 3 }],
        })
      : undefined,
  );
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  await daemon.sort();
  expect(warn.mock.calls.map((c) => c[0])).toContain(
    "japa.sort: dropped 1 malformed profile ops; 1 off-scope; 1 too long; 1 malformed pages; too-long pages: Huge; 2 pages over 15.",
  );
  warn.mockRestore();

  expect((await memory(daemon)).facts.map((f) => f.text)).toEqual([
    "Lives at Kopar at Newton, Singapore",
    "Factory settings: global defaults plus per-project overrides",
    "Plays drums in a band",
  ]);
  const titles = (await pad(daemon)).pages.map((p) => p.title);
  expect(titles).toEqual(Array.from({ length: 15 }, (_, i) => `P${i}`));
  expect((await memory(daemon)).sorted).toBe(true);
  await daemon.close();
});

test("the prompt states the caps and keeps the profile to the facts", async () => {
  const { daemon, faux } = await bootTest({ memory: { maxFacts: 12, maxTokens: 345 } });
  await asV2(daemon);
  let prompt = "";
  route(faux, (system) => {
    if (!sorting(system)) return;
    prompt = system;
    return save({ profile: [], pages: [] });
  });
  await daemon.sort();
  for (const cap of ["at most 12 items", "345 tokens", "at most 30 words", "at most 15", "at most 1,500 tokens"]) {
    expect(prompt).toContain(cap);
  }
  expect(prompt).toContain("never for the profile");
  await daemon.close();
});

test("a deleted fact whose replacement is dropped is kept as a legacy episode", async () => {
  const { daemon, faux } = await bootTest();
  await asV2(daemon);
  route(faux, (system) =>
    sorting(system)
      ? save({ profile: [{ op: "delete", id: "2" }, { op: "add", text: "word ".repeat(31).trim() }], pages: [] })
      : undefined,
  );
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  await daemon.sort();
  expect(warn.mock.calls.map((c) => c[0])).toContain(
    "japa.sort: dropped 1 too long. Kept 1 removed facts as legacy episodes.",
  );
  warn.mockRestore();

  const sorted = await memory(daemon);
  expect(sorted.facts.map((f) => f.text)).toEqual(["Lives at Kopar at Newton"]);
  expect(sorted.legacyEpisodes).toContainEqual({ id: "fact:2", at: 2, text: FACTS[1]!.text });
  expect(sorted.legacyUntil).toBeDefined();
  await daemon.close();
});

test("a fact folded verbatim into another isn't kept as a legacy episode", async () => {
  const { daemon, faux } = await bootTest();
  await asV2(daemon);
  route(faux, (system) =>
    sorting(system)
      ? save({
          profile: [
            { op: "delete", id: "1" },
            { op: "update", id: "2", text: "Lives at Kopar at Newton with his family" },
          ],
          pages: [],
        })
      : undefined,
  );
  await daemon.sort();
  expect((await memory(daemon)).legacyEpisodes).toEqual([EPISODE]);
  await daemon.close();
});

test("facts truncated to the cap are kept as legacy episodes", async () => {
  const { daemon, faux } = await bootTest({ memory: { maxFacts: 2 } });
  const facts = [
    { id: "1", text: "Plays drums in a band", updatedAt: 3 },
    { id: "2", text: "Prefers short answers", updatedAt: 1 },
    { id: "3", text: "Runs marathons", updatedAt: 2 },
  ];
  await asV2(daemon, facts);
  route(faux, (system) => (sorting(system) ? save({ profile: [], pages: [] }) : undefined));
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  await daemon.sort();
  expect(warn.mock.calls.map((c) => c[0])).toContain(
    "japa.sort: dropped 1 facts over the cap. Kept 1 removed facts as legacy episodes.",
  );
  warn.mockRestore();

  const sorted = await memory(daemon);
  expect(sorted.facts.map((f) => f.text)).toEqual(["Plays drums in a band", "Runs marathons"]);
  expect(sorted.legacyEpisodes).toEqual([EPISODE, { id: "fact:2", at: 1, text: "Prefers short answers" }]);
  await daemon.close();
});

test("a page the CoS already wrote is kept", async () => {
  const { daemon, faux } = await bootTest();
  await asV2(daemon);
  await daemon.root.commit(async (tx) => {
    const doc = await tx.doc(ScratchpadDoc, ROOT_CONVERSATION_ID);
    doc.pages.push({ id: "1", title: "Software factory", text: "The CoS's own notes.", updatedAt: 5 });
    doc.nextId = 2;
  }, ctx);
  route(faux, (system) => (sorting(system) ? save(SORTED) : undefined));
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  await daemon.sort();
  expect(warn.mock.calls.map((c) => c[0])).toContain("japa.sort: dropped pages already written: Software factory. Kept 1 removed facts as legacy episodes.");
  warn.mockRestore();

  expect(findPage(await pad(daemon), "Software factory")?.text).toBe("The CoS's own notes.");
  expect((await memory(daemon)).sorted).toBe(true);
  await daemon.close();
});

test("a failed sort leaves sorted unset and runs at the next boot", async () => {
  const kit = testKit();
  const home = tempHome({ models: { cos: kit.model } }); // default storage: sqlite
  const first = await boot({ home, extensions: [kit.extension] });
  await asV2(first);
  await first.close();

  let fail = true;
  // `save` without its fields makes the phase throw, which faults the task.
  const sorts = route(kit.faux, (system) => (sorting(system) ? save(fail ? {} : SORTED) : undefined));
  const second = await boot({ home, extensions: [kit.extension] });
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  await waitFor(() => sorts.length > 0);
  await second.sort(); // like `reflect`, it settles (faulted) rather than rejecting
  expect(warn.mock.calls.map((c) => c[0])).toContain(
    "japa.sort: failed (the model didn't save a profile list); it runs again at the next boot",
  );
  warn.mockRestore();
  expect((await memory(second)).sorted).toBeUndefined();
  expect((await memory(second)).facts).toHaveLength(2);
  await second.close();

  fail = false;
  const calls = sorts.length;
  const third = await boot({ home, extensions: [kit.extension] });
  await waitFor(async () => (await memory(third)).sorted === true);
  expect(sorts.length).toBe(calls + 1);
  expect((await memory(third)).facts.map((f) => f.text)).toEqual(["Lives at Kopar at Newton"]);
  await third.close();
});

test("a v2 memory with nothing in it is sorted without the model", async () => {
  const { daemon, faux } = await bootTest();
  await asV2(daemon, [], []);
  const sorts = route(faux, (system) => (sorting(system) ? save(SORTED) : undefined));
  await daemon.sort();
  expect(sorts).toEqual([]);
  const sorted = await memory(daemon);
  expect(sorted.sorted).toBe(true);
  expect(sorted.facts).toEqual([]);
  expect((await pad(daemon)).pages).toEqual([]);
  await daemon.close();
});

test("a fresh install never sorts", async () => {
  const { daemon, faux } = await bootTest();
  const sorts = route(faux, () => undefined);
  await ask(daemon, "hello");
  await resetDone(daemon);
  expect(sorts).toEqual([]);
  expect((await memory(daemon)).sorting).toBeUndefined();
  expect((await memory(daemon)).sorted).toBe(true);
  await daemon.close();
});

test("legacy episodes are searchable until they expire", async () => {
  const { daemon, faux } = await bootTest();
  await asV2(daemon);
  route(faux, (system, text) => {
    if (sorting(system)) return save(SORTED);
    if (text === "search") return call("history_search", { query: "software factory overrides" });
  });
  await daemon.sort();
  const found = async () => {
    await ask(daemon, "search");
    await resetDone(daemon);
    return (await texts(daemon.root, "toolResult")).at(-1);
  };
  expect(await found()).toContain(EPISODE.text);

  await daemon.root.commit(async (tx) => {
    const doc = await tx.doc(MemoryDoc, ROOT_CONVERSATION_ID);
    expireLegacy(doc, doc.legacyUntil! + 1);
  }, ctx);
  expect(await found()).not.toContain(EPISODE.text);
  await daemon.close();
});
