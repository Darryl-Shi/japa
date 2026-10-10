import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
  type ConversationId,
  AssistantEntry,
  defineTask,
  InboxDoc,
  LiveDoc,
  ROOT_CONVERSATION_ID,
  type SettledSubmissionRecord,
  type Tx,
} from "@earendil-works/pi-durable";
import type { Settings } from "../settings.ts";
import type { PublishJob } from "./publish.ts";
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
type Report = { seq: number; content: string };
const JOB_RUN = "japa.job-run";
type JobRunState =
  | { phase: "deliver" }
  | { phase: "publish"; report: Report }
  | { phase: "report"; report?: Report };

export type JobHooks = {
  /**
   * Publishes the changes of a job done (see publish.ts); the outcome line for its report, if any. Rejects once
   * `signal` aborts: the run's, when the daemon closes; the run then goes on in `publish` after the restart.
   */
  publish(job: PublishJob, signal: AbortSignal): Promise<string | undefined>;
  /** Stops job `jobId`'s sandbox and every process in it; its next tool call starts another. */
  closeSandbox(jobId: string): void;
  /** Job `jobId` ended (its report posted, or stopped): its clone, if kept, is kept 7 days from now. */
  ended(jobId: string): void;
};

/** The statuses a job ends in: its sandbox is closed then. */
const FINAL = ["done", "failed", "cancelled"];

/**
 * The `JobRun` task, which delivers one message to a job, publishes the job's changes when the run left it done, and
 * reports the answer to the CoS (or, for a run that ended without job_complete or job_ask, nudges the job once with
 * another `JobRun`), and `start`, which starts the queued jobs that fit under `jobs.maxConcurrent`.
 *
 * From the decision to publish until its report is posted, the job is `publishing` (the report's seq): its sandbox
 * doesn't start, `job_message` refuses it, and it isn't pruned. A run that leaves the job done meanwhile (a follow-up
 * queued before) publishes nothing itself: its sandbox couldn't start. Skipping the publish, its report has no
 * outcome line, and may be posted before the publishing run's. A run that faults leaves `publishing` set:
 * `unstickPublishing` ends it at the next boot.
 */
export function jobRun(settings: Settings, hooks: JobHooks) {
  const JobRun = defineTask<JobRunInput, JobRunState, null>({
    name: JOB_RUN,
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
          if (job === undefined || decision === undefined) {
            return { status: "running", checkpoint: { phase: "report" } };
          }
          job.updatedAt = Date.now();
          if ("nudge" in decision) {
            const nudge = { jobId, conversationId, text: NUDGE, mode: "followUp", nudge: true } as const;
            await tx.createTask(JobRun, nudge, BACKGROUND);
            return { status: "running", checkpoint: { phase: "report" } };
          }
          job.seq++;
          const report = { seq: job.seq, content: decision.report };
          if (!decision.completed || job.publishing !== undefined) {
            return { status: "running", checkpoint: { phase: "report", report } };
          }
          job.publishing = job.seq;
          return { status: "running", checkpoint: { phase: "publish", report } };
        }, context);
      },
      // Spec §4.3: the job's changes go live, or are kept, before its report; the report ends with the outcome line.
      publish: async (task, runtime, context) => {
        const { jobId } = task.input;
        const { report } = task.state.checkpoint as Extract<JobRunState, { phase: "publish" }>;
        // Nothing the job started may still touch its clone while it's published; `publishing` keeps it from starting.
        hooks.closeSandbox(jobId);
        const job = (await runtime.snapshot(JobsDoc, ROOT_CONVERSATION_ID, context))?.jobs[jobId];
        // A job stopped since is not published: its clone is kept.
        const published = { id: jobId, title: job?.title ?? "", seq: report.seq, stopped: job?.status === "cancelled" };
        const line = job === undefined ? undefined : await hooks.publish(published, runtime.signal);
        const content = line === undefined ? report.content : `${report.content}\n\n${line}`;
        await runtime.commit(
          () => ({ status: "running", checkpoint: { phase: "report", report: { ...report, content } } }),
          context,
        );
      },
      report: async (task, runtime, context) => {
        const { jobId } = task.input;
        const { report } = task.state.checkpoint as Extract<JobRunState, { phase: "report" }>;
        // A finished job's sandbox goes first (spec §3.3), with everything it left running; one waiting for an answer
        // keeps it.
        const job = (await runtime.snapshot(JobsDoc, ROOT_CONVERSATION_ID, context))?.jobs[jobId];
        const ended = job === undefined || FINAL.includes(job.status);
        if (ended) hooks.closeSandbox(jobId);
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
        if (ended) hooks.ended(jobId);
        await runtime.commit(async (tx) => {
          await donePublishing(tx, jobId, report);
          return { status: "terminal", outcome: { status: "completed", result: null } };
        }, context);
      },
    },
    abort: (task, runtime, context) =>
      runtime.commit(async (tx) => {
        const { checkpoint } = task.state;
        await donePublishing(tx, task.input.jobId, "report" in checkpoint ? checkpoint.report : undefined);
        return { status: "terminal", outcome: { status: "aborted" } };
      }, context),
  });

  /** Ends job `jobId`'s `publishing` when it's for `report`: its run's (see `unstickPublishing`). */
  async function donePublishing(tx: Tx, jobId: string, report: Report | undefined): Promise<void> {
    const job = (await tx.doc(JobsDoc, ROOT_CONVERSATION_ID)).jobs[jobId];
    if (job !== undefined && report !== undefined && job.publishing === report.seq) delete job.publishing;
  }

  async function start(tx: Tx, jobs: Record<string, Job>): Promise<void> {
    for (const job of promote(jobs, settings.jobs.maxConcurrent)) {
      job.status = "running";
      const input = { jobId: job.id, conversationId: job.conversationId, text: job.brief, mode: "followUp" } as const;
      await tx.createTask(JobRun, input, BACKGROUND);
    }
  }

  return { JobRun, start };
}

/** The JobRun statuses whose run may yet run code, and end its job's `publishing`. */
const RUNNING = ["pending", "running", "waiting"] as const;

/**
 * Ends `publishing` for every job whose publishing run is gone: only that run (the live JobRun whose report has the
 * seq) ends it, and pi-durable ends a run whose phase throws as `faulted`, without its abort handler. At boot, once the
 * tasks resumed.
 */
export async function unstickPublishing(tx: Tx): Promise<void> {
  const publishing = new Set<string>();
  for (const status of RUNNING) {
    let cursor: Parameters<Tx["scanTasks"]>[2];
    do {
      const page = await tx.scanTasks({ kind: JOB_RUN, status }, 256, cursor);
      for (const task of page.items) {
        const { jobId } = task.input as JobRunInput;
        const checkpoint = task.state.checkpoint as JobRunState | undefined;
        if (checkpoint !== undefined && "report" in checkpoint && checkpoint.report !== undefined) {
          publishing.add(`${jobId}:${checkpoint.report.seq}`);
        }
      }
      cursor = page.next;
    } while (cursor !== undefined);
  }
  for (const job of Object.values((await tx.doc(JobsDoc, ROOT_CONVERSATION_ID)).jobs)) {
    if (job.publishing !== undefined && !publishing.has(`${job.id}:${job.publishing}`)) delete job.publishing;
  }
}

/** `completed`: the run left the job done, so its changes are published before its report. */
type Decision = { report: string; completed?: true } | { nudge: true } | undefined;

/**
 * Updates `job` for the settled message; returns the report to post, a nudge, or nothing. A run that ends unreported
 * (stopped, aborted or failed) clears `completed`, which would otherwise keep the job from being pruned, and `asked`,
 * which would otherwise refuse the next run's ending call. A run that ends without job_complete or job_ask is nudged
 * (the job is `running` again), unless the job already has another message running or queued, which is decided on its
 * own; a nudged run that ends so is `done` with its text, or `failed` if it has none.
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
    return { report: reportText(job, job.result!), completed: true };
  }
  if (job.asked) {
    job.asked = false;
    return { report: reportText(job, job.result!) };
  }
  if (!nudged) {
    // Another message already running or queued is decided on its own; a nudge would reach the worker after it.
    if (await busy(tx, job.conversationId)) return undefined;
    // A follow-up queued before the last run's ending call starts with the job `done` or `needs_input`.
    job.status = "running";
    return { nudge: true };
  }
  const text = answer.content
    .flatMap((c) => (c.type === "text" ? [c.text] : []))
    .join("")
    .trim();
  job.status = text === "" ? "failed" : "done";
  job.result = text === "" ? "the worker ended its turn without a reply" : text;
  return text === "" ? { report: reportText(job, job.result) } : { report: reportText(job, job.result), completed: true };
}

/** Whether a job's conversation has a run, or an input queued for one. */
async function busy(tx: Tx, conversationId: ConversationId): Promise<boolean> {
  if ((await tx.doc(LiveDoc, conversationId)).run !== undefined) return true;
  return (await tx.doc(InboxDoc, conversationId)).items.some((item) => item.mode !== "write");
}
