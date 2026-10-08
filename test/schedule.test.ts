import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import {
  type FauxProviderHandle,
  type FauxResponseFactory,
  fauxAssistantMessage,
  fauxToolCall,
  getSystemMessageText,
} from "@earendil-works/pi-ai";
import type { JsonObject } from "@earendil-works/pi-durable";
import { expect, test, vi } from "vitest";
import { boot, type Daemon } from "../src/kernel/boot.ts";
import { bootTest, REPO_EXTENSIONS, testKit, waitFor } from "./helpers.ts";
import { ask, call, idle, say, script, system, texts } from "./jobs-helpers.ts";

/** Like jobs-helpers' `tool`, but answers a background reflection (due after 5 turns) that joins in. */
async function tool(daemon: Daemon, faux: FauxProviderHandle, name: string, args: JsonObject = {}) {
  let called = false;
  const step: FauxResponseFactory = ({ messages }) => {
    if (getSystemMessageText(messages.findLast((m) => m.role === "system")!).startsWith("You reflect")) {
      return fauxAssistantMessage([fauxToolCall("save", { facts: [], episode: "e" })], { stopReason: "toolUse" });
    }
    if (called) return say("ok");
    called = true;
    return call(name, args as Record<string, string>);
  };
  faux.setResponses(Array.from({ length: 5 }, () => step));
  await ask(daemon, name);
  return (await texts(daemon.root, "toolResult")).at(-1);
}

const soon = (ms = 1000) => new Date(Date.now() + ms).toISOString();
const fired = async (daemon: Awaited<ReturnType<typeof bootTest>>["daemon"]) =>
  (await texts(daemon.root, "user")).filter((t) => t.startsWith("[schedule"));
/** The live schedule tasks' inputs. */
const scheduleTasks = async (daemon: Daemon) =>
  (await daemon.harness.inspect(ctx)).tasks.filter((t) => t.record.kind === "japa.schedule").map((t) => t.record.input);
/** The `details` of the latest tool result. */
async function details(daemon: Daemon) {
  const page = await daemon.root.entries({}, 200, undefined, ctx);
  return page.items.flatMap((e) => e.model ?? []).find((m) => m.role === "toolResult")?.details;
}
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("a one-shot schedule fires once, then is gone", async () => {
  const { daemon, faux } = await bootTest();
  expect(await tool(daemon, faux, "schedule_add", { text: "stretch", at: soon() })).toMatch(
    /^Scheduled 1: next at .+\. \(change 1\)$/,
  );
  script(faux, () => undefined);
  await waitFor(async () => (await fired(daemon)).length > 0);
  await waitFor(() => idle(daemon));
  expect(await fired(daemon)).toEqual(["[schedule 1] stretch"]);
  expect(await tool(daemon, faux, "schedule_list")).toBe("No schedules.");
  await daemon.close();
});

test("a removed schedule does not fire", async () => {
  const { daemon, faux } = await bootTest();
  await tool(daemon, faux, "schedule_add", { text: "stretch", at: soon() });
  expect(await tool(daemon, faux, "schedule_remove", { id: "1" })).toBe("Removed schedule 1.");
  expect(await tool(daemon, faux, "schedule_remove", { id: "1" })).toBe("No schedule 1.");
  await waitFor(() => idle(daemon));
  expect(await fired(daemon)).toEqual([]);
  await daemon.close();
});

test("a schedule due while the daemon was down fires once at boot", async () => {
  const kit = testKit();
  let { daemon, home } = await bootTest({ storage: { adapter: "sqlite" } }, [], kit);
  await tool(daemon, kit.faux, "schedule_add", { text: "stretch", at: soon() });
  await daemon.close();
  await new Promise((resolve) => setTimeout(resolve, 1200));
  script(kit.faux, () => undefined);
  daemon = await boot({ home, extensionDirs: [REPO_EXTENSIONS], extensions: [kit.extension] });
  await waitFor(async () => (await fired(daemon)).length > 0);
  await waitFor(() => idle(daemon));
  expect(await fired(daemon)).toEqual(["[schedule 1] stretch"]);
  await daemon.close();
});

test("a paused one-shot doesn't fire; resumed after it was due, it fires once", async () => {
  const { daemon, faux } = await bootTest();
  await tool(daemon, faux, "schedule_add", { text: "stretch", at: soon() });
  expect(await tool(daemon, faux, "schedule_resume", { id: "1" })).toBe("Schedule 1 isn't paused.");
  expect(await tool(daemon, faux, "schedule_pause", { id: "1" })).toBe("Paused schedule 1.");
  expect(await tool(daemon, faux, "schedule_pause", { id: "1" })).toBe("Schedule 1 is already paused.");
  expect(await tool(daemon, faux, "schedule_pause", { id: "9" })).toBe("No schedule 9.");
  expect(await tool(daemon, faux, "schedule_resume", { id: "9" })).toBe("No schedule 9.");
  expect(await tool(daemon, faux, "schedule_list")).toMatch(/^1 {2}once {2}next .+ {2}stretch \(paused\)$/);
  await sleep(1200); // past its time: its task wakes, sees it paused and exits
  await waitFor(() => idle(daemon));
  expect(await fired(daemon)).toEqual([]);
  script(faux, () => undefined);
  expect(await tool(daemon, faux, "schedule_resume", { id: "1" })).toMatch(/^Resumed schedule 1: next at .+\.$/);
  await waitFor(async () => (await fired(daemon)).length > 0);
  await waitFor(() => idle(daemon));
  expect(await fired(daemon)).toEqual(["[schedule 1] stretch"]);
  expect(await tool(daemon, faux, "schedule_list")).toBe("No schedules.");
  await daemon.close();
});

test("a cron schedule paused and resumed fires once at its next occurrence, never twice", async () => {
  // The harness clock is Date.now, captured at boot: shift it to just before a minute boundary.
  const real = Date.now.bind(Date);
  let offset = 0;
  const clock = vi.spyOn(Date, "now").mockImplementation(() => real() + offset);
  try {
    const { daemon, faux } = await bootTest();
    const boundary = Math.ceil((real() + 1) / 60_000) * 60_000;
    offset = boundary - 4000 - real();
    await tool(daemon, faux, "schedule_add", { text: "tick", cron: "* * * * *" });
    for (let i = 0; i < 3; i++) {
      expect(await tool(daemon, faux, "schedule_pause", { id: "1" })).toBe("Paused schedule 1.");
      expect(await tool(daemon, faux, "schedule_resume", { id: "1" })).toBe(
        `Resumed schedule 1: next at ${new Date(boundary).toLocaleString()}.`,
      );
    }
    expect(Date.now()).toBeLessThan(boundary); // the calls finished before the occurrence
    script(faux, () => undefined);
    await waitFor(async () => (await fired(daemon)).length > 0);
    await sleep(1000);
    expect(await fired(daemon)).toEqual(["[schedule 1] tick"]);
    expect(await scheduleTasks(daemon)).toEqual([{ id: "1", gen: 3 }]);
    await daemon.close();
  } finally {
    clock.mockRestore();
  }
});

test("pause and resume are logged and undone by each other", async () => {
  const { daemon, faux } = await bootTest();
  await tool(daemon, faux, "schedule_add", { text: "standup", cron: "0 9 * * *" });
  await tool(daemon, faux, "schedule_pause", { id: "1" });
  await tool(daemon, faux, "schedule_resume", { id: "1" });
  const changes = await tool(daemon, faux, "changes_list");
  expect(changes).toMatch(/Paused schedule "standup"/);
  expect(changes).toMatch(/Resumed schedule "standup"/);
  expect(await tool(daemon, faux, "change_undo", { id: "2" })).toBe(
    'To undo this, call schedule_resume with {"id":"1"}.',
  );
  expect(await tool(daemon, faux, "change_undo", { id: "3" })).toBe(
    'To undo this, call schedule_pause with {"id":"1"}.',
  );
  await daemon.close();
});

test("a schedule stored before pause existed (no gen) still fires", async () => {
  const { daemon, faux } = await bootTest();
  await tool(daemon, faux, "schedule_add", { text: "stretch", at: soon() });
  expect(await scheduleTasks(daemon)).toEqual([{ id: "1" }]);
  script(faux, () => undefined);
  await waitFor(async () => (await fired(daemon)).length > 0);
  await waitFor(() => idle(daemon));
  expect(await fired(daemon)).toEqual(["[schedule 1] stretch"]);
  await daemon.close();
});

test("schedule_list details carry each schedule's fields and paused", async () => {
  const { daemon, faux } = await bootTest();
  await tool(daemon, faux, "schedule_add", { text: "standup", cron: "0 9 * * *" });
  const at = Date.parse(soon(3_600_000));
  await tool(daemon, faux, "schedule_add", { text: "call", at: new Date(at).toISOString() });
  await tool(daemon, faux, "schedule_pause", { id: "2" });
  expect(await tool(daemon, faux, "schedule_list")).toMatch(/\n2 {2}once {2}next .+ {2}call \(paused\)$/);
  const [standup, call] = (await details(daemon)) as Record<string, unknown>[];
  expect(standup).toEqual({
    id: "1",
    text: "standup",
    cron: "0 9 * * *",
    next: expect.any(Number),
    paused: false,
    label: "standup (0 9 * * *)",
  });
  expect(call).toEqual({
    id: "2",
    text: "call",
    at,
    next: at,
    paused: true,
    label: `call (${new Date(at).toLocaleString()})`,
  });
  await daemon.close();
});

test("recurring schedules: validation, list, section and undo", async () => {
  const { daemon, faux } = await bootTest();
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const now = new RegExp(`\\nNow: \\w+day, .+ \\d{1,2}:\\d{2}.* \\(${zone}\\)\\n`);
  expect(await system(daemon, faux)).toMatch(now);
  expect(await system(daemon, faux)).not.toContain("Active schedules:");
  expect(await tool(daemon, faux, "schedule_add", { text: "x" })).toMatch(/^Not scheduled: /);
  expect(await tool(daemon, faux, "schedule_add", { text: "x", at: "2000-01-01T00:00:00Z" })).toMatch(
    /^Not scheduled: /,
  );
  expect(await tool(daemon, faux, "schedule_add", { text: "x", cron: "61 * * * *" })).toMatch(
    /^Not scheduled: invalid cron: /,
  );
  expect(await tool(daemon, faux, "schedule_add", { text: "standup", cron: "0 9 * * *" })).toMatch(
    /^Scheduled 1: next at .+\. \(change 1\)$/,
  );
  const line = /^1 {2}0 9 \* \* \* {2}next .+ {2}standup$/;
  expect(await tool(daemon, faux, "schedule_list")).toMatch(line);
  const section = (await system(daemon, faux)).split(now)[1]!.split("\n");
  expect(section[0]).toBe("Active schedules:");
  expect(section[1]).toMatch(line);
  expect(await tool(daemon, faux, "change_undo", { id: "1" })).toBe(
    'To undo this, call schedule_remove with {"id":"1"}.',
  );
  expect(await tool(daemon, faux, "changes_list")).toMatch(/Scheduled "standup" \(0 9 \* \* \*\)/);
  await daemon.close();
});
