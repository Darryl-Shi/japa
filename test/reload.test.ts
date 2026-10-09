import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxToolCall, getSystemMessageText } from "@earendil-works/pi-ai";
import type { Conversation } from "@earendil-works/pi-durable";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, expect, test } from "vitest";
import { boot } from "../src/kernel/boot.ts";
import { bootErrors, bootTest, NO_BWRAP, REPO_EXTENSIONS, tempHome, testKit, waitFor } from "./helpers.ts";
import { ask, call, held, idle, jobs, say, script, textOf, texts } from "./jobs-helpers.ts";

const g = globalThis as { echoLog?: string[] };
beforeEach(() => {
  g.echoLog = [];
});

/** Writes `<home>/<path>` with `text`, creating its directory. */
function write(home: string, path: string, text: string) {
  mkdirSync(join(home, path, ".."), { recursive: true });
  writeFileSync(join(home, path), text);
}

/** Extension `echo`: tool `echo` replies `reply`; trigger `tick` logs its starts and stops to `echoLog`. */
const echo = (reply: string) => `import { defineJapaExtension, defineTool, Type } from "japa/sdk";
const log = globalThis.echoLog;
export default defineJapaExtension({
  name: "echo",
  summary: "Echoes",
  examples: ["echo"],
  docs: "Echo.",
  provides: {
    tool: [defineTool({
      name: "echo",
      description: "Echo",
      parameters: Type.Object({}),
      execute: async () => ({ content: [{ type: "text", text: "${reply}" }] }),
    })],
    trigger: [{ name: "tick", start: async () => { log.push("start ${reply}"); return () => { log.push("stop ${reply}"); }; } }],
  },
});
`;

const toolNames = async (c: Conversation) => (await c.agent(ctx)).tools.map((t) => t.name);
const echoes = (role: string, text: string) => (text === "echo" ? call("echo", {}) : undefined);

test("a new extension's tool reaches the CoS", async () => {
  const { daemon, faux, home } = await bootTest();
  write(home, "extensions/echo/index.ts", echo("v1"));
  expect(await daemon.reconcile()).toEqual({ errors: [], notices: [] });
  script(faux, echoes);
  await ask(daemon, "echo");
  expect(await texts(daemon.root, "toolResult")).toEqual(["v1"]);
  await daemon.close();
});

test("a changed extension replaces the old one; its trigger is disposed once and restarted", async () => {
  const { daemon, faux, home } = await bootTest();
  write(home, "extensions/echo/index.ts", echo("v1"));
  await daemon.reconcile();
  write(home, "extensions/echo/index.ts", echo("v2"));
  await daemon.reconcile();
  script(faux, echoes);
  await ask(daemon, "echo");
  expect(await texts(daemon.root, "toolResult")).toEqual(["v2"]);
  await daemon.close();
  expect(g.echoLog).toEqual(["start v1", "stop v1", "start v2", "stop v2"]);
});

test("a removed extension's tools are gone", async () => {
  const { daemon, home } = await bootTest();
  write(home, "extensions/echo/index.ts", echo("v1"));
  await daemon.reconcile();
  expect(await toolNames(daemon.root)).toContain("echo");
  rmSync(join(home, "extensions", "echo"), { recursive: true });
  await daemon.reconcile();
  expect(await toolNames(daemon.root)).not.toContain("echo");
  expect(g.echoLog).toEqual(["start v1", "stop v1"]);
  await daemon.close();
});

test.skipIf(NO_BWRAP)("a running job gets a new extension's tools", async () => {
  const { daemon, faux, home } = await bootTest();
  const work = held();
  script(faux, (_role, text, signal) => {
    if (text === "start") return call("job_start", { title: "Work", brief: "work" });
    if (text === "work") return work.wait(say("done"), signal);
  });
  await ask(daemon, "start");
  await waitFor(() => work.started());
  const job = (await daemon.harness.conversation((await jobs(daemon))["1"]!.conversationId, ctx))!;
  expect(await toolNames(job)).not.toContain("echo");
  write(home, "extensions/echo/index.ts", echo("v1"));
  await daemon.reconcile();
  expect(await toolNames(job)).toContain("echo");
  work.release();
  await waitFor(() => idle(daemon));
  await daemon.close();
});

test.skipIf(NO_BWRAP)("new skills and workers are picked up", async () => {
  const { daemon, faux, home } = await bootTest();
  write(home, "skills/notes/SKILL.md", "---\nname: notes\ndescription: Take notes\n---\nWrite them down.");
  write(home, "workers/scribe.md", "---\nname: scribe\ndescription: Writes\n---\nWrite.");
  await daemon.reconcile();
  let system = "";
  faux.setResponses(
    Array.from({ length: 10 }, () => ({ messages }) => {
      const last = textOf(messages.findLast((m) => m.role !== "system")!);
      if (last !== "start") return say("ok");
      system = messages.flatMap((m) => (m.role === "system" ? [getSystemMessageText(m)] : [])).join("\n");
      return call("job_start", { title: "Notes", brief: "brief", worker: "scribe" });
    }),
  );
  await ask(daemon, "start");
  expect(system).toContain("- notes: Take notes");
  expect((await jobs(daemon))["1"]).toMatchObject({ worker: "scribe" });
  await waitFor(() => idle(daemon));
  await daemon.close();
});

test("a broken extension is reported and the rest still works", async () => {
  const { daemon, faux, home } = await bootTest();
  write(home, "extensions/broken/index.ts", `throw new Error("boom");\n`);
  write(home, "extensions/echo/index.ts", echo("v1"));
  write(
    home,
    "extensions/store/index.ts",
    `export default { name: "store", summary: "Stores", provides: { storage: [{ name: "x", open: async () => ({}) }] } };\n`,
  );
  expect(await daemon.reconcile()).toEqual({
    errors: [{ name: "broken", error: "boom" }],
    notices: ["store: storage/secrets changes apply after a restart"],
  });
  expect(daemon.status().errors).toContainEqual({ name: "broken", error: "boom" });
  script(faux, echoes);
  await ask(daemon, "echo");
  expect(await texts(daemon.root, "toolResult")).toEqual(["v1"]);

  write(home, "extensions/broken/index.ts", `export default { name: "broken", summary: "Fixed" };\n`);
  await daemon.reconcile();
  expect(bootErrors(daemon)).toEqual([]);
  await daemon.close();
});

test("a change to a helper module alone is picked up", async () => {
  const { daemon, home } = await bootTest();
  write(
    home,
    "extensions/echo/index.ts",
    `import { reply } from "./reply.ts";
const log = globalThis.echoLog;
export default {
  name: "echo",
  summary: "Echoes",
  provides: { trigger: [{ name: "tick", start: async () => { log.push("start " + reply); return () => { log.push("stop " + reply); }; } }] },
};
`,
  );
  write(home, "extensions/echo/reply.ts", `export const reply = "v1";\n`);
  await daemon.reconcile();
  write(home, "extensions/echo/reply.ts", `export const reply = "v2";\n`);
  await daemon.reconcile();
  await daemon.close();
  expect(g.echoLog).toEqual(["start v1", "stop v1", "start v2", "stop v2"]);
});

test("removing a workspace override restores the packaged extension", async () => {
  const kit = testKit();
  const home = tempHome({ storage: { adapter: "memory" }, models: { cos: kit.model } });
  const packaged = join(home, "packaged");
  write(home, "packaged/echo/index.ts", echo("packaged"));
  const daemon = await boot({ home, extensionDirs: [REPO_EXTENSIONS, packaged], extensions: [kit.extension] });
  write(home, "extensions/echo/index.ts", echo("v1"));
  await daemon.reconcile();
  rmSync(join(home, "extensions", "echo"), { recursive: true });
  await daemon.reconcile();
  expect(await toolNames(daemon.root)).toContain("echo");
  await daemon.close();
  expect(g.echoLog).toEqual(["start packaged", "stop packaged", "start v1", "stop v1", "start packaged", "stop packaged"]);
});

test("a new extension's settings schema applies", async () => {
  const { daemon, faux, home } = await bootTest();
  write(
    home,
    "extensions/limited/index.ts",
    `import { Type } from "japa/sdk";\nexport default { name: "limited", summary: "Limited", settings: Type.Object({ limit: Type.Integer({ maximum: 10 }) }) };\n`,
  );
  await daemon.reconcile();
  const set = fauxToolCall("settings_set", { path: "extensions.limited.limit", value: 11 });
  faux.setResponses([fauxAssistantMessage([set], { stopReason: "toolUse" }), say("ok")]);
  await ask(daemon, "set");
  expect((await texts(daemon.root, "toolResult")).at(-1)).toMatch(/^Not changed: extensions\.limited\.limit: /);
  await daemon.close();
});

test("skill and worker errors are returned", async () => {
  const { daemon, home } = await bootTest();
  write(home, "workers/scribe.md", "---\nname: scribe\ndescription: Writes\ntools: [nope]\n---\nWrite.");
  expect((await daemon.reconcile()).errors).toEqual([{ name: "worker:scribe", error: 'unknown tool "nope"' }]);
  await daemon.close();
});
