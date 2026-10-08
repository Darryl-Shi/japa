import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { commit, dirHash, ensureWorkspace, restorePath, revert } from "../src/kernel/workspace.ts";
import { tempHome } from "./helpers.ts";

const git = (home: string, ...args: string[]) => execFileSync("git", ["-C", home, ...args], { encoding: "utf8" }).trim();

function workspace(): string {
  const home = tempHome();
  ensureWorkspace(home);
  return home;
}

test("ensureWorkspace creates the repo, .gitignore, the initial commit and the staging worktree, idempotently", () => {
  const home = workspace();
  ensureWorkspace(home);
  expect(readFileSync(join(home, ".gitignore"), "utf8")).toContain("secrets/");
  expect(git(home, "log", "--format=%s")).toBe("Initial workspace");
  expect(git(home, "branch", "--show-current")).toBe("main");
  expect(git(join(home, ".staging"), "branch", "--show-current")).toBe("staging");
});

test("commit never includes secrets or the database", () => {
  const home = tempHome();
  mkdirSync(join(home, "secrets"));
  writeFileSync(join(home, "secrets", "x"), "secret");
  writeFileSync(join(home, "state.db"), "db");
  ensureWorkspace(home);
  expect(commit(home, ["."], "m")).toBeUndefined();
  expect(git(home, "ls-files")).toBe(".gitignore");
});

test("commit then revert restores the earlier content", () => {
  const home = workspace();
  const file = join(home, "skills", "s", "SKILL.md");
  mkdirSync(join(home, "skills", "s"), { recursive: true });
  writeFileSync(file, "one");
  const first = commit(home, ["skills/s"], "add s")!;
  writeFileSync(file, "two");
  const second = commit(home, ["skills/s"], "change s")!;
  expect(second).not.toBe(first);
  expect(revert(home, [second])).toBe(git(home, "rev-parse", "HEAD"));
  expect(readFileSync(file, "utf8")).toBe("one");
});

test("restorePath removes a path that is absent at the ref", () => {
  const home = workspace();
  mkdirSync(join(home, "skills", "s"), { recursive: true });
  writeFileSync(join(home, "skills", "s", "SKILL.md"), "one");
  commit(home, ["skills/s"], "add s");
  restorePath(home, "HEAD~1", "skills/s");
  expect(existsSync(join(home, "skills", "s"))).toBe(false);
});

test("ensureWorkspace recovers from a hand-deleted .staging", () => {
  const home = workspace();
  rmSync(join(home, ".staging"), { recursive: true, force: true });
  ensureWorkspace(home);
  expect(git(join(home, ".staging"), "branch", "--show-current")).toBe("staging");
});

test("ensureWorkspace works with a global commit.gpgsign=true", () => {
  const home = tempHome();
  const config = join(tempHome(), "gitconfig");
  writeFileSync(config, "[commit]\n\tgpgsign = true\n");
  const prev = process.env.GIT_CONFIG_GLOBAL;
  process.env.GIT_CONFIG_GLOBAL = config;
  try {
    ensureWorkspace(home);
  } finally {
    if (prev === undefined) delete process.env.GIT_CONFIG_GLOBAL;
    else process.env.GIT_CONFIG_GLOBAL = prev;
  }
  expect(git(home, "log", "--format=%s")).toBe("Initial workspace");
});

test("restorePath removes files added to a dir since the ref", () => {
  const home = workspace();
  mkdirSync(join(home, "extensions"));
  writeFileSync(join(home, "extensions", "good.ts"), "good");
  const ref = commit(home, ["extensions"], "good")!;
  writeFileSync(join(home, "extensions", "bad.ts"), "bad");
  commit(home, ["extensions"], "bad");
  restorePath(home, ref, "extensions");
  expect(existsSync(join(home, "extensions", "bad.ts"))).toBe(false);
  expect(readFileSync(join(home, "extensions", "good.ts"), "utf8")).toBe("good");
});

test("a conflicting revert aborts, throws and leaves the live file untouched", () => {
  const home = workspace();
  const file = join(home, "f");
  writeFileSync(file, "v0\n");
  commit(home, ["f"], "v0");
  writeFileSync(file, "v1\n");
  const a = commit(home, ["f"], "v1")!;
  writeFileSync(file, "v2\n");
  commit(home, ["f"], "v2");
  expect(() => revert(home, [a])).toThrow();
  expect(readFileSync(file, "utf8")).toBe("v2\n");
  expect(git(home, "status", "--porcelain")).toBe("");
});

test("attachments are ignored by git, also in a workspace made before them", () => {
  const home = workspace();
  const gitignore = join(home, ".gitignore");
  writeFileSync(gitignore, readFileSync(gitignore, "utf8").replace("attachments/\n", ""));
  commit(home, [".gitignore"], "before attachments");
  ensureWorkspace(home);
  ensureWorkspace(home);
  expect(readFileSync(gitignore, "utf8").split("\n").filter((l) => l === "attachments/")).toHaveLength(1);
  expect(git(home, "status", "--porcelain")).toBe("");
});

test("appending to a .gitignore without a trailing newline keeps its last line intact", () => {
  const home = tempHome();
  writeFileSync(join(home, ".gitignore"), "build");
  ensureWorkspace(home);
  const lines = readFileSync(join(home, ".gitignore"), "utf8").split("\n");
  expect(lines).toContain("build");
  expect(lines).toContain("attachments/");
});

test("dirHash changes with the content and is empty for a missing dir", () => {
  const home = tempHome();
  writeFileSync(join(home, "a"), "1");
  const before = dirHash(home);
  writeFileSync(join(home, "a"), "2");
  expect(dirHash(home)).not.toBe(before);
  expect(dirHash(join(home, "missing"))).toBe("");
});
