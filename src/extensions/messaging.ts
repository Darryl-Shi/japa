import type { Context } from "@earendil-works/chord";
import {
  AssistantEntry,
  defineTask,
  LiveDoc,
  ROOT_CONVERSATION_ID,
} from "@earendil-works/pi-durable";
import type { TaskId, Tx } from "@earendil-works/pi-durable";
import type { Address, Incoming } from "../core/contracts.ts";
import type { Host } from "../core/host.ts";
import { AssistantState } from "./state.ts";
import { textOf } from "./text.ts";

export type InboxInput = {
  key: string;
  address: Address;
  text: string;
  /** A background reflection need not produce a user notification. */
  silent?: boolean;
  /** Send directly, without another model turn. */
  replyOnly?: boolean;
};
type Checkpoint =
  | { phase: "answer" }
  | { phase: "send"; text: string; attempt: number; retryAt: number };

/** Admission is durable before submit; delivery is durable after the answer. */
export function inboxTask(host: Host) {
  return defineTask<InboxInput, Checkpoint, null>({
    name: "japa.inbox",
    version: 1,
    initial: (input) =>
      input.replyOnly
        ? { phase: "send", text: input.text, attempt: 0, retryAt: 0 }
        : { phase: "answer" },
    phases: {
      answer: async (task, runtime, context) => {
        const root = (await runtime.conversation(
          ROOT_CONVERSATION_ID,
          context,
        ))!;
        const submission = await root.submit(
          {
            type: "input",
            content: task.input.text,
            requestId: `inbox:${task.id}`,
            whenBusy: "followUp",
          },
          context,
        );
        const settled = await submission.wait(context);
        await runtime.commit(async (tx) => {
          const answer =
            settled.status === "done" && settled.type === "input"
              ? textOf(
                  (await tx.entry(AssistantEntry, settled.answer))?.model?.[0],
                )
              : `I couldn't finish that response (${settled.status === "unanswered" ? settled.reason : "no answer"}). Please try again.`;
          return {
            status: "running",
            checkpoint: {
              phase: "send",
              text: task.input.silent ? "" : answer,
              attempt: 0,
              retryAt: 0,
            },
          };
        }, context);
      },
      send: async (task, runtime, context) => {
        const state = task.state.checkpoint;
        await runtime.sleep(state.retryAt, context);
        try {
          if (state.text.trim()) {
            await host.adapters.channel.send(
              task.input.address,
              { text: state.text },
              `reply:${task.id}`,
              context,
            );
          }
        } catch (error) {
          if (runtime.signal.aborted) throw error;
          runtime.report(error);
          const attempt = Math.min(state.attempt + 1, 10);
          await runtime.commit(
            () => ({
              status: "running",
              checkpoint: {
                ...state,
                attempt,
                retryAt: runtime.now() + Math.min(60_000, 1_000 * 2 ** attempt),
              },
            }),
            context,
          );
          return;
        }
        await runtime.commit(
          () => ({
            status: "terminal",
            outcome: { status: "completed", result: null },
          }),
          context,
        );
      },
    },
    abort: (_task, runtime, context) =>
      runtime.commit(
        () => ({ status: "terminal", outcome: { status: "aborted" } }),
        context,
      ),
  });
}

/** Also used by wakes to admit an input atomically with their own state change. */
export async function admit(
  host: Host,
  tx: Tx,
  input: InboxInput,
  fromUser = false,
): Promise<void> {
  const state = await tx.doc(AssistantState);
  if (Object.hasOwn(state.receipts, input.key)) return;
  if (fromUser) state.address = input.address;
  state.receipts[input.key] = await tx.createTask(inboxTask(host), input, {
    ownership: { kind: "conversation" },
    conversationId: ROOT_CONVERSATION_ID,
    background: true,
  });
}

/** Used by channels, job reports, notifications, and extension-defined events. */
export async function enqueue(
  host: Host,
  input: InboxInput,
  context: Context,
  fromUser = false,
): Promise<void> {
  await host.harness.commit((tx) => admit(host, tx, input, fromUser), context);
  host.harness.resume();
}

/** Resolve the address of this turn, not whichever channel happened to write most recently. */
export async function turnAddress(
  host: Host,
  context: Context,
): Promise<Address | undefined> {
  const live = await host.harness.snapshot(
    LiveDoc,
    ROOT_CONVERSATION_ID,
    context,
  );
  const id = live?.run?.inputs.at(-1);
  if (id !== undefined) {
    const submission = await host.harness.submission(id, context);
    const request = (await submission?.status(context))?.requestId;
    const match = /^inbox:(\d+)$/.exec(request ?? "");
    if (match) {
      // This ID comes from our own durable submission, not from user input.
      const task = await host.harness.getTask(
        Number(match[1]) as TaskId,
        context,
      );
      if (task?.kind === "japa.inbox")
        return (task.input as InboxInput).address;
    }
  }
  return (await host.harness.snapshot(AssistantState, context))?.address;
}

export async function receive(
  host: Host,
  message: Incoming,
  context: Context,
): Promise<void> {
  const decision = /^\/(approve|deny)\s+(\S+)\s*$/.exec(message.text);
  if (decision) {
    await host.adapters.approvals.resolve(
      decision[2]!,
      decision[1] === "approve",
      message.address,
      context,
    );
    return;
  }
  if (!message.text.trim()) return;
  if (message.text.length > 8_000)
    throw new Error(
      "Message too long; attach large material to a worker instead (8,000 character limit)",
    );
  const key = JSON.stringify([
    "user",
    message.address.channel,
    message.address.recipient,
    message.id,
  ]);
  await enqueue(
    host,
    { key, address: message.address, text: message.text },
    context,
    true,
  );
}
