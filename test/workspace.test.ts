import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, onTestFinished, test, vi } from "vitest";
import {
  abortPending,
  adoptOutsideEdits,
  commit,
  dirHash,
  ensureWorkspace,
  restorePath,
  retireStaging,
  revert,
} from "../src/kernel/workspace.ts";
import { tempHome } from "./helpers.ts";

const git = (home: string, ...args: string[]) => execFileSync("git", ["-C", home, ...args], { encoding: "utf8" }).trim();

function workspace(): string {
  const home = tempHome();
  ensureWorkspace(home);
  return home;
}

test("a secrets directory symlinked out of the workspace is ignored, in a new workspace and an older one", () => {
  const outside = tempHome();
  for (const before of [undefined, "secrets/\n"]) {
    const home = tempHome();
    if (before !== undefined) writeFileSync(join(home, ".gitignore"), before);
    symlinkSync(outside, join(home, "secrets"));
    ensureWorkspace(home);
    expect(git(home, "ls-files")).toBe(".gitignore");
    expect(git(home, "status", "--porcelain")).toBe("");
  }
});

test("ensureWorkspace creates the repo, .gitignore and the initial commit, idempotently", () => {
  const home = workspace();
  ensureWorkspace(home);
  expect(readFileSync(join(home, ".gitignore"), "utf8").split("\n")).toContain("/secrets");
  expect(git(home, "log", "--format=%s")).toBe("Initial workspace");
  expect(git(home, "branch", "--show-current")).toBe("main");
});

test("ensureWorkspace no longer creates .staging", () => {
  const home = workspace();
  expect(existsSync(join(home, ".staging"))).toBe(false);
  expect(git(home, "branch", "--list", "staging")).toBe("");
  expect(git(home, "worktree", "list").split("\n")).toHaveLength(1);
});

/** `home` as an older japa left it: a `staging` worktree at `.staging`. */
function withStaging(home: string): string {
  git(home, "worktree", "add", "-q", "-B", "staging", ".staging", "main");
  return join(home, ".staging");
}

test("retireStaging archives the whole .staging, ignored and edited files too, and removes the worktree and branch", () => {
  const home = workspace();
  const staging = withStaging(home);
  mkdirSync(join(staging, "skills", "draft"), { recursive: true });
  writeFileSync(join(staging, "skills", "draft", "SKILL.md"), "draft");
  writeFileSync(join(staging, "notes with space.md"), "notes");
  writeFileSync(join(staging, ".gitignore"), "changed, tracked\n");
  mkdirSync(join(staging, "extensions", "x", "node_modules"), { recursive: true });
  writeFileSync(join(staging, "extensions", "x", "node_modules", "a"), "ignored");
  expect(retireStaging(home)).toEqual([]);
  const archive = join(home, ".jobs", "staging-archive", ".staging");
  expect(readFileSync(join(archive, "skills", "draft", "SKILL.md"), "utf8")).toBe("draft");
  expect(readFileSync(join(archive, "notes with space.md"), "utf8")).toBe("notes");
  expect(readFileSync(join(archive, ".gitignore"), "utf8")).toBe("changed, tracked\n");
  expect(readFileSync(join(archive, "extensions", "x", "node_modules", "a"), "utf8")).toBe("ignored");
  expect(existsSync(staging)).toBe(false);
  expect(git(home, "branch", "--list", "staging")).toBe("");
  expect(git(home, "worktree", "list").split("\n")).toHaveLength(1);
  expect(git(home, "status", "--porcelain")).toBe("");
  expect(retireStaging(home)).toEqual([]); // nothing left to retire
});

test("retireStaging removes the branch and worktree record of a hand-deleted .staging", () => {
  const home = workspace();
  rmSync(withStaging(home), { recursive: true, force: true });
  retireStaging(home);
  expect(git(home, "branch", "--list", "staging")).toBe("");
  expect(git(home, "worktree", "list").split("\n")).toHaveLength(1);
});

/** The files under `dir`, relative to it, sorted. */
const filesIn = (dir: string) =>
  readdirSync(dir, { recursive: true, encoding: "utf8" })
    .filter((f) => statSync(join(dir, f)).isFile())
    .sort();

test("retireStaging archives a .staging whose worktree record is gone whole, beside an earlier archive", () => {
  const home = workspace();
  const staging = withStaging(home);
  writeFileSync(join(staging, "draft.md"), "draft");
  const archive = join(home, ".jobs", "staging-archive");
  mkdirSync(join(archive, ".staging"), { recursive: true });
  writeFileSync(join(archive, ".staging", "earlier.md"), "earlier");
  rmSync(join(home, ".git", "worktrees"), { recursive: true }); // its .git file now names a missing gitdir
  expect(retireStaging(home)).toEqual([]);
  expect(existsSync(staging)).toBe(false);
  expect(filesIn(archive)).toEqual([".staging-2/.git", ".staging-2/.gitignore", ".staging-2/draft.md", ".staging/earlier.md"]);
  expect(git(home, "branch", "--list", "staging")).toBe("");
  expect(git(home, "worktree", "list").split("\n")).toHaveLength(1);
});

test("retireStaging returns what failed, leaving .staging in place", () => {
  const home = workspace();
  const staging = withStaging(home);
  mkdirSync(join(home, ".jobs"), { mode: 0o500 });
  onTestFinished(() => chmodSync(join(home, ".jobs"), 0o700));
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  onTestFinished(() => errors.mockRestore());
  expect(retireStaging(home)).toEqual([expect.stringMatching(/^Couldn't retire the old staging worktree .*\.staging: .*EACCES/)]);
  expect(existsSync(join(staging, ".git"))).toBe(true);
});

test("retireStaging removes a locked worktree", () => {
  const home = workspace();
  const staging = withStaging(home);
  git(home, "worktree", "lock", ".staging");
  expect(retireStaging(home)).toEqual([]);
  expect(existsSync(staging)).toBe(false);
  expect(git(home, "branch", "--list", "staging")).toBe("");
  expect(git(home, "worktree", "list").split("\n")).toHaveLength(1);
});

/** `home` with `f` committed on main and changed on branch `other`, which main's next change conflicts with. */
function diverged(home: string): string {
  const file = join(home, "f");
  writeFileSync(file, "v0\n");
  commit(home, ["f"], "v0");
  git(home, "checkout", "-q", "-b", "other");
  writeFileSync(file, "other\n");
  commit(home, ["f"], "other");
  git(home, "checkout", "-q", "main");
  writeFileSync(file, "v1\n");
  commit(home, ["f"], "v1");
  return file;
}

test("abortPending aborts a cherry-pick or a rebase in progress", () => {
  const home = workspace();
  const file = diverged(home);
  const main = git(home, "rev-parse", "HEAD");
  const t = ["-c", "user.name=t", "-c", "user.email=t@t"];
  expect(() => git(home, ...t, "cherry-pick", "other")).toThrow();
  expect(existsSync(join(home, ".git", "CHERRY_PICK_HEAD"))).toBe(true);
  abortPending(home);
  expect(existsSync(join(home, ".git", "CHERRY_PICK_HEAD"))).toBe(false);
  expect(readFileSync(file, "utf8")).toBe("v1\n");

  for (const backend of ["--merge", "--apply"]) {
    expect(() => git(home, ...t, "rebase", backend, "other")).toThrow();
    const dir = backend === "--merge" ? "rebase-merge" : "rebase-apply";
    expect(existsSync(join(home, ".git", dir))).toBe(true);
    abortPending(home);
    expect(existsSync(join(home, ".git", dir))).toBe(false);
    expect(git(home, "branch", "--show-current")).toBe("main");
    expect(git(home, "rev-parse", "HEAD")).toBe(main);
    expect(readFileSync(file, "utf8")).toBe("v1\n");
  }
  expect(git(home, "status", "--porcelain")).toBe("");
});

test("abortPending aborts a git am in progress, and quits a sequence left between its picks", () => {
  const home = workspace();
  const file = diverged(home);
  const main = git(home, "rev-parse", "HEAD");
  const t = ["-c", "user.name=t", "-c", "user.email=t@t"];
  const patch = join(tempHome(), "p.patch");
  writeFileSync(patch, git(home, "format-patch", "-1", "--stdout", "other") + "\n");
  expect(() => git(home, ...t, "am", patch)).toThrow();
  expect(existsSync(join(home, ".git", "rebase-apply", "applying"))).toBe(true);
  abortPending(home);
  expect(existsSync(join(home, ".git", "rebase-apply"))).toBe(false);
  expect(git(home, "rev-parse", "HEAD")).toBe(main);
  expect(readFileSync(file, "utf8")).toBe("v1\n");

  // Two picks, the first conflicting: resolved and committed, the sequence is left mid-way.
  git(home, "checkout", "-q", "other");
  writeFileSync(join(home, "g"), "g\n");
  commit(home, ["g"], "g");
  git(home, "checkout", "-q", "main");
  expect(() => git(home, ...t, "cherry-pick", "other~1", "other")).toThrow();
  writeFileSync(file, "resolved\n");
  git(home, "add", "f");
  git(home, ...t, "commit", "-q", "--no-edit");
  expect(existsSync(join(home, ".git", "CHERRY_PICK_HEAD"))).toBe(false);
  expect(existsSync(join(home, ".git", "sequencer"))).toBe(true);
  abortPending(home);
  expect(existsSync(join(home, ".git", "sequencer"))).toBe(false);
  expect(git(home, "status", "--porcelain")).toBe("");
});

test("abortPending aborts an unfinished merge or revert", () => {
  const home = workspace();
  const file = join(home, "f");
  writeFileSync(file, "v0\n");
  commit(home, ["f"], "v0");
  git(home, "checkout", "-q", "-b", "other");
  writeFileSync(file, "other\n");
  commit(home, ["f"], "other");
  git(home, "checkout", "-q", "main");
  writeFileSync(file, "v1\n");
  const v1 = commit(home, ["f"], "v1")!;
  expect(() => git(home, "merge", "other")).toThrow();
  expect(existsSync(join(home, ".git", "MERGE_HEAD"))).toBe(true);
  abortPending(home);
  expect(existsSync(join(home, ".git", "MERGE_HEAD"))).toBe(false);
  expect(readFileSync(file, "utf8")).toBe("v1\n");

  writeFileSync(file, "v2\n");
  commit(home, ["f"], "v2");
  expect(() => git(home, "-c", "user.name=t", "-c", "user.email=t@t", "revert", "--no-edit", v1)).toThrow();
  expect(existsSync(join(home, ".git", "REVERT_HEAD"))).toBe(true);
  abortPending(home);
  expect(existsSync(join(home, ".git", "REVERT_HEAD"))).toBe(false);
  expect(readFileSync(file, "utf8")).toBe("v2\n");
  expect(git(home, "status", "--porcelain")).toBe("");
  abortPending(home); // nothing pending
});

test("adoptOutsideEdits commits only extensions and skills", () => {
  const home = workspace();
  writeFileSync(join(home, "settings.json"), "{}\n");
  writeFileSync(join(home, "other.txt"), "one\n");
  commit(home, ["settings.json", "other.txt"], "settings");
  mkdirSync(join(home, "extensions", "e"), { recursive: true });
  writeFileSync(join(home, "extensions", "e", "index.ts"), "export default {};\n");
  mkdirSync(join(home, "skills", "s"), { recursive: true });
  writeFileSync(join(home, "skills", "s", "SKILL.md"), "s");
  writeFileSync(join(home, "settings.json"), '{"x":1}\n');
  writeFileSync(join(home, "other.txt"), "two\n");
  git(home, "add", "other.txt"); // staged by hand: still not japa's to commit
  const sha = adoptOutsideEdits(home)!;
  expect(sha).toBe(git(home, "rev-parse", "HEAD"));
  expect(git(home, "log", "-1", "--format=%s")).toBe("Edits made outside japa");
  expect(git(home, "show", "--name-only", "--format=", sha).split("\n").sort()).toEqual([
    "extensions/e/index.ts",
    "skills/s/SKILL.md",
  ]);
  expect(git(home, "status", "--porcelain").split("\n").sort()).toEqual([" M settings.json", "M  other.txt"]);
  expect(adoptOutsideEdits(home)).toBeUndefined();
});

test("adoptOutsideEdits adopts a hand-staged deletion", () => {
  const home = workspace();
  mkdirSync(join(home, "skills", "s"), { recursive: true });
  writeFileSync(join(home, "skills", "s", "SKILL.md"), "s");
  commit(home, ["skills"], "add s");
  git(home, "rm", "-q", "-r", "skills/s");
  const sha = adoptOutsideEdits(home)!;
  expect(sha).toBe(git(home, "rev-parse", "HEAD"));
  expect(git(home, "show", "--name-status", "--format=", sha)).toBe("D\tskills/s/SKILL.md");
  expect(git(home, "status", "--porcelain")).toBe("");
});

test("adoptOutsideEdits adopts a removal, and does nothing without extensions or skills", () => {
  const home = workspace();
  expect(adoptOutsideEdits(home)).toBeUndefined();
  mkdirSync(join(home, "skills", "s"), { recursive: true });
  writeFileSync(join(home, "skills", "s", "SKILL.md"), "s");
  commit(home, ["skills"], "add s");
  rmSync(join(home, "skills"), { recursive: true });
  expect(adoptOutsideEdits(home)).toBeDefined();
  expect(git(home, "ls-files", "skills")).toBe("");
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

test("revert commits only what it reverted, not what's staged by hand", () => {
  const home = workspace();
  mkdirSync(join(home, "skills", "s"), { recursive: true });
  writeFileSync(join(home, "skills", "s", "SKILL.md"), "one");
  const added = commit(home, ["skills"], "add s")!;
  writeFileSync(join(home, "notes.txt"), "by hand\n");
  git(home, "add", "notes.txt");
  const sha = revert(home, [added]);
  expect(git(home, "show", "--name-status", "--format=", sha)).toBe("D\tskills/s/SKILL.md");
  expect(git(home, "status", "--porcelain")).toBe("A  notes.txt");
});

test("revert commits any number of paths, whatever their names", () => {
  const home = workspace();
  const dir = join(home, "skills", "many");
  mkdirSync(dir, { recursive: true });
  // Over 2 MB of paths: more than fit on a command line.
  const names = Array.from({ length: 12_000 }, (_, i) => `${String(i).padStart(5, "0")}-${"x".repeat(180)}`);
  for (const name of names) writeFileSync(join(dir, name), "");
  writeFileSync(join(dir, "odd *\nname"), "");
  writeFileSync(join(dir, "odd ab"), "");
  const added = commit(home, ["skills"], "add many")!;
  revert(home, [added]);
  expect(git(home, "ls-files", "skills")).toBe("");
  expect(git(home, "status", "--porcelain")).toBe("");
}, 60_000);

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

test("update.json and its temp files are ignored by git, also in a workspace made before them", () => {
  const home = workspace();
  const gitignore = join(home, ".gitignore");
  writeFileSync(gitignore, readFileSync(gitignore, "utf8").replace("update.json*\n", ""));
  commit(home, [".gitignore"], "before update.json");
  ensureWorkspace(home);
  ensureWorkspace(home);
  expect(readFileSync(gitignore, "utf8").split("\n").filter((l) => l === "update.json*")).toHaveLength(1);
  writeFileSync(join(home, "update.json"), "{}");
  writeFileSync(join(home, "update.json.123.tmp"), "{}");
  expect(git(home, "status", "--porcelain")).toBe("");
});

test("appending to a .gitignore without a trailing newline keeps its last line intact", () => {
  const home = tempHome();
  writeFileSync(join(home, ".gitignore"), "build");
  ensureWorkspace(home);
  const lines = readFileSync(join(home, ".gitignore"), "utf8").split("\n");
  expect(lines).toContain("build");
  expect(lines).toContain("attachments/");
  expect(lines).toContain("/desktop/");
});

test("dirHash changes with the content and is empty for a missing dir", () => {
  const home = tempHome();
  writeFileSync(join(home, "a"), "1");
  const before = dirHash(home);
  writeFileSync(join(home, "a"), "2");
  expect(dirHash(home)).not.toBe(before);
  expect(dirHash(join(home, "missing"))).toBe("");
});
