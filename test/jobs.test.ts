import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import {
  type AssistantMessage,
  type FauxProviderHandle,
  fauxAssistantMessage,
  fauxText,
  fauxToolCall,
  type Message,
} from "@earendil-works/pi-ai";
import { type Conversation, ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { boot, type Daemon } from "../src/kernel/boot.ts";
import { READ_ONLY_MESSAGE } from "../src/kernel/env.ts";
import { JobsDoc } from "../src/kernel/jobs/state.ts";
import { defineJapaExtension, defineTool, type EnvironmentAdapter, Type } from "../src/sdk.ts";
import { tempHome, testKit, waitFor } from "./helpers.ts";

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
const call = (name: string, args: Record<string, string>) =>
  fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" });
const say = (text: string) => fauxAssistantMessage([fauxText(text)]);

function textOf(m: Message): string {
  return typeof m.content === "string" ? m.content : m.content.map((p) => (p.type === "text" ? p.text : "")).join("");
}

/** Answers every request with `respond(role, text)` of its last non-system message, or "ok". */
function script(faux: FauxProviderHandle, respond: (role: string, text: string) => AssistantMessage | undefined) {
  const step = ({ messages }: { messages: Message[] }) => {
    const last = messages.findLast((m) => m.role !== "system")!;
    return respond(last.role, textOf(last)) ?? say("ok");
  };
  faux.setResponses(Array.from({ length: 50 }, () => step));
}

/** The texts of `conversation`'s messages with `role`. */
async function texts(conversation: Conversation, role: string): Promise<string[]> {
  const page = await conversation.entries({}, 200, undefined, ctx);
  return page.items.flatMap((e) => (e.model ?? []).filter((m) => m.role === role).map(textOf));
}

async function jobs(daemon: Daemon) {
  return (await daemon.harness.snapshot(JobsDoc, ROOT_CONVERSATION_ID, ctx))!.jobs;
}

async function ask(daemon: Daemon, text: string) {
  await (await daemon.root.submit({ type: "input", content: text }, ctx)).wait(ctx);
}

const reported = async (daemon: Daemon) => (await texts(daemon.root, "user")).filter((t) => t.startsWith("[job"));

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

test("the CoS and jobs are offered their own tools", async () => {
  const { daemon, faux } = await bootWith({ shell: profile("shell", ["tools: [read, bash]", "extensions: []"]) });
  const names = async (c: Conversation) => (await c.agent(ctx)).tools.map((t) => t.name);
  const root = await names(daemon.root);
  expect(root).toEqual(expect.arrayContaining(["read", "job_start", "probe_write"]));
  for (const name of ["write", "bash", "job_progress", "job_complete"]) expect(root).not.toContain(name);

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
  });
  expect(
    daemon
      .status()
      .errors.map((e) => e.name)
      .sort(),
  ).toEqual(["worker:bad-env", "worker:bad-ext", "worker:bad-tool"]);
  script(faux, (_role, text) => {
    if (text === "start bad") return call("job_start", { title: "Bad", brief: "b", worker: "bad-tool" });
  });
  await ask(daemon, "start bad");
  expect(await texts(daemon.root, "toolResult")).toEqual(['Unknown worker "bad-tool". Workers: general.']);
  expect(await jobs(daemon)).toEqual({});
  await daemon.close();
});
