import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { type FauxProviderHandle, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { type Conversation, ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, onTestFinished, test } from "vitest";
import { boot, type Daemon } from "../src/kernel/boot.ts";
import { READ_ONLY_MESSAGE } from "../src/kernel/env.ts";
import { NUDGE } from "../src/kernel/jobs/run.ts";
import { probeSandbox } from "../src/kernel/sandbox/bwrap.ts";
import { defineJapaExtension, defineTool, type EnvironmentAdapter, Type } from "../src/sdk.ts";
import { bootTest, tempHome, testKit, waitFor } from "./helpers.ts";
import { ask, call, held, idle, jobs, nudges, queued, reported, say, script, texts, tool } from "./jobs-helpers.ts";

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

/** Whether bwrap works here; the tests that run a job's tools in its sandbox are skipped where it doesn't. */
const NO_BWRAP = probeSandbox() !== undefined;
const HOME = process.env.HOME;

/**
 * Boots with the probe extension, the japa home and the user's home (`HOME`, until the test finishes) outside `/tmp`,
 * which jobs see replaced by their own; the home has `marker` and a secret `secrets/api-key`.
 */
async function bootSandboxed(): Promise<{ daemon: Daemon; faux: FauxProviderHandle; home: string; user: string }> {
  const cache = join(realpathSync(fileURLToPath(new URL("../node_modules", import.meta.url))), ".cache");
  mkdirSync(cache, { recursive: true });
  const outside = mkdtempSync(join(cache, "japa-jobs-"));
  const [home, user] = [join(outside, "home"), join(outside, "user")];
  mkdirSync(join(home, "secrets"), { recursive: true });
  mkdirSync(user);
  writeFileSync(join(home, "secrets", "api-key"), "sk-1");
  writeFileSync(join(home, "marker"), "the real marker");
  const kit = testKit();
  writeFileSync(join(home, "settings.json"), JSON.stringify({ storage: { adapter: "memory" }, models: { cos: kit.model } }));
  process.env.HOME = user;
  onTestFinished(() => {
    process.env.HOME = HOME;
    rmSync(outside, { recursive: true, force: true });
  });
  const daemon = await boot({ home, extensions: [kit.extension, probe] });
  return { daemon, faux: kit.faux, home, user };
}

/** The tool results of job 1's conversation. */
async function jobResults(daemon: Daemon): Promise<string[]> {
  const job = (await daemon.harness.conversation((await jobs(daemon))["1"]!.conversationId, ctx))!;
  return texts(job, "toolResult");
}

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

test("a job asks with job_ask and resumes on a follow-up", async () => {
  const { daemon, faux } = await bootWith();
  script(faux, (role, text) => {
    if (text === "start clone") return call("job_start", { title: "Clone", brief: "Clone it" });
    if (text === "Clone it") return call("job_ask", { question: "Which repo?" });
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

test("a run that ends without job_complete or job_ask is nudged, then completes", async () => {
  const { daemon, faux } = await bootWith();
  script(faux, (_role, text) => {
    if (text === "start sum") return call("job_start", { title: "Sum", brief: "Add 2 and 2" });
    if (text === "Add 2 and 2") return say("Working on it");
    if (text === NUDGE) return call("job_complete", { summary: "4" });
  });
  await ask(daemon, "start sum");
  await waitFor(() => idle(daemon));
  expect(await reported(daemon)).toEqual(['[job 1 "Sum" done] 4']);
  expect((await jobs(daemon))["1"]).toMatchObject({ status: "done", result: "4", seq: 1 });
  expect(await nudges(daemon)).toBe(1);
  await daemon.close();
});

test("a nudged run can ask with job_ask", async () => {
  const { daemon, faux } = await bootWith();
  script(faux, (_role, text) => {
    if (text === "start clone") return call("job_start", { title: "Clone", brief: "Clone it" });
    if (text === NUDGE) return call("job_ask", { question: "Which repo?" });
  });
  await ask(daemon, "start clone");
  await waitFor(() => idle(daemon));
  expect(await reported(daemon)).toEqual(['[job 1 "Clone" needs_input] Which repo?']);
  expect((await jobs(daemon))["1"]!.status).toBe("needs_input");
  expect(await nudges(daemon)).toBe(1);
  await daemon.close();
});

test("a nudged run that ends with text reports it done", async () => {
  const { daemon, faux } = await bootWith();
  script(faux, (_role, text) => {
    if (text === "start t") return call("job_start", { title: "T", brief: "Do it" });
    if (text === "Do it") return say("partial");
    if (text === NUDGE) return say("Here is the answer");
  });
  await ask(daemon, "start t");
  await waitFor(() => idle(daemon));
  expect(await reported(daemon)).toEqual(['[job 1 "T" done] Here is the answer']);
  expect((await jobs(daemon))["1"]!.status).toBe("done");
  expect(await nudges(daemon)).toBe(1);
  await daemon.close();
});

test("an empty run is nudged; an empty nudged run fails", async () => {
  const { daemon, faux } = await bootWith();
  script(faux, (_role, text) => {
    if (text === "start t") return call("job_start", { title: "T", brief: "Do it" });
    if (text === "Do it") return fauxAssistantMessage([]);
    if (text === NUDGE) return say("  \n");
  });
  await ask(daemon, "start t");
  await waitFor(() => idle(daemon));
  expect(await reported(daemon)).toEqual(['[job 1 "T" failed] the worker ended its turn without a reply']);
  expect((await jobs(daemon))["1"]!.status).toBe("failed");
  expect(await nudges(daemon)).toBe(1);
  await daemon.close();
});

test("a finished job that answers a follow-up with text is nudged, not asked", async () => {
  const { daemon, faux } = await bootWith();
  script(faux, (role, text) => {
    if (text === "start t") return call("job_start", { title: "T", brief: "Do it" });
    if (text === "Do it") return call("job_complete", { summary: "first" });
    if (text === "follow") return call("job_message", { id: "1", text: "anything else?", mode: "followup" });
    if (role === "user" && text === "anything else?") return say("No user input is needed");
    if (text === NUDGE) return say("Nothing else");
  });
  await ask(daemon, "start t");
  await waitFor(() => idle(daemon));
  await ask(daemon, "follow");
  await waitFor(() => idle(daemon));
  expect(await reported(daemon)).toEqual(['[job 1 "T" done] first', '[job 1 "T" done] Nothing else']);
  expect((await jobs(daemon))["1"]).toMatchObject({ status: "done", seq: 2 });
  await daemon.close();
});

test("a message queued behind the nudge is decided on its own", async () => {
  const { daemon, faux } = await bootWith();
  const hold = held();
  script(faux, (role, text, signal) => {
    if (text === "start t") return call("job_start", { title: "T", brief: "Do it" });
    if (text === "Do it") return say("partial");
    if (text === NUDGE) return hold.wait(call("job_complete", { summary: "one" }), signal);
    if (text === "follow") return call("job_message", { id: "1", text: "more", mode: "followup" });
    if (role === "user" && text === "more") return call("job_complete", { summary: "two" });
  });
  await ask(daemon, "start t");
  await waitFor(hold.started);
  await ask(daemon, "follow");
  const job = (await jobs(daemon))["1"]!.conversationId;
  const queued = async () =>
    (await daemon.harness.inspect(ctx)).submissions.some((s) => s.conversationId === job && s.status === "queued");
  await waitFor(queued);
  hold.release();
  await waitFor(() => idle(daemon));
  expect(await reported(daemon)).toEqual(['[job 1 "T" done] one', '[job 1 "T" done] two']);
  expect(await nudges(daemon)).toBe(1);
  await daemon.close();
});

test("a steer queued during a run's last answer is decided on its own, without a nudge", async () => {
  const { daemon, faux } = await bootWith();
  const hold = held();
  script(faux, (role, text, signal) => {
    if (text === "start t") return call("job_start", { title: "T", brief: "Do it" });
    if (text === "Do it") return hold.wait(say("one"), signal);
    if (text === "steer") return call("job_message", { id: "1", text: "more", mode: "steer" });
    if (role === "user" && text === "more") return call("job_complete", { summary: "two" });
    if (text === NUDGE) return say("I already finished");
  });
  await ask(daemon, "start t");
  await waitFor(hold.started);
  await ask(daemon, "steer");
  await waitFor(() => queued(daemon));
  hold.release();
  await waitFor(() => idle(daemon));
  expect(await reported(daemon)).toEqual(['[job 1 "T" done] two']);
  expect(await nudges(daemon)).toBe(0);
  await daemon.close();
});

test("a follow-up queued during a run's last answer can ask; the job waits for the answer", async () => {
  const { daemon, faux } = await bootWith();
  const hold = held();
  script(faux, (role, text, signal) => {
    if (text === "start t") return call("job_start", { title: "T", brief: "Do it" });
    if (text === "Do it") return hold.wait(say("one"), signal);
    if (text === "follow") return call("job_message", { id: "1", text: "more", mode: "followup" });
    if (role === "user" && text === "more") return call("job_ask", { question: "Which?" });
    if (text === NUDGE) return say("Waiting for your answer");
  });
  await ask(daemon, "start t");
  await waitFor(hold.started);
  await ask(daemon, "follow");
  await waitFor(() => queued(daemon));
  hold.release();
  await waitFor(() => idle(daemon));
  expect(await reported(daemon)).toEqual(['[job 1 "T" needs_input] Which?']);
  expect((await jobs(daemon))["1"]!.status).toBe("needs_input");
  expect(await nudges(daemon)).toBe(0);
  await daemon.close();
});

test("a finished job nudged after a queued follow-up is running during the nudge", async () => {
  const { daemon, faux } = await bootWith();
  const first = held();
  const nudge = held();
  script(faux, (role, text, signal) => {
    if (text === "start t") return call("job_start", { title: "T", brief: "Do it" });
    if (text === "Do it") return first.wait(call("job_complete", { summary: "one" }), signal);
    if (text === "follow") return call("job_message", { id: "1", text: "more", mode: "followup" });
    if (role === "user" && text === "more") return say("partial");
    if (text === NUDGE) return nudge.wait(call("job_complete", { summary: "two" }), signal);
  });
  await ask(daemon, "start t");
  await waitFor(first.started);
  await ask(daemon, "follow");
  await waitFor(() => queued(daemon));
  first.release();
  await waitFor(nudge.started);
  expect((await jobs(daemon))["1"]!.status).toBe("running");
  nudge.release();
  await waitFor(() => idle(daemon));
  expect(await reported(daemon)).toEqual(['[job 1 "T" done] one', '[job 1 "T" done] two']);
  expect(await nudges(daemon)).toBe(1);
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

test("job_complete and job_ask in one message: the first ends the turn", async () => {
  const { daemon, faux } = await bootWith();
  script(faux, (_role, text) => {
    if (text === "start both") return call("job_start", { title: "Both", brief: "Do both" });
    if (text === "Do both") {
      const calls = [fauxToolCall("job_complete", { summary: "x" }), fauxToolCall("job_ask", { question: "y" })];
      return fauxAssistantMessage(calls, { stopReason: "toolUse" });
    }
  });
  await ask(daemon, "start both");
  await waitFor(() => idle(daemon));
  expect(await reported(daemon)).toEqual(['[job 1 "Both" done] x']);
  expect((await jobs(daemon))["1"]).toMatchObject({ status: "done", result: "x" });
  const job = (await daemon.harness.conversation((await jobs(daemon))["1"]!.conversationId, ctx))!;
  expect(await texts(job, "toolResult")).toEqual(["Done.", "This turn already ended with job_complete."]);
  await daemon.close();
});

test("job_ask and job_complete in one message: the ask ends the turn", async () => {
  const { daemon, faux } = await bootWith();
  script(faux, (_role, text) => {
    if (text === "start both") return call("job_start", { title: "Both", brief: "Do both" });
    if (text === "Do both") {
      const calls = [fauxToolCall("job_ask", { question: "y" }), fauxToolCall("job_complete", { summary: "x" })];
      return fauxAssistantMessage(calls, { stopReason: "toolUse" });
    }
  });
  await ask(daemon, "start both");
  await waitFor(() => idle(daemon));
  expect(await reported(daemon)).toEqual(['[job 1 "Both" needs_input] y']);
  expect((await jobs(daemon))["1"]).toMatchObject({ status: "needs_input", result: "y" });
  const job = (await daemon.harness.conversation((await jobs(daemon))["1"]!.conversationId, ctx))!;
  expect(await texts(job, "toolResult")).toEqual(["Asked.", "This turn already ended with job_ask."]);
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
    if (role === "user" && text === "more") return call("job_ask", { question: "Which part?" });
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

test("a restart during the nudge nudges once and reports once", async () => {
  const kit = testKit();
  const home = tempHome({ models: { cos: kit.model } }); // default storage: sqlite
  const hold = held();
  script(kit.faux, (_role, text, signal) => {
    if (text === "start long") return call("job_start", { title: "Long", brief: "Take long" });
    if (text === "Take long") return say("partial");
    if (text === NUDGE)
      return hold.started() ? call("job_complete", { summary: "finished" }) : hold.wait(say("lost"), signal);
  });
  let daemon = await boot({ home, extensions: [kit.extension] });
  await ask(daemon, "start long");
  await waitFor(hold.started);
  await daemon.close();

  daemon = await boot({ home, extensions: [kit.extension] });
  await waitFor(() => idle(daemon));
  expect(await reported(daemon)).toEqual(['[job 1 "Long" done] finished']);
  expect(await nudges(daemon)).toBe(1);
  await daemon.close();
});

test("the CoS and jobs are offered their own tools", async () => {
  const { daemon, faux } = await bootWith({ shell: profile("shell", ["tools: [read, bash]", "extensions: []"]) });
  const names = async (c: Conversation) => (await c.agent(ctx)).tools.map((t) => t.name);
  const root = await names(daemon.root);
  expect(root).toEqual(expect.arrayContaining(["read", "job_start", "probe_write"]));
  for (const name of ["write", "edit", "bash", "job_progress", "job_complete", "job_ask"]) {
    expect(root).not.toContain(name);
  }

  script(faux, (_role, text) => {
    if (text === "start shell") return call("job_start", { title: "Shell", brief: "Look around", worker: "shell" });
  });
  await ask(daemon, "start shell");
  const job = (await daemon.harness.conversation((await jobs(daemon))["1"]!.conversationId, ctx))!;
  const tools = await names(job);
  expect(tools).toEqual(expect.arrayContaining(["read", "bash", "job_progress", "job_complete", "job_ask"]));
  for (const name of ["write", "job_start", "probe_write"]) expect(tools).not.toContain(name);
  await daemon.close();
});

test("the CoS's environment is the local one, read-only", async () => {
  created.length = 0;
  const { daemon, faux } = await bootWith();
  script(faux, (_role, text) => {
    if (text === "probe root") return call("probe_write", { path: join(dir, "root.txt") });
  });
  await ask(daemon, "probe root");
  expect(await texts(daemon.root, "toolResult")).toEqual([READ_ONLY_MESSAGE]);
  expect(existsSync(join(dir, "root.txt"))).toBe(false);
  expect(created).not.toEqual([]);
  expect(created.filter((c) => c.env !== "local" || c.conversationId !== String(ROOT_CONVERSATION_ID))).toEqual([]);
  await daemon.close();
});

test("job_start refuses without a sandbox", async () => {
  process.env.JAPA_BWRAP = "/nonexistent";
  onTestFinished(() => void delete process.env.JAPA_BWRAP);
  const { daemon, faux } = await bootTest();
  const reply = await tool(daemon, faux, "job_start", { title: "T", brief: "b" });
  expect(reply).toMatch(/^Jobs can't run: \S.*\. Install bubblewrap: sudo apt install bubblewrap$/);
  expect(await jobs(daemon)).toEqual({});
  expect(daemon.status().errors).toContainEqual({ name: "sandbox", error: reply });
  await daemon.close();
});

describe.skipIf(NO_BWRAP)("a job's sandbox", () => {
  test("a job's bash runs in its clone", async () => {
    const { daemon, faux, home } = await bootSandboxed();
    const command = `ls "${home}/secrets"; cat "${home}/marker"; echo made > "${home}/made"`;
    script(faux, (role, text) => {
      if (text === "start") return call("job_start", { title: "Look", brief: "look", worker: "coder" });
      if (text === "look") return call("bash", { command });
      if (role === "toolResult" && text.includes("marker")) return call("job_complete", { summary: "seen" });
    });
    await ask(daemon, "start");
    await waitFor(() => idle(daemon));
    const [result] = await jobResults(daemon);
    expect(result).toContain("the real marker");
    expect(result).not.toContain("api-key");
    expect(readFileSync(join(home, ".jobs", "1", "made"), "utf8")).toBe("made\n");
    expect(existsSync(join(home, "made"))).toBe(false);
    expect(await reported(daemon)).toEqual(['[job 1 "Look" done] seen']);
    await daemon.close();
  });

  test("a job's file tools work on its clone, not through an environment adapter", async () => {
    created.length = 0;
    const { daemon, faux, home } = await bootSandboxed();
    script(faux, (_role, text) => {
      if (text === "start") return call("job_start", { title: "Probe", brief: "probe" });
      if (text === "probe") return call("probe_write", { path: join(home, "job.txt") });
      if (text === "written") return call("job_complete", { summary: "probed" });
    });
    await ask(daemon, "start");
    await waitFor(() => idle(daemon));
    expect(await jobResults(daemon)).toEqual(["written", "Done."]);
    expect(readFileSync(join(home, ".jobs", "1", "job.txt"), "utf8")).toBe("x");
    expect(existsSync(join(home, "job.txt"))).toBe(false);
    const job = String((await jobs(daemon))["1"]!.conversationId);
    expect(created.filter((c) => c.conversationId === job)).toEqual([]);
    await daemon.close();
  });

  test("a dead sandbox fails one call, then restarts", async () => {
    const { daemon, faux } = await bootSandboxed();
    script(faux, (role, text) => {
      if (text === "start") return call("job_start", { title: "Die", brief: "die", worker: "coder" });
      // The env server, bwrap's only child: with it, the whole sandbox ends.
      if (text === "die") return call("bash", { command: "kill -9 $PPID" });
      if (role === "toolResult" && text.includes("sandbox stopped")) return call("bash", { command: "echo ok" });
      if (role === "toolResult" && text.trim() === "ok") return call("job_complete", { summary: "alive" });
    });
    await ask(daemon, "start");
    await waitFor(() => idle(daemon));
    const results = await jobResults(daemon);
    expect(results).toHaveLength(3);
    expect(results[0]).toContain("The job's sandbox stopped");
    expect(results.slice(1).map((r) => r.trim())).toEqual(["ok", "Done."]);
    await daemon.close();
  });

  test("the daemon's own PATH holds only its Node and the system dirs; a job's is the original", async () => {
    const original = process.env.PATH;
    const { daemon, faux } = await bootSandboxed();
    const system = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
    expect(process.env.PATH).toBe(`${dirname(process.execPath)}:${system}`);
    script(faux, (role, text) => {
      if (text === "start") return call("job_start", { title: "Path", brief: "path", worker: "coder" });
      if (text === "path") return call("bash", { command: 'echo "$PATH"' });
      if (role === "toolResult" && text.trim() === original) return call("job_complete", { summary: "same" });
    });
    await ask(daemon, "start");
    await waitFor(() => idle(daemon));
    expect((await jobResults(daemon))[0]!.trim()).toBe(original);
    await daemon.close();

    // A second boot in this process still gives jobs the original.
    const again = await bootSandboxed();
    script(again.faux, (_role, text) => {
      if (text === "start") return call("job_start", { title: "Path", brief: "path", worker: "coder" });
      if (text === "path") return call("bash", { command: 'echo "$PATH"' });
    });
    await ask(again.daemon, "start");
    await waitFor(() => idle(again.daemon));
    expect((await jobResults(again.daemon))[0]!.trim()).toBe(original);
    await again.daemon.close();
  });
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
  expect(await texts(daemon.root, "toolResult")).toEqual(['Unknown worker "bad-tool". Workers: builder, coder, general, operator, researcher.']);
  expect(await jobs(daemon)).toEqual({});
  await daemon.close();
});
