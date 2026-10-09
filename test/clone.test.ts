import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, onTestFinished, test, vi } from "vitest";
import {
  cloneBase,
  cloneDir,
  cloneMarker,
  ensureClone,
  jobLife,
  pruneClones,
  pruneJobRefs,
  removeClone,
} from "../src/kernel/jobs/clone.ts";
import type { Job, JobStatus } from "../src/kernel/jobs/state.ts";
import { commit, ensureWorkspace, git as daemonGit } from "../src/kernel/workspace.ts";
import { tempHome } from "./helpers.ts";

/** Paths `rmSync` fails on, standing in for an entry that can't be removed. */
const unremovable = vi.hoisted(() => new Set<string>());
vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs")>();
  const rmSync: typeof fs.rmSync = (path, options) => {
    if (unremovable.has(String(path))) throw new Error(`EBUSY: can't remove ${String(path)}`);
    fs.rmSync(path, options);
  };
  return { ...fs, rmSync };
});

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

test("the daemon's git ignores the user's default ignore and attributes files", () => {
  const home = workspace();
  // Read without any global config, from ~/.config/git; a job can write them.
  const user = tempHome();
  mkdirSync(join(user, ".config", "git"), { recursive: true });
  writeFileSync(join(user, ".config", "git", "ignore"), "unseen\n");
  writeFileSync(join(user, ".config", "git", "attributes"), "* japa-test-attr\n");
  writeFileSync(join(home, "unseen"), "x");
  const saved = { HOME: process.env.HOME, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME };
  process.env.HOME = user;
  delete process.env.XDG_CONFIG_HOME;
  onTestFinished(() => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
  expect(daemonGit(home, "status", "--porcelain")).toContain("unseen");
  expect(daemonGit(home, "check-attr", "japa-test-attr", "--", "marker")).toBe("marker: japa-test-attr: unspecified");
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
  pruneClones(home, (id) => (id === "3" ? undefined : "finished"), now);
  const left = ["1", "2", "3", "4"].flatMap((id) => [id, `${id}.base`, `${id}.tmp`]);
  expect(left.filter((name) => existsSync(join(jobs, name)))).toEqual(["2", "2.base", "2.tmp", "4", "4.base", "4.tmp"]);
  expect(["staging-archive", "5.tmp", "6.base"].filter((name) => existsSync(join(jobs, name)))).toEqual([
    "staging-archive",
  ]);

  // The staging archive goes only by age, whatever `keep` says.
  pruneClones(home, () => undefined, now);
  expect(existsSync(join(jobs, "staging-archive"))).toBe(true);
  age(join(jobs, "staging-archive"), 8);
  pruneClones(home, () => "active", now);
  expect(existsSync(join(jobs, "staging-archive"))).toBe(false);
});

test("pruneClones never removes an active job's clone or files, whatever their age", () => {
  const home = workspace();
  const now = Date.now();
  ensureClone(home, packageRoot, "1");
  const jobs = join(home, ".jobs");
  const old = (now - 30 * DAY) / 1000;
  utimesSync(join(jobs, "1"), old, old);
  writeFileSync(cloneMarker(home, "1"), "{}");
  mkdirSync(join(jobs, "2.tmp")); // its clone not made yet, or being made again
  pruneClones(home, () => "active", now);
  expect(readdirSync(jobs).sort()).toEqual(["1", "1.base", "1.merged", "1.tmp", "2.tmp"]);
  pruneClones(home, () => "finished", now);
  expect(readdirSync(jobs)).toEqual([]);
});

/** A job with `status`, and `extra`. */
const job = (status: JobStatus, extra: Partial<Job> = {}) => ({ status, ...extra }) as Job;

test("jobLife: queued, running, needs_input or publishing jobs are active, other known ones finished", () => {
  const life = jobLife({
    "1": job("queued"),
    "2": job("running"),
    "3": job("needs_input"),
    "4": job("done", { publishing: 3 }),
    "5": job("done"),
    "6": job("failed"),
    "7": job("cancelled"),
  });
  expect(["1", "2", "3", "4", "5", "6", "7", "8"].map(life)).toEqual([
    "active",
    "active",
    "active",
    "active",
    "finished",
    "finished",
    "finished",
    undefined,
  ]);
  expect(life("toString")).toBeUndefined();
});

test("pruneJobRefs deletes the leftover job refs of jobs that aren't active", () => {
  const home = workspace();
  for (const id of ["1", "2", "3"]) git(home, "update-ref", `refs/japa/jobs/${id}`, "HEAD");
  git(home, "update-ref", "refs/japa/other", "HEAD");
  pruneJobRefs(home, (id) => (id === "1" ? "active" : id === "2" ? "finished" : undefined));
  expect(git(home, "for-each-ref", "--format=%(refname)", "refs/japa").split("\n")).toEqual([
    "refs/japa/jobs/1",
    "refs/japa/other",
  ]);
  pruneJobRefs(home, () => undefined);
  expect(git(home, "for-each-ref", "--format=%(refname)", "refs/japa")).toBe("refs/japa/other");
});

test("pruneClones removes folders a job made inaccessible, and goes on past an entry it can't remove", () => {
  const home = workspace();
  for (const id of ["1", "2", "3"]) ensureClone(home, packageRoot, id);
  const jobs = join(home, ".jobs");
  const outside = tempHome();
  writeFileSync(join(outside, "keep"), "k");
  chmodSync(outside, 0o500);
  onTestFinished(() => chmodSync(outside, 0o700));
  for (const dir of [join(jobs, "1", "locked", "deeper"), join(jobs, "3.tmp", "locked")]) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "f"), "x");
  }
  // A symlink to a folder outside: neither followed nor changed.
  symlinkSync(outside, join(jobs, "1", "link"));
  chmodSync(join(jobs, "1", "locked", "deeper"), 0o000);
  chmodSync(join(jobs, "1", "locked"), 0o000);
  chmodSync(join(jobs, "3.tmp", "locked"), 0o000);
  unremovable.add(join(jobs, "2"));
  onTestFinished(() => unremovable.clear());
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  onTestFinished(() => errors.mockRestore());
  pruneClones(home, () => undefined);
  const left = ["1", "2", "3"].flatMap((id) => [id, `${id}.base`, `${id}.tmp`]);
  expect(left.filter((name) => existsSync(join(jobs, name)))).toEqual(["2"]);
  expect(errors).toHaveBeenCalledWith(expect.stringContaining(join(jobs, "2")));
  expect(statSync(outside).mode & 0o777).toBe(0o500);
  expect(readFileSync(join(outside, "keep"), "utf8")).toBe("k");
});

test("pruneClones removes a clone's merge marker with it, and orphaned ones", () => {
  const home = workspace();
  for (const id of ["1", "2"]) ensureClone(home, packageRoot, id);
  const jobs = join(home, ".jobs");
  expect(cloneMarker(home, "1")).toBe(join(jobs, "1.merged"));
  // `.merged.new`: one being written when the daemon stopped.
  for (const id of ["1", "2", "3"]) writeFileSync(cloneMarker(home, id), "{}");
  for (const id of ["1", "3"]) writeFileSync(`${cloneMarker(home, id)}.new`, "{");
  pruneClones(home, (id) => (id === "2" ? "finished" : undefined));
  expect(readdirSync(jobs).sort()).toEqual(["2", "2.base", "2.merged", "2.tmp"]);
});

test("removeClone deletes a clone with its base, temp dir and marker, and folders the job made inaccessible", () => {
  const home = workspace();
  for (const id of ["1", "2"]) ensureClone(home, packageRoot, id);
  const jobs = join(home, ".jobs");
  writeFileSync(cloneMarker(home, "1"), "{}");
  writeFileSync(`${cloneMarker(home, "1")}.new`, "{");
  mkdirSync(join(jobs, "1", "locked"));
  writeFileSync(join(jobs, "1", "locked", "f"), "x");
  chmodSync(join(jobs, "1", "locked"), 0o000);
  removeClone(home, "1");
  expect(readdirSync(jobs).sort()).toEqual(["2", "2.base", "2.tmp"]);
  expect(() => removeClone(home, "1")).not.toThrow();
});

test("pruneClones without a .jobs dir does nothing", () => {
  const home = workspace();
  expect(() => pruneClones(home, () => undefined)).not.toThrow();
});
