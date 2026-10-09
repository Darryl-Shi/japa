import type { Incoming, KernelContext, MessagingAdapter, MessagingContext } from "../contracts.ts";
import { message } from "../loader.ts";
import type { SecretRequest } from "../secret-requests.ts";
import type { SecretPrompt } from "./surface.ts";

/**
 * How many of its latest prompt and decline message ids an adapter keeps (those of its last 50 prompts), to know a
 * reply to one whose request is no longer pending.
 */
export const PROMPT_HISTORY = 100;

// A Decline button's action is this, then its request's id: not tied to the menu's per-run token, it outlives restarts.
const DECLINE = "d:";
const NO_TEXT = "Reply with the secret as text.";
const STALE = "That request is no longer pending.";

/**
 * The owner's prompts for the pending secret requests, in their `adapter` chat. `sync` prompts each pending request
 * without a prompt: the prompt, shown with the reply input, then a decline message with a `Decline` button; both ids
 * are saved before anything else, so a restart neither sends them again nor forgets them. A send that fails saves
 * no prompt, so the next `sync` tries again; a prompt already sent is deleted, and kept in the history in case it
 * couldn't be. A request that leaves the pending list, however it leaves, has both messages deleted. A reply to the
 * decline message counts as a reply to its prompt. `erase` deletes the owner's message carrying a secret.
 */
export async function createPrompts(
  adapter: MessagingAdapter,
  kernel: KernelContext,
  messaging: MessagingContext,
  erase: (m: Incoming) => Promise<unknown>,
) {
  let { prompts, history } = await messaging.promptState(adapter.name);
  let pending: SecretRequest[] = [];
  const save = () => messaging.savePromptState(adapter.name, { prompts, history });

  /** Deletes `p`'s messages (they may be gone already) and drops it. */
  const remove = async (p: SecretPrompt) => {
    await adapter.delete(p.chat, p.prompt).catch(() => {});
    await adapter.delete(p.chat, p.decline).catch(() => {});
    prompts = prompts.filter((q) => q !== p);
    await save();
  };

  /** Sends `owner` the prompt for `r`, then its decline message, and saves both ids. */
  const ask = async (owner: string, r: SecretRequest) => {
    let prompt: string | undefined;
    let decline: string | undefined;
    try {
      const markdown = `japa needs \`${r.name}\`: ${r.why}. Reply to this message with it; I'll delete your reply at once.`;
      prompt = await adapter.send(owner, { markdown, input: { placeholder: `Paste ${r.name}` } });
      const buttons = [[{ label: "Decline", action: `${DECLINE}${r.id}` }]];
      decline = await adapter.send(owner, { markdown: `Don't want to provide \`${r.name}\`?`, buttons });
      prompts = [...prompts, { requestId: r.id, chat: owner, prompt, decline }];
    } catch (error) {
      console.error(`${adapter.name}: couldn't send a secret prompt: ${message(error)}`);
      if (prompt === undefined) return;
      await adapter.delete(owner, prompt).catch(() => {});
    }
    history = [...history, prompt, ...(decline === undefined ? [] : [decline])].slice(-PROMPT_HISTORY);
    await save();
  };

  return {
    /** Takes the pending secret requests, as they change, for `sync` and Decline. */
    track(list: SecretRequest[]) {
      pending = list;
    },

    /** Deletes the prompts of requests no longer pending; then, with an owner, prompts each pending one without. */
    async sync() {
      for (const p of prompts.filter((q) => !pending.some((r) => r.id === q.requestId))) await remove(p);
      const owner = kernel.settings().owner as string | undefined;
      if (owner === undefined) return;
      for (const r of pending) if (!prompts.some((p) => p.requestId === r.id)) await ask(owner, r);
    },

    /**
     * Handles the owner's message `m` when it replies to a prompt or its decline message; whether it did. A text
     * fulfils the prompt's request (`by` records `m` as carrying it), is deleted at once, and the prompt and decline
     * message are deleted. A reply to one of the last `PROMPT_HISTORY` messages, its request no longer pending, is a
     * secret that can't be used: deleted, recorded as `by` (so it is dropped if delivered again), never submitted.
     */
    async reply(m: Incoming, by: string) {
      if (m.replyTo === undefined) return false;
      const p = prompts.find((q) => q.prompt === m.replyTo || q.decline === m.replyTo);
      if (p === undefined) {
        if (!history.includes(m.replyTo)) return false;
        await erase(m);
        await messaging.recordSecretMessage(by);
        await adapter.send(m.chat, { markdown: STALE });
        return true;
      }
      if (m.text === undefined) {
        await adapter.send(m.chat, { markdown: NO_TEXT });
        return true;
      }
      try {
        await kernel.surface.secrets.fulfil(p.requestId, m.text, by);
      } finally {
        await erase(m);
      }
      await remove(p);
      return true;
    },

    /**
     * Handles the owner's press `m` when it is a Decline button's, declining its request (whose messages `sync` then
     * deletes); whether it was. For a request already gone, whose prompt `sync` has deleted, it deletes the pressed
     * message.
     */
    async press(m: Incoming) {
      if (!m.action!.startsWith(DECLINE)) return false;
      const requestId = m.action!.slice(DECLINE.length);
      if (pending.some((r) => r.id === requestId)) await kernel.surface.secrets.decline(requestId);
      else await adapter.delete(m.chat, m.messageId).catch(() => {});
      return true;
    },
  };
}
