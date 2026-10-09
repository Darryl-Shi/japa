import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import type { Daemon } from "../src/kernel/boot.ts";
import { rollBackAndLog } from "../src/kernel/rollback.ts";
import { createWorkspaceLock } from "../src/kernel/workspace-lock.ts";
import { ensureWorkspace } from "../src/kernel/workspace.ts";
import { bootTest, echo, land, tempHome } from "./helpers.ts";
import { tool } from "./jobs-helpers.ts";

const subjects = (home: string) =>
  execFileSync("git", ["-C", home, "log", "--format=%s"], { encoding: "utf8" }).trim().split("\n");
const toolNames = async (daemon: Daemon) => (await daemon.root.agent(ctx)).tools.map((t) => t.name);
const skill = (description: string) => `---\nname: s\ndescription: ${description}\n---\nDo s.`;
const read = (home: string, path: string) => readFileSync(join(home, path), "utf8");

test("a skill rolls back to a git ref, and undo restores it", async () => {
  const { daemon, faux, home } = await bootTest();
  land(home, "skills/s/SKILL.md", skill("Does s"));
  land(home, "skills/s/SKILL.md", skill("Does s better"));
  await daemon.reconcile();
  expect(await tool(daemon, faux, "rollback", { kind: "skill", name: "s", to: "HEAD~1" })).toBe("Rolled back skill s.");
  expect(subjects(home)[0]).toBe("Roll back skill s");
  expect(read(home, "skills/s/SKILL.md")).toBe(skill("Does s"));
  expect(await tool(daemon, faux, "changes_list")).toMatch(/^1 \S+ Rolled back skill s$/);

  expect(await tool(daemon, faux, "change_undo", { id: "1" })).toBe("Undid: Rolled back skill s");
  expect(read(home, "skills/s/SKILL.md")).toBe(skill("Does s better"));
  expect(await tool(daemon, faux, "changes_list")).toBe("No changes yet.");
  await daemon.close();
});

test("a skill already at that version is not rolled back", async () => {
  const { daemon, faux, home } = await bootTest();
  land(home, "skills/s/SKILL.md", skill("Does s"));
  await daemon.reconcile();
  expect(await tool(daemon, faux, "rollback", { kind: "skill", name: "s", to: "HEAD" })).toBe(
    "skill s is already at that version.",
  );
  expect(await tool(daemon, faux, "changes_list")).toBe("No changes yet.");
  await daemon.close();
});

test("undoing a rollback that a later change changed is refused plainly", async () => {
  const { daemon, faux, home } = await bootTest();
  land(home, "skills/s/SKILL.md", skill("Does s"));
  land(home, "skills/s/SKILL.md", skill("Does s better"));
  await daemon.reconcile();
  await tool(daemon, faux, "rollback", { kind: "skill", name: "s", to: "HEAD~1" });
  land(home, "skills/s/SKILL.md", skill("Does s best"));
  const undo = await tool(daemon, faux, "change_undo", { id: "1" });
  expect(undo).toMatch(/^Not undone: [^]*could not revert/);
  expect(undo).not.toContain("--abort");
  expect(read(home, "skills/s/SKILL.md")).toBe(skill("Does s best"));
  await daemon.close();
});

describe("extensions", { timeout: 60_000 }, () => {
  test("an extension rolls back to its last known good version, and its tool works again", async () => {
    const { daemon, faux, home } = await bootTest();
    land(home, "extensions/echo/index.ts", echo("v1"));
    await daemon.reconcile();
    await daemon.markGood();
    land(home, "extensions/echo/index.ts", echo("v2"));
    await daemon.reconcile();
    expect(await tool(daemon, faux, "echo")).toBe("v2");

    expect(await tool(daemon, faux, "rollback", { kind: "extension", name: "echo" })).toBe(
      "Rolled back extension echo.",
    );
    expect(read(home, "extensions/echo/index.ts")).toBe(echo("v1"));
    expect(await tool(daemon, faux, "echo")).toBe("v1");
    await daemon.close();
  });

  test("an extension new since the last known good setup is removed by its rollback", async () => {
    const { daemon, faux, home } = await bootTest();
    land(home, "extensions/echo/index.ts", echo("v1"));
    await daemon.reconcile();
    expect(await toolNames(daemon)).toContain("echo");
    expect(await tool(daemon, faux, "rollback", { kind: "extension", name: "echo" })).toBe(
      "Rolled back extension echo.",
    );
    expect(await toolNames(daemon)).not.toContain("echo");
    await daemon.close();
  });
});

test("rollback waits for a publish in progress", async () => {
  const home = tempHome();
  ensureWorkspace(home); // tags the initial workspace as last known good
  land(home, "skills/s/SKILL.md", skill("Does s"));
  const lock = createWorkspaceLock();
  let release = () => {};
  const publishing = lock(() => new Promise<void>((resolve) => (release = resolve)));
  let reconciled = 0;
  const reconcile = async () => {
    reconciled++;
    return { errors: [], notices: [] };
  };
  const logged: string[] = [];
  const commit = async <T>() => {
    logged.push("change");
    return "1" as T;
  };
  let settled = false;
  const rolledBack = rollBackAndLog(home, "skill", "s", undefined, reconcile, commit, lock).then((reply) => {
    settled = true;
    return reply;
  });
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(settled).toBe(false);
  expect(subjects(home)[0]).toBe("Land skills/s/SKILL.md");
  expect(reconciled).toBe(0);

  release();
  await publishing;
  expect(await rolledBack).toBe("Rolled back skill s.");
  expect(subjects(home)[0]).toBe("Roll back skill s");
  expect(reconciled).toBe(1);
  expect(logged).toEqual(["change"]);
});
