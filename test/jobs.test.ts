import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { type FauxProviderHandle, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { type Conversation, ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { boot, type Daemon } from "../src/kernel/boot.ts";
import { READ_ONLY_MESSAGE } from "../src/kernel/env.ts";
import { defineJapaExtension, defineTool, type EnvironmentAdapter, Type } from "../src/sdk.ts";
import { tempHome, testKit, waitFor } from "./helpers.ts";
import { ask, call, held, idle, jobs, reported, say, script, texts } from "./jobs-helpers.ts";

/** Each `create` of the probe extension's environments, by environment name. */
const created: { env: string; conversationId: string }[] = [];
const dir = mkdtempSync(join(tmpdir(), "japa-jobs-"));
const recording = (name: string): EnvironmentAdapter => ({
  name,
  create: ({ conversationId }) => {
    created.push({ env: name, conversationId });
    return new NodeExecutionEnv({ cwd: dir });
  },
});
const probeWrite = defineTool({
  name: "probe_write",
  description: "Write a file through the environment",
  parameters: Type.Object({ path: Type.String() }),
  execute: async ({ path }, api, context) => {
    const written = await api.env!.writeFile(path, "x", context);
    return { content: [{ type: "text", text: written.ok ? "written" : written.error.message }] };
  },
});
const probe = defineJapaExtension({
  name: "probe",
  summary: "Probe environments and a probe tool",
  examples: ["probe"],
  docs: "Probe.",
  provides: { environment: [recording("local"), recording("probe")], tool: [probeWrite] },
});

/** Boots with `workers` written to `<home>/workers` and the probe extension. */
async function bootWith(workers: Record<string, string> = {}): Promise<{ daemon: Daemon; faux: FauxProviderHandle }> {
  const kit = testKit();
  const home = tempHome({ storage: { adapter: "memory" }, models: { cos: kit.model } });
  mkdirSync(join(home, "workers"));
  for (const [name, text] of Object.entries(workers)) writeFileSync(join(home, "workers", `${name}.md`), text);
  const daemon = await boot({ home, extensions: [kit.extension, probe] });
  return { daemon, faux: kit.faux };
}

const profile = (name: string, lines: string[]) =>
  ["---", `name: ${name}`, "description: Test", ...lines, "---", "Work."].join("\n");
test("a job runs and reports once", async () => {
  const { daemon, faux } = await bootWith();
  script(faux, (role, text) => {
    if (text === "start sum") return call("job_start", { title: "Sum", brief: "Add 2 and 2" });
    if (text === "Add 2 and 2") return call("job_progress", { note: "adding" });
    if (role === "toolResult" && text === "Noted.") return call("job_complete", { summary: "4" });
  });
  await ask(daemon, "start sum");
  await waitFor(async () => (await reported(daemon)).length > 0);
  expect((await jobs(daemon))["1"]).toMatchObject({ status: "done", result: "4", progress: "adding" });
  expect(await reported(daemon)).toEqual(['[job 1 "Sum" done] 4']);
  await daemon.close();
});

test("a job asks a question and resumes on a follow-up", async () => {
  const { daemon, faux } = await bootWith();
  script(faux, (role, text) => {
    if (text === "start clone") return call("job_start", { title: "Clone", brief: "Clone it" });
    if (text === "Clone it") return say("Which repo?");
    if (text === "answer") return call("job_message", { id: "1", text: "japa", mode: "followup" });
    if (role === "user" && text === "japa") return call("job_complete", { summary: "cloned" });
  });
  await ask(daemon, "start clone");
  await waitFor(async () => (await reported(daemon)).length === 1);
  expect(await reported(daemon)).toEqual(['[job 1 "Clone" needs_input] Which repo?']);
  expect((await jobs(daemon))["1"]!.status).toBe("needs_input");

  await ask(daemon, "answer");
  expect(await texts(daemon.root, "toolResult")).toContain("Sent to job 1.");
  await waitFor(async () => (await reported(daemon)).length === 2);
  expect((await reported(daemon))[1]).toEqual('[job 1 "Clone" done] cloned');
  expect((await jobs(daemon))["1"]).toMatchObject({ status: "done", seq: 2 });
  await daemon.close();
});

test("job_progress and job_complete in one message report done once", async () => {
  const { daemon, faux } = await bootWith();
  script(faux, (role, text) => {
    if (text === "start both") return call("job_start", { title: "Both", brief: "Do both" });
    if (text === "Do both") {
      const calls = [fauxToolCall("job_progress", { note: "half" }), fauxToolCall("job_complete", { summary: "2" })];
      return fauxAssistantMessage(calls, { stopReason: "toolUse" });
    }
    if (role === "toolResult" && text === "Done.") return say("All done.");
  });
  await ask(daemon, "start both");
  await waitFor(() => idle(daemon));
  expect(await reported(daemon)).toEqual(['[job 1 "Both" done] 2']);
  expect((await jobs(daemon))["1"]).toMatchObject({ status: "done", result: "2" });
  await daemon.close();
});

test("job_message refuses an unknown job", async () => {
  const { daemon, faux } = await bootWith();
  script(faux, (_role, text) => {
    if (text === "message") return call("job_message", { id: "9", text: "hi", mode: "followup" });
  });
  await ask(daemon, "message");
  expect(await texts(daemon.root, "toolResult")).toEqual(["No job 9."]);
  await daemon.close();
});

test("a job whose model fails reports once", async () => {
  const { daemon, faux } = await bootWith();
  script(faux, (_role, text) => {
    if (text === "start fail") return call("job_start", { title: "Fail", brief: "Break" });
    // Not a retryable provider error, so Pi Durable gives up at once.
    if (text === "Break") return fauxAssistantMessage([], { stopReason: "error", errorMessage: "boom" });
  });
  await ask(daemon, "start fail");
  await waitFor(() => idle(daemon));
  expect((await jobs(daemon))["1"]!.status).toBe("failed");
  expect(await reported(daemon)).toEqual(['[job 1 "Fail" failed] model_error: boom']);
  await daemon.close();
});

test("a steer during a run ends in one answer and one report", async () => {
  const { daemon, faux } = await bootWith();
  const hold = held();
  script(faux, (role, text, signal) => {
    if (text === "start work") return call("job_start", { title: "Work", brief: "Do work" });
    if (text === "Do work") return hold.wait(call("job_progress", { note: "working" }), signal);
    if (text === "steer") return call("job_message", { id: "1", text: "use japa", mode: "steer" });
    if (role === "user" && text === "use japa") return call("job_complete", { summary: "used japa" });
  });
  await ask(daemon, "start work");
  await waitFor(hold.started);
  await ask(daemon, "steer");
  const job = (await jobs(daemon))["1"]!.conversationId;
  const queued = async () =>
    (await daemon.harness.inspect(ctx)).submissions.some((s) => s.conversationId === job && s.status === "queued");
  await waitFor(queued);
  hold.release();
  await waitFor(() => idle(daemon));
  expect(await reported(daemon)).toEqual(['[job 1 "Work" done] used japa']);
  await daemon.close();
});

test("a follow-up queued before job_complete reports its own answer", async () => {
  const { daemon, faux } = await bootWith();
  const hold = held();
  script(faux, (role, text, signal) => {
    if (text === "start work") return call("job_start", { title: "Work", brief: "Do work" });
    if (text === "Do work") return hold.wait(call("job_complete", { summary: "first done" }), signal);
    if (text === "follow") return call("job_message", { id: "1", text: "more", mode: "followup" });
    if (role === "user" && text === "more") return say("Which part?");
  });
  await ask(daemon, "start work");
  await waitFor(hold.started);
  await ask(daemon, "follow");
  const job = (await jobs(daemon))["1"]!.conversationId;
  const queued = async () =>
    (await daemon.harness.inspect(ctx)).submissions.some((s) => s.conversationId === job && s.status === "queued");
  await waitFor(queued);
  hold.release();
  await waitFor(() => idle(daemon));
  expect(await reported(daemon)).toEqual([
    '[job 1 "Work" done] first done',
    '[job 1 "Work" needs_input] Which part?',
  ]);
  await daemon.close();
});

test("a report withdrawn by Esc still reaches the CoS once", async () => {
  const { daemon, faux } = await bootWith();
  const hold = held();
  script(faux, (role, text, signal) => {
    if (text === "start work") return call("job_start", { title: "Work", brief: "Do work" });
    if (text === "Do work") return call("job_complete", { summary: "w" });
    if (role === "toolResult" && text === "Started job 1.") return hold.wait(say("ok"), signal);
  });
  await daemon.root.submit({ type: "input", content: "start work" }, ctx);
  await waitFor(hold.started);
  const queued = async () =>
    (await daemon.harness.inspect(ctx)).submissions.some((s) => s.requestId === "report:1:1" && s.status === "queued");
  await waitFor(queued);
  await daemon.root.abort(ctx);
  await waitFor(() => idle(daemon));
  expect(await reported(daemon)).toEqual(['[job 1 "Work" done] w']);
  await daemon.close();
});

test("a job interrupted by a restart finishes and reports once", async () => {
  const kit = testKit();
  const home = tempHome({ models: { cos: kit.model } }); // default storage: sqlite
  const hold = held();
  script(kit.faux, (_role, text, signal) => {
    if (text === "start long") return call("job_start", { title: "Long", brief: "Take long" });
    if (text === "Take long")
      return hold.started() ? call("job_complete", { summary: "finished" }) : hold.wait(say("lost"), signal);
  });
  let daemon = await boot({ home, extensions: [kit.extension] });
  await ask(daemon, "start long");
  await waitFor(hold.started);
  await daemon.close();

  daemon = await boot({ home, extensions: [kit.extension] });
  await waitFor(() => idle(daemon));
  expect(await reported(daemon)).toEqual(['[job 1 "Long" done] finished']);
  const job = (await daemon.harness.conversation((await jobs(daemon))["1"]!.conversationId, ctx))!;
  expect((await texts(job, "user")).filter((t) => t === "Take long")).toHaveLength(1);
  await daemon.close();
});

test("the CoS and jobs are offered their own tools", async () => {
  const { daemon, faux } = await bootWith({ shell: profile("shell", ["tools: [read, bash]", "extensions: []"]) });
  const names = async (c: Conversation) => (await c.agent(ctx)).tools.map((t) => t.name);
  const root = await names(daemon.root);
  expect(root).toEqual(expect.arrayContaining(["read", "job_start", "probe_write"]));
  for (const name of ["write", "edit", "bash", "job_progress", "job_complete"]) expect(root).not.toContain(name);

  script(faux, (_role, text) => {
    if (text === "start shell") return call("job_start", { title: "Shell", brief: "Look around", worker: "shell" });
  });
  await ask(daemon, "start shell");
  const job = (await daemon.harness.conversation((await jobs(daemon))["1"]!.conversationId, ctx))!;
  const tools = await names(job);
  expect(tools).toEqual(expect.arrayContaining(["read", "bash", "job_progress", "job_complete"]));
  for (const name of ["write", "job_start", "probe_write"]) expect(tools).not.toContain(name);
  await daemon.close();
});

test("a job runs in its profile's environment; the CoS's is read-only", async () => {
  created.length = 0;
  const { daemon, faux } = await bootWith({ prober: profile("prober", ["environment: probe"]) });
  script(faux, (_role, text) => {
    if (text === "probe root") return call("probe_write", { path: join(dir, "root.txt") });
    if (text === "start probe") return call("job_start", { title: "Probe", brief: "probe job", worker: "prober" });
    if (text === "probe job") return call("probe_write", { path: join(dir, "job.txt") });
  });
  await ask(daemon, "probe root");
  expect(await texts(daemon.root, "toolResult")).toEqual([READ_ONLY_MESSAGE]);
  expect(existsSync(join(dir, "root.txt"))).toBe(false);

  await ask(daemon, "start probe");
  await waitFor(async () => (await reported(daemon)).length > 0);
  const job = String((await jobs(daemon))["1"]!.conversationId);
  expect(existsSync(join(dir, "job.txt"))).toBe(true);
  expect(created).toContainEqual({ env: "local", conversationId: String(ROOT_CONVERSATION_ID) });
  expect(created).toContainEqual({ env: "probe", conversationId: job });
  expect(created).not.toContainEqual({ env: "local", conversationId: job });
  await daemon.close();
});

test("bad worker profiles are reported and cannot be started", async () => {
  const { daemon, faux } = await bootWith({
    "bad-tool": profile("bad-tool", ["tools: [grep]"]),
    "bad-ext": profile("bad-ext", ["extensions: [nope]"]),
    "bad-env": profile("bad-env", ["environment: nowhere"]),
    "bad-model": profile("bad-model", ["model: { provider: nope, modelId: none }"]),
  });
  expect(
    daemon
      .status()
      .errors.map((e) => e.name)
      .sort(),
  ).toEqual(["worker:bad-env", "worker:bad-ext", "worker:bad-model", "worker:bad-tool"]);
  script(faux, (_role, text) => {
    if (text === "start bad") return call("job_start", { title: "Bad", brief: "b", worker: "bad-tool" });
  });
  await ask(daemon, "start bad");
  expect(await texts(daemon.root, "toolResult")).toEqual(['Unknown worker "bad-tool". Workers: builder, coder, general, researcher.']);
  expect(await jobs(daemon)).toEqual({});
  await daemon.close();
});
