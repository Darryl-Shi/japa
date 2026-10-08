import type { Dispose, Incoming, KernelContext, MessagingAdapter } from "../contracts.ts";
import { message } from "../loader.ts";

/** Owner messages arriving within this long of each other are merged into one input. */
export const MERGE_MS = 1500;

/**
 * The kernel's messaging surface for `adapter`: handles its messages one at a time, in arrival order, answering anyone
 * but the owner (`extensions.<adapter>.owner`) with their user id, and submitting the owner's texts, merged, to the CoS.
 */
export async function startMessaging(adapter: MessagingAdapter, kernel: KernelContext): Promise<Dispose> {
  const log = (error: unknown) => console.error(`${adapter.name}: ${message(error)}`);
  let stopped = false;
  let handled = Promise.resolve();
  let submitted = Promise.resolve();
  let buffer: Incoming[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;

  /** Submits the buffer, if any, after the submissions before it; resolves once they are all done. */
  const flush = () => {
    clearTimeout(timer);
    const first = buffer[0];
    if (first !== undefined) {
      const input = buffer.map((m) => m.text).join("\n\n");
      buffer = [];
      const origin = { surface: adapter.name, chat: first.chat, id: first.id };
      submitted = submitted.then(() => kernel.surface.root.submit(input, "followUp", origin)).catch(log);
    }
    return submitted;
  };

  const handle = async (m: Incoming) => {
    if (m.user !== kernel.settings().owner) {
      await adapter.send(m.chat, { markdown: `Not authorized. Your ${adapter.name} user id is ${m.user}.` });
      return;
    }
    if (m.text === undefined || buffer.some((b) => b.id === m.id)) return;
    buffer.push(m);
    clearTimeout(timer);
    timer = setTimeout(flush, MERGE_MS);
  };

  const stopAdapter = await adapter.start({
    receive: (m) => {
      handled = handled.then(() => (stopped ? undefined : handle(m))).catch(log);
      return handled;
    },
  });
  return async () => {
    stopped = true;
    await stopAdapter();
    await flush();
  };
}
