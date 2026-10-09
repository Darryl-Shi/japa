import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readlinkSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { cloneBase, cloneDir, ensureClone, pruneClones } from "../src/kernel/jobs/clone.ts";
import { commit, ensureWorkspace } from "../src/kernel/workspace.ts";
import { tempHome } from "./helpers.ts";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const DAY = 86_400_000;

const git = (dir: string, ...args: string[]) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" }).trim();

/** A workspace with `marker` committed. */
function workspace(): string {
  const home = tempHome();
  ensureWorkspace(home);
  writeFileSync(join(home, "marker"), "m");
  commit(home, ["marker"], "marker");
  return home;
}

test("cloneDir is <home>/.jobs/<jobId>, for job ids only", () => {
  expect(cloneDir("/h", "12")).toBe("/h/.jobs/12");
  for (const id of ["", "..", "1/../x", "staging-archive"]) expect(() => cloneDir("/h", id)).toThrow();
});

test("ensureClone makes a clone at HEAD, with its base outside it and no remote", () => {
  const home = workspace();
  const dir = ensureClone(home, packageRoot, "1");
  expect(dir).toBe(join(home, ".jobs", "1"));
  expect(git(dir, "rev-parse", "HEAD")).toBe(git(home, "rev-parse", "HEAD"));
  expect(readFileSync(join(dir, "marker"), "utf8")).toBe("m");
  // The starting commit is out of the job's reach: a fetch inside the sandbox can't move it.
  expect(readFileSync(join(home, ".jobs", "1.base"), "utf8").trim()).toBe(git(home, "rev-parse", "HEAD"));
  expect(cloneBase(home, "1")).toBe(git(home, "rev-parse", "HEAD"));
  expect(git(dir, "remote")).toBe("");
  expect(readlinkSync(join(dir, "node_modules", "japa"))).toBe(resolve(packageRoot));
  expect(statSync(join(home, ".jobs", "1.tmp")).isDirectory()).toBe(true);
  // Its objects are its own: nothing hardlinked to the real repo, nor borrowed through alternates.
  expect(existsSync(join(dir, ".git", "objects", "info", "alternates"))).toBe(false);
  const objects = git(dir, "count-objects", "-v");
  expect(objects).toMatch(/^count: [1-9]/m);
  const loose = git(dir, "rev-parse", "--git-path", "objects");
  const sample = execFileSync("find", [resolve(dir, loose), "-type", "f", "-links", "+1"], { encoding: "utf8" });
  expect(sample).toBe("");
  // `.jobs/` is ignored: the real tree stays clean.
  expect(git(home, "status", "--porcelain")).toBe("");
});

test("ensureClone is idempotent", () => {
  const home = workspace();
  const dir = ensureClone(home, packageRoot, "1");
  writeFileSync(join(dir, "work"), "w");
  writeFileSync(join(home, "marker"), "changed");
  commit(home, ["marker"], "later");
  expect(ensureClone(home, packageRoot, "1")).toBe(dir);
  expect(readFileSync(join(dir, "work"), "utf8")).toBe("w");
  expect(readFileSync(join(dir, "marker"), "utf8")).toBe("m");
  expect(cloneBase(home, "1")).toBe(git(dir, "rev-parse", "HEAD"));
  expect(cloneBase(home, "2")).toBeUndefined();
});

test("ensureClone makes again a clone it didn't finish", () => {
  const home = workspace();
  // Interrupted before its base was written: nothing of the job's is in it yet.
  mkdirSync(join(home, ".jobs", "1"), { recursive: true });
  writeFileSync(join(home, ".jobs", "1", "partial"), "p");
  const dir = ensureClone(home, packageRoot, "1");
  expect(existsSync(join(dir, "partial"))).toBe(false);
  expect(readFileSync(join(dir, "marker"), "utf8")).toBe("m");
  expect(cloneBase(home, "1")).toBe(git(home, "rev-parse", "HEAD"));
});

test("the daemon's git ignores the user's global config and hooks", () => {
  const home = workspace();
  // A job can write the user's git config; a hook there would run outside its sandbox.
  const user = tempHome();
  const ran = join(user, "ran");
  mkdirSync(join(user, "hooks"));
  writeFileSync(join(user, "hooks", "post-checkout"), `#!/bin/sh\ntouch "${ran}"\n`, { mode: 0o755 });
  writeFileSync(join(user, ".gitconfig"), `[core]\n\thooksPath = ${join(user, "hooks")}\n`);
  const saved = process.env.HOME;
  process.env.HOME = user;
  try {
    ensureClone(home, packageRoot, "1");
  } finally {
    process.env.HOME = saved;
  }
  expect(existsSync(ran)).toBe(false);
});

test("pruneClones removes old and orphaned clones, keeps recent ones", () => {
  const home = workspace();
  const now = Date.now();
  for (const id of ["1", "2", "3", "4"]) ensureClone(home, packageRoot, id);
  const jobs = join(home, ".jobs");
  const age = (path: string, days: number) => utimesSync(path, (now - days * DAY) / 1000, (now - days * DAY) / 1000);
  age(join(jobs, "1"), 8); // kept too long
  age(join(jobs, "2"), 1); // recent and kept
  // 3: recent, but its job is gone
  age(join(jobs, "4"), 6); // recent and kept
  mkdirSync(join(jobs, "staging-archive"));
  mkdirSync(join(jobs, "5.tmp")); // left without its clone
  writeFileSync(join(jobs, "6.base"), "x");
  pruneClones(home, (id) => id !== "3", now);
  const left = ["1", "2", "3", "4"].flatMap((id) => [id, `${id}.base`, `${id}.tmp`]);
  expect(left.filter((name) => existsSync(join(jobs, name)))).toEqual(["2", "2.base", "2.tmp", "4", "4.base", "4.tmp"]);
  expect(["staging-archive", "5.tmp", "6.base"].filter((name) => existsSync(join(jobs, name)))).toEqual([
    "staging-archive",
  ]);

  // The staging archive goes only by age, whatever `keep` says.
  pruneClones(home, () => false, now);
  expect(existsSync(join(jobs, "staging-archive"))).toBe(true);
  age(join(jobs, "staging-archive"), 8);
  pruneClones(home, () => true, now);
  expect(existsSync(join(jobs, "staging-archive"))).toBe(false);
});

test("pruneClones without a .jobs dir does nothing", () => {
  const home = workspace();
  expect(() => pruneClones(home, () => false)).not.toThrow();
});
