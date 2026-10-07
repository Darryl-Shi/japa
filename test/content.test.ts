import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { check } from "../src/kernel/check.ts";
import { bootTest, tempHome } from "./helpers.ts";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const skills = readdirSync(join(packageRoot, "skills"));
const workers = readdirSync(join(packageRoot, "workers")).map((f) => f.replace(/\.md$/, ""));
const files = [
  ...skills.map((s) => join(packageRoot, "skills", s, "SKILL.md")),
  ...workers.map((w) => join(packageRoot, "workers", `${w}.md`)),
];

test("the packaged skills are the default set", () => {
  expect(skills.sort()).toEqual([
    "building-extensions",
    "building-skills",
    "building-workers",
    "choosing-a-mechanism",
    "reporting-changes",
    "research",
    "writing-job-briefs",
  ]);
});

test("every packaged skill and worker passes japa check", async () => {
  const home = tempHome();
  for (const name of skills) expect([name, await check("skill", name, packageRoot, home)]).toEqual([name, []]);
  for (const name of workers) expect([name, await check("worker", name, packageRoot, home)]).toEqual([name, []]);
});

test("every tool name the skills and workers mention exists", async () => {
  const { daemon } = await bootTest();
  const tools = new Set(daemon.registry.snapshot().tools().map((t) => t.tool.name));
  await daemon.close();
  const unknown = files.flatMap((file) =>
    [...readFileSync(file, "utf8").matchAll(/`([a-z]+_[a-z_]+)/g)]
      .map((m) => m[1]!)
      .filter((name) => !tools.has(name))
      .map((name) => `${file}: ${name}`),
  );
  expect(unknown).toEqual([]);
});
