import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
  const home = workspace();
  mkdirSync(join(home, "secrets"));
  writeFileSync(join(home, "secrets", "x"), "secret");
  writeFileSync(join(home, "state.db"), "db");
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

test("dirHash changes with the content and is empty for a missing dir", () => {
  const home = tempHome();
  writeFileSync(join(home, "a"), "1");
  const before = dirHash(home);
  writeFileSync(join(home, "a"), "2");
  expect(dirHash(home)).not.toBe(before);
  expect(dirHash(join(home, "missing"))).toBe("");
});
