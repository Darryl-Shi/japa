import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import {
  type AgentEvent,
  type Cursor,
  type EntryId,
  type EntryRecord,
  type Harness,
  type Page,
  ROOT_CONVERSATION_ID,
  type Storage,
  type SubmissionRecord,
  UserEntry,
} from "@earendil-works/pi-durable";
import type { InputSource } from "./contracts.ts";
import { sourceOf } from "./origin.ts";

async function all<T>(scan: (cursor: Cursor | undefined) => Promise<Page<T, Cursor>>): Promise<T[]> {
  const items: T[] = [];
  let cursor: Cursor | undefined;
  do {
    const page = await scan(cursor);
    items.push(...page.items);
    cursor = page.next;
  } while (cursor !== undefined);
  return items;
}

/** A user entry's text: its message's string content, or its text blocks joined. */
function textOf(entry: EntryRecord): string {
  const message = entry.model?.[0];
  if (message === undefined || message.role !== "user") return "";
  const { content } = message;
  return typeof content === "string" ? content : content.map((b) => (b.type === "text" ? b.text : "")).join("");
}

/** The root user entries in a batch of events: a snapshot's and each `message_end`'s. */
function userEntries(events: readonly AgentEvent[]): EntryRecord[] {
  const entries = events.flatMap((e) =>
    e.type === "snapshot" ? e.entries : e.type === "message_end" ? [e.entry] : [],
  );
  return entries.filter((e) => e.kind === UserEntry.kind);
}

export type Sources = {
  /** The source of every root user entry in `events`; an entry with no submission record found is a person's. */
  of(events: readonly AgentEvent[]): Promise<Map<EntryId, InputSource>>;
  stop(): void;
};

/**
 * Tracks the root's input submissions (the commit stream, after a scan, as `watchReplies` does) to tell each root user
 * entry's source. An entry not yet known re-reads the submissions once per batch, so a source always comes with its
 * entry.
 */
export async function watchSources(harness: Harness, storage: Storage): Promise<Sources> {
  const requestIds = new Map<EntryId, string | undefined>(); // user entry → its submission's requestId
  const record = (s: SubmissionRecord) => {
    if (s.type === "input" && s.entry !== undefined) requestIds.set(s.entry, s.requestId);
  };
  const scan = async () => {
    const submissions = await all((cursor) =>
      storage.scanSubmissions({ conversationId: ROOT_CONVERSATION_ID }, 500, cursor, ctx),
    );
    submissions.forEach(record);
  };
  const unsubscribe = harness.subscribeCommits(({ changes }) => {
    for (const change of changes) {
      if (change.type === "submission" && change.value.conversationId === ROOT_CONVERSATION_ID) record(change.value);
    }
  });
  try {
    await scan();
  } catch (error) {
    unsubscribe();
    throw error;
  }
  const scanned = new Set<EntryId>(); // entries already looked for in a re-read, found or not
  return {
    async of(events) {
      const entries = userEntries(events);
      const missing = entries.filter((e) => !requestIds.has(e.id) && !scanned.has(e.id));
      if (missing.length > 0) {
        await scan();
        for (const e of missing) scanned.add(e.id);
      }
      // No record found: `sourceOf(undefined)`, a person's.
      return new Map(entries.map((e) => [e.id, sourceOf(requestIds.get(e.id), textOf(e))]));
    },
    stop: unsubscribe,
  };
}
