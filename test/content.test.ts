import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { check } from "../src/kernel/check.ts";
import { CONTRACTS } from "../src/kernel/contracts.ts";
import { bootTest, tempHome } from "./helpers.ts";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const skills = readdirSync(join(packageRoot, "skills"));
const files = skills.map((s) => join(packageRoot, "skills", s, "SKILL.md"));

test("the packaged skills are the default set", () => {
  expect(skills.sort()).toEqual([
    "building-extensions",
    "building-skills",
    "choosing-a-mechanism",
    "reporting-changes",
    "research",
    "writing-job-briefs",
  ]);
});

test("every packaged skill passes japa check", async () => {
  const home = tempHome();
  for (const name of skills) expect([name, await check("skill", name, packageRoot, home)]).toEqual([name, []]);
});

test("there are no packaged worker profiles", () => {
  expect(existsSync(join(packageRoot, "workers"))).toBe(false);
});

/** Every SKILL.md under `dir`'s skill directories. */
const skillFiles = (dir: string) =>
  existsSync(dir) ? readdirSync(dir).map((s) => join(dir, s, "SKILL.md")).filter((f) => existsSync(f)) : [];

test("no packaged text mentions staging, install, worker profiles or operator jobs", () => {
  const texts = [
    ...files,
    ...readdirSync(join(packageRoot, "extensions")).flatMap((e) => skillFiles(join(packageRoot, "extensions", e, "skills"))),
    join(packageRoot, "src/kernel/identity.md"),
    join(packageRoot, "src/kernel/jobs/worker.ts"),
  ];
  expect(texts.length).toBeGreaterThan(files.length + 2);
  const stale = /\.staging|staging copy|install\(|`install`|worker profile|`?operator`? job|`?builder`? job|\.\.\/node_modules/i;
  const hits = texts.flatMap((file) =>
    readFileSync(file, "utf8")
      .split("\n")
      .filter((line) => stale.test(line))
      .map((line) => `${file}: ${line}`),
  );
  expect(hits).toEqual([]);
});

test("every tool name the skills mention exists", async () => {
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

test("the building-extensions skill covers every core contract", () => {
  const skill = readFileSync(join(packageRoot, "skills/building-extensions/SKILL.md"), "utf8");
  for (const name of CONTRACTS.keys()) expect([name, skill.includes(`**${name}**`)]).toEqual([name, true]);
  for (const text of ["root.replies", "secretProvided", "requestSecret", "setSecret", "japa status"]) expect([text, skill.includes(text)]).toEqual([text, true]);
});

const PROMISE_RULE =
  "Never promise anything you have not backed with a mechanism: a job for work now, a schedule for anything later — including following up on something you are waiting for (\"check in about Bob's reply on Thursday\") — or a trigger for \"when X happens\". Your context is cleared after every reply; anything not backed this way is forgotten.";

test("the identity text and the two skills state the promise rule", () => {
  for (const file of [
    join(packageRoot, "src/kernel/identity.md"),
    join(packageRoot, "skills/choosing-a-mechanism/SKILL.md"),
    join(packageRoot, "skills/writing-job-briefs/SKILL.md"),
  ]) {
    expect([file, readFileSync(file, "utf8").includes(PROMISE_RULE)]).toEqual([file, true]);
  }
});
