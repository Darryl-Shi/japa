import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const IGNORED = ["state.db*", "secrets/", "japa.sock", "daemon.lock", "node_modules/", ".staging/", ".cache/", "boots.json"];

function git(home: string, ...args: string[]): string {
  return execFileSync("git", ["-C", home, "-c", "user.name=japa", "-c", "user.email=japa@localhost", "-c", "commit.gpgsign=false", ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

/** Makes `home` a git repo on `main` with an initial commit and a `staging` worktree at `<home>/.staging`. */
export function ensureWorkspace(home: string): void {
  if (!existsSync(join(home, ".git"))) git(home, "init", "-q", "-b", "main");
  if (!existsSync(join(home, ".gitignore"))) writeFileSync(join(home, ".gitignore"), `${IGNORED.join("\n")}\n`);
  if (!hasHead(home)) commit(home, ["."], "Initial workspace");
  if (!existsSync(join(home, ".staging"))) {
    git(home, "worktree", "prune");
    git(home, "worktree", "add", "-q", "-B", "staging", ".staging", "main");
  }
}

function hasHead(home: string): boolean {
  try {
    git(home, "rev-parse", "--verify", "-q", "HEAD");
    return true;
  } catch {
    return false;
  }
}

/** Commits the changes under `paths`; the new sha, or undefined when nothing changed. */
export function commit(home: string, paths: string[], message: string): string | undefined {
  git(home, "add", "-A", "--", ...paths);
  if (!git(home, "diff", "--cached", "--name-only")) return undefined;
  git(home, "commit", "-q", "-m", message);
  return git(home, "rev-parse", "HEAD");
}

/** Reverts `shas` (given oldest first) newest first; returns the new HEAD. On a conflict, aborts and throws. */
export function revert(home: string, shas: string[]): string {
  for (const sha of shas.toReversed()) {
    try {
      git(home, "revert", "--no-edit", sha);
    } catch (err) {
      git(home, "revert", "--abort");
      throw err;
    }
  }
  return git(home, "rev-parse", "HEAD");
}

/** Restores `path` as it is at `ref`, removing it when it doesn't exist there. */
export function restorePath(home: string, ref: string, path: string): void {
  if (git(home, "ls-tree", ref, "--", path)) {
    git(home, "checkout", "--no-overlay", ref, "--", path);
  } else {
    git(home, "rm", "-r", "-q", "--ignore-unmatch", "--", path);
    rmSync(join(home, path), { recursive: true, force: true });
  }
}

export function tag(home: string, name: string): void {
  git(home, "tag", "-f", name, "HEAD");
}

export function hasTag(home: string, name: string): boolean {
  return git(home, "tag", "--list", name) !== "";
}

/** A sha1 over the sorted relative paths and contents of the files in `dir`; "" when `dir` is missing. */
export function dirHash(dir: string): string {
  if (!existsSync(dir)) return "";
  const hash = createHash("sha1");
  const files = readdirSync(dir, { recursive: true, encoding: "utf8" }).filter((f) => statSync(join(dir, f)).isFile());
  for (const file of files.sort()) hash.update(`${file}\0`).update(readFileSync(join(dir, file)));
  return hash.digest("hex");
}
