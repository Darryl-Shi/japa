import { expect, test } from "vitest";
import { JOB_STATUS_LABEL, isJobStatus, jobStatusLabel } from "../extensions/webui/app/src/lib/jobs.ts";

test("job status labels match the Jobs panel's", () => {
  expect(JOB_STATUS_LABEL).toEqual({
    queued: "queued",
    running: "running",
    needs_input: "needs input",
    done: "done",
    failed: "failed",
    cancelled: "cancelled",
  });
  expect(jobStatusLabel("needs_input")).toBe("needs input");
  expect(jobStatusLabel("done")).toBe("done");
});

test("an unknown report status is shown readably, not dropped", () => {
  expect(isJobStatus("weird_state")).toBe(false);
  expect(isJobStatus("toString")).toBe(false);
  expect(jobStatusLabel("weird_state")).toBe("weird state");
  expect(jobStatusLabel("")).toBe("");
});
