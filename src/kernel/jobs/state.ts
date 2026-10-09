import { defineDoc, type ConversationId, type EntryId } from "@earendil-works/pi-durable";

export type JobStatus = "queued" | "running" | "needs_input" | "done" | "failed" | "cancelled";

export type Job = {
  id: string;
  title: string;
  brief: string;
  worker: string;
  status: JobStatus;
  conversationId: ConversationId;
  progress?: string;
  result?: string; // done: summary, needs_input: question, failed: reason
  createdAt: number;
  updatedAt: number;
  seq: number; // reports posted
  reported: EntryId[]; // answer entries already reported
  completed?: boolean; // job_complete called in the run not yet reported
  asked?: boolean; // job_ask called in the run not yet reported
};

// On the root conversation.
export const JobsDoc = defineDoc<{ nextId: number; jobs: Record<string, Job> }>({
  kind: "japa.jobs",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ nextId: 1, jobs: {} }),
});

// On each job's conversation. `skills` is its profile's, until profiles go; one stored with an `environment` (the
// profile's, before every job ran in its sandbox) still loads.
export const JobDoc = defineDoc<{ jobId: string; skills?: string[] }>({
  kind: "japa.job",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ jobId: "" }),
});

export function byId(jobs: Record<string, Job>): Job[] {
  return Object.values(jobs).sort((a, b) => Number(a.id) - Number(b.id));
}

export function promote(jobs: Record<string, Job>, max: number): Job[] {
  const all = byId(jobs);
  const running = all.filter((j) => j.status === "running").length;
  return all.filter((j) => j.status === "queued").slice(0, Math.max(0, max - running));
}

export function reportText(job: Job, text: string): string {
  return `[job ${job.id} "${job.title}" ${job.status}] ${text}`;
}

function cut(text: string): string {
  return text.length > 120 ? `${text.slice(0, 119)}…` : text;
}

export const DAY = 86_400_000;

const active = (j: Job) => j.status === "queued" || j.status === "running" || j.status === "needs_input";

/** Active jobs, and finished ones updated in the last 24 hours. */
export function recent(jobs: Job[], now = Date.now()): Job[] {
  return jobs.filter((j) => active(j) || j.updatedAt > now - DAY);
}

/**
 * Deletes the done, failed and cancelled jobs updated before `before`, except one whose completion is not yet reported;
 * returns how many.
 */
export function prune(jobs: Record<string, Job>, before: number): number {
  const old = Object.values(jobs).filter((j) => !active(j) && !j.completed && j.updatedAt < before);
  for (const job of old) delete jobs[job.id];
  return old.length;
}

/** The `recent` jobs, a line each. */
export function board(jobs: Record<string, Job>, now = Date.now()): string | undefined {
  const lines = recent(byId(jobs), now).map((j) => {
    const detail = j.status === "running" ? j.progress : j.status === "queued" ? undefined : j.result;
    const first = detail?.split("\n")[0];
    return `- ${j.id} "${j.title}" ${j.status}${first ? `: ${cut(first)}` : ""}`;
  });
  return lines.length ? lines.join("\n") : undefined;
}
