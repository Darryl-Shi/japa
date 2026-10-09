import type { Context } from "@earendil-works/chord";
import { Type } from "@earendil-works/pi-ai";
import {
  defineExtension,
  defineTool,
  type Extension,
  ROOT_CONVERSATION_ID,
  section,
  type ToolExecutionApi,
} from "@earendil-works/pi-durable";
import { type Job, JobDoc, JobsDoc } from "./state.ts";

const WORKER_TEXT =
  "You are working on a job for the chief of staff. Work in the directory the brief names; if it names none and you " +
  "need one, ask with job_ask. Report notable progress with job_progress. When finished, call job_complete with a " +
  "short summary of what you did and found. If you need an answer to continue, call job_ask with one clear question.";

/** Changes the caller's job in one commit and returns `change`'s result; a job already cleared stays gone. */
async function updateJob<T>(
  api: ToolExecutionApi,
  context: Context,
  change: (job: Job) => T,
): Promise<T | undefined> {
  return api.commit(async (tx) => {
    const { jobId } = await tx.doc(JobDoc, api.conversationId);
    const job = (await tx.doc(JobsDoc, ROOT_CONVERSATION_ID)).jobs[jobId];
    return job === undefined ? undefined : change(job);
  }, context);
}

/** The tool that already ended the job's current run, if any. */
function ended(job: Job): "job_complete" | "job_ask" | undefined {
  if (job.completed) return "job_complete";
  if (job.asked) return "job_ask";
  return undefined;
}

/** A tool reply that ends the worker's turn. */
function terminal(text: string) {
  return { content: [{ type: "text" as const, text }], control: { terminate: true as const } };
}

const jobProgress = defineTool({
  name: "job_progress",
  description: "Report notable progress on your job to the chief of staff.",
  parameters: Type.Object({ note: Type.String() }),
  execute: async ({ note }, api, context) => {
    await updateJob(api, context, (job) => {
      job.progress = note;
      job.updatedAt = Date.now();
    });
    return { content: [{ type: "text", text: "Noted." }] };
  },
});

const jobComplete = defineTool({
  name: "job_complete",
  description: "Finish your job with a short summary of the result.",
  parameters: Type.Object({ summary: Type.String() }),
  execute: async ({ summary }, api, context) => {
    const refusal = await updateJob(api, context, (job) => {
      if (job.status === "cancelled") return undefined;
      // One ending per run: a second ending call, even in the same message, changes nothing.
      const by = ended(job);
      if (by !== undefined) return `This turn already ended with ${by}.`;
      job.status = "done";
      job.result = summary;
      job.completed = true;
      return undefined;
    });
    return terminal(refusal ?? "Done.");
  },
});

const jobAsk = defineTool({
  name: "job_ask",
  description:
    "Ask the chief of staff one clear question you need answered to continue, and end your turn. " +
    "It answers with a follow-up message.",
  parameters: Type.Object({ question: Type.String() }),
  execute: async ({ question }, api, context) => {
    const refusal = await updateJob(api, context, (job) => {
      if (job.status === "cancelled") return undefined;
      const by = ended(job);
      if (by !== undefined) return `This turn already ended with ${by}.`;
      job.status = "needs_input";
      job.result = question;
      job.asked = true;
      job.updatedAt = Date.now();
      return undefined;
    });
    return terminal(refusal ?? "Asked.");
  },
});

/** What every job conversation runs with: its role and the tools to report on its job. */
export const WorkerExtension: Extension = defineExtension({
  name: "japa-worker",
  sections: [section("worker", () => WORKER_TEXT)],
  tools: [jobProgress, jobComplete, jobAsk],
});
