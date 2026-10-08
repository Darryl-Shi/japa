import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { type Message, type Models, type TSchema, type Tool, Type } from "@earendil-works/pi-ai";
import {
  CompactionEntry,
  type Conversation,
  type Cursor,
  defineTask,
  type EntryId,
  type EntryRecord,
  type Harness,
  ResetEntry,
  ROOT_CONVERSATION_ID,
  type TaskId,
  type Tx,
} from "@earendil-works/pi-durable";
import { line } from "../jobs/cos.ts";
import { BACKGROUND } from "../jobs/run.ts";
import type { Settings } from "../settings.ts";
import { applyFactOps, estimateTokens, type FactOp, type Memory, MemoryDoc, overCap, truncateToCap } from "./state.ts";

const REFLECT = `You reflect on a chief-of-staff assistant's recent turns and update what it remembers about the user. Call save once with:
- facts: operations on the user facts ("About you"), a high-level picture of the user, not a log. Each entry is one lasting aspect in at most two sentences (50 words): who the user is, what they're working toward, how they like to work, key people and projects, standing preferences. Use add(text), update(id, text) or delete(id); an empty list when nothing changes. Rules:
  - record patterns and lasting context, not events or task details;
  - fold new details into an existing entry and generalize, rather than adding entries;
  - rewrite entries that have become too specific at a higher level;
  - skip sensitive details unless the user explicitly asks to remember them.
- episode: a short summary of these turns, for later search. Name the people, projects and decisions.
\`user:\` lines starting with \`[job \` or \`[<name>]\` are automated reports, not the user: don't record them as facts about the user.`;

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
const saveTool = (properties: Record<string, TSchema>): Tool => ({
  name: "save",
  description: "Save your result.",
  parameters: Type.Object(properties),
});
const save = saveTool({ facts: factOps, episode: Type.String() });
const saveFacts = saveTool({ facts: factOps });

type Saved = { facts: FactOp[]; episode: string };
type Chunk = { taken: EntryRecord[]; lines: string[]; more: boolean };

const listed = (items: { id: string; text: string }[]) => items.map((i) => `${i.id}: ${i.text}`).join("\n") || "(none)";

/** `entry`'s non-system model messages, one per line. */
const entryText = (entry: EntryRecord) => (entry.model ?? []).filter((m) => m.role !== "system").map(line).join("\n");

/** Every entry after `from` (exclusive), oldest first. */
async function drain(tx: Tx, from: EntryId | undefined): Promise<EntryRecord[]> {
  const items: EntryRecord[] = [];
  let cursor: Cursor | undefined;
  do {
    const page = await tx.scanEntries({ conversationId: ROOT_CONVERSATION_ID, minEntryId: from }, 200, cursor);
    items.push(...page.items);
    cursor = page.next;
  } while (cursor !== undefined);
  return items.toReversed();
}

/** The oldest of `entries` (skipping resets and compactions) whose rendered text fits `budget` tokens; at least one. */
function chunk(entries: EntryRecord[], budget: number): Chunk {
  const candidates = entries.filter((e) => e.kind !== ResetEntry.kind && e.kind !== CompactionEntry.kind);
  const taken: EntryRecord[] = [];
  const lines: string[] = [];
  for (const entry of candidates) {
    const text = entryText(entry).slice(0, budget * 4); // an oversized entry is reflected truncated, not forever
    if (lines.length > 0 && estimateTokens([...lines, text].join("\n")) > budget) break;
    taken.push(entry);
    lines.push(text);
  }
  return { taken, lines, more: candidates.length > taken.length };
}

/**
 * The `Reflect` task, which reads the root's stored transcript since the last reflection and saves what it taught
 * about the user as facts and an episode, and `startReflect`, which starts it unless it is already running.
 */
export function reflection({ models, settings }: { models: Models; settings: Settings }) {
  /** The model that reflects: the consolidation model when set, the CoS's otherwise. Read live: settings change. */
  const reflectModel = () => {
    const ref = settings.models.consolidation ?? settings.models.cos!;
    return models.getModel(ref.provider, ref.modelId)!;
  };

  /** The `save` arguments of the reflection model's answer, if it called `save`. */
  async function ask<T>(systemPrompt: string, text: string, tool: Tool, signal: AbortSignal): Promise<T | undefined> {
    const messages = [{ role: "user" as const, content: text, timestamp: Date.now() }];
    const answer = await models.completeSimple(reflectModel(), { systemPrompt, messages, tools: [tool] }, { signal });
    return answer.content.find((c) => c.type === "toolCall")?.arguments as T | undefined;
  }

  const Reflect = defineTask<null, { phase: "reflect"; through?: EntryId }, null>({
    name: "japa.reflect",
    version: 1,
    initial: () => ({ phase: "reflect" }),
    phases: {
      reflect: async (_task, runtime, context) => {
        const memory = structuredClone((await runtime.snapshot(MemoryDoc, ROOT_CONVERSATION_ID, context))!) as Memory;
        const budget = Math.floor(reflectModel().contextWindow / 2);
        const from = memory.reflectedThrough !== undefined ? ((memory.reflectedThrough + 1) as EntryId) : undefined;

        // Read-only: finds this invocation's chunk, or ends the task at once when nothing is left to reflect on.
        let batch: (Chunk & { through: EntryId }) | undefined;
        await runtime.commit(async (tx) => {
          const entries = await drain(tx, from);
          const found = chunk(entries, budget);
          if (found.taken.length === 0) return { status: "terminal", outcome: { status: "completed", result: null } };
          // The cursor covers what follows the last taken entry as well: the resets and summaries it never renders.
          batch = { ...found, through: (found.more ? found.taken.at(-1)! : entries.at(-1)!).id };
          return undefined;
        }, context);
        if (batch === undefined) return;
        const piece = batch;

        const text = `Turns since the last reflection:\n${piece.lines.join("\n")}\n\nFacts:\n${listed(memory.facts)}`;
        const saved = (await ask<Saved>(REFLECT, text, save, runtime.signal))!; // a missing field throws below, faulting the task
        const now = runtime.now();
        // The decisions are made on the snapshot; the operations they produce are applied to the live memory below.
        const ops = [...saved.facts];
        const { tooLong } = applyFactOps(memory, saved.facts, now);
        if (tooLong.length > 0) {
          const shortened = await ask<{ facts: FactOp[] }>(SHORTEN, JSON.stringify(tooLong), saveFacts, runtime.signal);
          ops.push(...(shortened?.facts ?? []));
          applyFactOps(memory, shortened?.facts ?? [], now); // still too long: dropped
        }
        if (overCap(memory.facts, settings.memory)) {
          const merged = await ask<{ facts: FactOp[] }>(merge(settings.memory), listed(memory.facts), saveFacts, runtime.signal);
          ops.push(...(merged?.facts ?? []));
        }

        // One commit applies the operations to the memory as it stands now — so a `memory_remember` or
        // `memory_forget` made while the models ran survives — and either continues with the next chunk or ends the
        // task. `through` marks the checkpoint as changed (it differs from the previous one), so the task keeps going.
        await runtime.commit(async (tx) => {
          const draft = await tx.doc(MemoryDoc, ROOT_CONVERSATION_ID);
          applyFactOps(draft, ops, now);
          draft.facts = truncateToCap(draft.facts, settings.memory); // a no-op under the cap
          draft.episodes.push({ id: String(draft.nextId++), at: now, text: saved.episode });
          draft.reflectedThrough = piece.through;
          return piece.more
            ? { status: "running", checkpoint: { phase: "reflect", through: piece.through } }
            : { status: "terminal", outcome: { status: "completed", result: null } };
        }, context);
      },
    },
    abort: (_task, runtime, context) =>
      runtime.commit(async () => ({ status: "terminal", outcome: { status: "aborted" } }), context),
  });

  /** Starts `Reflect` on `root` unless one is live; returns its id. */
  function startReflect(root: Conversation): Promise<TaskId> {
    return root.commit(async (tx) => {
      const memory = await tx.doc(MemoryDoc, ROOT_CONVERSATION_ID);
      const last = memory.reflecting && (await tx.task(memory.reflecting));
      if (!last || last.state.status === "terminal") {
        memory.reflecting = await tx.createTask(Reflect, null, BACKGROUND);
      }
      return memory.reflecting!;
    }, ctx);
  }

  return { Reflect, startReflect };
}

/** The number of `pi.reset` entries after `MemoryDoc.reflectedThrough` — one per unreflected turn. */
export async function unreflectedTurns(harness: Harness, root: Conversation): Promise<number> {
  const memory = await harness.snapshot(MemoryDoc, ROOT_CONVERSATION_ID, ctx);
  const minEntryId = memory?.reflectedThrough !== undefined ? ((memory.reflectedThrough + 1) as EntryId) : undefined;
  let turns = 0;
  let cursor: Cursor | undefined;
  do {
    const page = await root.entries({ minEntryId }, 200, cursor, ctx);
    turns += page.items.filter((e) => e.kind === ResetEntry.kind).length;
    cursor = page.next;
  } while (cursor !== undefined);
  return turns;
}

/** Delay before reflecting `turns` unreflected turns: now, in 15 minutes, or never (none unreflected). */
export function reflectDelay(turns: number): number | undefined {
  if (turns === 0) return undefined;
  return turns >= 5 ? 0 : 900_000;
}

/** Clears a pending version 1 upgrade and sets the cursor to the newest entry; returns its dropped loop texts. */
export async function upgradeMemory(root: Conversation): Promise<string[]> {
  return root.commit(async (tx) => {
    const memory = await tx.doc(MemoryDoc, ROOT_CONVERSATION_ID);
    if (memory.upgraded === undefined) return [];
    const newest = (await tx.scanEntries({ conversationId: ROOT_CONVERSATION_ID }, 1)).items[0]?.id;
    const loops = [...memory.upgraded.loops]; // detached from the draft: it outlives this commit
    memory.reflectedThrough = newest;
    delete memory.upgraded;
    return loops;
  }, ctx);
}
