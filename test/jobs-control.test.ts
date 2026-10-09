import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { getSystemMessageText } from "@earendil-works/pi-ai";
import { ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { expect, test } from "vitest";
import type { Daemon } from "../src/kernel/boot.ts";
import { NUDGE } from "../src/kernel/jobs/run.ts";
import { JobsDoc } from "../src/kernel/jobs/state.ts";
import { bootTest, waitFor } from "./helpers.ts";
import { ask, call, held, idle, jobs, reported, say, script, texts } from "./jobs-helpers.ts";

const statuses = async (daemon: Daemon) => Object.values(await jobs(daemon)).map((j) => j.status);

test("queued jobs start in order, one at a time", async () => {
  const { daemon, faux } = await bootTest({ jobs: { maxConcurrent: 1 } });
  const one = held();
  const two = held();
  script(faux, (_role, text, signal) => {
    if (text.startsWith("start ")) return call("job_start", { title: text, brief: `work ${text.slice(6)}` });
    if (text === "message 3") return call("job_message", { id: "3", text: "hi", mode: "steer" });
    if (text === "work 1") return one.wait(call("job_complete", { summary: "one" }), signal);
    if (text === "work 2") return two.wait(call("job_complete", { summary: "two" }), signal);
    if (text === "work 3") return call("job_complete", { summary: "three" });
  });
  let most = 0;
  const watch = (await daemon.harness.watchDoc(JobsDoc, ROOT_CONVERSATION_ID, ctx))!;
  watch.start(async (doc) => {
    most = Math.max(most, Object.values(doc!.jobs).filter((j) => j.status === "running").length);
  });

  for (const n of ["1", "2", "3"]) await ask(daemon, `start ${n}`);
  await waitFor(one.started);
  expect(await statuses(daemon)).toEqual(["running", "queued", "queued"]);
  expect(await texts(daemon.root, "toolResult")).toEqual([
    "Started job 1.",
    "Queued job 2; it starts when a running job finishes.",
    "Queued job 3; it starts when a running job finishes.",
  ]);
  await ask(daemon, "message 3");
  expect((await texts(daemon.root, "toolResult")).at(-1)).toBe("Job 3 hasn't started yet.");

  one.release();
  await waitFor(two.started);
  expect(await statuses(daemon)).toEqual(["done", "running", "queued"]);
  two.release();
  await waitFor(() => idle(daemon));
  expect(await statuses(daemon)).toEqual(["done", "done", "done"]);
  expect(most).toBe(1);
  await watch.stop();
  await daemon.close();
});

test("a stopped job stays quiet and frees its slot", async () => {
  const { daemon, faux } = await bootTest({ jobs: { maxConcurrent: 1 } });
  const hold = held();
  script(faux, (_role, text, signal) => {
    if (text === "start 1") return call("job_start", { title: "One", brief: "work 1" });
    if (text === "start 2") return call("job_start", { title: "Two", brief: "work 2" });
    if (text === "stop 1") return call("job_stop", { id: "1" });
    if (text === "work 1") return hold.wait(call("job_complete", { summary: "one" }), signal);
    if (text === "work 2") return call("job_complete", { summary: "two" });
  });
  await ask(daemon, "start 1");
  await ask(daemon, "start 2");
  await waitFor(hold.started);
  await ask(daemon, "stop 1");
  await waitFor(() => idle(daemon));
  expect((await texts(daemon.root, "toolResult")).at(-1)).toBe("Stopped job 1.");
  expect(await statuses(daemon)).toEqual(["cancelled", "done"]);
  expect(await reported(daemon)).toEqual(['[job 2 "Two" done] two']);
  await daemon.close();
});

test("a job stopped during its nudge stays cancelled", async () => {
  const { daemon, faux } = await bootTest();
  const hold = held();
  script(faux, (_role, text, signal) => {
    if (text === "start work") return call("job_start", { title: "Work", brief: "Do work" });
    if (text === "stop 1") return call("job_stop", { id: "1" });
    if (text === "Do work") return say("partial");
    if (text === NUDGE) return hold.wait(say("x"), signal);
  });
  await ask(daemon, "start work");
  await waitFor(hold.started);
  await ask(daemon, "stop 1");
  await waitFor(() => idle(daemon));
  expect(await statuses(daemon)).toEqual(["cancelled"]);
  expect(await reported(daemon)).toEqual([]);
  await daemon.close();
});

test("job_complete racing a stop leaves the job cancelled", async () => {
  const { daemon, faux } = await bootTest();
  const hold = held();
  script(faux, (_role, text) => {
    if (text === "start work") return call("job_start", { title: "Work", brief: "Do work" });
    if (text === "Do work") return hold.wait(call("job_complete", { summary: "done" }));
  });
  await ask(daemon, "start work");
  await waitFor(hold.started);
  // The stop's commit lands, but its abort has not reached the worker yet.
  await daemon.harness.commit(async (tx) => {
    (await tx.doc(JobsDoc, ROOT_CONVERSATION_ID)).jobs["1"]!.status = "cancelled";
  }, ctx);
  hold.release();
  await waitFor(() => idle(daemon));
  expect(await statuses(daemon)).toEqual(["cancelled"]);
  expect(await reported(daemon)).toEqual([]);
  await daemon.close();
});

test("job_ask racing a stop leaves the job cancelled", async () => {
  const { daemon, faux } = await bootTest();
  const hold = held();
  script(faux, (_role, text) => {
    if (text === "start work") return call("job_start", { title: "Work", brief: "Do work" });
    if (text === "Do work") return hold.wait(call("job_ask", { question: "q" }));
  });
  await ask(daemon, "start work");
  await waitFor(hold.started);
  // The stop's commit lands, but its abort has not reached the worker yet.
  await daemon.harness.commit(async (tx) => {
    (await tx.doc(JobsDoc, ROOT_CONVERSATION_ID)).jobs["1"]!.status = "cancelled";
  }, ctx);
  hold.release();
  await waitFor(() => idle(daemon));
  expect(await statuses(daemon)).toEqual(["cancelled"]);
  expect(await reported(daemon)).toEqual([]);
  await daemon.close();
});

test("job_list and job_transcript describe a finished job", async () => {
  const { daemon, faux } = await bootTest();
  script(faux, (role, text) => {
    if (text === "start sum") return call("job_start", { title: "Sum", brief: "Add 2 and 2" });
    if (text === "Add 2 and 2") return call("job_progress", { note: "adding" });
    if (role === "toolResult" && text === "Noted.") return call("job_complete", { summary: "4" });
    if (text === "list") return call("job_list", {});
    if (text === "transcript") return call("job_transcript", { id: "1" });
  });
  await ask(daemon, "start sum");
  await waitFor(() => idle(daemon));
  await ask(daemon, "list");
  await ask(daemon, "transcript");
  const [list, transcript] = (await texts(daemon.root, "toolResult")).slice(-2);
  expect(list).toBe('1 "Sum" done: 4');
  expect(transcript!.split("\n")).toEqual([
    "user: Add 2 and 2",
    "assistant: ",
    "tool job_progress: Noted.",
    "assistant: ",
    "tool job_complete: Done.",
  ]);
  await daemon.close();
});

test("the CoS's prompt shows running jobs on the board", async () => {
  const { daemon, faux } = await bootTest();
  const hold = held();
  let prompt = "";
  script(faux, (_role, text, signal) => {
    if (text === "start work") return call("job_start", { title: "Work", brief: "Do work" });
    if (text === "Do work") return hold.wait(call("job_complete", { summary: "done" }), signal);
  });
  await ask(daemon, "start work");
  await waitFor(hold.started);
  faux.setResponses([
    ({ messages }) => {
      prompt = messages.map((m) => (m.role === "system" ? getSystemMessageText(m) : "")).join("\n");
      return say("ok");
    },
  ]);
  await ask(daemon, "board?");
  expect(prompt).toContain('- 1 "Work" running');
  await daemon.close();
});
