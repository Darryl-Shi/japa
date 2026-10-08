import type { ConversationId } from "@earendil-works/pi-durable";
import { expect, test } from "vitest";
import { board, promote, recent, reportText, type Job, type JobStatus } from "../src/kernel/jobs/state.ts";

function job(id: number, status: JobStatus, extra: Partial<Job> = {}): Job {
  return {
    id: String(id),
    title: `t${id}`,
    brief: "b",
    worker: "general",
    status,
    conversationId: id as ConversationId,
    createdAt: id,
    updatedAt: id,
    seq: 0,
    reported: [],
    ...extra,
  };
}

function jobsOf(...list: Job[]): Record<string, Job> {
  return Object.fromEntries(list.map((j) => [j.id, j]));
}

test("promote keeps the running count within max, in id order", () => {
  const running = [1, 2, 3, 4].map((id) => job(id, "running"));
  const full = jobsOf(...running, job(12, "queued"), job(9, "queued"));
  expect(promote(full, 4)).toEqual([]);
  expect(promote(full, 5).map((j) => j.id)).toEqual(["9"]);

  const idle = jobsOf(job(10, "queued"), job(2, "queued"), job(3, "done"), job(7, "queued"));
  expect(promote(idle, 2).map((j) => j.id)).toEqual(["2", "7"]);
});

test("reportText formats the report", () => {
  expect(reportText(job(3, "done", { title: "Fix it" }), "all good")).toBe('[job 3 "Fix it" done] all good');
});

test("board lists active jobs and truncates their text", () => {
  expect(board(jobsOf(job(1, "done"), job(2, "failed"), job(3, "cancelled")))).toBeUndefined();
  const long = "x".repeat(130);
  const text = board(
    jobsOf(
      job(10, "needs_input", { result: "which branch?" }),
      job(2, "running", { progress: long }),
      job(3, "queued"),
      job(4, "done", { result: "ok" }),
    ),
  );
  expect(text).toBe(
    [`- 2 "t2" running: ${"x".repeat(119)}…`, '- 3 "t3" queued', '- 10 "t10" needs_input: which branch?'].join("\n"),
  );
});

const HOUR = 3_600_000;

test("board lists jobs finished in the last 24 hours and the first line of their detail", () => {
  const now = 100 * HOUR;
  const jobs = jobsOf(
    job(1, "done", { result: "old", updatedAt: now - 25 * HOUR }),
    job(5, "failed", { result: "boom\nstack trace", updatedAt: now - 23 * HOUR }),
  );
  expect(board(jobs, now)).toBe('- 5 "t5" failed: boom');
});

test("recent keeps active jobs and those updated in the last 24 hours", () => {
  const now = 100 * HOUR;
  const old = { updatedAt: now - 25 * HOUR };
  const list = [job(1, "done", old), job(2, "running", old), job(3, "failed", { updatedAt: now - HOUR })];
  expect(recent(list, now).map((j) => j.id)).toEqual(["2", "3"]);
});
