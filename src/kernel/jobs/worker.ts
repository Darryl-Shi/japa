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
  "You are working on a job for the chief of staff. Report notable progress with job_progress. " +
  "When finished, call job_complete with a short summary. If you need input, end your turn with one clear question.";

/** Changes the caller's job in one commit. */
async function updateJob(api: ToolExecutionApi, context: Context, change: (job: Job) => void): Promise<void> {
  await api.commit(async (tx) => {
    const { jobId } = await tx.doc(JobDoc, api.conversationId);
    change((await tx.doc(JobsDoc, ROOT_CONVERSATION_ID)).jobs[jobId]!);
  }, context);
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
    await updateJob(api, context, (job) => {
      if (job.status === "cancelled") return;
      job.status = "done";
      job.result = summary;
      job.completed = true;
    });
    return { content: [{ type: "text", text: "Done." }], control: { terminate: true } };
  },
});

/** What every job conversation runs with: its role and the tools to report on its job. */
export const WorkerExtension: Extension = defineExtension({
  name: "japa-worker",
  sections: [section("worker", () => WORKER_TEXT)],
  tools: [jobProgress, jobComplete],
});
