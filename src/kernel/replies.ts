import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
  AssistantEntry,
  type Conversation,
  type Cursor,
  type EntryId,
  type Harness,
  type Page,
  ROOT_CONVERSATION_ID,
  type Storage,
  type SubmissionRecord,
  UserEntry,
} from "@earendil-works/pi-durable";
import type { Origin, Reply } from "./contracts.ts";
import { originOf } from "./origin.ts";

/** Every item of a paged scan, in scan order. */
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

/**
 * Delivers each of the root's finished assistant messages with text, in entry order and one at a time, with the
 * origin of its turn's latest input; after the entry `after`, or from the newest entry when absent.
 */
export async function watchReplies(
  harness: Harness,
  storage: Storage,
  root: Conversation,
  listener: (r: Reply) => void | Promise<void>,
  after?: string,
): Promise<{ stop(): Promise<void> }> {
  const requestIds = new Map<EntryId, string | undefined>(); // user entry → its submission's requestId
  let last = 0; // the newest entry seen
  let origin: Origin = { surface: "gateway" };
  const record = (s: SubmissionRecord) => {
    if (s.type === "input" && s.entry !== undefined) requestIds.set(s.entry, s.requestId);
  };

  async function pump() {
    const minEntryId = (last + 1) as EntryId;
    const entries = await all((cursor) => root.entries({ minEntryId }, 200, cursor, ctx));
    for (const e of entries.toReversed()) {
      if (e.kind === UserEntry.kind && requestIds.has(e.id)) origin = originOf(requestIds.get(e.id));
      if (e.kind === AssistantEntry.kind) {
        const message = e.model![0] as AssistantMessage;
        const parts = message.content.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("");
        const text = [parts, message.errorMessage].filter(Boolean).join("\n");
        if (text !== "") {
          try {
            await listener({ cursor: String(e.id), origin, text });
          } catch (error) {
            console.error(error);
          }
        }
      }
      last = e.id;
    }
  }
  // One pump at a time, after the setup below; wakes while one is queued fold into it.
  let running: Promise<void>;
  let queued = false;
  function wake() {
    if (queued) return;
    queued = true;
    running = running.then(() => {
      queued = false;
      return pump();
    });
  }

  const unsubscribe = harness.subscribeCommits(({ changes }) => {
    for (const change of changes) {
      if (change.type === "submission" && change.value.conversationId === root.id) record(change.value);
      if (change.type === "entry" && change.value.conversationId === root.id) wake();
    }
  });
  running = (async () => {
    const submissions = await all((cursor) =>
      storage.scanSubmissions({ conversationId: ROOT_CONVERSATION_ID }, 500, cursor, ctx),
    );
    submissions.forEach(record);
    last = after !== undefined ? Number(after) : ((await root.entries({}, 1, undefined, ctx)).items[0]?.id ?? 0);
    const inputs = [...requestIds.keys()].filter((id) => id <= last);
    if (inputs.length > 0) origin = originOf(requestIds.get(Math.max(...inputs) as EntryId));
  })();
  await running;
  wake(); // catch up
  return {
    stop: async () => {
      unsubscribe();
      await running;
    },
  };
}
