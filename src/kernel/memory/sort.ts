import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { type Models, Type } from "@earendil-works/pi-ai";
import { type Conversation, defineTask, ROOT_CONVERSATION_ID, type TaskId } from "@earendil-works/pi-durable";
import { BACKGROUND } from "../jobs/run.ts";
import type { Settings } from "../settings.ts";
import { factOp, isString, pageWrite, reflectionModel, saveTool, SCOPE } from "./reflect.ts";
import { ACTIVE_PAGES, DELETE_AFTER, findPage, PAGE_TOKENS, ScratchpadDoc, writePage } from "./scratchpad.ts";
import { applyFactOps, type Episode, estimateTokens, type FactOp, type Memory, MemoryDoc, truncateToCap } from "./state.ts";

const SORT = `You sort a chief-of-staff assistant's old memory into its new shape: a short profile of the user ("About you") and scratchpad pages. The old memory is a list of facts, some about the user and some about projects and the assistant's own setup, and episodes: notes on past conversations, newest first. Call save once with:
- profile: operations on the facts so that only short items strictly about the user remain, not a log. Each item is one lasting aspect in at most 30 words: who the user is, people in their life, what they're working toward and why, life and interests, taste, how they like to work with the assistant. Use add(text), update(id, text) or delete(id); a fact you leave out of the list is kept as it is.
  ${SCOPE}
  Rules:
  - delete a fact that isn't about the user, once what matters in it is on a page;
  - fold related facts together and generalize; drop events and task details;
  - where facts or episodes disagree, the newer one wins.
- pages: the scratchpad, at most ${ACTIVE_PAGES} pages, one per project or topic you find in the facts and episodes, each its whole text in free-form markdown, at most 1,500 tokens. A page records the current state (what it is, decisions and why, where it lives, what's open), not how it got there. An empty list when there are none.`;

const save = saveTool({
  profile: Type.Array(
    Type.Union([
      Type.Object({ op: Type.Literal("add"), text: Type.String() }),
      Type.Object({ op: Type.Literal("update"), id: Type.String(), text: Type.String() }),
      Type.Object({ op: Type.Literal("delete"), id: Type.String() }),
    ]),
  ),
  pages: Type.Array(Type.Object({ title: Type.String(), text: Type.String() })),
});

type Saved = { profile: unknown[]; pages?: unknown };
type Page = { title: string; text: string };

/** What the Sort dropped, for its one-line report. */
type Drops = { malformedOps: number; offScope: number; tooLong: number; malformedPages: number; longPages: string[]; extraPages: number; existingPages: string[] };

/** The Sort's one-line report, or undefined when it dropped nothing. Names page titles only, never user text. */
function report(d: Drops): string | undefined {
  const parts = [
    d.malformedOps > 0 && `${d.malformedOps} malformed profile ops`,
    d.offScope > 0 && `${d.offScope} off-scope`,
    d.tooLong > 0 && `${d.tooLong} too long`,
    d.malformedPages > 0 && `${d.malformedPages} malformed pages`,
    d.longPages.length > 0 && `too-long pages: ${d.longPages.join(", ")}`,
    d.extraPages > 0 && `${d.extraPages} pages over ${ACTIVE_PAGES}`,
    d.existingPages.length > 0 && `pages already written: ${d.existingPages.join(", ")}`,
  ].filter(isString);
  return parts.length > 0 ? `japa.sort: dropped ${parts.join("; ")}` : undefined;
}

const day = (at: number) => new Date(at).toISOString().slice(0, 10);

/** `<date>: <text>` per episode, newest first, as many as fit `budget` tokens; at least one, cut to fit. */
function episodeLines(episodes: Episode[], budget: number): string[] {
  const lines: string[] = [];
  for (const episode of episodes.toSorted((a, b) => b.at - a.at)) {
    const text = `${day(episode.at)}: ${episode.text}`.slice(0, budget * 4);
    if (lines.length > 0 && estimateTokens([...lines, text].join("\n")) > budget) break;
    lines.push(text);
  }
  return lines;
}

/**
 * The one-time `Sort` task, which turns a version 2 memory (facts of any kind, and episodes) into profile items about
 * the user and scratchpad pages, then sets `sorted`; and `startSort`, which starts it unless it is already running.
 * A failed or aborted Sort leaves `sorted` unset, so boot starts it again.
 */
export function sorting({ models, settings }: { models: Models; settings: Settings }) {
  const Sort = defineTask<null, { phase: "sort" }, null>({
    name: "japa.sort",
    version: 1,
    initial: () => ({ phase: "sort" }),
    phases: {
      sort: async (_task, runtime, context) => {
        const memory = structuredClone((await runtime.snapshot(MemoryDoc, ROOT_CONVERSATION_ID, context))!) as Memory;
        if (memory.sorted) {
          await runtime.commit(async () => ({ status: "terminal", outcome: { status: "completed", result: null } }), context);
          return;
        }
        const model = reflectionModel(models, settings);
        const budget = Math.floor(model.contextWindow / 2);
        const facts = memory.facts.map((f) => `${f.id}: ${f.text}`).join("\n") || "(none)";
        const episodes = episodeLines(memory.legacyEpisodes ?? [], budget).join("\n") || "(none)";
        const text = `Facts:\n${facts}\n\nEpisodes (newest first):\n${episodes}`;

        const messages = [{ role: "user" as const, content: text, timestamp: Date.now() }];
        const answer = await models.completeSimple(model, { systemPrompt: SORT, messages, tools: [save] }, { signal: runtime.signal });
        const saved = answer.content.find((c) => c.type === "toolCall")?.arguments as Saved | undefined;
        if (!Array.isArray(saved?.profile)) throw new Error("The sort model didn't save a profile list."); // faults the task

        const drops: Drops = { malformedOps: 0, offScope: 0, tooLong: 0, malformedPages: 0, longPages: [], extraPages: 0, existingPages: [] };
        // The evidence check is waived: the source is earlier facts, not what the user said. The scope and caps hold.
        const ops = saved.profile.flatMap((raw): FactOp[] => {
          const o = factOp(raw);
          if (o === undefined) {
            drops.malformedOps++;
            return [];
          }
          const { evidence: _, ...bare } = o;
          return [bare as FactOp];
        });
        const tried = applyFactOps(memory, ops, runtime.now()); // on the snapshot: only to count what's dropped
        drops.offScope = tried.rejected.length;
        drops.tooLong = tried.tooLong.length;

        const pages: Page[] = [];
        for (const raw of Array.isArray(saved.pages) ? saved.pages : []) {
          const write = pageWrite(raw);
          if (write === undefined) drops.malformedPages++;
          else if (estimateTokens(write.text) > PAGE_TOKENS) drops.longPages.push(write.title);
          else if (pages.length >= ACTIVE_PAGES) drops.extraPages++;
          else pages.push({ title: write.title, text: write.text });
        }

        let existing: string[] = []; // reset on each attempt of the commit below
        // One commit applies the operations to the memory as it stands now, so a fact remembered or forgotten while the
        // model ran survives, writes the pages and marks the memory sorted. Pages get the sort's time, not the episodes'.
        await runtime.commit(async (tx) => {
          const draft = await tx.doc(MemoryDoc, ROOT_CONVERSATION_ID);
          const now = runtime.now();
          applyFactOps(draft, ops, now); // off-scope and too-long ops are skipped again
          draft.facts = truncateToCap(draft.facts, settings.memory);
          existing = [];
          if (pages.length > 0) {
            const pad = await tx.doc(ScratchpadDoc, ROOT_CONVERSATION_ID);
            for (const page of pages) {
              // A page the CoS or reflection already wrote holds a newer state than the old memory.
              if (findPage(pad, page.title) !== undefined) existing.push(page.title);
              else writePage(pad, page.title, page.text, now);
            }
          }
          draft.legacyUntil = now + DELETE_AFTER;
          draft.sorted = true;
          return { status: "terminal", outcome: { status: "completed", result: null } };
        }, context);
        const summary = report({ ...drops, existingPages: existing });
        if (summary !== undefined) console.warn(summary);
      },
    },
    abort: (_task, runtime, context) =>
      runtime.commit(async () => ({ status: "terminal", outcome: { status: "aborted" } }), context),
  });

  /** Starts `Sort` on `root` unless one is live; returns its id. Once the memory is sorted, it ends at once. */
  function startSort(root: Conversation): Promise<TaskId> {
    return root.commit(async (tx) => {
      const memory = await tx.doc(MemoryDoc, ROOT_CONVERSATION_ID);
      const last = memory.sorting && (await tx.task(memory.sorting));
      if (!last || last.state.status === "terminal") {
        memory.sorting = await tx.createTask(Sort, null, BACKGROUND);
      }
      return memory.sorting!;
    }, ctx);
  }

  return { Sort, startSort };
}
