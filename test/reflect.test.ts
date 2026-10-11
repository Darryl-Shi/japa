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
import { ScratchpadDoc, writePage } from "../src/kernel/memory/scratchpad.ts";
import { applyFactOps, MemoryDoc } from "../src/kernel/memory/state.ts";
import { bootErrors, bootTest, resetDone, tempHome, testKit, waitFor } from "./helpers.ts";
import { ask, call, held, say, textOf, texts } from "./jobs-helpers.ts";

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

const DAY = 86_400_000;
const save = (args: object) =>
  fauxAssistantMessage([fauxToolCall("save", args as JsonObject)], { stopReason: "toolUse" });
const memory = async (daemon: Daemon) => (await daemon.harness.snapshot(MemoryDoc, ROOT_CONVERSATION_ID, ctx))!;
const pad = async (daemon: Daemon) =>
  (await daemon.harness.snapshot(ScratchpadDoc, ROOT_CONVERSATION_ID, ctx)) ?? { nextId: 1, pages: [] };
const factTexts = async (daemon: Daemon) => (await memory(daemon)).facts.map((f) => f.text);
const newest = async (daemon: Daemon) => (await daemon.root.entries({}, 1, undefined, ctx)).items[0]!.id;
/** A `save` with these profile ops and no page writes. */
const profile = (...ops: object[]) => ({ profile: ops, pages: [] });
/** A `save` with these page writes and no profile ops. */
const pages = (...writes: object[]) => ({ profile: [], pages: writes });
const reflecting = (system: string) => system.startsWith("You reflect");

test("reflection saves profile items with evidence and advances the cursor", async () => {
  const { daemon, faux } = await bootTest();
  route(faux, (system) => {
    if (reflecting(system)) {
      return save(profile({ op: "add", text: "Ada prefers short answers", evidence: "I prefer  SHORT answers" }));
    }
  });
  await ask(daemon, "I'm Ada, I prefer short answers");
  await resetDone(daemon);
  await daemon.reflect();

  const saved = await memory(daemon);
  expect(saved.facts.map((f) => f.text)).toEqual(["Ada prefers short answers"]);
  expect(saved.legacyEpisodes).toBeUndefined();
  expect(saved.reflectedThrough).toBe(await newest(daemon));
  await daemon.close();
});

test("an add whose evidence isn't in the batch is rejected", async () => {
  const { daemon, faux } = await bootTest();
  await daemon.root.commit(async (tx) => {
    applyFactOps(await tx.doc(MemoryDoc, ROOT_CONVERSATION_ID), [{ op: "add", text: "Ada lives in Oslo" }], 0);
  }, ctx);
  route(faux, (system) => {
    if (reflecting(system)) {
      return save(
        profile(
          { op: "add", text: "Ada loves long answers", evidence: "I love long answers" },
          { op: "update", id: "1", text: "Ada lives in Bergen", evidence: "I moved to Bergen" },
          { op: "add", text: "Ada prefers short answers" }, // no evidence at all
        ),
      );
    }
  });
  await ask(daemon, "I'm Ada, I prefer short answers");
  await resetDone(daemon);
  await daemon.reflect();

  expect(await factTexts(daemon)).toEqual(["Ada lives in Oslo"]);
  expect((await memory(daemon)).reflectedThrough).toBe(await newest(daemon));
  await daemon.close();
});

test("evidence quoted from an automated line is rejected", async () => {
  const { daemon, faux } = await bootTest();
  route(faux, (system) => {
    if (reflecting(system)) {
      return save(
        profile(
          { op: "add", text: "Ada cleans up old backups", evidence: "removed the old backups" },
          { op: "add", text: "Ada is called Ada", evidence: "my name is Ada" },
        ),
      );
    }
  });
  await ask(daemon, "[job 3 Cleanup] done: removed the old backups");
  await resetDone(daemon);
  await ask(daemon, "hi, my name is Ada");
  await resetDone(daemon);
  await daemon.reflect();

  expect(await factTexts(daemon)).toEqual(["Ada is called Ada"]);
  await daemon.close();
});

test("an off-scope add is rejected", async () => {
  const { daemon, faux } = await bootTest();
  route(faux, (system) => {
    if (reflecting(system)) {
      return save(profile({ op: "add", text: "Ada's server is at 10.0.0.5", evidence: "my server is at 10.0.0.5" }));
    }
  });
  await ask(daemon, "my server is at 10.0.0.5 now");
  await resetDone(daemon);
  await daemon.reflect();

  expect(await factTexts(daemon)).toEqual([]);
  expect((await memory(daemon)).reflectedThrough).toBe(await newest(daemon));
  await daemon.close();
});

test("a page write creates the page", async () => {
  const { daemon, faux } = await bootTest();
  route(faux, (system) => {
    if (reflecting(system)) return save(pages({ title: "Home servers", text: "NAS in the closet; backups nightly." }));
  });
  await ask(daemon, "the NAS now lives in the closet");
  await resetDone(daemon);
  await daemon.reflect();

  expect((await pad(daemon)).pages).toEqual([
    { id: "1", title: "Home servers", text: "NAS in the closet; backups nightly.", updatedAt: expect.any(Number) },
  ]);
  await daemon.close();
});

test("a page write with a stale basedOn is skipped", async () => {
  const { daemon, faux } = await bootTest();
  const write = (title: string, text: string, at: number) =>
    daemon.root.commit(async (tx) => {
      writePage(await tx.doc(ScratchpadDoc, ROOT_CONVERSATION_ID), title, text, at);
    }, ctx);
  await write("Home servers", "NAS in the hallway.", 1000);
  const hold = held();
  route(faux, (system, _text, signal) => {
    if (reflecting(system)) {
      return hold.wait(
        save(
          pages(
            { title: "Home servers", text: "the reflection's version", basedOn: 1000 },
            { title: "Garden", text: "Tomatoes planted." },
          ),
        ),
        signal,
      );
    }
  });
  await ask(daemon, "the NAS moved; also planted tomatoes");
  await resetDone(daemon);

  const reflected = daemon.reflect();
  await waitFor(() => hold.started()); // the reflection has read the pages and is waiting for its model
  await write("Home servers", "NAS in the closet (the CoS's edit).", 2000); // the CoS edits the page meanwhile
  hold.release();
  await reflected;

  const saved = (await pad(daemon)).pages.map((p) => [p.title, p.text]);
  expect(saved).toEqual([
    ["Home servers", "NAS in the closet (the CoS's edit)."],
    ["Garden", "Tomatoes planted."],
  ]);
  await daemon.close();
});

test("a page write with a current basedOn replaces the page", async () => {
  const { daemon, faux } = await bootTest();
  await daemon.root.commit(async (tx) => {
    writePage(await tx.doc(ScratchpadDoc, ROOT_CONVERSATION_ID), "Home servers", "NAS in the hallway.", 1000);
  }, ctx);
  route(faux, (system) => {
    if (reflecting(system)) {
      return save(
        pages(
          { title: "home servers", text: "NAS in the closet.", basedOn: 1000 },
          { title: "Home servers", text: "a second write without basedOn" }, // the page exists: skipped
        ),
      );
    }
  });
  await ask(daemon, "the NAS moved to the closet");
  await resetDone(daemon);
  await daemon.reflect();

  expect((await pad(daemon)).pages.map((p) => [p.title, p.text])).toEqual([["Home servers", "NAS in the closet."]]);
  await daemon.close();
});

test("a basedOn given as a string still matches the page", async () => {
  const { daemon, faux } = await bootTest();
  await daemon.root.commit(async (tx) => {
    writePage(await tx.doc(ScratchpadDoc, ROOT_CONVERSATION_ID), "Home servers", "NAS in the hallway.", 1000);
  }, ctx);
  route(faux, (system) => {
    if (reflecting(system)) return save(pages({ title: "Home servers", text: "NAS in the closet.", basedOn: "1000" }));
  });
  await ask(daemon, "the NAS moved to the closet");
  await resetDone(daemon);
  await daemon.reflect();

  expect((await pad(daemon)).pages.map((p) => [p.title, p.text])).toEqual([["Home servers", "NAS in the closet."]]);
  await daemon.close();
});

test("malformed entries are dropped, the valid ones applied, and the drops reported", async () => {
  const { daemon, faux } = await bootTest();
  const warned: string[] = [];
  const warn = console.warn;
  console.warn = (...args: unknown[]) => void warned.push(args.join(" "));
  try {
    route(faux, (system) => {
      if (reflecting(system)) {
        return save({
          profile: [
            { op: "add", evidence: "I like tea" }, // no text
            { op: "update", text: "Ada likes tea a lot", evidence: "I like tea" }, // no id
            { op: "delete" }, // no id
            null,
            { op: "add", text: "Ada likes tea", evidence: "I like tea" },
          ],
          pages: [{ title: "Garden" }, { text: "no title" }, "junk", { title: "Tea", text: "Green, mostly." }],
        });
      }
    });
    await ask(daemon, "hello, I like tea");
    await resetDone(daemon);
    await daemon.reflect();
  } finally {
    console.warn = warn;
  }

  expect(await factTexts(daemon)).toEqual(["Ada likes tea"]);
  expect((await pad(daemon)).pages.map((p) => [p.title, p.text])).toEqual([["Tea", "Green, mostly."]]);
  expect((await memory(daemon)).reflectedThrough).toBe(await newest(daemon));
  const reports = warned.filter((w) => w.startsWith("japa.reflect:"));
  expect(reports).toHaveLength(1);
  expect(reports[0]).toContain("4 malformed profile ops");
  expect(reports[0]).toContain("3 malformed pages");
  await daemon.close();
});

test("dropped operations are reported once per pass, without the user's text", async () => {
  const { daemon, faux } = await bootTest();
  await daemon.root.commit(async (tx) => {
    writePage(await tx.doc(ScratchpadDoc, ROOT_CONVERSATION_ID), "Home servers", "NAS in the hallway.", 1000);
  }, ctx);
  const warned: string[] = [];
  const warn = console.warn;
  console.warn = (...args: unknown[]) => void warned.push(args.join(" "));
  try {
    route(faux, (system) => {
      if (reflecting(system)) {
        return save({
          profile: [
            { op: "add", text: "Ada loves opera", evidence: "I love opera" },
            { op: "add", text: "Ada's server is at 10.0.0.5", evidence: "my server is at 10.0.0.5" },
          ],
          pages: [{ title: "Home servers", text: "stale", basedOn: 5 }],
        });
      }
    });
    await ask(daemon, "my server is at 10.0.0.5 now");
    await resetDone(daemon);
    await daemon.reflect();
  } finally {
    console.warn = warn;
  }

  const reports = warned.filter((w) => w.startsWith("japa.reflect:"));
  expect(reports).toHaveLength(1);
  expect(reports[0]).toContain("1 without evidence");
  expect(reports[0]).toContain("1 off-scope");
  expect(reports[0]).toContain("stale pages: Home servers");
  expect(reports[0]).not.toContain("opera");
  expect(reports[0]).not.toContain("10.0.0.5");
  await daemon.close();
});

test("a clean pass reports nothing", async () => {
  const { daemon, faux } = await bootTest();
  const warned: string[] = [];
  const warn = console.warn;
  console.warn = (...args: unknown[]) => void warned.push(args.join(" "));
  try {
    route(faux, (system) =>
      reflecting(system) ? save(profile({ op: "add", text: "Ada likes tea", evidence: "I like tea" })) : undefined,
    );
    await ask(daemon, "hello, I like tea");
    await resetDone(daemon);
    await daemon.reflect();
  } finally {
    console.warn = warn;
  }
  expect(warned.filter((w) => w.startsWith("japa.reflect:"))).toEqual([]);
  await daemon.close();
});

test("an oversized page is shortened once, then dropped if still too long", async () => {
  const { daemon, faux } = await bootTest();
  const shortened: string[] = [];
  const big = (c: string) => `${c} `.repeat(3001); // 6 002 characters: 1 501 tokens
  route(faux, (system, text) => {
    if (reflecting(system)) {
      return save(pages({ title: "Alpha", text: big("a") }, { title: "Beta", text: big("b") }));
    }
    if (system.startsWith("Shorten this page")) {
      shortened.push(text.split("\n")[0]!);
      return save({ text: text.includes("Alpha") ? "Alpha, condensed." : big("b") });
    }
  });
  await ask(daemon, "lots of alpha and beta");
  await resetDone(daemon);
  await daemon.reflect();

  expect(shortened.toSorted()).toEqual(["## Alpha", "## Beta"]); // once each
  expect((await pad(daemon)).pages.map((p) => [p.title, p.text])).toEqual([["Alpha", "Alpha, condensed."]]);
  await daemon.close();
});

test("the prompt shows profile ages and active pages", async () => {
  const { daemon, faux } = await bootTest();
  const now = Date.now();
  await daemon.root.commit(async (tx) => {
    applyFactOps(await tx.doc(MemoryDoc, ROOT_CONVERSATION_ID), [{ op: "add", text: "Ada likes tea" }], now - 3 * DAY - 60_000);
    const scratchpad = await tx.doc(ScratchpadDoc, ROOT_CONVERSATION_ID);
    writePage(scratchpad, "Old project", "Long done.", 500);
    writePage(scratchpad, "Home servers", "NAS in the closet.", 1000);
    scratchpad.pages[0]!.archivedAt = 600;
  }, ctx);
  let system = "";
  let prompt = "";
  route(faux, (s, text) => {
    if (reflecting(s)) {
      system = s;
      prompt = text;
      return save(profile());
    }
  });
  await ask(daemon, "hello there");
  await resetDone(daemon);
  await daemon.reflect();

  expect(prompt).toMatch(/^Turns since the last reflection:\nuser: hello there\n/);
  expect(prompt).toContain("\n\nProfile:\n1 (3 d ago): Ada likes tea\n\nPages:\n## Home servers (basedOn 1000)\nNAS in the closet.");
  expect(prompt).not.toContain("Old project");
  expect(system).toContain("Protective of his Claude subscription limits; expects integrations to be efficient by default.");
  expect(system).toContain(
    "Factory settings: global defaults plus per-project overrides (behaviour, model/thinking per role, sandbox, ci).",
  );
  expect(system).toContain("evidence");
  expect(system).toContain("`[secret `");
  expect(system).toContain("basedOn");
  expect(system).toContain(
    "What the user said, decided or prefers comes only from `user:` lines; the assistant's own statements about the user are not a source.",
  );
  await daemon.close();
});

test("an empty profile and no pages show as none", async () => {
  const { daemon, faux } = await bootTest();
  let prompt = "";
  route(faux, (system, text) => {
    if (reflecting(system)) {
      prompt = text;
      return save(profile());
    }
  });
  await ask(daemon, "hello");
  await resetDone(daemon);
  await daemon.reflect();
  expect(prompt).toContain("\n\nProfile:\n(none)\n\nPages:\n(none)");
  await daemon.close();
});

test("reflection reads only the turns after the cursor", async () => {
  const { daemon, faux } = await bootTest();
  const prompts: string[] = [];
  route(faux, (system, text) => {
    if (reflecting(system)) {
      prompts.push(text);
      return save(profile());
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
  route(faux, (system) => (reflecting(system) ? save(profile()) : undefined));
  await ask(daemon, "hello");
  await resetDone(daemon);
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
    if (reflecting(system)) {
      prompts.push(text);
      return save(profile());
    }
  });
  await ask(daemon, `A ${"x".repeat(5000)}`);
  await resetDone(daemon);
  await ask(daemon, `B ${"y".repeat(5000)}`);
  await resetDone(daemon);
  await daemon.reflect();

  expect(prompts).toHaveLength(2);
  expect(prompts[0]!.includes("A ")).toBe(true);
  expect(prompts[0]!.includes("B ")).toBe(false);
  expect((await memory(daemon)).reflectedThrough).toBe(await newest(daemon));
  await daemon.close();
});

test("evidence counts only the turns of its own chunk", async () => {
  const kit = testKit({ models: [{ id: "narrow", contextWindow: 4000 }] });
  const { daemon, faux } = await bootTest({}, [], kit);
  route(faux, (system, text) => {
    if (!reflecting(system)) return;
    // Both chunks quote the first one's line: only the first chunk may.
    const fact = text.includes("A x") ? "Ada likes the letter A" : "Ada likes the letter B";
    return save(profile({ op: "add", text: fact, evidence: "I like A" }));
  });
  await ask(daemon, `I like A ${"x".repeat(5000)}`);
  await resetDone(daemon);
  await ask(daemon, `B ${"y".repeat(5000)}`);
  await resetDone(daemon);
  await daemon.reflect();

  expect(await factTexts(daemon)).toEqual(["Ada likes the letter A"]);
  await daemon.close();
});

test("a fact forgotten while the reflection runs stays forgotten", async () => {
  const { daemon, faux } = await bootTest();
  const hold = held();
  route(faux, (system, text, signal) => {
    if (reflecting(system)) {
      return hold.wait(save(profile({ op: "add", text: "Ada likes tea", evidence: "I like tea" })), signal);
    }
    if (text === "forget it") return call("memory_forget", { id: "1" });
  });
  await ask(daemon, "hello, I like tea");
  await daemon.root.commit(async (tx) => {
    applyFactOps(await tx.doc(MemoryDoc, ROOT_CONVERSATION_ID), [{ op: "add", text: "Ada lives in Oslo" }], 0);
  }, ctx);

  const reflected = daemon.reflect();
  await waitFor(() => hold.started()); // the reflection has read the memory and is waiting for its model
  await ask(daemon, "forget it");
  hold.release();
  await reflected;

  expect(await factTexts(daemon)).toEqual(["Ada likes tea"]);
  await daemon.close();
});

test("an entry larger than the chunk budget is sent truncated", async () => {
  const kit = testKit({ models: [{ id: "narrow", contextWindow: 4000 }] });
  const { daemon, faux } = await bootTest({}, [], kit);
  const prompts: string[] = [];
  route(faux, (system, text) => {
    if (reflecting(system)) {
      prompts.push(text);
      return save(profile());
    }
  });
  await ask(daemon, `A ${"x".repeat(10_000)}`);
  await resetDone(daemon);
  await daemon.reflect();

  const sent = prompts[0]!.split("\n")[1]!; // the oversized entry's line
  expect(sent.length).toBe(8000); // half of the 4 000-token window, four characters per token
  expect(sent.startsWith(`user: A ${"x".repeat(100)}`)).toBe(true);
  expect((await memory(daemon)).reflectedThrough).toBe(await newest(daemon));
  await daemon.close();
});

test("the chunk budget leaves room for the profile and pages, down to a floor", async () => {
  /** The length of the oversized entry's line as sent, with `n` 1,500-token pages, on a model with `contextWindow`. */
  async function sent(contextWindow: number, n: number): Promise<number> {
    const kit = testKit({ models: [{ id: "narrow", contextWindow }] });
    const { daemon, faux } = await bootTest({}, [], kit);
    await daemon.root.commit(async (tx) => {
      const scratchpad = await tx.doc(ScratchpadDoc, ROOT_CONVERSATION_ID);
      for (let i = 0; i < n; i++) writePage(scratchpad, `P${i}`, "p".repeat(6000), 1000 + i);
    }, ctx);
    const prompts: string[] = [];
    route(faux, (system, text) => {
      if (reflecting(system)) {
        prompts.push(text);
        return save(profile());
      }
    });
    await ask(daemon, `A ${"x".repeat(60_000)}`);
    await resetDone(daemon);
    await daemon.reflect();
    await daemon.close();
    return prompts[0]!.split("\n")[1]!.length;
  }
  // Half of 20 000 tokens is 10 000; four pages take about 6 000 of them, leaving about 4 000 (16 000 characters).
  const roomy = await sent(20_000, 4);
  expect(roomy).toBeLessThan(16_000);
  expect(roomy).toBeGreaterThan(15_800);
  // Pages larger than half the window: the budget is the floor, 2 000 tokens (8 000 characters).
  expect(await sent(4000, 2)).toBe(8000);
});

test("a reflection that faults leaves the cursor and is retried", async () => {
  const { daemon, faux } = await bootTest();
  let calls = 0;
  // `save` without its fields makes the phase throw, which faults the task
  route(faux, (system) => {
    if (!reflecting(system)) return;
    return calls++ === 0 ? save({}) : save(profile({ op: "add", text: "Ada likes tea", evidence: "I like tea" }));
  });
  await ask(daemon, "hello, I like tea");
  await daemon.reflect().catch(() => {});
  expect((await memory(daemon)).reflectedThrough).toBeUndefined();
  await daemon.reflect();
  expect(await factTexts(daemon)).toEqual(["Ada likes tea"]);
  await daemon.close();
});

const SAID = "hello, I like tea";
const EVIDENCE = "I like tea";

/** Boots, has one exchange (`SAID`), and reflects with `respond` answering every reflection-model request. */
async function reflected(respond: Respond, settings = {}) {
  const { daemon, faux } = await bootTest(settings);
  const prompts: string[] = [];
  route(faux, (system, text, signal) => {
    if (!reflecting(system) && !system.startsWith("Shorten") && !system.startsWith("Merge")) return;
    prompts.push(system.split(" ")[0]!);
    return respond(system, text, signal);
  });
  await ask(daemon, SAID);
  await daemon.reflect();
  return { daemon, prompts };
}

const LONG = "word ".repeat(60).trim();

test("a too-long fact is shortened", async () => {
  const { daemon, prompts } = await reflected((system) =>
    system.startsWith("Shorten")
      ? save({ facts: [{ op: "add", text: "Ada writes a lot" }] })
      : save(profile({ op: "add", text: LONG, evidence: EVIDENCE })),
  );
  expect(prompts).toEqual(["You", "Shorten"]);
  expect(await factTexts(daemon)).toEqual(["Ada writes a lot"]);
  await daemon.close();
});

test("a fact still too long after shortening is dropped", async () => {
  const { daemon } = await reflected((system) =>
    system.startsWith("Shorten")
      ? save({ facts: [{ op: "add", text: `${LONG} more` }] })
      : save(profile({ op: "add", text: LONG, evidence: EVIDENCE })),
  );
  expect(await factTexts(daemon)).toEqual([]);
  await daemon.close();
});

test("the shorten pass can't introduce operations it wasn't given", async () => {
  const { daemon } = await reflected((system) =>
    system.startsWith("Shorten")
      ? save({
          facts: [
            { op: "add", text: "Ada writes a lot" },
            { op: "add", text: "Ada secretly loves opera" },
            { op: "update", id: "7", text: "Ada lives on the moon" },
          ],
        })
      : save(profile({ op: "add", text: LONG, evidence: EVIDENCE })),
  );
  expect(await factTexts(daemon)).toEqual(["Ada writes a lot"]);
  await daemon.close();
});

test("facts over the cap are merged, and the merge pass can't add", async () => {
  const added = ["Ada likes tea", "Ada runs marathons", "Ada lives in Oslo", "Ada has two cats"];
  let merging = "";
  const { daemon, prompts } = await reflected(
    (system) => {
      if (!system.startsWith("Merge")) return save(profile(...added.map((text) => ({ op: "add", text, evidence: EVIDENCE }))));
      merging = system;
      return save({
        facts: [
          { op: "delete", id: "1" },
          { op: "update", id: "2", text: "Ada is sporty and likes tea" },
          { op: "add", text: "Ada secretly loves opera" }, // nothing backs it: dropped
        ],
      });
    },
    { memory: { maxFacts: 3 } },
  );
  expect(prompts).toEqual(["You", "Merge"]);
  expect(merging).toContain("update(id, text) and delete(id)");
  expect(merging).not.toContain("add(");
  expect(await factTexts(daemon)).toEqual(["Ada is sporty and likes tea", "Ada lives in Oslo", "Ada has two cats"]);
  await daemon.close();
});

test("an unsorted memory is neither merged nor truncated by a reflection", async () => {
  const v2 = ["Ada runs marathons", "Ada lives in Oslo", "Ada has two cats", "Ada plays chess"];
  const { daemon, faux } = await bootTest({ memory: { maxFacts: 3 } });
  await daemon.root.commit(async (tx) => {
    const doc = await tx.doc(MemoryDoc, ROOT_CONVERSATION_ID);
    delete doc.sorted; // a version 2 memory the Sort hasn't reached yet
    doc.facts = v2.map((text, i) => ({ id: String(i + 1), text, updatedAt: i + 1 }));
    doc.nextId = v2.length + 1;
  }, ctx);
  const prompts: string[] = [];
  route(faux, (system) => {
    if (!reflecting(system) && !system.startsWith("Merge")) return;
    prompts.push(system.split(" ")[0]!);
    if (system.startsWith("Merge")) return save({ facts: [{ op: "delete", id: "1" }] });
    return save(profile({ op: "add", text: "Ada likes tea", evidence: EVIDENCE }, { op: "delete", id: "2" }));
  });
  await ask(daemon, SAID);
  await daemon.reflect();

  expect(prompts).toEqual(["You"]);
  const saved = await memory(daemon);
  expect(saved.reflectedThrough).toBe(await newest(daemon));
  expect(saved.facts.map((f) => f.text)).toEqual(["Ada runs marathons", "Ada has two cats", "Ada plays chess", "Ada likes tea"]);
  // The fact the reflection deleted stays searchable as a legacy episode, for the Sort to see.
  expect(saved.legacyEpisodes).toEqual([{ id: "fact:2", at: 2, text: "Ada lives in Oslo" }]);
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
    if (reflecting(system)) {
      prompts.push(text);
      return save(profile());
    }
  });
  const reopened = await boot({ home, extensions: [kit.extension] });
  await waitFor(() => prompts.length > 0);
  await waitFor(async () => (await memory(reopened)).reflectedThrough !== undefined);
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
  ).toEqual({ nextId: 4, facts: [fact], legacyEpisodes: [], upgraded: { loops: ["call the bank"] } });
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
  expect(bootErrors(daemon)).toEqual([]);
  await daemon.close();
});
