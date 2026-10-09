import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { defineExtension, ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, vi } from "vitest";
import { ChangesDoc } from "../src/kernel/changes.ts";
import { createSafety } from "../src/kernel/safety.ts";
import type { Settings } from "../src/kernel/settings.ts";
import { commit, ensureWorkspace } from "../src/kernel/workspace.ts";
import { createWorkspaceLock } from "../src/kernel/workspace-lock.ts";
import { bootTest, land, tempHome, waitFor } from "./helpers.ts";
import { ask, call, script, system, texts, tool } from "./jobs-helpers.ts";

/** Extension `flaky`: tool `flaky` replies `v1`, or throws when `broken`. */
const flaky = (broken: boolean) => `import { defineJapaExtension, defineTool, Type } from "japa/sdk";

export default defineJapaExtension({
  name: "flaky",
  summary: "Flaky",
  examples: ["flaky"],
  docs: "Flaky.",
  provides: {
    tool: [defineTool({
      name: "flaky",
      description: "Flaky",
      parameters: Type.Object({}),
      execute: async () => {
        ${broken ? 'throw new Error("broken");' : ""}
        return { content: [{ type: "text", text: "v1" }] };
      },
    })],
  },
});
`;

const skill = (description: string) => `---\nname: s\ndescription: ${description}\n---\nDo s.`;

test("an extension whose tool keeps failing is rolled back to its last known good version", { timeout: 60_000 }, async () => {
  const { daemon, faux, home } = await bootTest();
  land(home, "extensions/flaky/index.ts", flaky(false));
  await daemon.reconcile();
  await daemon.markGood();
  land(home, "extensions/flaky/index.ts", flaky(true));
  await daemon.reconcile();

  script(faux, (role, text) => (role === "user" && text === "flaky" ? call("flaky", {}) : undefined));
  for (let i = 0; i < 5; i++) await ask(daemon, "flaky");
  const rolledBack = async () => (await texts(daemon.root, "user")).filter((t) => t.startsWith("[japa] I rolled back flaky"));
  await waitFor(async () => (await rolledBack()).length > 0);

  expect(readFileSync(join(home, "extensions", "flaky", "index.ts"), "utf8")).toBe(flaky(false));
  await ask(daemon, "flaky");
  expect((await texts(daemon.root, "toolResult")).at(-1)).toBe("v1");
  expect(await rolledBack()).toHaveLength(1);
  const { changes } = (await daemon.harness.snapshot(ChangesDoc, ROOT_CONVERSATION_ID, ctx))!;
  expect(changes.at(-1)!.title).toBe("Rolled back flaky");
  await daemon.close();
});

test("an extension that keeps failing with no earlier working version is reported once", { timeout: 60_000 }, async () => {
  const { daemon, faux, home } = await bootTest();
  land(home, "extensions/flaky/index.ts", flaky(true));
  await daemon.reconcile();
  await daemon.markGood();

  script(faux, (role, text) => (role === "user" && text === "flaky" ? call("flaky", {}) : undefined));
  const notices = async () => (await texts(daemon.root, "user")).filter((t) => t.startsWith("[japa] flaky keeps failing"));
  for (let i = 0; i < 5; i++) await ask(daemon, "flaky");
  await waitFor(async () => (await notices()).length > 0);
  for (let i = 0; i < 5; i++) await ask(daemon, "flaky");
  await new Promise((r) => setTimeout(r, 50));
  expect(await notices()).toEqual(["[japa] flaky keeps failing and has no earlier working version: its tool flaky failed 5 times in a row"]);
  expect(existsSync(join(home, "extensions", "flaky"))).toBe(true);
  await daemon.close();
});

test("rollback restores a skill's last known good version", async () => {
  const { daemon, faux, home } = await bootTest();
  land(home, "skills/s/SKILL.md", skill("Does s"));
  await daemon.reconcile();
  await daemon.markGood();
  land(home, "skills/s/SKILL.md", skill("Does s better"));
  await daemon.reconcile();

  expect(await tool(daemon, faux, "rollback", { kind: "skill", name: "s" })).toBe("Rolled back skill s.");
  expect(readFileSync(join(home, "skills", "s", "SKILL.md"), "utf8")).toBe(skill("Does s"));
  const prompt = await system(daemon, faux);
  expect(prompt).toContain("- s: Does s\n");
  expect(prompt).not.toContain("Does s better");
  await daemon.close();
});

test("japa rollback works on the files without a daemon", () => {
  const home = tempHome();
  ensureWorkspace(home); // tags the initial workspace as last known good
  mkdirSync(join(home, "skills", "s"), { recursive: true });
  writeFileSync(join(home, "skills", "s", "SKILL.md"), skill("Does s"));
  commit(home, ["skills/s"], "Install skill s");

  const main = fileURLToPath(new URL("../src/cli/main.ts", import.meta.url));
  const out = execFileSync(main, ["rollback", "skill", "s"], { env: { ...process.env, JAPA_HOME: home }, encoding: "utf8" });
  expect(out).toBe("Rolled back. Restart the daemon to apply.\n");
  expect(existsSync(join(home, "skills", "s"))).toBe(false);
  expect(execFileSync("git", ["-C", home, "status", "--porcelain"], { encoding: "utf8" })).toBe("");
});

const lkg = (home: string) => execFileSync("git", ["-C", home, "rev-parse", "japa-lkg^{commit}"], { encoding: "utf8" });
const head = (home: string) => execFileSync("git", ["-C", home, "rev-parse", "HEAD"], { encoding: "utf8" });
const settings = { safety: { toolErrorThreshold: 2, goodAfterMinutes: 10 } } as Settings;
const unused = () => {
  throw new Error("unused");
};

test("only the latest schedule tags the last known good setup, after its own delay", async () => {
  const home = tempHome();
  ensureWorkspace(home);
  const initial = head(home);
  const lock = createWorkspaceLock();
  vi.useFakeTimers();
  try {
    const safety = createSafety({
      home,
      settings,
      built: () => new Map(),
      reconcile: unused,
      root: unused,
      report: unused,
      lock,
    });
    safety.scheduleGood();
    vi.advanceTimersByTime(8 * 60_000);
    writeFileSync(join(home, "notes.md"), "v3");
    commit(home, ["notes.md"], "v3");
    safety.scheduleGood();
    vi.advanceTimersByTime(2 * 60_000);
    await lock(async () => {}); // after any tagging that fired
    expect(lkg(home)).toBe(initial);
    vi.advanceTimersByTime(8 * 60_000);
    await lock(async () => {});
    expect(lkg(home)).toBe(head(home));
  } finally {
    vi.useRealTimers();
  }
});

// Not while a publish has merged and is still loading, for one: a revert may follow.
test("tagging the last known good setup waits for the workspace lock, scheduled or not", async () => {
  const home = tempHome();
  ensureWorkspace(home);
  const initial = head(home);
  const lock = createWorkspaceLock();
  const safety = createSafety({ home, settings, built: () => new Map(), reconcile: unused, root: unused, report: unused, lock });
  land(home, "notes.md", "v2");
  let release = () => {};
  let publishing = lock(() => new Promise<void>((resolve) => (release = resolve)));
  const marking = safety.markGood();
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(lkg(home)).toBe(initial);
  release();
  await publishing;
  await marking;
  expect(lkg(home)).toBe(head(home));

  land(home, "notes.md", "v3");
  vi.useFakeTimers();
  try {
    safety.scheduleGood();
    publishing = lock(() => new Promise<void>((resolve) => (release = resolve)));
    vi.advanceTimersByTime(10 * 60_000);
  } finally {
    vi.useRealTimers();
  }
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(lkg(home)).not.toBe(head(home));
  release();
  await publishing;
  await lock(async () => {});
  expect(lkg(home)).toBe(head(home));
  safety.close();
});

test("tool errors from packaged extensions never roll anything back", async () => {
  const home = tempHome(); // not a git repository: touching git would report an error
  const packaged = defineExtension({ name: "pkg", tools: [{ name: "t" } as never] });
  const errors: string[] = [];
  const safety = createSafety({
    home,
    settings,
    built: () => new Map([["pkg", packaged]]),
    reconcile: unused,
    root: unused,
    report: (e) => errors.push(e),
    lock: createWorkspaceLock(),
  });
  const { afterTool } = safety.extension.hooks![0].handlers as { afterTool: (c: unknown, r: unknown) => void };
  for (let i = 0; i < 3; i++) afterTool({ name: "t" }, { isError: true });
  await new Promise((r) => setImmediate(r));
  expect(errors).toEqual([]);
});

test("auto-rollback waits for the workspace lock", async () => {
  const home = tempHome();
  ensureWorkspace(home); // tags the initial workspace as last known good
  land(home, "extensions/flaky/index.ts", flaky(true));
  const extension = defineExtension({ name: "flaky", tools: [{ name: "flaky" } as never] });
  const lock = createWorkspaceLock();
  let release = () => {};
  const publishing = lock(() => new Promise<void>((resolve) => (release = resolve)));
  const submitted: string[] = [];
  const root = {
    submit: async ({ content }: { content: string }) => void submitted.push(content),
    commit: async () => {},
  };
  const errors: string[] = [];
  const safety = createSafety({
    home,
    settings,
    built: () => new Map([["flaky", extension]]),
    reconcile: async () => {},
    root: () => root as never,
    report: (e) => errors.push(e),
    lock,
  });
  const { afterTool } = safety.extension.hooks![0].handlers as { afterTool: (c: unknown, r: unknown) => void };
  for (let i = 0; i < 2; i++) afterTool({ name: "flaky" }, { isError: true });
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(existsSync(join(home, "extensions", "flaky"))).toBe(true);
  expect(submitted).toEqual([]);

  release();
  await publishing;
  await waitFor(() => submitted.length > 0);
  expect(existsSync(join(home, "extensions", "flaky"))).toBe(false);
  expect(submitted).toEqual(["[japa] I removed flaky (new since the last working setup): its tool flaky failed 2 times in a row"]);
  expect(errors).toEqual([]);
  safety.close();
});

/** A root that records what is submitted to it. */
function recordingRoot() {
  const submitted: string[] = [];
  const root = { submit: async ({ content }: { content: string }) => void submitted.push(content), commit: async () => {} };
  return { submitted, root: () => root as never };
}

const flakyTools = () => defineExtension({ name: "flaky", tools: [{ name: "flaky" } as never] });

test("an auto-rollback waiting for the lock is dropped once another version of the extension loaded", async () => {
  const home = tempHome();
  ensureWorkspace(home);
  land(home, "extensions/flaky/index.ts", flaky(true));
  let loaded = flakyTools();
  const lock = createWorkspaceLock();
  let release = () => {};
  const publishing = lock(() => new Promise<void>((resolve) => (release = resolve)));
  const { submitted, root } = recordingRoot();
  const errors: string[] = [];
  const safety = createSafety({
    home,
    settings,
    built: () => new Map([["flaky", loaded]]),
    reconcile: async () => {},
    root,
    report: (e) => errors.push(e),
    lock,
  });
  const { afterTool } = safety.extension.hooks![0].handlers as { afterTool: (c: unknown, r: unknown) => void };
  for (let i = 0; i < 2; i++) afterTool({ name: "flaky" }, { isError: true });
  await new Promise((resolve) => setTimeout(resolve, 50)); // the auto-rollback waits for the lock
  // The publish holding it merges a fix, and loads it.
  land(home, "extensions/flaky/index.ts", flaky(false));
  loaded = flakyTools();
  release();
  await publishing;
  await lock(async () => {}); // after the auto-rollback's turn
  expect(readFileSync(join(home, "extensions", "flaky", "index.ts"), "utf8")).toBe(flaky(false));
  expect(submitted).toEqual([]);
  expect(errors).toEqual([]);
  safety.close();
});

test("a new version of an extension counts its tool errors from zero", async () => {
  const home = tempHome();
  ensureWorkspace(home);
  land(home, "extensions/flaky/index.ts", flaky(true));
  let loaded = flakyTools();
  const lock = createWorkspaceLock();
  const { submitted, root } = recordingRoot();
  const safety = createSafety({
    home,
    settings,
    built: () => new Map([["flaky", loaded]]),
    reconcile: async () => {},
    root,
    report: unused,
    lock,
  });
  const { afterTool } = safety.extension.hooks![0].handlers as { afterTool: (c: unknown, r: unknown) => void };
  afterTool({ name: "flaky" }, { isError: true });
  loaded = flakyTools();
  afterTool({ name: "flaky" }, { isError: true });
  await new Promise((resolve) => setTimeout(resolve, 50));
  await lock(async () => {});
  expect(submitted).toEqual([]);
  afterTool({ name: "flaky" }, { isError: true });
  await waitFor(() => submitted.length > 0);
  expect(submitted).toEqual(["[japa] I removed flaky (new since the last working setup): its tool flaky failed 2 times in a row"]);
  safety.close();
});
