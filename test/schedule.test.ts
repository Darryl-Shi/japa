import { expect, test } from "vitest";
import { boot } from "../src/kernel/boot.ts";
import { bootTest, REPO_EXTENSIONS, testKit, waitFor } from "./helpers.ts";
import { idle, script, system, texts, tool } from "./jobs-helpers.ts";

const soon = (ms = 1000) => new Date(Date.now() + ms).toISOString();
const fired = async (daemon: Awaited<ReturnType<typeof bootTest>>["daemon"]) =>
  (await texts(daemon.root, "user")).filter((t) => t.startsWith("[schedule"));

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

test("recurring schedules: validation, list, section and undo", async () => {
  const { daemon, faux } = await bootTest();
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
  const section = (await system(daemon, faux)).split("Active schedules:\n")[1]!.split("\n")[0];
  expect(section).toMatch(line);
  expect(await tool(daemon, faux, "change_undo", { id: "1" })).toBe(
    'To undo this, call schedule_remove with {"id":"1"}.',
  );
  expect(await tool(daemon, faux, "changes_list")).toMatch(/Scheduled "standup" \(0 9 \* \* \*\)/);
  await daemon.close();
});
