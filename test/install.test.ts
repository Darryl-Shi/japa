import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import type { Daemon } from "../src/kernel/boot.ts";
import { bootTest, echo, stage } from "./helpers.ts";
import { ask, say, system, tool } from "./jobs-helpers.ts";

const subjects = (home: string) => execFileSync("git", ["-C", home, "log", "--format=%s"], { encoding: "utf8" }).trim().split("\n");
const toolNames = async (daemon: Daemon) => (await daemon.root.agent(ctx)).tools.map((t) => t.name);

test("a staged skill installs, and undo removes it", async () => {
  const { daemon, faux, home } = await bootTest();
  stage(home, "skills/s/SKILL.md", "---\nname: s\ndescription: Does s\n---\nDo s.");
  expect(await tool(daemon, faux, "install", { kind: "skill", name: "s" })).toBe("Installed skill s. (change 1)");
  expect(subjects(home)[0]).toBe("Install skill s");
  expect(await system(daemon, faux)).toContain("- s: Does s");
  expect(await tool(daemon, faux, "changes_list")).toMatch(/ Installed skill s$/);

  expect(await tool(daemon, faux, "change_undo", { id: "1" })).toBe("Undid: Installed skill s");
  expect(existsSync(join(home, "skills", "s"))).toBe(false);
  expect(await system(daemon, faux)).not.toContain("- s: Does s");
  await daemon.close();
});

test("undoing an install that a later install changed is refused plainly", async () => {
  const { daemon, faux, home } = await bootTest();
  stage(home, "skills/s/SKILL.md", "---\nname: s\ndescription: Does s\n---\nDo s.");
  await tool(daemon, faux, "install", { kind: "skill", name: "s" });
  stage(home, "skills/s/SKILL.md", "---\nname: s\ndescription: Does s better\n---\nDo s.");
  await tool(daemon, faux, "install", { kind: "skill", name: "s" });
  const undo = await tool(daemon, faux, "change_undo", { id: "1" });
  expect(undo).toMatch(/^Not undone: [^]*could not revert/);
  expect(undo).not.toContain("--abort");
  expect(readFileSync(join(home, "skills", "s", "SKILL.md"), "utf8")).toContain("Does s better");
  await daemon.close();
});

test("undoing an install that was already rolled back succeeds and removes its entry", async () => {
  const { daemon, faux, home } = await bootTest();
  stage(home, "skills/s/SKILL.md", "---\nname: s\ndescription: Does s\n---\nDo s.");
  await tool(daemon, faux, "install", { kind: "skill", name: "s" });
  stage(home, "skills/s/SKILL.md", "---\nname: s\ndescription: Does s better\n---\nDo s.");
  await tool(daemon, faux, "install", { kind: "skill", name: "s" });
  await tool(daemon, faux, "rollback", { kind: "skill", name: "s", to: "HEAD~1" });
  expect(await tool(daemon, faux, "change_undo", { id: "2" })).toBe("Undid: Installed skill s");
  expect(await tool(daemon, faux, "changes_list")).not.toMatch(/2 .*Installed skill s/);
  expect(readFileSync(join(home, "skills", "s", "SKILL.md"), "utf8")).not.toContain("better");
  await daemon.close();
});

test("a skill that fails its check is not installed", async () => {
  const { daemon, faux, home } = await bootTest();
  stage(home, "skills/s/SKILL.md", "---\nname: other\ndescription: Does s\n---\nDo s.");
  expect(await tool(daemon, faux, "install", { kind: "skill", name: "s" })).toBe('Not installed: name must be "s"');
  expect(subjects(home)).toEqual(["Initial workspace"]);
  expect(existsSync(join(home, "skills", "s"))).toBe(false);
  await daemon.close();
});

describe("extensions", { timeout: 60_000 }, () => {
  test("a staged extension installs, its tool works for the CoS, and undo removes it", async () => {
    const { daemon, faux, home } = await bootTest();
    stage(home, "extensions/echo/index.ts", echo("v1"));
    expect(await tool(daemon, faux, "install", { kind: "extension", name: "echo" })).toBe(
      "Installed extension echo. (change 1)",
    );
    expect(await tool(daemon, faux, "echo")).toBe("v1");

    expect(await tool(daemon, faux, "change_undo", { id: "1" })).toBe("Undid: Installed extension echo");
    expect(await toolNames(daemon)).not.toContain("echo");
    await daemon.close();
  });

  test("a version that passes its check but fails to activate is reverted, and the previous one still works", async () => {
    const { daemon, faux, home } = await bootTest();
    stage(home, "extensions/echo/index.ts", echo("v1"));
    await tool(daemon, faux, "install", { kind: "extension", name: "echo" });
    // The check's throwaway home has no `v2.busy`, so v2 passes it, but its trigger fails in this home.
    writeFileSync(join(home, "v2.busy"), "");
    stage(home, "extensions/echo/index.ts", echo("v2"));
    expect(await tool(daemon, faux, "install", { kind: "extension", name: "echo" })).toBe(
      "Not installed — trigger: busy. Nothing changed.",
    );
    expect(subjects(home)).toEqual([
      'Revert "Install extension echo"',
      "Install extension echo",
      "Install extension echo",
      "Initial workspace",
    ]);
    expect(readFileSync(join(home, "extensions", "echo", "index.ts"), "utf8")).toBe(echo("v1"));
    expect(await tool(daemon, faux, "echo")).toBe("v1");
    expect(await tool(daemon, faux, "changes_list")).toMatch(/^1 \S+ Installed extension echo$/);
    await daemon.close();
  });
});
