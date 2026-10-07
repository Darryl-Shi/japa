import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { type FauxProviderHandle, getSystemMessageText } from "@earendil-works/pi-ai";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import type { Daemon } from "../src/kernel/boot.ts";
import { bootTest, stage } from "./helpers.ts";
import { ask, say, tool } from "./jobs-helpers.ts";

/** The CoS's system prompt on its next request. */
async function system(daemon: Daemon, faux: FauxProviderHandle) {
  let text = "";
  faux.setResponses([
    ({ messages }) => {
      text = getSystemMessageText(messages.findLast((m) => m.role === "system")!);
      return say("ok");
    },
  ]);
  await ask(daemon, "hi");
  return text;
}

const subjects = (home: string) => execFileSync("git", ["-C", home, "log", "--format=%s"], { encoding: "utf8" }).trim().split("\n");
const toolNames = async (daemon: Daemon) => (await daemon.root.agent(ctx)).tools.map((t) => t.name);

/** Extension `echo`: tool `echo` replies `reply`; its trigger fails to start while `<home>/<reply>.busy` exists. */
const echo = (reply: string) => `import { existsSync } from "node:fs";
import { join } from "node:path";
import { defineJapaExtension, defineTool, type TriggerContext, Type } from "japa/sdk";

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
    trigger: [{
      name: "tick",
      start: async ({ home }: TriggerContext) => {
        if (existsSync(join(home, "${reply}.busy"))) throw new Error("busy");
        return () => {};
      },
    }],
  },
});
`;

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
  expect(await tool(daemon, faux, "change_undo", { id: "1" })).toMatch(/^Not undone: /);
  expect(readFileSync(join(home, "skills", "s", "SKILL.md"), "utf8")).toContain("Does s better");
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
