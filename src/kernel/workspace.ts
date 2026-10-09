import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";

/** The last-known-good tag. */
export const LKG = "japa-lkg";

const IGNORED = ["state.db*", "secrets/", "japa.sock", "daemon.lock", "node_modules/", ".staging/", ".cache/", "boots.json", "attachments/", "/desktop/", "logs/", "setup.json", "update.json*", ".jobs/"];

/**
 * Runs git in `home` as japa, with neither the user's global config, ignore and attributes files nor any hooks: jobs
 * can write them all, and the daemon's git runs outside their sandbox.
 */
export function git(home: string, ...args: string[]): string {
  return run(home, args).trim();
}

/** `git` for a NUL-separated list (`-z` in `args`): the paths, exactly as git wrote them. */
export function gitPaths(home: string, ...args: string[]): string[] {
  return run(home, args).split("\0").filter((path) => path !== "");
}

/** What git said when `git` threw: its stderr, else the error's message. */
export function gitError(error: unknown): string {
  const stderr = (error as { stderr?: unknown } | undefined)?.stderr;
  if (typeof stderr === "string" && stderr.trim() !== "") return stderr.trim();
  return error instanceof Error ? error.message : String(error);
}

function run(home: string, args: string[]): string {
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
    maxBuffer: 1024 ** 3,
  });
}

/** The components the daemon loads from the workspace; only japa commits changes to them. */
const COMPONENTS = ["extensions", "skills"];

/**
 * Makes `home` a git repo on `main` with an initial commit and the `LKG` tag, which starts at HEAD. Commits the
 * `IGNORED` lines missing from `.gitignore`.
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
}

/**
 * Retires the `staging` worktree older versions kept at `<home>/.staging`: moves its untracked files under
 * `<home>/.jobs/staging-archive/` (pruned by age, see clone.ts), then removes the worktree and the `staging` branch.
 * A `.staging` git can't handle (moved, or its worktree record gone) is moved there whole, as `.staging` (or
 * `.staging-<n>`). Never throws: what fails is logged and left.
 */
export function retireStaging(home: string): void {
  const staging = join(home, ".staging");
  if (existsSync(staging)) {
    try {
      if (!existsSync(join(staging, ".git"))) throw new Error("not a git worktree");
      const archive = join(home, ".jobs", "staging-archive");
      for (const path of gitPaths(staging, "ls-files", "--others", "--exclude-standard", "-z")) {
        const to = join(archive, path);
        mkdirSync(dirname(to), { recursive: true });
        renameSync(join(staging, path), to);
      }
      git(home, "worktree", "remove", "--force", "--force", ".staging"); // locked too
    } catch (error) {
      console.error(`Couldn't remove the worktree ${staging} (${gitError(error)}); archiving it whole`);
      try {
        archiveWhole(home, staging);
      } catch (error) {
        console.error(`Couldn't archive ${staging}: ${gitError(error)}`);
      }
    }
  }
  try {
    git(home, "worktree", "prune"); // the record of one removed by hand, or archived
  } catch (error) {
    console.error(`Couldn't prune the workspace's worktrees: ${gitError(error)}`);
  }
  try {
    git(home, "branch", "-D", "staging");
  } catch {
    // no such branch, or still checked out: harmless
  }
}

/** Moves `dir` into `<home>/.jobs/staging-archive/`, under its own name or, if that's taken, `<name>-<n>`. */
function archiveWhole(home: string, dir: string): void {
  const archive = join(home, ".jobs", "staging-archive");
  mkdirSync(archive, { recursive: true });
  let to = join(archive, basename(dir));
  for (let n = 2; existsSync(to); n++) to = join(archive, `${basename(dir)}-${n}`);
  renameSync(dir, to);
}

/**
 * Aborts a merge, revert, cherry-pick or rebase left unfinished (the daemon or a person stopped mid-way), so the
 * working tree is HEAD's again. Throws git's error when one can't be aborted.
 */
export function abortPending(home: string): void {
  const dotGit = (name: string) => existsSync(join(home, ".git", name));
  if (dotGit("MERGE_HEAD")) git(home, "merge", "--abort");
  if (dotGit("REVERT_HEAD")) git(home, "revert", "--abort");
  if (dotGit("CHERRY_PICK_HEAD")) git(home, "cherry-pick", "--abort");
  if (dotGit("rebase-merge") || dotGit("rebase-apply")) git(home, "rebase", "--abort");
}

/**
 * Commits the uncommitted changes to the workspace's extensions and skills, made by hand or by an older japa: they
 * are what the daemon ran, as it loads the working tree. The new sha, or undefined when there were none.
 */
export function adoptOutsideEdits(home: string): string | undefined {
  return commit(home, COMPONENTS, "Edits made outside japa");
}

/**
 * Spec §6.1, at boot before anything loads: retires staging, aborts what's unfinished, and adopts edits made outside
 * japa. Never throws: `errors` says what failed. When aborting fails, nothing is adopted: the working tree may hold
 * an unfinished operation's changes.
 */
export function tidyWorkspace(home: string): { adopted?: string; errors: string[] } {
  retireStaging(home);
  try {
    abortPending(home);
    const adopted = adoptOutsideEdits(home);
    return { ...(adopted !== undefined && { adopted }), errors: [] };
  } catch (error) {
    const text = `Couldn't finish tidying the workspace: ${gitError(error)}`;
    console.error(text);
    return { errors: [text] };
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

/**
 * Commits the changes under `paths`, and only those (whatever else is staged); the new sha, or undefined when nothing
 * changed. A path neither on disk, nor in the index or HEAD, is skipped.
 */
export function commit(home: string, paths: string[], message: string): string | undefined {
  // `add` takes paths on disk or in the index; `commit`, also those only in HEAD (a staged deletion).
  const added = paths.filter((path) => existsSync(join(home, path)) || git(home, "ls-files", "--", path) !== "");
  const present = paths.filter((path) => added.includes(path) || inHead(home, path));
  if (present.length === 0) return undefined;
  if (added.length > 0) git(home, "add", "-A", "--", ...added);
  if (!git(home, "diff", "--cached", "--name-only", "--", ...present)) return undefined;
  git(home, "commit", "-q", "-m", message, "--", ...present);
  return head(home);
}

export const head = (home: string) => git(home, "rev-parse", "HEAD");

function inHead(home: string, path: string): boolean {
  return hasHead(home) && git(home, "ls-tree", "HEAD", "--", path) !== "";
}

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
  // Only what the revert changed: not what else is staged.
  const reverted = new Set(
    shas.flatMap((sha) =>
      gitPaths(home, "diff-tree", "-r", "--root", "--no-renames", "--no-commit-id", "--name-only", "-z", "-m", "--first-parent", sha),
    ),
  );
  const literal = [...reverted].map((path) => `:(literal)${path}`);
  const changed = literal.length > 0 ? gitPaths(home, "diff", "--cached", "--name-only", "-z", "--", ...literal) : [];
  if (changed.length > 0) {
    git(home, "commit", "-q", "-m", subjects, "--", ...changed.map((path) => `:(literal)${path}`));
  }
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
