import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { type FauxProviderHandle, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { configure, type Conversation, ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { describe, expect, onTestFinished, test } from "vitest";
import { boot, type Daemon } from "../src/kernel/boot.ts";
import { READ_ONLY_MESSAGE } from "../src/kernel/env.ts";
import { modelRefusal } from "../src/kernel/jobs/cos.ts";
import { NUDGE } from "../src/kernel/jobs/run.ts";
import { JobDoc, JobsDoc } from "../src/kernel/jobs/state.ts";
import { defineJapaExtension, defineTool, type EnvironmentAdapter, Type } from "../src/sdk.ts";
import { bootErrors, bootTest, NO_BWRAP, sandboxScratch, tempHome, testKit, waitFor } from "./helpers.ts";
import {
  ask,
  call,
  held,
  idle,
  jobs,
  nudges,
  queued,
  reported,
  say,
  script,
  system,
  texts,
  tool,
} from "./jobs-helpers.ts";

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

/** Boots with the probe extension and `settings` over in-memory storage and the kit's CoS model. */
async function bootWith(
  settings: object = {},
  kit = testKit(),
): Promise<{ daemon: Daemon; faux: FauxProviderHandle; home: string }> {
  const home = tempHome({ storage: { adapter: "memory" }, models: { cos: kit.model }, ...settings });
  const daemon = await boot({ home, extensions: [kit.extension, probe] });
  return { daemon, faux: kit.faux, home };
}

const HOME = process.env.HOME;

/**
 * Boots with the probe extension, the japa home and the user's home (`HOME`, until the test finishes) outside `/tmp`,
 * which jobs see replaced by their own; the home has `marker` and a secret `secrets/api-key`, or with `o.vault`,
 * `secrets` is a symlink to `<outside>/vault`, which has it. `o.storage(outside)` is the storage setting, and
 * `o.secrets(outside)` the secrets one.
 */
async function bootSandboxed(
  o: { vault?: boolean; storage?: (outside: string) => object; secrets?: (outside: string) => object } = {},
): Promise<{
  daemon: Daemon;
  faux: FauxProviderHandle;
  home: string;
  user: string;
  outside: string;
  kit: ReturnType<typeof testKit>;
}> {
  const outside = sandboxScratch("japa-jobs-");
  const [home, user] = [join(outside, "home"), join(outside, "user")];
  const secrets = o.vault ? join(outside, "vault") : join(home, "secrets");
  mkdirSync(secrets, { recursive: true });
  mkdirSync(home, { recursive: true });
  if (o.vault) symlinkSync(secrets, join(home, "secrets"));
  mkdirSync(user);
  writeFileSync(join(secrets, "api-key"), "sk-1");
  writeFileSync(join(home, "marker"), "the real marker");
  const kit = testKit();
  const storage = o.storage?.(outside) ?? { adapter: "memory" };
  const setting = o.secrets === undefined ? {} : { secrets: o.secrets(outside) };
  writeFileSync(join(home, "settings.json"), JSON.stringify({ storage, models: { cos: kit.model }, ...setting }));
  process.env.HOME = user;
  onTestFinished(() => {
    process.env.HOME = HOME;
    rmSync(outside, { recursive: true, force: true });
  });
  const daemon = await boot({ home, extensions: [kit.extension, probe] });
  return { daemon, faux: kit.faux, home, user, outside, kit };
}

/** Has job 1 (a coder) run `command` in bash; its result. */
async function jobBash(daemon: Daemon, faux: FauxProviderHandle, command: string): Promise<string> {
  script(faux, (role, text) => {
    if (text === "start") return call("job_start", { title: "Bash", brief: "bash" });
    if (text === "bash") return call("bash", { command });
    if (role === "toolResult" && text.includes("end")) return call("job_complete", { summary: "ran" });
  });
  await ask(daemon, "start");
  await waitFor(() => idle(daemon));
  return (await jobResults(daemon))[0]!;
}

/** The tool results of job 1's conversation. */
async function jobResults(daemon: Daemon): Promise<string[]> {
  const job = (await daemon.harness.conversation((await jobs(daemon))["1"]!.conversationId, ctx))!;
  return texts(job, "toolResult");
}

test.skipIf(NO_BWRAP)("a job runs and reports once", async () => {
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

test.skipIf(NO_BWRAP)("a job asks with job_ask and resumes on a follow-up", async () => {
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

test.skipIf(NO_BWRAP)("a run that ends without job_complete or job_ask is nudged, then completes", async () => {
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

test.skipIf(NO_BWRAP)("a nudged run can ask with job_ask", async () => {
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

test.skipIf(NO_BWRAP)("a nudged run that ends with text reports it done", async () => {
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

test.skipIf(NO_BWRAP)("an empty run is nudged; an empty nudged run fails", async () => {
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

test.skipIf(NO_BWRAP)("a finished job that answers a follow-up with text is nudged, not asked", async () => {
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

test.skipIf(NO_BWRAP)("a message queued behind the nudge is decided on its own", async () => {
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

test.skipIf(NO_BWRAP)("a steer queued during a run's last answer is decided on its own, without a nudge", async () => {
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

test.skipIf(NO_BWRAP)("a follow-up queued during a run's last answer can ask; the job waits for the answer", async () => {
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

test.skipIf(NO_BWRAP)("a finished job nudged after a queued follow-up is running during the nudge", async () => {
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

test.skipIf(NO_BWRAP)("job_progress and job_complete in one message report done once", async () => {
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

test.skipIf(NO_BWRAP)("job_complete and job_ask in one message: the first ends the turn", async () => {
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

test.skipIf(NO_BWRAP)("job_ask and job_complete in one message: the ask ends the turn", async () => {
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

test.skipIf(NO_BWRAP)("a job whose model fails reports once", async () => {
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

test.skipIf(NO_BWRAP)("a steer during a run ends in one answer and one report", async () => {
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

test.skipIf(NO_BWRAP)("a follow-up queued before job_complete reports its own answer", async () => {
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

test.skipIf(NO_BWRAP)("a report withdrawn by Esc still reaches the CoS once", async () => {
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

test.skipIf(NO_BWRAP)("a job interrupted by a restart finishes and reports once", async () => {
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

test.skipIf(NO_BWRAP)("a restart during the nudge nudges once and reports once", async () => {
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

const names = async (c: Conversation) => (await c.agent(ctx)).tools.map((t) => t.name);

/** Job 1's conversation. */
const jobConversation = async (daemon: Daemon) =>
  (await daemon.harness.conversation((await jobs(daemon))["1"]!.conversationId, ctx))!;

test.skipIf(NO_BWRAP)("every job has all four coding tools and every available extension", async () => {
  const { daemon, faux } = await bootWith();
  const root = await names(daemon.root);
  expect(root).toEqual(expect.arrayContaining(["read", "job_start", "probe_write"]));
  for (const name of ["write", "edit", "bash", "job_progress", "job_complete", "job_ask"]) {
    expect(root).not.toContain(name);
  }

  script(faux, (_role, text) => {
    if (text === "start shell") return call("job_start", { title: "Shell", brief: "Look around" });
    if (text === "Look around") return call("job_complete", { summary: "looked" });
  });
  await ask(daemon, "start shell");
  const tools = await names(await jobConversation(daemon));
  expect(tools).toEqual(
    expect.arrayContaining(["read", "write", "edit", "bash", "job_progress", "job_complete", "job_ask", "skill_read", "probe_write"]),
  );
  expect(tools).not.toContain("job_start");
  await waitFor(() => idle(daemon));
  await daemon.close();
});

test.skipIf(NO_BWRAP)("job_start without model or thinking uses the settings", async () => {
  const kit = testKit({ models: [{ id: "a" }, { id: "x" }] });
  const worker = { provider: kit.model.provider, modelId: "x" };
  const { daemon, faux } = await bootWith({ models: { cos: kit.model, worker } }, kit);
  script(faux, (_role, text) => {
    if (text === "start") return call("job_start", { title: "T", brief: "Do it" });
    if (text === "Do it") return call("job_complete", { summary: "done" });
  });
  await ask(daemon, "start");
  const agent = await (await jobConversation(daemon)).agent(ctx);
  expect(agent.model).toEqual(worker);
  expect(agent.thinkingLevel).toBe("medium");
  expect(agent.cwd).toBeUndefined();
  expect((await jobs(daemon))["1"]).toMatchObject({ model: `${kit.model.provider}/x`, thinking: "medium" });
  await waitFor(() => idle(daemon));
  await daemon.close();
});

test.skipIf(NO_BWRAP)("job_start with model and thinking stores and uses them", async () => {
  const kit = testKit({ models: [{ id: "a" }, { id: "x" }] });
  const { daemon, faux } = await bootWith({ jobs: { thinking: "low" } }, kit);
  const model = `${kit.model.provider}/x`;
  script(faux, (_role, text) => {
    if (text === "start") return call("job_start", { title: "T", brief: "Do it", model, thinking: "high" });
    if (text === "Do it") return call("job_complete", { summary: "done" });
  });
  await ask(daemon, "start");
  const agent = await (await jobConversation(daemon)).agent(ctx);
  expect(agent.model).toEqual({ provider: kit.model.provider, modelId: "x" });
  expect(agent.thinkingLevel).toBe("high");
  expect((await jobs(daemon))["1"]).toMatchObject({ model, thinking: "high" });
  await waitFor(() => idle(daemon));
  await daemon.close();
});

test.skipIf(NO_BWRAP)("an unknown model is refused with the list", async () => {
  const kit = testKit({ models: [{ id: "a" }, { id: "x" }] });
  const { daemon, faux } = await bootWith({}, kit);
  const list = `Models: ${kit.model.provider}/a, ${kit.model.provider}/x.`;
  for (const model of ["nope/none", `${kit.model.provider}/none`, "no-slash"]) {
    expect(await tool(daemon, faux, "job_start", { title: "T", brief: "b", model })).toBe(
      `Unknown model "${model}". ${list}`,
    );
  }
  expect(await jobs(daemon)).toEqual({});
  await daemon.close();
});

test.skipIf(NO_BWRAP)("a known model whose provider has no credentials is refused as such, with the list", async () => {
  const kit = testKit({ models: [{ id: "a" }] });
  const locked = fauxProvider({ provider: "locked", models: [{ id: "m" }] }).provider;
  // As a provider whose key isn't set: known, but not usable.
  const provider = Object.assign(Object.create(Object.getPrototypeOf(locked)), locked, {
    auth: { apiKey: { name: "Locked", resolve: async () => undefined } },
  });
  const extension = { name: "locked", summary: "A provider without credentials", provides: { provider: [provider] } };
  const home = tempHome({ storage: { adapter: "memory" }, models: { cos: kit.model } });
  const daemon = await boot({ home, extensions: [kit.extension, probe, extension] });
  expect(await tool(daemon, kit.faux, "job_start", { title: "T", brief: "b", model: "locked/m" })).toBe(
    `Model "locked/m" has no credentials. Models: ${kit.model.provider}/a.`,
  );
  expect(await jobs(daemon)).toEqual({});
  await daemon.close();
});

test("the model refusal says when no model is usable", () => {
  expect(modelRefusal("p/x", false, [])).toBe('Unknown model "p/x". No models are usable.');
  expect(modelRefusal("p/x", true, [])).toBe('Model "p/x" has no credentials. No models are usable.');
  expect(modelRefusal("p/x", false, ["p/a", "p/b"])).toBe('Unknown model "p/x". Models: p/a, p/b.');
});

test.skipIf(NO_BWRAP)("a stored job with worker and environment still loads", async () => {
  const kit = testKit();
  const home = tempHome({ models: { cos: kit.model } }); // default storage: sqlite
  const hold = held();
  script(kit.faux, (_role, text, signal) => {
    if (text === "start") return call("job_start", { title: "Old", brief: "Take long" });
    if (text === "Take long") return hold.wait(say("lost"), signal);
  });
  let daemon = await boot({ home, extensions: [kit.extension, probe] });
  await ask(daemon, "start");
  await waitFor(hold.started);
  // As a job started by a worker profile left them.
  const { conversationId } = (await jobs(daemon))["1"]!;
  await daemon.harness.commit(async (tx) => {
    const job = (await tx.doc(JobsDoc, ROOT_CONVERSATION_ID)).jobs["1"]!;
    delete job.model;
    delete job.thinking;
    Object.assign(job, { worker: "coder", environment: "local" });
    Object.assign(await tx.doc(JobDoc, conversationId), { skills: ["nope"], environment: "local" });
    const write = CodingTools.tools!.filter((t) => t.name !== "read");
    await configure(tx, conversationId, { tools: { remove: write }, cwd: "/nowhere", instructions: "Old." });
  }, ctx);
  await daemon.close();

  script(kit.faux, (_role, text) => {
    if (text === "Take long") return call("job_complete", { summary: "finished" });
  });
  daemon = await boot({ home, extensions: [kit.extension, probe] });
  const agent = await (await jobConversation(daemon)).agent(ctx);
  expect(agent.tools.map((t) => t.name)).toEqual(expect.arrayContaining(["read", "write", "edit", "bash", "probe_write"]));
  expect(agent.cwd).toBeUndefined();
  expect(agent.instructions).toBeUndefined();
  expect(agent.model).toEqual(kit.model);
  expect(agent.thinkingLevel).toBe("medium");
  await waitFor(() => idle(daemon));
  expect(await reported(daemon)).toEqual(['[job 1 "Old" done] finished']);
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
  const saved = process.env.JAPA_BWRAP;
  process.env.JAPA_BWRAP = "/nonexistent";
  onTestFinished(() => {
    if (saved === undefined) delete process.env.JAPA_BWRAP;
    else process.env.JAPA_BWRAP = saved;
  });
  const { daemon, faux } = await bootTest();
  const reply = await tool(daemon, faux, "job_start", { title: "T", brief: "b" });
  expect(reply).toMatch(/^Jobs can't run: \S.*\. Install bubblewrap: sudo apt install bubblewrap$/);
  expect(await jobs(daemon)).toEqual({});
  expect(daemon.status().errors).toContainEqual({ name: "sandbox", error: reply });
  await daemon.close();
});

test("the CoS can't read a secrets dir that is a symlink out of the home through its real path", async () => {
  const { daemon, faux, home, outside } = await bootSandboxed({ vault: true });
  for (const path of [join(home, "secrets", "api-key"), join(outside, "vault", "api-key")]) {
    const reply = await tool(daemon, faux, "read", { path });
    expect(reply).toContain("Secrets are not readable here.");
    expect(reply).not.toContain("sk-1");
  }
  await daemon.close();
});

// Masked, it would cover the job's clone.
test("a secrets dir that holds the japa home is reported: jobs can read it", async () => {
  const { daemon, outside } = await bootSandboxed({ secrets: (outside) => ({ dir: outside }) });
  expect(daemon.status().errors).toContainEqual({
    name: "sandbox",
    error: `Jobs can read ${outside}: it is or holds the japa home, so their sandboxes can't hide it`,
  });
  await daemon.close();
});

describe.skipIf(NO_BWRAP)("a job's sandbox", () => {
  test("a job still runs in its clone with a secrets dir that holds the japa home", async () => {
    const { daemon, faux, home } = await bootSandboxed({ secrets: (outside) => ({ dir: outside }) });
    const result = await jobBash(daemon, faux, `cat "${home}/marker"; echo; echo end`);
    expect(result.trim()).toBe("the real marker\nend");
    await daemon.close();
  });

  test("a job's bash runs in its clone", async () => {
    const { daemon, faux, home } = await bootSandboxed();
    const command = `ls "${home}/secrets"; cat "${home}/marker"; echo made > "${home}/made"`;
    // Held until the clone is looked at: completing deletes a clone with nothing to publish.
    const hold = held();
    script(faux, (role, text, signal) => {
      if (text === "start") return call("job_start", { title: "Look", brief: "look" });
      if (text === "look") return call("bash", { command });
      if (role === "toolResult" && text.includes("marker")) return hold.wait(call("job_complete", { summary: "seen" }), signal);
    });
    await ask(daemon, "start");
    await waitFor(hold.started);
    expect(readFileSync(join(home, ".jobs", "1", "made"), "utf8")).toBe("made\n");
    expect(existsSync(join(home, "made"))).toBe(false);
    hold.release();
    await waitFor(() => idle(daemon));
    const [result] = await jobResults(daemon);
    expect(result).toContain("the real marker");
    expect(result).not.toContain("api-key");
    expect(await reported(daemon)).toEqual(['[job 1 "Look" done] seen']);
    await daemon.close();
  });

  test("a job's file tools work on its clone, not through an environment adapter", async () => {
    created.length = 0;
    const { daemon, faux, home } = await bootSandboxed();
    const hold = held();
    script(faux, (_role, text, signal) => {
      if (text === "start") return call("job_start", { title: "Probe", brief: "probe" });
      if (text === "probe") return call("probe_write", { path: join(home, "job.txt") });
      if (text === "written") return hold.wait(call("job_complete", { summary: "probed" }), signal);
    });
    await ask(daemon, "start");
    await waitFor(hold.started);
    expect(readFileSync(join(home, ".jobs", "1", "job.txt"), "utf8")).toBe("x");
    expect(existsSync(join(home, "job.txt"))).toBe(false);
    hold.release();
    await waitFor(() => idle(daemon));
    expect(await jobResults(daemon)).toEqual(["written", "Done."]);
    const job = String((await jobs(daemon))["1"]!.conversationId);
    expect(created.filter((c) => c.conversationId === job)).toEqual([]);
    await daemon.close();
  });

  test("the daemon's environment isn't readable from a job's sandbox", async () => {
    const value = `japa-env-${process.pid}-${Date.now()}`;
    process.env.JAPA_TEST_LEAK = value;
    onTestFinished(() => void delete process.env.JAPA_TEST_LEAK);
    const { daemon, faux } = await bootSandboxed();
    const command = "tr '\\0' '\\n' </proc/1/environ; cat /proc/*/environ 2>/dev/null; echo end";
    script(faux, (role, text) => {
      if (text === "start") return call("job_start", { title: "Env", brief: "env" });
      if (text === "env") return call("bash", { command });
      if (role === "toolResult" && text.includes("end")) return call("job_complete", { summary: "seen" });
    });
    await ask(daemon, "start");
    await waitFor(() => idle(daemon));
    const [result] = await jobResults(daemon);
    expect(result).toMatch(/end\s*$/);
    expect(result).not.toContain(value);
    await daemon.close();
  });

  test("a secrets dir that is a symlink in the home to a dir outside it is hidden", async () => {
    const { daemon, faux, home, outside } = await bootSandboxed({ vault: true });
    const vault = join(outside, "vault");
    const result = await jobBash(daemon, faux, `cat "${home}/secrets/api-key" "${vault}/api-key"; ls -A "${vault}"; echo end`);
    expect(result).toMatch(/end\s*$/);
    expect(result).not.toContain("sk-1");
    expect(result).not.toMatch(/^api-key$/m);
    await daemon.close();
  });

  test("a storage database outside the home reads empty, its -wal and -shm too", async () => {
    const storage = (outside: string) => ({ adapter: "sqlite", file: join(outside, "db", "state.db") });
    const { daemon, faux, outside } = await bootSandboxed({
      storage: (outside) => {
        mkdirSync(join(outside, "db"));
        return storage(outside);
      },
    });
    const db = storage(outside).file;
    const files = [db, `${db}-wal`, `${db}-shm`];
    const sizes = files.map((file) => `test -e "${file}" && echo "$(basename "${file}") $(wc -c < "${file}")"`);
    const result = await jobBash(daemon, faux, `${sizes.join("; ")}; echo end`);
    const host = files.filter((file) => existsSync(file));
    expect(host.length).toBeGreaterThan(1);
    expect(result.trim()).toBe([...host.map((file) => `${basename(file)} 0`), "end"].join("\n"));
    expect(readFileSync(db).length).toBeGreaterThan(0);
    await daemon.close();
  });

  test("a dead sandbox fails one call, then restarts", async () => {
    const { daemon, faux } = await bootSandboxed();
    script(faux, (role, text) => {
      if (text === "start") return call("job_start", { title: "Die", brief: "die" });
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
      if (text === "start") return call("job_start", { title: "Path", brief: "path" });
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
      if (text === "start") return call("job_start", { title: "Path", brief: "path" });
      if (text === "path") return call("bash", { command: 'echo "$PATH"' });
    });
    await ask(again.daemon, "start");
    await waitFor(() => idle(again.daemon));
    expect((await jobResults(again.daemon))[0]!.trim()).toBe(original);
    await again.daemon.close();
  });
});

const HELLO = "---\nname: hello\ndescription: Says hello\n---\nSay hello.\n";

/** A bash command that writes `<home>/skills/hello/SKILL.md`, then prints `written`. */
const writeHello = (home: string) =>
  `mkdir -p "${home}/skills/hello" && cat > "${home}/skills/hello/SKILL.md" <<'EOF'\n${HELLO}EOF\necho written`;

/** A bash command that leaves a process in the job's sandbox writing the time to `file` every 50 ms. */
const heartbeat = (file: string) =>
  `setsid sh -c 'while :; do date +%s%N > "${file}"; sleep 0.05; done' </dev/null >/dev/null 2>&1 & echo beating`;

/** Whether `file` stays the same for 500 ms: whatever wrote it has stopped. */
async function still(file: string): Promise<boolean> {
  const before = readFileSync(file, "utf8");
  await new Promise((resolve) => setTimeout(resolve, 500));
  return readFileSync(file, "utf8") === before;
}

describe.skipIf(NO_BWRAP)("going live", { timeout: 60_000 }, () => {
  test("a job's skill goes live when it completes", async () => {
    const { daemon, faux, home } = await bootSandboxed();
    script(faux, (role, text) => {
      if (text === "start") return call("job_start", { title: "Hello", brief: "hello" });
      if (text === "hello") return call("bash", { command: writeHello(home) });
      if (role === "toolResult" && text.trim() === "written") return call("job_complete", { summary: "wrote it" });
    });
    await ask(daemon, "start");
    await waitFor(() => idle(daemon), 50_000);
    expect(await reported(daemon)).toEqual(['[job 1 "Hello" done] wrote it\n\nLive: skills/hello (change 1).']);
    expect(readFileSync(join(home, "skills", "hello", "SKILL.md"), "utf8")).toBe(HELLO);
    expect(await system(daemon, faux)).toContain("- hello: Says hello\n");
    expect(existsSync(join(home, ".jobs", "1"))).toBe(false);
    await daemon.close();
  });

  test("a job stopped before publish is not merged", async () => {
    const { daemon, faux, home } = await bootSandboxed();
    const hold = held();
    script(faux, (role, text, signal) => {
      if (text === "start") return call("job_start", { title: "Hello", brief: "hello" });
      if (text === "hello") return call("bash", { command: writeHello(home) });
      if (role === "toolResult" && text.trim() === "written") {
        return hold.wait(call("job_complete", { summary: "wrote it" }), signal);
      }
      if (text === "stop") return call("job_stop", { id: "1" });
    });
    await ask(daemon, "start");
    await waitFor(hold.started);
    await ask(daemon, "stop");
    hold.release();
    await waitFor(() => idle(daemon));
    expect((await jobs(daemon))["1"]!.status).toBe("cancelled");
    expect(existsSync(join(home, "skills", "hello"))).toBe(false);
    expect(readFileSync(join(home, ".jobs", "1", "skills", "hello", "SKILL.md"), "utf8")).toBe(HELLO);
    expect(await reported(daemon)).toEqual([]);
    await daemon.close();
  });

  test("a job's processes stop when it completes", async () => {
    const { daemon, faux, user } = await bootSandboxed();
    const beat = join(user, "beat");
    const hold = held();
    script(faux, (role, text, signal) => {
      if (text === "start") return call("job_start", { title: "Beat", brief: "beat" });
      if (text === "beat") return call("bash", { command: heartbeat(beat) });
      if (role === "toolResult" && text.trim() === "beating") {
        return hold.wait(call("job_complete", { summary: "left it running" }), signal);
      }
    });
    await ask(daemon, "start");
    await waitFor(hold.started);
    await waitFor(() => existsSync(beat));
    expect(await still(beat)).toBe(false);
    hold.release();
    await waitFor(() => idle(daemon));
    expect(await still(beat)).toBe(true);
    await daemon.close();
  });

  test("job_stop stops a waiting job's processes", async () => {
    const { daemon, faux, user } = await bootSandboxed();
    const beat = join(user, "beat");
    script(faux, (role, text) => {
      if (text === "start") return call("job_start", { title: "Beat", brief: "beat" });
      if (text === "beat") return call("bash", { command: heartbeat(beat) });
      if (role === "toolResult" && text.trim() === "beating") return call("job_ask", { question: "Stop it?" });
      if (text === "stop") return call("job_stop", { id: "1" });
    });
    await ask(daemon, "start");
    await waitFor(() => idle(daemon));
    expect(await reported(daemon)).toEqual(['[job 1 "Beat" needs_input] Stop it?']);
    // Waiting for an answer, the job keeps its sandbox.
    expect(await still(beat)).toBe(false);
    await ask(daemon, "stop");
    expect((await texts(daemon.root, "toolResult")).at(-1)).toBe("Stopped job 1.");
    expect(await still(beat)).toBe(true);
    await daemon.close();
  });
});

/**
 * Extension `slow`: importing it writes the time to `beat` every 50 ms until `gate` exists, so its `japa check`, which
 * imports it first, waits too.
 */
const SLOW = (beat: string, gate: string) => `import { existsSync, writeFileSync } from "node:fs";
import { defineJapaExtension } from "japa/sdk";

while (!existsSync(${JSON.stringify(gate)})) {
  writeFileSync(${JSON.stringify(beat)}, String(performance.now()));
  await new Promise((resolve) => setTimeout(resolve, 50));
}

export default defineJapaExtension({ name: "slow", summary: "Slow", examples: ["slow"], docs: "Slow." });
`;

/** A bash command that writes extension `slow` (see `SLOW`) to `<home>/extensions/slow`, then prints `written`. */
const writeSlow = (home: string, beat: string, gate: string) =>
  `mkdir -p "${home}/extensions/slow" && cat > "${home}/extensions/slow/index.ts" <<'EOF'\n${SLOW(beat, gate)}EOF\necho written`;

/** Whether `promise` settles within `ms`. */
const settlesWithin = (promise: Promise<unknown>, ms: number) =>
  Promise.race([promise.then(() => true), new Promise<boolean>((resolve) => setTimeout(() => resolve(false), ms))]);

/**
 * Boots sandboxed on sqlite storage, and has job 1 ("Slow") write extension `slow` and complete: its publish then waits
 * in `japa check` until `gate` exists, which the test makes when it finishes, if not before. Returns once the check
 * waits.
 */
async function slowJob() {
  const booted = await bootSandboxed({ storage: () => ({ adapter: "sqlite" }) });
  const { daemon, faux, home, user } = booted;
  const [beat, gate] = [join(user, "beat"), join(user, "gate")];
  onTestFinished(() => {
    if (existsSync(user)) writeFileSync(gate, "");
  });
  script(faux, (role, text) => {
    if (text === "start") return call("job_start", { title: "Slow", brief: "slow" });
    if (text === "slow") return call("bash", { command: writeSlow(home, beat, gate) });
    if (role === "toolResult" && text.trim() === "written") return call("job_complete", { summary: "wrote it" });
  });
  await ask(daemon, "start");
  await waitFor(() => existsSync(beat), 30_000);
  return { ...booted, beat, gate };
}

describe.skipIf(NO_BWRAP)("going live, slowly", { timeout: 120_000 }, () => {
  test("a daemon closing mid-check stops the publish at once; after a restart, it goes live", async () => {
    const { daemon, home, kit, beat, gate } = await slowJob();
    expect(await settlesWithin(daemon.close(), 5000)).toBe(true);
    expect(await still(beat)).toBe(true);
    expect(existsSync(join(home, "extensions", "slow"))).toBe(false);

    const again = await boot({ home, extensions: [kit.extension, probe] });
    await waitFor(async () => !(await still(beat)), 30_000); // checking again
    // Its publishing run is live again: the boot leaves it going live.
    expect((await jobs(again))["1"]!.publishing).toBe(1);
    writeFileSync(gate, "");
    await waitFor(() => idle(again), 90_000);
    expect(await reported(again)).toEqual(['[job 1 "Slow" done] wrote it\n\nLive: extensions/slow (change 1).']);
    expect(again.capabilities()).toContain("- slow: ");
    expect(existsSync(join(home, ".jobs", "1"))).toBe(false);
    await again.close();
  });

  test("a job stopped before its publish runs is not merged; its report says where it's kept", async () => {
    const { daemon, home, kit } = await slowJob();
    // As no tool can: job_stop refuses a done job, and job_message one going live.
    await daemon.harness.commit(async (tx) => {
      (await tx.doc(JobsDoc, ROOT_CONVERSATION_ID)).jobs["1"]!.status = "cancelled";
    }, ctx);
    expect(await settlesWithin(daemon.close(), 5000)).toBe(true);

    const again = await boot({ home, extensions: [kit.extension, probe] });
    await waitFor(() => idle(again), 60_000);
    const clone = join(home, ".jobs", "1");
    expect(await reported(again)).toEqual([
      `[job 1 "Slow" done] wrote it\n\nNot live: the job was stopped. Kept at ${clone}.`,
    ]);
    expect(existsSync(join(clone, "extensions", "slow", "index.ts"))).toBe(true);
    expect(existsSync(join(home, "extensions", "slow"))).toBe(false);
    expect((await jobs(again))["1"]).toMatchObject({ status: "cancelled" });
    expect((await jobs(again))["1"]!.publishing).toBeUndefined();
    await again.close();
  });

  test("while a job goes live, job_message is refused and a queued follow-up's tools fail", async () => {
    const booted = await bootSandboxed();
    const { daemon, faux, home, user } = booted;
    const [beat, gate] = [join(user, "beat"), join(user, "gate")];
    onTestFinished(() => {
      if (existsSync(user)) writeFileSync(gate, "");
    });
    const GOING_LIVE = "Job 1 is going live; message it after its report.";
    const first = held();
    const more = held();
    script(faux, (role, text, signal) => {
      if (text === "start") return call("job_start", { title: "Slow", brief: "slow" });
      if (text === "slow") return call("bash", { command: writeSlow(home, beat, gate) });
      if (role === "toolResult" && text.trim() === "written") {
        return first.wait(call("job_complete", { summary: "wrote it" }), signal);
      }
      if (text === "follow") return call("job_message", { id: "1", text: "more", mode: "followup" });
      if (role === "user" && text === "more") {
        return more.wait(call("bash", { command: `echo touched > "${home}/touched"` }), signal);
      }
      // The job's bash failing; the CoS's job_message replies with just the text.
      if (role === "toolResult" && text.includes(GOING_LIVE) && text !== GOING_LIVE) {
        return call("job_complete", { summary: "couldn't" });
      }
      if (text === "again") return call("job_message", { id: "1", text: "again", mode: "followup" });
    });
    await ask(daemon, "start");
    await waitFor(first.started);
    await ask(daemon, "follow"); // queued behind the run that completes the job
    await waitFor(() => queued(daemon));
    first.release();
    await waitFor(() => existsSync(beat), 30_000); // publishing: its check waits
    expect((await jobs(daemon))["1"]).toMatchObject({ status: "done", publishing: 1 });

    await ask(daemon, "again");
    expect((await texts(daemon.root, "toolResult")).at(-1)).toBe(GOING_LIVE);
    more.release();
    await waitFor(async () => (await jobResults(daemon)).some((result) => result.includes(GOING_LIVE)));
    expect(existsSync(join(home, ".jobs", "1", "touched"))).toBe(false);

    writeFileSync(gate, "");
    await waitFor(() => idle(daemon), 90_000);
    expect(await reported(daemon)).toContain('[job 1 "Slow" done] wrote it\n\nLive: extensions/slow (change 1).');
    expect((await jobs(daemon))["1"]!.publishing).toBeUndefined();
    expect(existsSync(join(home, "touched"))).toBe(false);
    await daemon.close();
  });
});

describe.skipIf(NO_BWRAP)("finishing", { timeout: 60_000 }, () => {
  test("a failed job's processes stop before its report is posted", async () => {
    const { daemon, faux, user } = await bootSandboxed();
    const beat = join(user, "beat");
    const report = held();
    script(faux, (role, text, signal) => {
      if (text === "start") return call("job_start", { title: "Beat", brief: "beat" });
      if (text === "beat") return call("bash", { command: heartbeat(beat) });
      if (role === "toolResult" && text.trim() === "beating") {
        return fauxAssistantMessage([], { stopReason: "error", errorMessage: "boom" });
      }
      if (role === "user" && text.startsWith('[job 1 "Beat" failed]')) return report.wait(say("noted"), signal);
    });
    await ask(daemon, "start");
    await waitFor(report.started);
    expect(await still(beat)).toBe(true);
    report.release();
    await waitFor(() => idle(daemon));
    expect(await reported(daemon)).toEqual(['[job 1 "Beat" failed] model_error: boom']);
    await daemon.close();
  });

  test("a job done after its nudge publishes too", async () => {
    const { daemon, faux, home } = await bootSandboxed();
    script(faux, (role, text) => {
      if (text === "start") return call("job_start", { title: "Hello", brief: "hello" });
      if (text === "hello") return call("bash", { command: writeHello(home) });
      if (role === "toolResult" && text.trim() === "written") return say("I wrote it");
      if (text === NUDGE) return say("Wrote skills/hello");
    });
    await ask(daemon, "start");
    await waitFor(() => idle(daemon), 50_000);
    expect(await reported(daemon)).toEqual(['[job 1 "Hello" done] Wrote skills/hello\n\nLive: skills/hello (change 1).']);
    expect(readFileSync(join(home, "skills", "hello", "SKILL.md"), "utf8")).toBe(HELLO);
    expect(await nudges(daemon)).toBe(1);
    await daemon.close();
  });
});

test("the CoS has no install tool", async () => {
  const { daemon } = await bootWith();
  const tools = (await daemon.root.agent(ctx)).tools.map((t) => t.name);
  expect(tools).toContain("rollback");
  expect(tools).not.toContain("install");
  await daemon.close();
});

test("a leftover workers dir shows in status", async () => {
  const kit = testKit();
  const home = tempHome({ storage: { adapter: "memory" }, models: { cos: kit.model } });
  mkdirSync(join(home, "workers"));
  writeFileSync(join(home, "workers", "coder.md"), "---\nname: coder\ndescription: Codes\n---\nCode.");
  const daemon = await boot({ home, extensions: [kit.extension] });
  expect(bootErrors(daemon)).toEqual([
    { name: "workers", error: "~/.japa/workers/ is no longer used: jobs have no profiles" },
  ]);
  await daemon.close();
});
