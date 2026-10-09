// Going live (spec §4.3): a finished job's changes to extensions/ and skills/ are merged into the real `~/.japa`,
// checked before and loaded after, never copied.
//
// The clone, its `.git` included, is the job's: its config, hooks and attributes would run whatever git the daemon ran
// there. So the daemon runs no git in it. The job's sandbox commits and bundles its changes (narrow.ts); the daemon
// fetches that bundle into the real repo, as data, and checks there what it changes.
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { Change } from "../changes.ts";
import type { LoadError } from "../loader.ts";
import { runSandboxed, type SandboxSpec } from "../sandbox/bwrap.ts";
import type { WorkspaceLock } from "../workspace-lock.ts";
import { git, gitError, gitPaths, head } from "../workspace.ts";
import { cloneBase, cloneDir, cloneMarker, removeClone } from "./clone.ts";
import { BUNDLE, inComponents } from "./narrow.ts";

type Kind = "skill" | "extension";

export type PublishDeps = {
  home: string;
  packageRoot: string;
  lock: WorkspaceLock;
  /** Job `jobId`'s sandbox (`JobSandboxes.spec`): where everything that touches its clone runs. */
  spec(jobId: string): SandboxSpec;
  /** The problems `japa check` finds with a component of job `jobId`'s clone (see `sandboxCheck`); `[]` passes. */
  check(jobId: string, kind: Kind, name: string): Promise<string[]>;
  reconcile(): Promise<{ errors: LoadError[]; notices?: string[] }>;
  loaded(kind: Kind, name: string): boolean;
  logChange(change: Omit<Change, "id" | "at">): Promise<string>;
  scheduleGood(): void;
};

/**
 * What publishing a job did to the real repo, in `cloneMarker` (outside the clone, which the job can write): its merge
 * commit, the paths it dropped, then the change logged for it, or the line it ended with once the merge was reverted.
 * A job resumed in publish after a restart goes on from there, and never merges twice.
 */
type Marker = { merge: string; dropped: string[]; change?: string; reverted?: string };

/** How long `japa check` may run, per component. */
const CHECK_TIMEOUT_MS = 600_000;
/** How long committing and bundling a job's changes in its sandbox may take. */
const NARROW_TIMEOUT_MS = 120_000;
/** How many dropped paths an outcome line names. */
const SHOWN = 10;

/** Characters that would break, or disguise, an outcome line: controls, line separators and bidi overrides. */
const UNSAFE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g;

/** A path or message from the job, safe to show on one line. */
const show = (text: string) => text.replace(UNSAFE, "?");

/** `text` (git's error, a check's output) on one line, without its final period, and at most `max` characters. */
function oneLine(text: string, max = 500): string {
  const line = show(text.trim().replace(/\s*\n\s*/g, " ")).replace(/\.$/, "");
  return line.length > max ? `${line.slice(0, max)}…` : line;
}

/** The components (`extensions/<x>`, `skills/<x>`) `paths` are in (each is in one); sorted, each once. */
const componentsOf = (paths: string[]) => [...new Set(paths.map((path) => path.split("/", 2).join("/")))].sort();

/** The kind and name of component `component`. */
function parts(component: string): [Kind, string] {
  const [dir, name] = component.split("/") as [string, string];
  return [dir === "extensions" ? "extension" : "skill", name];
}

/**
 * Copies `path`, which must be a regular file (not a symlink to one, nor a FIFO to wait on), to new file `dest`: as many
 * bytes as it had when opened, though the job may still be writing it.
 */
function copyRegular(path: string, dest: string): void {
  const from = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(from);
    if (!stat.isFile()) throw new Error(`${basename(path)} is not a regular file`);
    const to = openSync(dest, "wx", 0o600);
    try {
      const buffer = Buffer.alloc(1024 * 1024);
      for (let left = stat.size; left > 0; ) {
        const read = readSync(from, buffer, 0, Math.min(buffer.length, left), null);
        if (read === 0) break;
        writeSync(to, buffer, 0, read);
        left -= read;
      }
    } finally {
      closeSync(to);
    }
  } finally {
    closeSync(from);
  }
}

/**
 * `PublishDeps.check`: `japa check <kind> <name>` in job `jobId`'s sandbox, where `home` is its clone, with a 10-minute
 * timeout; the command's output when it fails.
 */
export function sandboxCheck(
  spec: (jobId: string) => SandboxSpec,
  home: string,
  packageRoot: string,
): PublishDeps["check"] {
  const main = join(packageRoot, "src", "cli", "main.ts");
  return async (jobId, kind, name) => {
    // The sandbox passes no JAPA_HOME: without it, the CLI's home would be `~/.japa`, wherever `home` is.
    const node = [process.execPath, "--disable-warning=ExperimentalWarning", main];
    const command = ["/usr/bin/env", `JAPA_HOME=${home}`, ...node, "check", kind, name];
    const { code, output, timedOut } = await runSandboxed(spec(jobId), command, {
      timeoutMs: CHECK_TIMEOUT_MS,
      cwd: home,
    });
    if (timedOut) return ["timed out after 10 minutes"];
    return code === 0 ? [] : [output.trim() || `japa check exited with ${code}`];
  };
}

/**
 * Publishes job `id`'s changes to extensions/ and skills/ (spec §4.3); the outcome line for its report, or undefined
 * when there's nothing to publish (no clone, or no change left once narrowed). The clone is deleted once its changes are
 * live or when there are none, and kept otherwise.
 */
export function createPublisher(deps: PublishDeps): (job: { id: string; title: string }) => Promise<string | undefined> {
  const { home } = deps;

  const isAncestor = (ancestor: string, rev: string) => {
    try {
      git(home, "merge-base", "--is-ancestor", ancestor, rev);
      return true;
    } catch (error) {
      if ((error as { status?: number }).status === 1) return false;
      throw error;
    }
  };
  const exists = (rev: string) => {
    try {
      git(home, "rev-parse", "-q", "--verify", rev);
      return true;
    } catch {
      return false;
    }
  };
  const inTree = (rev: string, path: string) =>
    gitPaths(home, "--literal-pathspecs", "ls-tree", "-z", "--name-only", rev, "--", path).length > 0;

  function readMarker(id: string): Marker | undefined {
    try {
      return JSON.parse(readFileSync(cloneMarker(home, id), "utf8")) as Marker;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  function writeMarker(id: string, marker: Marker): void {
    const file = cloneMarker(home, id);
    writeFileSync(`${file}.new`, JSON.stringify(marker));
    renameSync(`${file}.new`, file);
  }

  /** Commits and bundles the job's changes in its sandbox (narrow.ts): what it dropped and whether there's a bundle. */
  async function narrowInSandbox(id: string, base: string, message: string) {
    const script = join(deps.packageRoot, "src", "kernel", "jobs", "narrow.ts");
    // `/tmp` in the sandbox is the job's own temp dir, `spec.tmp` on the host.
    const command = [process.execPath, "--disable-warning=ExperimentalWarning", script, base, message, "/tmp"];
    const { code, output, timedOut } = await runSandboxed(deps.spec(id), command, {
      timeoutMs: NARROW_TIMEOUT_MS,
      cwd: home,
    });
    if (timedOut) return { error: "timed out after 2 minutes" };
    if (code === 0) {
      try {
        const result = JSON.parse(output.trim().split("\n").at(-1) ?? "") as { dropped?: unknown; bundle?: unknown };
        const { dropped, bundle } = result;
        if (Array.isArray(dropped) && dropped.every((p) => typeof p === "string") && typeof bundle === "boolean") {
          return { dropped: dropped as string[], bundle };
        }
      } catch {}
    }
    return { error: oneLine(output) || `it exited with ${code}` };
  }

  /** Fetches the job's bundle at `path` (in its temp dir, which it can write) to `ref` in the real repo; its commit. */
  function fetchBundle(path: string, ref: string): string {
    const dir = mkdtempSync(join(tmpdir(), "japa-publish-"));
    try {
      const bundle = join(dir, BUNDLE);
      copyRegular(path, bundle);
      git(home, "bundle", "verify", "-q", bundle);
      const fetch = ["fetch", "-q", "--no-auto-gc", "--no-write-fetch-head", bundle, `+HEAD:${ref}`];
      git(home, "-c", "transfer.fsckObjects=true", ...fetch);
      return git(home, "rev-parse", "--verify", `${ref}^{commit}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  /** The merge of `sha` already in HEAD's history: one from before a restart that left no marker. */
  function earlierMerge(sha: string): string | undefined {
    const merges = git(home, "log", "--merges", "--format=%H %P", `${sha}..HEAD`).split("\n");
    return merges.map((line) => line.split(" ")).find((shas) => shas[2] === sha)?.[0];
  }

  /**
   * Under the lock, once merged: reconciles, and reverts the merge if a component it changed that still exists fails to
   * load; else logs the change (once) and schedules the good tag.
   */
  async function load(id: string, base: string, marker: Marker, notLive: (reason: string) => string) {
    const components = componentsOf(
      gitPaths(home, "diff", "--name-only", "--no-renames", "-z", base, `${marker.merge}^2`),
    );
    const { errors, notices = [] } = await deps.reconcile();
    const failures = components
      .filter((component) => inTree(marker.merge, component))
      .flatMap((component) => {
        const [kind, name] = parts(component);
        const failed = errors.filter((e) => e.name === (kind === "extension" ? name : `skill:${name}`)).map((e) => e.error);
        if (kind === "skill" && failed.length === 0 && !deps.loaded("skill", name)) failed.push("did not load");
        return failed.length > 0 ? [`${show(component)} failed to load: ${show(failed.join("; "))}`] : [];
      });
    if (failures.length > 0) {
      try {
        git(home, "revert", "--no-edit", "-m", "1", marker.merge);
      } catch (error) {
        if (exists("REVERT_HEAD")) git(home, "revert", "--abort");
        throw error;
      }
      const line = notLive(`${failures.join("; ")}. Reverted`);
      writeMarker(id, { ...marker, reverted: line });
      await deps.reconcile();
      return { line, live: false };
    }
    let change = marker.change;
    if (change === undefined) {
      const title = `Job ${id}: changed ${components.map(show).join(", ")}`;
      change = await deps.logChange({ title, howToUse: "", undo: { commits: [marker.merge] } });
      writeMarker(id, { ...marker, change });
    }
    deps.scheduleGood();
    const { dropped } = marker;
    const more = dropped.length > SHOWN ? ` and ${dropped.length - SHOWN} more` : "";
    const line = [
      `Live: ${components.map(show).join(", ")} (change ${change}).`,
      ...(dropped.length > 0 ? [`Dropped: ${dropped.slice(0, SHOWN).map(show).join(", ")}${more}.`] : []),
      ...notices,
    ];
    return { line: line.join(" "), live: true };
  }

  return async ({ id, title }) => {
    const base = cloneBase(home, id);
    if (base === undefined || !existsSync(cloneDir(home, id))) return undefined; // no tool call, so no clone
    const notLive = (reason: string) => `Not live: ${reason}. Kept at ~/.japa/.jobs/${id}.`;
    /** Under the lock, `load`; then the clone goes if the changes are live. */
    const finish = async (merge: () => Marker | string) => {
      const { line, live } = await deps.lock(async () => {
        const marker = merge();
        return typeof marker === "string" ? { line: marker, live: false } : load(id, base, marker, notLive);
      });
      if (live) removeClone(home, id);
      return line;
    };

    const marker = readMarker(id);
    if (marker?.reverted !== undefined) return marker.reverted;
    if (marker !== undefined) return finish(() => marker);

    const message = `Job ${id}: ${title}`;
    const narrowed = await narrowInSandbox(id, base, message);
    if ("error" in narrowed) return notLive(`couldn't commit the job's changes: ${narrowed.error}`);
    if (!narrowed.bundle) {
      removeClone(home, id);
      return undefined;
    }
    const ref = `refs/japa/jobs/${id}`;
    try {
      let sha: string;
      try {
        sha = fetchBundle(join(deps.spec(id).tmp, BUNDLE), ref);
      } catch (error) {
        return notLive(`couldn't commit the job's changes: ${oneLine(gitError(error))}`);
      }
      if (!isAncestor(base, sha)) return notLive("the job's history doesn't start from its base");
      // Narrowed in the job's sandbox, and checked again here: the job's git, and its clone, are its own.
      const changed = gitPaths(home, "diff", "--name-only", "--no-renames", "-z", base, sha);
      const outside = changed.find((path) => !inComponents(path));
      if (outside !== undefined) return notLive(`the job changed ${show(outside)} outside extensions/ and skills/`);
      if (changed.length === 0) {
        removeClone(home, id);
        return undefined;
      }
      // A deleted component has nothing to check.
      for (const component of componentsOf(changed).filter((c) => inTree(sha, c))) {
        const problems = await deps.check(id, ...parts(component));
        if (problems.length > 0) {
          return notLive(`check failed for ${show(component)}: ${oneLine(problems.join("; "), 2000)}`);
        }
      }
      return await finish(() => {
        const earlier = isAncestor(sha, "HEAD") ? earlierMerge(sha) : undefined;
        if (earlier === undefined) {
          try {
            git(home, "merge", "--no-ff", "-q", "--cleanup=whitespace", "-m", message, sha);
          } catch (error) {
            const conflicts = gitPaths(home, "diff", "--name-only", "-z", "--diff-filter=U");
            if (exists("MERGE_HEAD")) git(home, "merge", "--abort");
            if (conflicts.length > 0) return notLive(`${conflicts.map(show).join(", ")} changed since this job started`);
            return notLive(`couldn't merge the job's changes: ${oneLine(gitError(error))}`);
          }
        }
        const merged: Marker = { merge: earlier ?? head(home), dropped: narrowed.dropped };
        writeMarker(id, merged);
        return merged;
      });
    } finally {
      if (exists(ref)) git(home, "update-ref", "-d", ref);
    }
  };
}
