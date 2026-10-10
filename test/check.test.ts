import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, onTestFinished, test } from "vitest";
import { CHECK_KINDS, check } from "../src/kernel/check.ts";
import { tempHome } from "./helpers.ts";

/** A temp home holding `files` (by path relative to it), used as both the checked dir and the home. */
function homeWith(files: Record<string, string>): string {
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
  const home = homeWith({ "skills/notes/SKILL.md": "---\nname: other\ndescription: Takes notes\n---\nBody" });
  expect(await check("skill", "notes", home, home)).toEqual([`name must be "notes"`]);
});

test("a good skill passes", async () => {
  const home = homeWith({ "skills/notes/SKILL.md": "---\nname: notes\ndescription: Takes notes\n---\nBody" });
  expect(await check("skill", "notes", home, home)).toEqual([]);
});

test("the check kinds are skill and extension", () => {
  expect(CHECK_KINDS).toEqual(["skill", "extension"]);
});

describe("extensions", { timeout: 60_000 }, () => {
  test("an extension with a type error fails with the compiler output", async () => {
    const home = homeWith({ "extensions/hello/index.ts": extension("hello", "hello").replace(`"hello " + who`, "who * 2") });
    const problems = await check("extension", "hello", home, home);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("index.ts");
    expect(problems[0]).toContain("error TS");
  });

  test("an extension whose tool collides with a kernel tool fails", async () => {
    const home = homeWith({ "extensions/hello/index.ts": extension("hello", "job_start") });
    expect(await check("extension", "hello", home, home)).toEqual([`tool "job_start" is also provided by japa-jobs`]);
  });

  test("an extension whose tool collides with another extension's tool fails", async () => {
    const home = homeWith({
      "extensions/hello/index.ts": extension("hello", "greet"),
      "extensions/hi/index.ts": extension("hi", "greet"),
    });
    expect(await check("extension", "hello", home, home)).toEqual([`tool "greet" is also provided by hi`]);
  });

  test("an extension whose activation throws fails the smoke load", async () => {
    const provides = `tool: [tool], trigger: [{ name: "tick", start: () => { throw new Error("boom"); } }]`;
    const home = homeWith({ "extensions/hello/index.ts": extension("hello", "hello", provides) });
    expect(await check("extension", "hello", home, home)).toEqual(["trigger: boom"]);
  });

  test("checking again after an edit runs the edited module", async () => {
    const home = homeWith({
      "extensions/hello/index.ts": extension("hello", "hello"),
      "extensions/hello/index.test.ts": `import { expect, test } from "vitest";\ntest("ok", () => expect(1).toBe(1));\n`,
    });
    expect(await check("extension", "hello", home, home)).toEqual([]);
    const provides = `tool: [tool], trigger: [{ name: "tick", start: () => { throw new Error("boom"); } }]`;
    writeFileSync(join(home, "extensions/hello/index.ts"), extension("hello", "hello", provides));
    expect(await check("extension", "hello", home, home)).toEqual(["trigger: boom"]);
    expect(existsSync(join(home, "extensions/hello/node_modules"))).toBe(false);
  });

  test("the smoke load's kernel errors don't count against an extension of the same name", async () => {
    // As in a job's sandbox, where jobs can't run: the throwaway daemon reports a `sandbox` error.
    const saved = process.env.JAPA_BWRAP;
    process.env.JAPA_BWRAP = "/nonexistent";
    onTestFinished(() => {
      if (saved === undefined) delete process.env.JAPA_BWRAP;
      else process.env.JAPA_BWRAP = saved;
    });
    const home = homeWith({ "extensions/sandbox/index.ts": extension("sandbox", "hello") });
    expect(await check("extension", "sandbox", home, home)).toEqual([]);
  });

  test("a good extension with one tool, importing japa/sdk, passes", async () => {
    const home = homeWith({ "extensions/hello/index.ts": extension("hello", "hello") });
    expect(await check("extension", "hello", home, home)).toEqual([]);
  });

  test("tsc and vitest run on japa's own Node when there is no node on PATH", () => {
    const home = homeWith({
      "extensions/hello/index.ts": extension("hello", "hello"),
      "extensions/hello/index.test.ts": `import { expect, test } from "vitest";\ntest("ok", () => expect(1).toBe(1));\n`,
    });
    // A private-Node install: japa runs on an absolute Node path, and PATH has git but no node at all.
    const bin = mkdtempSync(join(tmpdir(), "japa-check-bin-"));
    symlinkSync(execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim(), join(bin, "git"));
    const main = fileURLToPath(new URL("../src/cli/main.ts", import.meta.url));

    const r = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", main, "check", "extension", "hello"], {
      cwd: home,
      env: { ...process.env, PATH: bin, JAPA_HOME: home },
      encoding: "utf8",
    });

    expect(`${r.stdout}${r.stderr}`.trim()).toBe("ok");
  });
});

test("japa check worker is refused", () => {
  const dir = homeWith({ "workers/scout.md": "---\nname: scout\ndescription: Looks around\n---\nLook." });
  const main = fileURLToPath(new URL("../src/cli/main.ts", import.meta.url));
  const r = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", main, "check", "worker", "scout"], {
    cwd: dir,
    env: { ...process.env, JAPA_HOME: tempHome() },
    encoding: "utf8",
  });
  expect(r.status).toBe(1);
  expect(r.stderr).toContain("Usage: japa check <skill|extension> <name>");
  const usage = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", main], { encoding: "utf8" });
  expect(usage.stderr).toMatch(/^ {2}check <skill\|extension> <name>$/m);
  expect(usage.stderr).not.toMatch(/worker/);
});

test("japa check prints ok and exits 0 for a good skill", () => {
  const dir = homeWith({ "skills/notes/SKILL.md": "---\nname: notes\ndescription: Takes notes\n---\nBody" });
  const main = fileURLToPath(new URL("../src/cli/main.ts", import.meta.url));
  const out = execFileSync(main, ["check", "skill", "notes"], { cwd: dir, env: { ...process.env, JAPA_HOME: tempHome() }, encoding: "utf8" });
  expect(out.trim()).toBe("ok");
});
