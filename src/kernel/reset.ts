import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import {
  type Conversation,
  type EntryId,
  type Harness,
  InboxDoc,
  LiveDoc,
  ResetEntry,
  ROOT_CONVERSATION_ID,
} from "@earendil-works/pi-durable";

/**
 * Resets the root's context after a settled run; returns whether it did. The reset carries nothing: each run's
 * context is injected as it starts (`memory/context.ts`). It writes nothing when the root is busy again, an input is
 * queued, or the run already reset: the next settle resets instead.
 */
export async function resetRoot(root: Conversation): Promise<boolean> {
  const seen = (await root.entries({}, 1, undefined, ctx)).items[0];
  if (seen === undefined || seen.kind === ResetEntry.kind) return false;
  return root.commit(async (tx) => {
    const live = await tx.doc(LiveDoc, ROOT_CONVERSATION_ID);
    const inbox = await tx.doc(InboxDoc, ROOT_CONVERSATION_ID);
    const marker = await tx.latestHeadMarker(ROOT_CONVERSATION_ID);
    const minEntryId = marker?.head ?? (1 as EntryId);
    const page = await tx.scanEntries({ conversationId: ROOT_CONVERSATION_ID, minEntryId }, 1); // newest first
    if (live.run !== undefined || inbox.items.some((i) => i.mode !== "write") || page.items[0]?.id !== seen.id) {
      return false;
    }
    await tx.appendEntry(ResetEntry, ROOT_CONVERSATION_ID, { head: "self" });
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
