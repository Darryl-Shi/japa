import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import type { ConversationId } from "@earendil-works/pi-durable";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, expect, test, vi } from "vitest";
import { boot, type Daemon } from "../src/kernel/boot.ts";
import { CONTRACTS, type MessagingContext } from "../src/kernel/contracts.ts";
import { DAY, type Job, JobsDoc, type JobStatus } from "../src/kernel/jobs/state.ts";
import { bootTest, REPO_EXTENSIONS, testKit, waitFor } from "./helpers.ts";
import { ask, call, held, idle, jobs, reported, script, texts, tool } from "./jobs-helpers.ts";
import { bootMessaging, fakeAdapter } from "./messaging-helpers.ts";

/** Boots with messaging and returns its context, for `clearFinishedJobs`. */
async function bootClearing() {
  const contract = CONTRACTS.get("messaging")! as { activate: (...args: unknown[]) => Promise<unknown> };
  const activate = contract.activate;
  let messaging: MessagingContext | undefined;
  vi.spyOn(contract, "activate").mockImplementation((c, k, m) => {
    messaging = m as MessagingContext;
    return activate(c, k, m);
  });
  const booted = await bootMessaging(fakeAdapter());
  return { ...booted, messaging: messaging! };
}

/** Puts jobs with the given status and `updatedAt` into the root's `JobsDoc`, ids from 1. */
async function seed(daemon: Daemon, list: [JobStatus, number][]) {
  await daemon.root.commit(async (tx) => {
    const doc = await tx.doc(JobsDoc, daemon.root.id);
    list.forEach(([status, updatedAt], i) => {
      const id = String(i + 1);
      const job: Job = {
        id,
        title: `t${id}`,
        brief: "b",
        worker: "general",
        status,
        conversationId: (1000 + i) as ConversationId,
        createdAt: updatedAt,
        updatedAt,
        seq: 0,
        reported: [],
      };
      doc.jobs[id] = job;
    });
    doc.nextId = list.length + 1;
  }, ctx);
}

afterEach(() => {
  vi.restoreAllMocks();
});

test("boot prunes finished jobs older than jobs.keepFinishedDays, never active ones", async () => {
  const kit = testKit();
  let { daemon, home } = await bootTest({ storage: { adapter: "sqlite" } }, [], kit);
  const now = Date.now();
  await seed(daemon, [
    ["done", now - 10 * DAY],
    ["done", now - DAY],
    ["failed", now - 8 * DAY],
    ["needs_input", 0],
    ["queued", 0],
    ["running", 0],
  ]);
  await daemon.close();
  daemon = await boot({ home, extensionDirs: [REPO_EXTENSIONS], extensions: [kit.extension] });
  expect(Object.keys(await jobs(daemon))).toEqual(["2", "4", "5", "6"]);
  expect(await tool(daemon, kit.faux, "job_transcript", { id: "1" })).toBe("No job 1.");
  await daemon.close();
});

test("clearFinishedJobs removes every finished job and leaves the active ones", async () => {
  const { daemon, faux, messaging } = await bootClearing();
  const now = Date.now();
  await seed(daemon, [
    ["done", now],
    ["running", 0],
    ["failed", now],
    ["queued", 0],
    ["cancelled", now],
    ["needs_input", 0],
  ]);
  expect(await messaging!.clearFinishedJobs()).toBe(3);
  expect(Object.keys(await jobs(daemon))).toEqual(["2", "4", "6"]);
  expect(await messaging!.clearFinishedJobs()).toBe(0);
  expect(await tool(daemon, faux, "job_transcript", { id: "1" })).toBe("No job 1.");
  await daemon.close();
});

test("clearFinishedJobs keeps a completed job until its report is posted", async () => {
  const { daemon, faux, messaging } = await bootClearing();
  const hold = held();
  script(faux, (_role, text, signal) => {
    if (text === "start work") return call("job_start", { title: "Work", brief: "Do work" });
    if (text === "Do work") return hold.wait(call("job_complete", { summary: "done" }), signal);
  });
  await ask(daemon, "start work");
  await waitFor(hold.started);
  // As job_complete leaves it, before its run's answer is reported.
  await daemon.harness.commit(async (tx) => {
    Object.assign((await tx.doc(JobsDoc, daemon.root.id)).jobs["1"]!, { status: "done", completed: true });
  }, ctx);
  expect(await messaging.clearFinishedJobs()).toBe(0);
  hold.release();
  await waitFor(() => idle(daemon));
  expect(await reported(daemon)).toEqual(['[job 1 "Work" done] done']);
  expect(await messaging.clearFinishedJobs()).toBe(1);
  await daemon.close();
});

/**
 * Starts a job whose worker's model call is held, then marks it as job_complete leaves it, before its run's answer is
 * reported; `end` then ends that run.
 */
async function completedThen(end: (daemon: Daemon, release: () => void) => Promise<void>) {
  const booted = await bootClearing();
  const { daemon, faux } = booted;
  const hold = held();
  const boom = fauxAssistantMessage([], { stopReason: "error", errorMessage: "boom" });
  script(faux, (_role, text, signal) => {
    if (text === "start work") return call("job_start", { title: "Work", brief: "Do work" });
    if (text === "Do work") return hold.wait(boom, signal);
  });
  await ask(daemon, "start work");
  await waitFor(hold.started);
  await daemon.harness.commit(async (tx) => {
    Object.assign((await tx.doc(JobsDoc, daemon.root.id)).jobs["1"]!, { status: "done", completed: true });
  }, ctx);
  await end(daemon, hold.release);
  await waitFor(() => idle(daemon));
  return booted;
}

test("a job whose run then fails can be cleared", async () => {
  const { daemon, messaging } = await completedThen(async (_daemon, release) => release());
  expect((await jobs(daemon))["1"]).toMatchObject({ status: "failed", completed: false });
  expect(await reported(daemon)).toEqual(['[job 1 "Work" failed] model_error: boom']);
  expect(await messaging.clearFinishedJobs()).toBe(1);
  await daemon.close();
});

test("a job whose run is then aborted can be cleared", async () => {
  const { daemon, messaging } = await completedThen(async (d) => {
    await (await d.harness.conversation((await jobs(d))["1"]!.conversationId, ctx))!.abort(ctx);
  });
  expect((await jobs(daemon))["1"]).toMatchObject({ status: "done", completed: false });
  expect(await messaging.clearFinishedJobs()).toBe(1);
  await daemon.close();
});

test("a run whose job was cleared ends quietly", async () => {
  const { daemon, faux, messaging } = await bootClearing();
  const hold = held();
  script(faux, (_role, text, signal) => {
    if (text === "start work") return call("job_start", { title: "Work", brief: "Do work" });
    if (text === "Do work") return hold.wait(call("job_complete", { summary: "done" }), signal);
  });
  await ask(daemon, "start work");
  await waitFor(hold.started);
  const conversationId = (await jobs(daemon))["1"]!.conversationId;
  const run = (await daemon.harness.inspect(ctx)).tasks.find((t) => t.record.kind === "japa.job-run")!.record.id;
  // A stop's commit lands, but its abort has not reached the worker yet.
  await daemon.harness.commit(async (tx) => {
    (await tx.doc(JobsDoc, daemon.root.id)).jobs["1"]!.status = "cancelled";
  }, ctx);
  expect(await messaging.clearFinishedJobs()).toBe(1);
  hold.release();
  await waitFor(() => idle(daemon));
  expect((await daemon.harness.getTask(run, ctx))!.state).toEqual({
    status: "terminal",
    outcome: { status: "completed", result: null },
  });
  const worker = (await daemon.harness.conversation(conversationId, ctx))!;
  expect(await texts(worker, "toolResult")).toEqual(["Done."]);
  expect(await jobs(daemon)).toEqual({});
  expect(await reported(daemon)).toEqual([]);
  await daemon.close();
});
