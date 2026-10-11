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
import { findPage, PAGE_TOKENS, type Scratchpad, ScratchpadDoc, writePage } from "./scratchpad.ts";
import {
  applyFactOps,
  estimateTokens,
  type Fact,
  type FactOp,
  hasEvidence,
  type Memory,
  MemoryDoc,
  overCap,
  truncateToCap,
} from "./state.ts";
import { AUTOMATED } from "./transcript.ts";
import { ago } from "./window.ts";

const REFLECT = `You reflect on a chief-of-staff assistant's recent turns and update what it remembers: the user's profile and its scratchpad pages. Call save once with:
- profile: operations on the profile ("About you"), short items strictly about the user, not a log. Each item is one lasting aspect in at most 30 words: who the user is, people in their life, what they're working toward and why, life and interests, taste, how they like to work with the assistant. Use add(text, evidence), update(id, text, evidence) or delete(id); an empty list when nothing changes.
  Keep out of the profile: japa's own setup (extensions, models, settings, schedules, jobs); file paths, repos, commits, hosts and IPs; credentials and contact numbers; task status and one-off events; a project's internals, which belong on a page.
  A good item: "Protective of his Claude subscription limits; expects integrations to be efficient by default."
  A bad item: "Factory settings: global defaults plus per-project overrides (behaviour, model/thinking per role, sandbox, ci)." That is a project's internals: it belongs on a page.
  Rules:
  - every add and update needs evidence: a verbatim quote, at least 3 words, from a \`user:\` line in these turns that isn't automated. An operation without it is rejected;
  - if the user corrected something later in these turns, the correction is what you record;
  - record patterns and lasting context, not events or task details;
  - fold new details into an existing item and generalize, rather than adding items; revise items that are stale or too specific;
  - skip sensitive details unless the user explicitly asks to remember them.
- pages: the scratchpad, one page per project or topic, each its whole text in free-form markdown, at most 1,500 tokens. A page records the state these turns reached (what it is, decisions and why, where it lives, what's open), not how they got there. To change a page, write its whole new text and pass back the basedOn you were shown; a new page has no basedOn. Leave out pages that didn't change; an empty list when none did.
\`user:\` lines starting with \`[job \`, \`[schedule \`, \`[japa]\` or \`[<name>]\` are automated reports, not the user: don't record them as facts about the user, and don't quote them as evidence.`;

const SHORTEN = `Shorten each of these user fact operations to at most 30 words, keeping its meaning. Call save with the same operations and the shortened texts.`;

const SHORTEN_PAGE = `Shorten this page to at most 1,500 tokens, keeping its current state. Call save with its new text.`;

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
const profileOps = Type.Array(
  Type.Union([
    Type.Object({ op: Type.Literal("add"), text: Type.String(), evidence: Type.String() }),
    Type.Object({ op: Type.Literal("update"), id: Type.String(), text: Type.String(), evidence: Type.String() }),
    Type.Object({ op: Type.Literal("delete"), id: Type.String() }),
  ]),
);
const pageWrites = Type.Array(
  Type.Object({ title: Type.String(), text: Type.String(), basedOn: Type.Optional(Type.Number()) }),
);
const save = saveTool({ profile: profileOps, pages: pageWrites });
const saveFacts = saveTool({ facts: factOps });
const saveText = saveTool({ text: Type.String() });

type ProfileOp = FactOp & { evidence?: string };
type PageWrite = { title: string; text: string; basedOn?: number };
type Saved = { profile: ProfileOp[]; pages?: PageWrite[] };
type Chunk = { taken: EntryRecord[]; lines: string[]; more: boolean };

const listed = (items: { id: string; text: string }[]) => items.map((i) => `${i.id}: ${i.text}`).join("\n") || "(none)";

/** The profile as the reflection sees it: `<id> (<age>): <text>` per item. */
const aged = (facts: Fact[], now: number) =>
  facts.map((f) => `${f.id} (${ago(f.updatedAt, now)}): ${f.text}`).join("\n") || "(none)";

/** The active pages in full: `## <title> (basedOn <updatedAt>)` and the text. */
const shown = (pad: Scratchpad) =>
  pad.pages
    .filter((p) => p.archivedAt === undefined)
    .map((p) => `## ${p.title} (basedOn ${p.updatedAt})\n${p.text}`)
    .join("\n\n") || "(none)";

/** The text of `message`'s text parts. */
const textOf = (message: Message) =>
  typeof message.content === "string"
    ? message.content
    : message.content.flatMap((c) => (c.type === "text" ? [c.text] : [])).join("");

/** What the user said in `entries`: the texts of their inputs that aren't automated. */
const userLines = (entries: EntryRecord[]) =>
  entries
    .flatMap((e) => (e.model ?? []).filter((m) => m.role === "user").map(textOf))
    .filter((t) => !AUTOMATED.test(t));

/**
 * The shortened `ops` among `shortened`, in order: as many adds as `ops` had, and updates of the ids it updated; the
 * pass can't introduce operations of its own.
 */
function matching(ops: FactOp[], shortened: FactOp[]): FactOp[] {
  let adds = ops.filter((o) => o.op === "add").length;
  const ids = new Set(ops.flatMap((o) => (o.op === "update" ? [o.id] : [])));
  return shortened.filter((o) => {
    if (o.op === "add") return adds-- > 0;
    return o.op === "update" && ids.delete(o.id);
  });
}

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
 * about the user as profile items (each backed by a quote of the user) and what it changed as scratchpad pages, and
 * `startReflect`, which starts it unless it is already running.
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
        const pad = (await runtime.snapshot(ScratchpadDoc, ROOT_CONVERSATION_ID, context)) ?? { nextId: 1, pages: [] };
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

        const now = runtime.now();
        const text = [
          `Turns since the last reflection:\n${piece.lines.join("\n")}`,
          `Profile:\n${aged(memory.facts, now)}`,
          `Pages:\n${shown(pad)}`,
        ].join("\n\n");
        const saved = await ask<Saved>(REFLECT, text, save, runtime.signal);
        if (!Array.isArray(saved?.profile)) throw new Error("The reflection model didn't save a profile list."); // faults the task

        // An add or update must quote what the user said in this chunk; the others are dropped.
        const said = userLines(piece.taken);
        const proven: FactOp[] = saved.profile.flatMap((o): FactOp[] => {
          if (o.op === "delete") return [{ op: "delete", id: o.id }];
          if (typeof o.evidence !== "string" || !hasEvidence(o.evidence, said)) return [];
          return [o.op === "add" ? { op: "add", text: o.text } : { op: "update", id: o.id, text: o.text }];
        });
        // The decisions are made on the snapshot; the operations they produce are applied to the live memory below.
        const ops = [...proven];
        const { tooLong } = applyFactOps(memory, proven, now); // off-scope ops are rejected, here and below
        if (tooLong.length > 0) {
          const shortened = await ask<{ facts: FactOp[] }>(SHORTEN, JSON.stringify(tooLong), saveFacts, runtime.signal);
          const kept = matching(tooLong, shortened?.facts ?? []);
          ops.push(...kept);
          applyFactOps(memory, kept, now); // still too long: dropped
        }
        if (overCap(memory.facts, settings.memory)) {
          const merged = await ask<{ facts: FactOp[] }>(merge(settings.memory), listed(memory.facts), saveFacts, runtime.signal);
          ops.push(...(merged?.facts ?? []));
        }

        // A page over the cap gets one shorten pass and is dropped if it's still over.
        const writes: PageWrite[] = [];
        for (const write of saved.pages ?? []) {
          if (estimateTokens(write.text) <= PAGE_TOKENS) {
            writes.push(write);
            continue;
          }
          const page = `## ${write.title}\n${write.text}`;
          const shorter = await ask<{ text: string }>(SHORTEN_PAGE, page, saveText, runtime.signal);
          if (typeof shorter?.text === "string" && estimateTokens(shorter.text) <= PAGE_TOKENS) {
            writes.push({ ...write, text: shorter.text });
          }
        }

        // One commit applies the operations to the memory as it stands now — so a `memory_remember` or
        // `memory_forget` made while the models ran survives — and either continues with the next chunk or ends the
        // task. `through` marks the checkpoint as changed (it differs from the previous one), so the task keeps going.
        await runtime.commit(async (tx) => {
          const draft = await tx.doc(MemoryDoc, ROOT_CONVERSATION_ID);
          applyFactOps(draft, ops, now);
          draft.facts = truncateToCap(draft.facts, settings.memory); // a no-op under the cap
          draft.reflectedThrough = piece.through;
          // A page changed since the reflection was shown it (or created meanwhile) keeps that change.
          const scratchpad = writes.length > 0 ? await tx.doc(ScratchpadDoc, ROOT_CONVERSATION_ID) : undefined;
          for (const write of writes) {
            const page = findPage(scratchpad!, write.title);
            if (page !== undefined && write.basedOn !== page.updatedAt) continue;
            writePage(scratchpad!, write.title, write.text, now);
          }
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
