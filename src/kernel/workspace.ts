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

// `/secrets`, not `secrets/`: that matches only a directory, and `~/.japa/secrets` may be a symlink to one elsewhere.
// japa's own folders are anchored at the top, so a component's folder of the same name (`extensions/x/logs/`) goes
// live with it; `node_modules/` is ignored everywhere. An older home keeps its own lines; these are appended.
const IGNORED = [
  "state.db*",
  "/secrets",
  "japa.sock",
  "daemon.lock",
  "node_modules/",
  ".staging/",
  "/.cache/",
  "boots.json",
  "/attachments/",
  "/desktop/",
  "/logs/",
  "setup.json",
  "update.json*",
  "/.jobs/",
];

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

function run(home: string, args: string[], input?: string): string {
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
    stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    ...(input !== undefined && { input }),
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
 * Retires the `staging` worktree older versions kept at `<home>/.staging`: moves it whole, ignored and edited files
 * too, into `<home>/.jobs/staging-archive/` as `.staging` (or `.staging-<n>`), pruned by age (see clone.ts); then drops
 * its worktree record and the `staging` branch. Never throws: returns what failed, also logged.
 */
export function retireStaging(home: string): string[] {
  const staging = join(home, ".staging");
  const errors: string[] = [];
  const failed = (what: string, error: unknown) => {
    const text = `Couldn't ${what}: ${gitError(error)}`;
    console.error(text);
    errors.push(text);
  };
  if (existsSync(staging)) {
    try {
      git(home, "worktree", "unlock", ".staging"); // a locked one's record isn't pruned
    } catch {
      // not locked, or not a worktree
    }
    try {
      const archive = join(home, ".jobs", "staging-archive");
      mkdirSync(archive, { recursive: true });
      let to = join(archive, ".staging");
      for (let n = 2; existsSync(to); n++) to = join(archive, `.staging-${n}`);
      renameSync(staging, to);
    } catch (error) {
      failed(`retire the old staging worktree ${staging}`, error);
      return errors;
    }
  }
  try {
    git(home, "worktree", "prune"); // the record of the one archived, or removed by hand
  } catch (error) {
    failed("prune the workspace's worktrees", error);
  }
  try {
    git(home, "branch", "-D", "staging");
  } catch {
    // no such branch
  }
  return errors;
}

/** An operation git couldn't abort: it's still in progress. */
class Unaborted extends Error {
  readonly operation: string;

  constructor(operation: string, error: unknown) {
    super(`the ${operation} in progress couldn't be aborted: ${gitError(error)}`);
    this.operation = operation;
  }
}

/**
 * Aborts a merge, revert, cherry-pick, `git am` or rebase left unfinished (the daemon or a person stopped mid-way), and
 * quits a revert or cherry-pick sequence left between its picks, so the working tree is HEAD's again. Throws an
 * `Unaborted` when one can't be.
 */
export function abortPending(home: string): void {
  const dotGit = (name: string) => existsSync(join(home, ".git", name));
  const abort = (operation: string, ...args: string[]) => {
    try {
      git(home, ...args);
    } catch (error) {
      throw new Unaborted(operation, error);
    }
  };
  if (dotGit("MERGE_HEAD")) abort("merge", "merge", "--abort");
  if (dotGit("REVERT_HEAD")) abort("revert", "revert", "--abort");
  if (dotGit("CHERRY_PICK_HEAD")) abort("cherry-pick", "cherry-pick", "--abort");
  if (dotGit("sequencer")) abort("cherry-pick or revert sequence", "cherry-pick", "--quit");
  if (dotGit("rebase-apply/applying")) abort("git am", "am", "--abort");
  if (dotGit("rebase-merge") || dotGit("rebase-apply")) abort("rebase", "rebase", "--abort");
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
  const errors = retireStaging(home);
  const failed = (error: unknown) => {
    let text = `Couldn't finish tidying the workspace: ${gitError(error)}`;
    if (error instanceof Unaborted) {
      text = text.replace(/\.$/, "");
      text +=
        `. The repo is still mid-${error.operation}, so edits made outside japa weren't adopted; if it's aborted by ` +
        "hand later, the commits japa makes until then may be lost.";
    }
    console.error(text);
    return { errors: [...errors, text] };
  };
  try {
    abortPending(home);
  } catch (error) {
    return failed(error);
  }
  try {
    const adopted = adoptOutsideEdits(home);
    return { ...(adopted !== undefined && { adopted }), errors };
  } catch (error) {
    return failed(error);
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
  const changed = gitPaths(home, "diff", "--cached", "--name-only", "--no-renames", "-z").filter((p) => reverted.has(p));
  if (changed.length > 0) {
    // On stdin: there may be more than fit on a command line.
    const pathspecs = changed.map((path) => `:(literal)${path}\0`).join("");
    run(home, ["commit", "-q", "-m", subjects, "--pathspec-from-file=-", "--pathspec-file-nul"], pathspecs);
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
