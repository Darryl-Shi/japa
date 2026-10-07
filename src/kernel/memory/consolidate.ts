import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { type Models, type TSchema, type Tool, Type } from "@earendil-works/pi-ai";
import {
  type Conversation,
  defineTask,
  LiveDoc,
  ResetEntry,
  ROOT_CONVERSATION_ID,
  type TaskId,
  type Tx,
} from "@earendil-works/pi-durable";
import { line } from "../jobs/cos.ts";
import { BACKGROUND } from "../jobs/run.ts";
import type { Settings } from "../settings.ts";
import {
  applyFactOps,
  applyLoopOps,
  type FactOp,
  type LoopOp,
  type Memory,
  MemoryDoc,
  overCap,
  truncateToCap,
} from "./state.ts";

const REFLECT = `You consolidate a chief-of-staff assistant's conversation before its context is reset. Call save once with:
- facts: operations on the user facts ("About you"), a high-level picture of the user, not a log. Each entry is one lasting aspect in at most two sentences (50 words): who the user is, what they're working toward, how they like to work, key people and projects, standing preferences. Use add(text), update(id, text) or delete(id); an empty list when nothing changes. Rules:
  - record patterns and lasting context, not events or task details;
  - fold new details into an existing entry and generalize, rather than adding entries;
  - rewrite entries that have become too specific at a higher level;
  - skip sensitive details unless the user explicitly asks to remember them.
- loops: the open loops, commitments and things being waited on. Add new ones with add(text); close finished ones with close(id).
- episode: a short summary of this conversation, for later search.
- handoff: a note that starts the next context: what is in progress and what comes next.`;

const SHORTEN = `Shorten each of these user fact operations to at most 50 words, keeping its meaning. Call save with the same operations and the shortened texts.`;

const merge = (limits: Settings["memory"]) =>
  `Merge these user facts: they exceed the limit of ${limits.maxFacts} entries and ${limits.maxTokens} tokens (about 4 characters per token). Combine related entries and delete the least useful until the list fits. Call save with update(id, text), delete(id) and add(text) operations.`;

const factOps = Type.Array(
  Type.Union([
    Type.Object({ op: Type.Literal("add"), text: Type.String() }),
    Type.Object({ op: Type.Literal("update"), id: Type.String(), text: Type.String() }),
    Type.Object({ op: Type.Literal("delete"), id: Type.String() }),
  ]),
);
const loopOps = Type.Array(
  Type.Union([
    Type.Object({ op: Type.Literal("add"), text: Type.String() }),
    Type.Object({ op: Type.Literal("close"), id: Type.String() }),
  ]),
);
const saveTool = (properties: Record<string, TSchema>): Tool => ({
  name: "save",
  description: "Save your result.",
  parameters: Type.Object(properties),
});
const save = saveTool({ facts: factOps, loops: loopOps, episode: Type.String(), handoff: Type.String() });
const saveFacts = saveTool({ facts: factOps });

type Saved = { facts: FactOp[]; loops: LoopOp[]; episode: string; handoff: string };

const listed = (items: { id: string; text: string }[]) => items.map((i) => `${i.id}: ${i.text}`).join("\n") || "(none)";

/**
 * The `Consolidate` task, which saves what the CoS's live window taught about the user and resets its context with a
 * handoff note, and `startConsolidation`, which starts it unless it is already running.
 */
export function consolidation({ models, settings }: { models: Models; settings: Settings }) {
  /** The `save` arguments of the consolidation model's answer, if it called `save`. */
  async function ask<T>(systemPrompt: string, text: string, tool: Tool, signal: AbortSignal): Promise<T | undefined> {
    const ref = settings.models.consolidation ?? settings.models.cos!;
    const model = models.getModel(ref.provider, ref.modelId)!;
    const messages = [{ role: "user" as const, content: text, timestamp: Date.now() }];
    const answer = await models.completeSimple(model, { systemPrompt, messages, tools: [tool] }, { signal });
    return answer.content.find((c) => c.type === "toolCall")?.arguments as T | undefined;
  }

  async function finish(tx: Tx) {
    delete (await tx.doc(MemoryDoc, ROOT_CONVERSATION_ID)).consolidating;
  }

  const Consolidate = defineTask<null, { phase: "consolidate" }, null>({
    name: "japa.consolidate",
    version: 1,
    initial: () => ({ phase: "consolidate" }),
    phases: {
      consolidate: async (_task, runtime, context) => {
        const view = await runtime.context(ROOT_CONVERSATION_ID, context);
        const head = view.entries.at(-1)?.id;
        const memory = structuredClone((await runtime.snapshot(MemoryDoc, ROOT_CONVERSATION_ID, context))!) as Memory;
        const now = runtime.now();
        const window = view.messages
          .filter((m) => m.role !== "system")
          .map(line)
          .join("\n");
        const text = `Conversation since the last reset:\n${window}\n\nFacts:\n${listed(memory.facts)}\n\nOpen loops:\n${listed(memory.loops)}`;
        const saved = await ask<Saved>(REFLECT, text, save, runtime.signal);
        if (saved !== undefined) {
          const { tooLong } = applyFactOps(memory, saved.facts, now);
          applyLoopOps(memory, saved.loops, now);
          if (tooLong.length > 0) {
            const shortened = await ask<{ facts: FactOp[] }>(
              SHORTEN,
              JSON.stringify(tooLong),
              saveFacts,
              runtime.signal,
            );
            applyFactOps(memory, shortened?.facts ?? [], now); // still too long: dropped
          }
          if (overCap(memory.facts, settings.memory)) {
            const merged = await ask<{ facts: FactOp[] }>(
              merge(settings.memory),
              listed(memory.facts),
              saveFacts,
              runtime.signal,
            );
            applyFactOps(memory, merged?.facts ?? [], now);
            memory.facts = truncateToCap(memory.facts, settings.memory);
          }
        }
        // One commit checks that the root is still idle and unchanged, saves the memory and resets the context.
        await runtime.commit(async (tx) => {
          await finish(tx);
          const busy = (await tx.doc(LiveDoc, ROOT_CONVERSATION_ID)).run !== undefined;
          const latest = (await tx.scanEntries({ conversationId: ROOT_CONVERSATION_ID }, 1)).items[0]?.id;
          if (saved !== undefined && !busy && latest === head) {
            delete memory.consolidating;
            memory.episodes.push({ id: String(memory.nextId++), at: now, text: saved.episode });
            memory.previousResetAt = memory.lastResetAt ?? 0;
            memory.lastResetAt = now;
            Object.assign(await tx.doc(MemoryDoc, ROOT_CONVERSATION_ID), memory);
            const handoff = { role: "user" as const, content: saved.handoff, timestamp: now };
            await tx.appendEntry(ResetEntry, ROOT_CONVERSATION_ID, { head: "self", model: [handoff] });
          }
          return { status: "terminal", outcome: { status: "completed", result: null } };
        }, context);
      },
    },
    abort: (_task, runtime, context) =>
      runtime.commit(async (tx) => {
        await finish(tx);
        return { status: "terminal", outcome: { status: "aborted" } };
      }, context),
  });

  /** Starts `Consolidate` on `root` unless one is live; returns its id. */
  function startConsolidation(root: Conversation): Promise<TaskId> {
    return root.commit(async (tx) => {
      const memory = await tx.doc(MemoryDoc, ROOT_CONVERSATION_ID);
      memory.consolidating ??= await tx.createTask(Consolidate, null, BACKGROUND);
      return memory.consolidating;
    }, ctx);
  }

  return { Consolidate, startConsolidation };
}
