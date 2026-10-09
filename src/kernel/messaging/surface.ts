import { defineDoc } from "@earendil-works/pi-durable";
import type {
  Dispose,
  Incoming,
  KernelContext,
  MessagingAdapter,
  MessagingContext,
  Origin,
  Reply,
} from "../contracts.ts";
import type { Job } from "../jobs/state.ts";
import { message } from "../loader.ts";
import { originOf } from "../origin.ts";
import { inputOf } from "./attachments.ts";
import { COMMANDS, createMenu, UNDELETED } from "./menu/index.ts";
import { INPUT_MS } from "./menu/nav.ts";
import { createPrompts } from "./prompts.ts";
import { splitMessage } from "./split.ts";

/** Owner messages arriving within this long of each other are merged into one input. */
export const MERGE_MS = 1500;
/** How often "typing…" is shown while a run of the adapter's own origin is active. */
export const TYPING_MS = 4000;

const EXPIRED = "That prompt expired — tap Set again.";

/** A pending secret request's prompt: the chat it was sent to, and the ids of the prompt and its decline message. */
export type SecretPrompt = { requestId: string; chat: string; prompt: string; decline: string };

// On the root conversation, per adapter: its reply cursor, when its menu screen waiting for a secret opened, its
// secret prompts, and the ids of its latest prompts and their decline messages (`PROMPT_HISTORY`).
export const MessagingDoc = defineDoc<{
  cursors: Record<string, string>;
  secretInput?: Record<string, number>;
  prompts?: Record<string, SecretPrompt[]>;
  promptHistory?: Record<string, string[]>;
}>({
  kind: "japa.messaging",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ cursors: {} }),
});

/**
 * The kernel's messaging surface for `adapter`: handles its messages one at a time, in arrival order, answering anyone
 * but the owner (`extensions.<adapter>.owner`) with their user id, and submitting the owner's texts and images, merged,
 * to the CoS. Every pending secret request has its own prompt (see `createPrompts`), synced when the pending list
 * changes and before each owner message is handled, so prompts go out once an owner is set and first writes. Only a
 * reply to a prompt fulfils its request, ahead of any menu screen waiting for a value; it is deleted at once and,
 * delivered again, dropped and deleted again. A Decline button declines its request. Commands and the menu's button
 * presses go to the menu, never to the CoS, as does the next other text while a menu screen waits for a value. A
 * screen that waited for a secret when the daemon stopped (its `secretInput`) holds the next such text for `INPUT_MS`
 * from when it opened: that text is deleted at once and never submitted, and the owner is told to tap Set again.
 * Sends the replies to its own inputs, and the proactive ones to the owner; shows "typing…" while its own run is active.
 */
export async function startMessaging(
  adapter: MessagingAdapter,
  kernel: KernelContext,
  messaging: MessagingContext,
): Promise<Dispose> {
  if (adapter.name !== kernel.extension) throw new Error(`name must be "${kernel.extension}"`);
  const log = (error: unknown) => console.error(`${adapter.name}: ${message(error)}`);
  let stopped = false;
  let ready!: () => void;
  let handled = new Promise<void>((resolve) => (ready = resolve)); // messages wait until every subscription is in place
  let submitted = Promise.resolve();
  let buffer: Incoming[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  let jobs: Job[] = [];
  const menu = createMenu(adapter, kernel, messaging, () => jobs);
  // When the screen that waited for a secret when the daemon stopped opened, until the next command, menu press or
  // text other than a reply to a prompt.
  let stale = await messaging.secretInput(adapter.name);

  /** Deletes the owner's message `m`, which carried a secret; when it can't, asks them to. */
  const erase = (m: Incoming) =>
    adapter.delete(m.chat, m.messageId).catch(() => adapter.send(m.chat, { markdown: UNDELETED }));
  const prompts = await createPrompts(adapter, kernel, messaging, erase);

  /** Submits the buffer, if any, after the submissions before it; resolves once they are all done. */
  const flush = () => {
    clearTimeout(timer);
    const messages = buffer;
    const first = messages[0];
    if (first !== undefined) {
      buffer = [];
      const origin = { surface: adapter.name, chat: first.chat, id: first.id };
      const m = kernel.surface.status().model!;
      const vision = kernel.models.getModel(m.provider, m.modelId)?.input.includes("image") ?? false;
      submitted = submitted
        .then(() => kernel.surface.root.submit(inputOf(kernel.home, messages, vision), "followUp", origin))
        .catch(log);
    }
    return submitted;
  };

  /** Clears the `secretInput` from before the restart, if any. */
  const forget = async () => {
    if (stale === undefined) return;
    await messaging.saveSecretInput(adapter.name, undefined);
    stale = undefined;
  };

  const handle = async (m: Incoming) => {
    if (m.user !== kernel.settings().owner) {
      await adapter.send(m.chat, { markdown: `Not authorized. Your ${adapter.name} user id is ${m.user}.` });
      return;
    }
    await prompts.sync().catch(log);
    await menu.expire();
    await route(m);
  };

  /** Handles the owner's message `m`. */
  const route = async (m: Incoming) => {
    if (m.command !== undefined) {
      await forget();
      await menu.command(m);
      return;
    }
    if (m.action !== undefined) {
      if (await prompts.press(m)) return;
      await forget();
      await menu.press(m);
      return;
    }
    const by = `${adapter.name}:${m.id}`;
    if ((await messaging.secretFulfilledBy()) === by) {
      await adapter.delete(m.chat, m.messageId).catch(() => {}); // a secret delivered again
      return;
    }
    if (await prompts.reply(m, by)) return;
    if (menu.pendingInput() && m.text !== undefined) {
      await menu.input(m);
      return;
    }
    if (stale !== undefined && m.text !== undefined) {
      const fresh = Date.now() - stale < INPUT_MS;
      if (fresh) {
        await erase(m);
        await messaging.recordSecretMessage(by); // so it is dropped if delivered again
      }
      await forget();
      if (fresh) {
        await adapter.send(m.chat, { markdown: EXPIRED });
        return;
      }
    }
    if ((m.text === undefined && m.images === undefined) || buffer.some((b) => b.id === m.id)) return;
    buffer.push(m);
    clearTimeout(timer);
    timer = setTimeout(flush, MERGE_MS);
  };

  /** Sends `r` in parts to its chat, if it has one here; its cursor is saved unless the daemon is stopping. */
  const deliver = async (r: Reply) => {
    const owner = kernel.settings().owner as string | undefined;
    const chat = r.origin === "proactive" ? owner : r.origin.surface === adapter.name ? r.origin.chat : undefined;
    if (chat !== undefined) {
      for (const part of splitMessage(r.text, adapter.maxMessageChars)) {
        if (stopped) return;
        try {
          await adapter.send(chat, { markdown: part });
        } catch (error) {
          if (stopped) return; // sent again after the restart
          console.error(`${adapter.name}: couldn't send a reply: ${message(error)}`);
          break;
        }
      }
    }
    if (!stopped) await messaging.saveCursor(adapter.name, r.cursor);
  };

  let busy = false;
  let origin: Origin | undefined; // the latest placed input's
  let typingChat: string | undefined;
  let typingTimer: ReturnType<typeof setInterval> | undefined;
  const typing = (chat: string) => void adapter.typing(chat).catch(() => {});

  const jobsStream = await kernel.surface.jobs((list) => (jobs = list));
  await adapter.commands(COMMANDS);
  const stopAdapter = await adapter.start({
    receive: (m) => {
      if (stopped) return handled;
      handled = handled.then(() => handle(m)).catch(log);
      return handled;
    },
  });
  const secrets = await kernel.surface.secrets.pending((pending) => {
    prompts.track(pending);
    handled = handled.then(() => (stopped ? undefined : prompts.sync())).catch(log);
  });
  const replies = await kernel.surface.root.replies(deliver, await messaging.cursor(adapter.name));
  const events = await kernel.surface.root.events((batch) => {
    for (const e of batch) {
      if (e.type === "snapshot") busy = e.run !== undefined;
      if (e.type === "run_start") busy = true;
      if (e.type === "run_end") busy = false;
      if (e.type === "submission" && e.record.status === "placed") origin = originOf(e.record.requestId);
    }
    const chat = busy && typeof origin === "object" && origin.surface === adapter.name ? origin.chat : undefined;
    if (chat === typingChat) return;
    clearInterval(typingTimer);
    typingChat = chat;
    if (chat !== undefined) {
      typing(chat);
      typingTimer = setInterval(() => typing(chat), TYPING_MS);
    }
  });
  ready();
  return async () => {
    stopped = true;
    await stopAdapter();
    await flush();
    await secrets.stop();
    await jobsStream.stop();
    await replies.stop();
    await events.stop();
    clearInterval(typingTimer);
  };
}
