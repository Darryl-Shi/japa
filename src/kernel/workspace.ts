import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, cpSync, existsSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { basename, join } from "node:path";

/** The last-known-good tag. */
export const LKG = "japa-lkg";

const IGNORED = ["state.db*", "secrets/", "japa.sock", "daemon.lock", "node_modules/", ".staging/", ".cache/", "boots.json", "attachments/", "/desktop/", "logs/", "setup.json", "update.json*", ".jobs/"];

/**
 * Runs git in `home` as japa, with neither the user's global config, ignore and attributes files nor any hooks: jobs
 * can write them all, and the daemon's git runs outside their sandbox.
 */
export function git(home: string, ...args: string[]): string {
  const config = [
    "-c", "core.hooksPath=/dev/null",
    "-c", "core.excludesFile=/dev/null",
    "-c", "core.attributesFile=/dev/null",
    "-c", "user.name=japa",
    "-c", "user.email=japa@localhost",
    "-c", "commit.gpgsign=false",
  ];
  return execFileSync("git", ["-C", home, ...config, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" },
  }).trim();
}

/**
 * Makes `home` a git repo on `main` with an initial commit, a `staging` worktree at `<home>/.staging`, and the `LKG`
 * tag, which starts at HEAD. Commits the `IGNORED` lines missing from `.gitignore`.
 */
export function ensureWorkspace(home: string): void {
  if (!existsSync(join(home, ".git"))) git(home, "init", "-q", "-b", "main");
  const gitignore = join(home, ".gitignore");
  const existing = existsSync(gitignore) ? readFileSync(gitignore, "utf8") : "";
  const missing = IGNORED.filter((line) => !existing.split("\n").includes(line));
  const separator = existing === "" || existing.endsWith("\n") ? "" : "\n";
  if (missing.length > 0) appendFileSync(gitignore, `${separator}${missing.join("\n")}\n`);
  if (!hasHead(home)) commit(home, ["."], "Initial workspace");
  if (missing.length > 0) commit(home, [".gitignore"], "Update .gitignore");
  if (!hasTag(home, LKG)) tag(home, LKG);
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
  return head(home);
}

export const head = (home: string) => git(home, "rev-parse", "HEAD");

/**
 * Reverts `shas` (given oldest first) newest first in one commit, or none when they are already undone; returns the
 * new HEAD. On a failure, aborts any revert in progress and throws git's error.
 */
export function revert(home: string, shas: string[]): string {
  try {
    for (const sha of shas.toReversed()) git(home, "revert", "--no-commit", sha);
  } catch (err) {
    if (existsSync(join(home, ".git", "REVERT_HEAD"))) git(home, "revert", "--abort");
    throw err;
  }
  git(home, "revert", "--quit");
  const subjects = git(home, "log", "--no-walk=unsorted", "--format=Revert \"%s\"", ...shas.toReversed());
  if (git(home, "diff", "--cached", "--name-only")) git(home, "commit", "-q", "-m", subjects);
  return head(home);
}

/** Restores `path` as it is at `ref`, removing it when it doesn't exist there. */
export function restorePath(home: string, ref: string, path: string): void {
  if (git(home, "ls-tree", ref, "--", path)) git(home, "checkout", "--no-overlay", ref, "--", path);
  else rmSync(join(home, path), { recursive: true, force: true }); // `commit` stages the removal
}

/** Whether `paths` in the working tree are as at `ref`, with no untracked files. */
export function matches(home: string, ref: string, paths: string[]): boolean {
  if (git(home, "ls-files", "--others", "--exclude-standard", "--", ...paths)) return false;
  try {
    git(home, "diff", "--quiet", ref, "--", ...paths);
    return true;
  } catch {
    return false;
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

/** `<home>/.cache/extensions/<basename>-<dirHash(dir)>`, copied from `dir` if missing, so its modules import afresh. */
export function cachedCopy(home: string, dir: string): string {
  const copy = join(home, ".cache", "extensions", `${basename(dir)}-${dirHash(dir)}`);
  if (!existsSync(copy)) cpSync(dir, copy, { recursive: true });
  return copy;
}
