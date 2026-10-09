// The one-operator lock: only jobs in the desktop environment act on the desktop, one at a time.
import type { Context } from "@earendil-works/chord";
import type { ToolExecutionApi } from "@earendil-works/pi-durable";
import { setTimeout as sleep } from "node:timers/promises";
import { defineDoc, JobDoc, JobsDoc, ROOT_CONVERSATION_ID } from "../../src/sdk.ts";
import { isDesktop } from "../../src/kernel/sandbox/remote-env.ts";

// On the root conversation: the job holding the desktop. It is free once that job is not running or waiting on the user.
export const LockDoc = defineDoc<{ job?: string }>({
  kind: "japa.desktop-lock",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({}),
});

export const OPERATOR = "This acts on the desktop — start an operator job for it.";
const waiting = (job: string) => `Waiting for the desktop (in use by job ${job})`;

/** Takes the lock for the caller's job, waiting while another job holds it; outside the desktop environment, the refusal. */
export async function claimDesktop(api: ToolExecutionApi, context: Context): Promise<string | undefined> {
  if (!isDesktop(api.env)) return OPERATOR;
  for (let first = true; ; first = false) {
    const holder = await api.commit(async (tx) => {
      const me = (await tx.doc(JobDoc, api.conversationId)).jobId;
      const lock = await tx.doc(LockDoc, ROOT_CONVERSATION_ID);
      const { jobs } = await tx.doc(JobsDoc, ROOT_CONVERSATION_ID);
      const h = lock.job;
      if (h !== undefined && h !== me && (jobs[h]?.status === "running" || jobs[h]?.status === "needs_input")) {
        if (first) {
          jobs[me]!.progress = waiting(h);
          jobs[me]!.updatedAt = Date.now();
        }
        return h;
      }
      lock.job = me;
      if (!first) delete jobs[me]!.progress;
      return undefined;
    }, context);
    if (holder === undefined) return undefined;
    await sleep(2000, undefined, { signal: context.abortSignal });
  }
}
