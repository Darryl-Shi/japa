import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import type { ConversationId } from "@earendil-works/pi-durable";
import { afterEach, expect, test, vi } from "vitest";
import { boot, type Daemon } from "../src/kernel/boot.ts";
import { CONTRACTS, type MessagingContext } from "../src/kernel/contracts.ts";
import { type Job, JobsDoc, type JobStatus } from "../src/kernel/jobs/state.ts";
import { bootTest, REPO_EXTENSIONS, testKit } from "./helpers.ts";
import { jobs, tool } from "./jobs-helpers.ts";
import { bootMessaging, fakeAdapter } from "./messaging-helpers.ts";

const DAY = 86_400_000;

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
  const contract = CONTRACTS.get("messaging")! as { activate: (...args: unknown[]) => Promise<unknown> };
  const activate = contract.activate;
  let messaging: MessagingContext | undefined;
  vi.spyOn(contract, "activate").mockImplementation((c, k, m) => {
    messaging = m as MessagingContext;
    return activate(c, k, m);
  });
  const fake = fakeAdapter();
  const { daemon, faux } = await bootMessaging(fake);
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
