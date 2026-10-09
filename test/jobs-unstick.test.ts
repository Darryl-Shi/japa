import { expect, test, vi } from "vitest";
import { boot } from "../src/kernel/boot.ts";
import { goingLive } from "../src/kernel/jobs/state.ts";
import { bootTest, NO_BWRAP, REPO_EXTENSIONS, testKit, waitFor } from "./helpers.ts";
import { ask, call, idle, jobs, script, texts } from "./jobs-helpers.ts";

/** Which call to close a job's sandbox throws (1 is the first), if any; and whether it has. */
const fault = vi.hoisted(() => ({ at: 0, calls: 0, thrown: false }));

vi.mock("../src/kernel/sandbox/jobs.ts", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/kernel/sandbox/jobs.ts")>();
  return {
    ...real,
    createJobSandboxes: (o: Parameters<typeof real.createJobSandboxes>[0]) => {
      const sandboxes = real.createJobSandboxes(o);
      return {
        ...sandboxes,
        close: (jobId: string) => {
          if (++fault.calls === fault.at) {
            fault.thrown = true;
            throw new Error("closing failed");
          }
          sandboxes.close(jobId);
        },
      };
    },
  };
});

// pi-durable ends a task whose phase throws as `faulted`, without its abort handler: nothing in the run clears the
// job's `publishing` then.
test.skipIf(NO_BWRAP)("a job left going live by a run that faulted isn't stuck after a restart", async () => {
  const kit = testKit();
  const { daemon, faux, home } = await bootTest({ storage: { adapter: "sqlite" } }, [], kit);
  // The publish phase closes the job's sandbox first, then the report phase: its close throws.
  Object.assign(fault, { at: 2, calls: 0, thrown: false });
  // Scripted, not `tool`: after the restart, reflection asks the model too.
  const respond = (_role: string, text: string) => {
    if (text === "start") return call("job_start", { title: "Hello", brief: "hello" });
    if (text === "hello") return call("job_complete", { summary: "said hello" });
    if (text === "follow") return call("job_message", { id: "1", text: "more", mode: "followup" });
    if (text === "more") return call("job_complete", { summary: "said more" });
  };
  script(faux, respond);
  await ask(daemon, "start");
  await waitFor(() => fault.thrown);
  await waitFor(() => idle(daemon));
  expect((await jobs(daemon))["1"]).toMatchObject({ status: "done", publishing: 1 });
  await ask(daemon, "follow");
  expect((await texts(daemon.root, "toolResult")).at(-1)).toBe(goingLive("1"));
  await daemon.close();

  const again = await boot({ home, extensionDirs: [REPO_EXTENSIONS], extensions: [kit.extension] });
  expect((await jobs(again))["1"]!.publishing).toBeUndefined();
  script(kit.faux, respond);
  await ask(again, "follow");
  expect((await texts(again.root, "toolResult")).at(-1)).toBe("Sent to job 1.");
  await waitFor(() => idle(again));
  expect((await jobs(again))["1"]).toMatchObject({ status: "done", result: "said more" });
  expect((await jobs(again))["1"]!.publishing).toBeUndefined();
  await again.close();
});
