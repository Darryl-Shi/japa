import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { check } from "../src/kernel/check.ts";
import { tempHome } from "./helpers.ts";

/** A temp home holding `files` (by path relative to it), used as both the checked dir and the home. */
function staged(files: Record<string, string>): string {
  const home = tempHome();
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(home, path)), { recursive: true });
    writeFileSync(join(home, path), text);
  }
  return home;
}

/** An extension `name` with one tool `tool`, importing `japa/sdk`; `provides` is its manifest's `provides` body. */
const extension = (name: string, tool: string, provides = "tool: [tool]") => `import { defineJapaExtension, defineTool, Type } from "japa/sdk";

const tool = defineTool({
  name: "${tool}",
  description: "Says hello",
  parameters: Type.Object({ who: Type.String() }),
  execute: async ({ who }) => ({ content: [{ type: "text", text: "hello " + who }] }),
});

export default defineJapaExtension({
  name: "${name}",
  summary: "Says hello",
  examples: ["say hello to Dana"],
  docs: "Says hello.",
  provides: { ${provides} },
});
`;

test("a skill whose name does not match its directory fails", async () => {
  const home = staged({ "skills/notes/SKILL.md": "---\nname: other\ndescription: Takes notes\n---\nBody" });
  expect(await check("skill", "notes", home, home)).toEqual([`name must be "notes"`]);
});

test("a good skill passes", async () => {
  const home = staged({ "skills/notes/SKILL.md": "---\nname: notes\ndescription: Takes notes\n---\nBody" });
  expect(await check("skill", "notes", home, home)).toEqual([]);
});

test("a worker naming an unknown tool fails", async () => {
  const home = staged({ "workers/scout.md": "---\nname: scout\ndescription: Looks around\ntools: [read, fly]\n---\nLook." });
  expect(await check("worker", "scout", home, home)).toEqual([`unknown tool "fly"`]);
});

test("a good worker passes", async () => {
  const home = staged({
    "skills/notes/SKILL.md": "---\nname: notes\ndescription: Takes notes\n---\nBody",
    "workers/scout.md": "---\nname: scout\ndescription: Looks around\ntools: [read]\nskills: [notes]\n---\nLook.",
  });
  expect(await check("worker", "scout", home, home)).toEqual([]);
});

test("a worker may use a skill shipped by an extension", async () => {
  const home = staged({
    "extensions/hello/index.ts": extension("hello", "hello"),
    "extensions/hello/skills/greeting/SKILL.md": "---\nname: greeting\ndescription: Greets\n---\nBody",
    "workers/scout.md": "---\nname: scout\ndescription: Looks around\ntools: [read]\nskills: [greeting]\n---\nLook.",
  });
  expect(await check("worker", "scout", home, home)).toEqual([]);
});

describe("extensions", { timeout: 60_000 }, () => {
  test("an extension with a type error fails with the compiler output", async () => {
    const home = staged({ "extensions/hello/index.ts": extension("hello", "hello").replace(`"hello " + who`, "who * 2") });
    const problems = await check("extension", "hello", home, home);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("index.ts");
    expect(problems[0]).toContain("error TS");
  });

  test("an extension whose tool collides with a kernel tool fails", async () => {
    const home = staged({ "extensions/hello/index.ts": extension("hello", "job_start") });
    expect(await check("extension", "hello", home, home)).toEqual([`tool "job_start" is also provided by japa-jobs`]);
  });

  test("an extension whose tool collides with another extension's tool fails", async () => {
    const home = staged({
      "extensions/hello/index.ts": extension("hello", "greet"),
      "extensions/hi/index.ts": extension("hi", "greet"),
    });
    expect(await check("extension", "hello", home, home)).toEqual([`tool "greet" is also provided by hi`]);
  });

  test("an extension whose activation throws fails the smoke load", async () => {
    const provides = `tool: [tool], trigger: [{ name: "tick", start: () => { throw new Error("boom"); } }]`;
    const home = staged({ "extensions/hello/index.ts": extension("hello", "hello", provides) });
    expect(await check("extension", "hello", home, home)).toEqual(["trigger: boom"]);
  });

  test("checking again after an edit runs the edited module", async () => {
    const home = staged({
      "extensions/hello/index.ts": extension("hello", "hello"),
      "extensions/hello/index.test.ts": `import { expect, test } from "vitest";\ntest("ok", () => expect(1).toBe(1));\n`,
    });
    expect(await check("extension", "hello", home, home)).toEqual([]);
    const provides = `tool: [tool], trigger: [{ name: "tick", start: () => { throw new Error("boom"); } }]`;
    writeFileSync(join(home, "extensions/hello/index.ts"), extension("hello", "hello", provides));
    expect(await check("extension", "hello", home, home)).toEqual(["trigger: boom"]);
    expect(existsSync(join(home, "extensions/hello/node_modules"))).toBe(false);
  });

  test("a good extension with one tool, importing japa/sdk, passes", async () => {
    const home = staged({ "extensions/hello/index.ts": extension("hello", "hello") });
    expect(await check("extension", "hello", home, home)).toEqual([]);
  });
});

test("japa check prints ok and exits 0 for a good skill", () => {
  const dir = staged({ "skills/notes/SKILL.md": "---\nname: notes\ndescription: Takes notes\n---\nBody" });
  const main = fileURLToPath(new URL("../src/cli/main.ts", import.meta.url));
  const out = execFileSync(main, ["check", "skill", "notes"], { cwd: dir, env: { ...process.env, JAPA_HOME: tempHome() }, encoding: "utf8" });
  expect(out.trim()).toBe("ok");
});
