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
import { COMMANDS, createMenu } from "./menu/index.ts";
import { splitMessage } from "./split.ts";

/** Owner messages arriving within this long of each other are merged into one input. */
export const MERGE_MS = 1500;
/** How often "typing…" is shown while a run of the adapter's own origin is active. */
export const TYPING_MS = 4000;

// On the root conversation: each adapter's reply cursor.
export const MessagingDoc = defineDoc<{ cursors: Record<string, string> }>({
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
 * to the CoS. Asks the owner for the oldest pending secret request; their next text fulfils it and is deleted at once
 * (a command cancels this); delivered again, it is dropped and deleted again. Commands and button presses go to the
 * menu, never to the CoS, as does the next text while a menu screen waits for a value; that wait takes precedence over
 * the secret request, which is asked for again when it ends.
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
  let awaiting: string | undefined; // the secret request the owner's next text fulfils
  let request: { id: string; name: string; why: string } | undefined; // the oldest pending secret request
  let jobs: Job[] = [];
  const menu = createMenu(adapter, kernel, messaging, () => jobs);

  /** Asks the owner for the oldest pending secret request, unless already asked or a menu screen waits for a value. */
  const announce = () => {
    const owner = kernel.settings().owner as string | undefined;
    if (owner === undefined || request === undefined || request.id === awaiting || menu.pendingInput()) return;
    awaiting = request.id;
    const markdown = `japa needs \`${request.name}\`: ${request.why}. Send it as your next message; I'll delete it at once.`;
    adapter.send(owner, { markdown }).catch(log);
  };

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

  const handle = async (m: Incoming) => {
    if (m.user !== kernel.settings().owner) {
      await adapter.send(m.chat, { markdown: `Not authorized. Your ${adapter.name} user id is ${m.user}.` });
      return;
    }
    if (m.command !== undefined) {
      awaiting = undefined;
      menu.cancelInput();
      return menu.command(m);
    }
    if (m.action !== undefined) {
      const inputting = menu.pendingInput();
      await menu.press(m);
      if (menu.pendingInput()) awaiting = undefined;
      else if (inputting) announce();
      return;
    }
    const by = `${adapter.name}:${m.id}`;
    if ((await messaging.secretFulfilledBy()) === by) {
      await adapter.delete(m.chat, m.messageId).catch(() => {}); // a secret delivered again
      return;
    }
    if (menu.pendingInput() && m.text !== undefined) {
      await menu.input(m);
      if (!menu.pendingInput()) announce();
      return;
    }
    if (awaiting !== undefined && m.text !== undefined) {
      const requestId = awaiting;
      awaiting = undefined;
      try {
        await kernel.surface.secrets.fulfil(requestId, m.text, by);
      } finally {
        await adapter.delete(m.chat, m.messageId).catch(() =>
          adapter.send(m.chat, { markdown: "Couldn't delete your message — please delete it yourself." }),
        );
      }
      return;
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
    request = pending[0];
    if (request === undefined) awaiting = undefined;
    else announce();
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
