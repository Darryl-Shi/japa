import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
  type ConversationId,
  AssistantEntry,
  defineTask,
  ROOT_CONVERSATION_ID,
  type SettledSubmissionRecord,
  type Tx,
} from "@earendil-works/pi-durable";
import type { Settings } from "../settings.ts";
import { type Job, JobsDoc, promote, reportText } from "./state.ts";

// Both tasks belong to the root conversation and are background: the CoS's Esc and idle waits skip them.
export const BACKGROUND = { ownership: { kind: "conversation" }, background: true } as const;

// Owns a job's conversation so the job outlives the CoS's turns; it finishes at once.
export const Anchor = defineTask<null, { phase: "done" }, null>({
  name: "japa.job-anchor",
  version: 1,
  initial: () => ({ phase: "done" }),
  phases: {
    done: (_anchor, runtime, context) =>
      runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: null } }), context),
  },
  abort: (_anchor, runtime, context) =>
    runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context),
});

// Sent once to a job whose run ended without job_complete or job_ask.
export const NUDGE =
  "Your turn ended without job_complete or job_ask. If the job is finished, call job_complete with your summary. " +
  "If you need an answer to continue, call job_ask with one clear question. Otherwise, carry on with the job.";

// `nudge` marks the run that delivers `NUDGE`; optional, so runs persisted before it still load.
export type JobRunInput = {
  jobId: string;
  conversationId: ConversationId;
  text: string;
  mode: "steer" | "followUp";
  nudge?: true;
};
type JobRunState = { phase: "deliver" } | { phase: "report"; report?: { seq: number; content: string } };

/**
 * The `JobRun` task, which delivers one message to a job and reports the answer to the CoS (or, for a run that ended
 * without job_complete or job_ask, nudges the job once with another `JobRun`), and `start`, which starts the queued
 * jobs that fit under `jobs.maxConcurrent`.
 */
export function jobRun(settings: Settings) {
  const JobRun = defineTask<JobRunInput, JobRunState, null>({
    name: "japa.job-run",
    version: 1,
    initial: () => ({ phase: "deliver" }),
    phases: {
      deliver: async (task, runtime, context) => {
        const { jobId, conversationId, text, mode } = task.input;
        const conversation = (await runtime.conversation(conversationId, context))!;
        const request = { type: "input", content: text, whenBusy: mode, requestId: `job:${task.id}` } as const;
        const settled = await (await conversation.submit(request, context)).wait(context);
        // One commit decides the report (or creates the nudge) and records the answer as reported, so a restart
        // neither decides again nor nudges twice.
        await runtime.commit(async (tx) => {
          const doc = await tx.doc(JobsDoc, ROOT_CONVERSATION_ID);
          // A job cleared after it was stopped has nothing to report.
          const job = doc.jobs[jobId];
          const decision = job === undefined ? undefined : await decide(tx, job, settled, task.input.nudge === true);
          await start(tx, doc.jobs);
          if (job === undefined || decision === undefined) return { status: "running", checkpoint: { phase: "report" } };
          job.updatedAt = Date.now();
          if ("nudge" in decision) {
            const nudge = { jobId, conversationId, text: NUDGE, mode: "followUp", nudge: true } as const;
            await tx.createTask(JobRun, nudge, BACKGROUND);
            return { status: "running", checkpoint: { phase: "report" } };
          }
          job.seq++;
          const report = { seq: job.seq, content: decision.report };
          return { status: "running", checkpoint: { phase: "report", report } };
        }, context);
      },
      report: async (task, runtime, context) => {
        const { report } = task.state.checkpoint as Extract<JobRunState, { phase: "report" }>;
        if (report !== undefined) {
          const root = (await runtime.conversation(ROOT_CONVERSATION_ID, context))!;
          // Esc withdraws queued inputs; a report withdrawn before the CoS saw it is posted again once the CoS is
          // idle, since an input queued behind an aborted run waits for the next submission.
          for (let attempt = 0; ; attempt++) {
            const requestId = `report:${task.input.jobId}:${report.seq}${attempt ? `:${attempt}` : ""}`;
            const request = { type: "input", content: report.content, whenBusy: "followUp", requestId } as const;
            const settled = await (await root.submit(request, context)).wait(context);
            if (settled.status !== "unanswered" || settled.reason !== "aborted" || settled.entry !== undefined) break;
            await root.waitForIdle(context);
          }
        }
        await runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: null } }), context);
      },
    },
    abort: (_task, runtime, context) =>
      runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context),
  });

  async function start(tx: Tx, jobs: Record<string, Job>): Promise<void> {
    for (const job of promote(jobs, settings.jobs.maxConcurrent)) {
      job.status = "running";
      const input = { jobId: job.id, conversationId: job.conversationId, text: job.brief, mode: "followUp" } as const;
      await tx.createTask(JobRun, input, BACKGROUND);
    }
  }

  return { JobRun, start };
}

type Decision = { report: string } | { nudge: true } | undefined;

/**
 * Updates `job` for the settled message; returns the report to post, a nudge, or nothing. A run that ends unreported
 * (stopped, aborted or failed) clears `completed`, which would otherwise keep the job from being pruned, and `asked`,
 * which would otherwise refuse the next run's ending call. A run that ends without job_complete or job_ask is nudged
 * (the job stays `running`); a nudged run that ends so is `done` with its text, or `failed` if it has none.
 */
async function decide(tx: Tx, job: Job, settled: SettledSubmissionRecord, nudged: boolean): Promise<Decision> {
  const aborted = settled.status === "unanswered" && settled.reason === "aborted";
  if (job.status === "cancelled" || aborted) {
    job.completed = false;
    job.asked = false;
    return undefined;
  }
  if (settled.status === "unanswered") {
    job.completed = false;
    job.asked = false;
    job.status = "failed";
    job.result = settled.detail === undefined ? settled.reason : `${settled.reason}: ${String(settled.detail)}`;
    return { report: reportText(job, job.result) };
  }
  if (settled.type !== "input" || job.reported.includes(settled.answer)) return undefined;
  job.reported.push(settled.answer);
  const answer = (await tx.entry(AssistantEntry, settled.answer))?.model?.[0] as AssistantMessage;
  // Only the run that called job_complete reports the job done; a later run's answer is its own.
  if (job.completed) {
    job.completed = false;
    return { report: reportText(job, job.result!) };
  }
  if (job.asked) {
    job.asked = false;
    return { report: reportText(job, job.result!) };
  }
  if (!nudged) return { nudge: true };
  const text = answer.content
    .flatMap((c) => (c.type === "text" ? [c.text] : []))
    .join("")
    .trim();
  job.status = text === "" ? "failed" : "done";
  job.result = text === "" ? "the worker ended its turn without a reply" : text;
  return { report: reportText(job, job.result) };
}
