// Job status labels, shared by the Jobs panel and the transcript's job reports. Pure TS (a type-only import), so vitest and the root tsc can import it directly.
import type { JobStatus } from "./protocol.ts";

export const JOB_STATUS_LABEL: Record<JobStatus, string> = {
  queued: "queued",
  running: "running",
  needs_input: "needs input",
  done: "done",
  failed: "failed",
  cancelled: "cancelled",
};

/** Whether `status` is one of the job statuses (a report's status comes from its header, so it's just a string). */
export function isJobStatus(status: string): status is JobStatus {
  return Object.hasOwn(JOB_STATUS_LABEL, status);
}

/** The pill label for a status: the known label, else the status with underscores as spaces. */
export function jobStatusLabel(status: string): string {
  return isJobStatus(status) ? JOB_STATUS_LABEL[status] : status.replace(/_/g, " ");
}
