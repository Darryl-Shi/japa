import type { Context } from "@earendil-works/chord";
import { type Conversation, type EntryId, type EntryRecord, ResetEntry } from "@earendil-works/pi-durable";
import type { Job } from "../jobs/state.ts";
import type { Scratchpad } from "./scratchpad.ts";
import type { Doc } from "./search.ts";
import type { Memory } from "./state.ts";
import { type HistoryMessage, transcriptMessages } from "./transcript.ts";

const PAGE = 200;

/** An in-process mirror of the root transcript, rebuilt per daemon: derived data, nothing is stored. */
export type History = {
  attach(root: Conversation): void;
  /** Catches the mirror up with the root's new entries; returns every message and the newest reset's id. */
  refresh(context: Context): Promise<{ messages: HistoryMessage[]; lastReset?: EntryId }>;
};

/**
 * A history that keeps the root's raw entries (a japa message's `did:` needs its tool results) and re-derives the
 * messages from them when new ones arrive. Refreshes run one at a time, so overlapping callers never read twice.
 */
export function createHistory(): History {
  let root: Conversation | undefined;
  let entries: EntryRecord[] = [];
  let messages: HistoryMessage[] = [];
  let lastReset: EntryId | undefined;
  let queue: Promise<unknown> = Promise.resolve();
  /** Bumped by each `attach`: a refresh begun before it is stale, even for the same root. */
  let generation = 0;

  const catchUp = async (conversation: Conversation, context: Context) => {
    const started = generation;
    const last = entries.at(-1)?.id;
    const fresh: EntryRecord[] = [];
    let cursor;
    do {
      // Newest first.
      const query = last === undefined ? {} : { minEntryId: (last + 1) as EntryId };
      const page = await conversation.entries(query, PAGE, cursor, context);
      fresh.push(...page.items);
      cursor = page.next;
    } while (cursor !== undefined);
    if (started !== generation || conversation !== root) return; // re-attached meanwhile
    const added = fresh.reverse().filter((e) => last === undefined || e.id > last);
    if (added.length > 0) {
      entries.push(...added);
      for (const e of added) if (e.kind === ResetEntry.kind) lastReset = e.id;
      messages = transcriptMessages(entries);
    }
  };

  return {
    attach(conversation) {
      root = conversation;
      generation++;
      entries = [];
      messages = [];
      lastReset = undefined;
    },
    refresh(context) {
      const conversation = root;
      if (conversation === undefined) return Promise.reject(new Error("The history isn't attached to the root."));
      const done = queue.then(() => catchUp(conversation, context));
      queue = done.catch(() => {});
      return done.then(() => ({ messages, ...(lastReset === undefined ? {} : { lastReset }) }));
    },
  };
}

/**
 * The search corpus: one doc per message (keyed by its entry id), per job with a result (`job:<id>`), per page,
 * active or archived (`page:<id>`), and per legacy episode (`episode:<id>`). Titles are part of the text, since only
 * the text is indexed.
 */
export function corpus(
  messages: readonly HistoryMessage[],
  memory: Memory,
  pad: Scratchpad,
  jobs: Record<string, Job>,
): Doc[] {
  const docs: Doc[] = messages.map((m) => ({ key: String(m.id), kind: m.kind, text: m.text, at: m.at, id: m.id }));
  for (const job of Object.values(jobs)) {
    if (!job.result) continue;
    docs.push({ key: `job:${job.id}`, kind: "job", text: `"${job.title}": ${job.result}`, at: job.updatedAt, title: job.title });
  }
  for (const page of pad.pages) {
    docs.push({ key: `page:${page.id}`, kind: "page", text: `${page.title}\n${page.text}`, at: page.updatedAt, title: page.title });
  }
  for (const episode of memory.legacyEpisodes ?? []) {
    docs.push({ key: `episode:${episode.id}`, kind: "episode", text: episode.text, at: episode.at });
  }
  return docs;
}
