import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import type { Message } from "@earendil-works/pi-ai";
import {
  AssistantEntry,
  type Conversation,
  type EntryId,
  type EntryRecord,
  type Harness,
  InboxDoc,
  LiveDoc,
  ResetEntry,
  ROOT_CONVERSATION_ID,
  UserEntry,
} from "@earendil-works/pi-durable";

const HEADER = "[Your last exchange]";
const CAP = 8000; // 2 000 tokens, at 4 characters per token
const CUT = "[…]";

type Line = { label: string; text: string };

/** `message`'s text; an input's non-text part becomes `[<type>]`, an answer's thinking and tool calls are dropped. */
const render = (message: Message): string =>
  typeof message.content === "string"
    ? message.content
    : message.content
        .flatMap((part) => (part.type === "text" ? [part.text] : message.role === "user" ? [`[${part.type}]`] : []))
        .join("");

const show = (lines: Line[]) => [HEADER, ...lines.map((l) => `${l.label}: ${l.text}`)].join("\n");

/** `text` shortened by `over` characters, its middle replaced by `[…]`. */
function cut(text: string, over: number): string {
  const keep = text.length - over - CUT.length;
  if (keep <= 0) return CUT;
  const head = Math.ceil(keep / 2);
  return text.slice(0, head) + CUT + text.slice(text.length - (keep - head));
}

/**
 * The carry-over of the run `entries` cover: its inputs and its final answer, capped at 2 000 tokens; undefined when
 * it had neither. Entries with a `head` (the previous reset, compaction summaries) and tool traffic are left out.
 */
export function lastExchange(entries: readonly EntryRecord[]): string | undefined {
  const active = entries.filter((e) => e.head === undefined);
  const texts = (kind: string) =>
    active.filter((e) => e.kind === kind).flatMap((e) => (e.model ?? []).map(render)).filter((t) => t !== "");
  const lines: Line[] = texts(UserEntry.kind).map((text) => ({ label: "user", text }));
  const answer = texts(AssistantEntry.kind).at(-1);
  if (answer !== undefined) lines.push({ label: "you", text: answer });
  if (lines.length === 0) return undefined;

  let rendered = show(lines);
  while (rendered.length > CAP) {
    const longest = lines.reduce((a, b) => (b.text.length > a.text.length ? b : a));
    if (longest.text.length <= CUT.length) break; // every line is cut to the bone
    longest.text = cut(longest.text, rendered.length - CAP);
    rendered = show(lines);
  }
  return rendered;
}

/**
 * Resets the root's context after a settled run, carrying over its last exchange; returns whether it did. It writes
 * nothing when the root is busy again, an input is queued, or the run already reset: the next settle resets instead.
 */
export async function resetRoot(root: Conversation): Promise<boolean> {
  const seen = (await root.entries({}, 1, undefined, ctx)).items[0];
  if (seen === undefined || seen.kind === ResetEntry.kind) return false;
  return root.commit(async (tx) => {
    const live = await tx.doc(LiveDoc, ROOT_CONVERSATION_ID);
    const inbox = await tx.doc(InboxDoc, ROOT_CONVERSATION_ID);
    const marker = await tx.latestHeadMarker(ROOT_CONVERSATION_ID);
    const minEntryId = marker?.head ?? (1 as EntryId);
    const page = await tx.scanEntries({ conversationId: ROOT_CONVERSATION_ID, minEntryId }, 500);
    if (live.run !== undefined || inbox.items.some((i) => i.mode !== "write") || page.items[0]?.id !== seen.id) {
      return false;
    }
    const text = lastExchange(page.items.toReversed());
    const carry = text === undefined ? {} : { model: [{ role: "user" as const, content: text, timestamp: Date.now() }] };
    await tx.appendEntry(ResetEntry, ROOT_CONVERSATION_ID, { head: "self", ...carry });
    return true;
  }, ctx);
}

/** Resets the root's context whenever a run settles, calling `onReset` after each reset. */
export async function watchResets(
  harness: Harness,
  root: Conversation,
  onReset: () => Promise<void>,
): Promise<{ stop(): Promise<void> }> {
  const watch = (await harness.watchDoc(LiveDoc, root.id, ctx))!;
  watch.start(async (live) => {
    if (live?.run !== undefined) return;
    try {
      if (await resetRoot(root)) await onReset();
    } catch {
      // A reset that fails leaves the context as it is; the next settle resets it.
    }
  });
  return {
    stop: async () => {
      await watch.stop();
    },
  };
}
