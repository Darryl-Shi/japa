import { Type } from "@earendil-works/pi-ai";
import { defineTool, ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { JobsDoc } from "../jobs/state.ts";
import { applyFactOps, MAX_WORDS, MemoryDoc, nearDuplicate, offScope, wordCount, words } from "./state.ts";

const reply = (text: string) => ({ content: [{ type: "text" as const, text }] });

const memoryFacts = defineTool({
  name: "memory_facts",
  description: "List the facts you remember about the user, with their ids.",
  parameters: Type.Object({}),
  execute: async (_args, api, context) => {
    const { facts } = (await api.snapshot(MemoryDoc, ROOT_CONVERSATION_ID, context))!;
    return reply(facts.length ? facts.map((f) => `${f.id}: ${f.text}`).join("\n") : "Nothing saved yet.");
  },
});

const memoryRemember = defineTool({
  name: "memory_remember",
  description: `Remember a lasting fact about the user, in at most ${MAX_WORDS} words.`,
  parameters: Type.Object({ text: Type.String() }),
  execute: async ({ text }, api, context) => {
    // The checks `applyFactOps` makes, in its order, so the refusal can say why.
    const reason = offScope(text);
    if (reason !== undefined) return reply(`Not about the user (${reason}): put it on a scratchpad page instead.`);
    if (wordCount(text) > MAX_WORDS) return reply(`Too long — keep it to ${MAX_WORDS} words.`);
    const answer = await api.commit(async (tx) => {
      const memory = await tx.doc(MemoryDoc, ROOT_CONVERSATION_ID);
      const existing = memory.facts.find((f) => nearDuplicate(f.text, text));
      if (existing) return `Already remembered: ${existing.text}`;
      applyFactOps(memory, [{ op: "add", text }], Date.now());
      return "Remembered.";
    }, context);
    return reply(answer);
  },
});

const memoryForget = defineTool({
  name: "memory_forget",
  description: "Forget the fact with this id.",
  parameters: Type.Object({ id: Type.String() }),
  execute: async ({ id }, api, context) => {
    const answer = await api.commit(async (tx) => {
      const memory = await tx.doc(MemoryDoc, ROOT_CONVERSATION_ID);
      const fact = memory.facts.find((f) => f.id === id);
      if (!fact) return `No memory ${id}.`;
      memory.facts = memory.facts.filter((f) => f !== fact);
      return `Forgot: ${fact.text}`;
    }, context);
    return reply(answer);
  },
});

// Temporary: replaced by `history_search`.
const memorySearch = defineTool({
  name: "memory_search",
  description: "Search past conversation episodes and job results by keywords.",
  parameters: Type.Object({ query: Type.String() }),
  execute: async ({ query }, api, context) => {
    const memory = (await api.snapshot(MemoryDoc, ROOT_CONVERSATION_ID, context))!;
    const { jobs } = (await api.snapshot(JobsDoc, ROOT_CONVERSATION_ID, context))!;
    const terms = new Set(words(query));
    const items = [
      ...(memory.legacyEpisodes ?? []).map((e) => ({ at: e.at, text: e.text, line: `${new Date(e.at).toISOString()} episode: ${e.text}` })),
      ...Object.values(jobs)
        .filter((j) => j.result)
        .map((j) => ({ at: j.updatedAt, text: j.result!, line: `${new Date(j.updatedAt).toISOString()} job ${j.id} "${j.title}": ${j.result}` })),
    ];
    const lines = items
      .map((i) => {
        const w = new Set(words(i.text));
        return { ...i, score: [...terms].filter((t) => w.has(t)).length }; // distinct query words matched
      })
      .filter((i) => i.score > 0)
      .sort((a, b) => b.score - a.score || b.at - a.at)
      .slice(0, 5)
      .map((i) => i.line);
    return reply(lines.length ? lines.join("\n") : "Nothing found.");
  },
});

export const memoryTools = [memoryFacts, memoryRemember, memoryForget, memorySearch];
