// Each job's private copy of the japa home: a git clone at `<home>/.jobs/<id>`, which its sandbox mounts in place of
// the home. Next to it, outside the job's reach: `<id>.base`, the commit it started from, `<id>.tmp`, its /tmp, and
// `<id>.merged`, written once its changes are merged (see publish.ts).
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { linkSdk } from "../loader.ts";
import { git, gitError } from "../workspace.ts";
import type { Job } from "./state.ts";

/** How long a kept clone, or the staging archive, stays. */
const KEEP_MS = 7 * 86_400_000;

/** Where the old staging worktree's untracked files were moved; pruned by age only. */
const STAGING_ARCHIVE = "staging-archive";

const jobsDir = (home: string) => join(home, ".jobs");

/** Job `jobId`'s clone of `home`; throws for anything but a job id, so it never names another path. */
export function cloneDir(home: string, jobId: string): string {
  if (!/^[0-9]+$/.test(jobId)) throw new Error(`Not a job id: "${jobId}"`);
  return join(jobsDir(home), jobId);
}

/** The host dir mounted at the job's /tmp and /var/tmp. */
export const cloneTmp = (home: string, jobId: string) => `${cloneDir(home, jobId)}.tmp`;

const baseFile = (home: string, jobId: string) => `${cloneDir(home, jobId)}.base`;

/** Where publishing job `jobId` records its merge and how it ended. */
export const cloneMarker = (home: string, jobId: string) => `${cloneDir(home, jobId)}.merged`;

/** The suffixes of the files kept next to a clone. */
const SIDE_FILES = [".base", ".tmp", ".merged.new", ".merged"];

/** The commit job `jobId`'s clone started from; undefined without a clone. */
export function cloneBase(home: string, jobId: string): string | undefined {
  try {
    return readFileSync(baseFile(home, jobId), "utf8").trim() || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Job `jobId`'s clone, made at `home`'s HEAD if it's missing: its own objects (no hardlinks), no remote (a fetch in
 * the sandbox would move one), and `node_modules/japa` linked to `packageRoot`; the commit it starts from goes to
 * `<id>.base`. Once made, the clone is the job's: it isn't touched again. Its /tmp dir is (re)made either way.
 */
export function ensureClone(home: string, packageRoot: string, jobId: string): string {
  const dir = cloneDir(home, jobId);
  // Without its base, a clone is one this didn't finish making, so nothing of the job's is in it yet.
  if (!existsSync(dir) || cloneBase(home, jobId) === undefined) {
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(jobsDir(home), { recursive: true });
    git(home, "clone", "-q", "--local", "--no-hardlinks", home, dir);
    git(dir, "remote", "remove", "origin");
    linkSdk(dir, packageRoot);
    writeFileSync(baseFile(home, jobId), `${git(dir, "rev-parse", "HEAD")}\n`);
  }
  mkdirSync(cloneTmp(home, jobId), { recursive: true });
  return dir;
}

/**
 * Starts the 7 days job `jobId`'s kept clone stays, now its job has ended: sets the clone folder's mtime, which
 * `pruneClones` goes by, to now. Without a clone, does nothing; a failure is logged.
 */
export function keepCloneFromNow(home: string, jobId: string): void {
  const now = new Date();
  try {
    utimesSync(cloneDir(home, jobId), now, now);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      console.error(`Couldn't mark ${cloneDir(home, jobId)} as kept from now: ${(error as Error).message}`);
    }
  }
}

/**
 * Deletes `path`, first making every folder under it (not through symlinks) readable, writable and searchable by its
 * owner: a job can `chmod 000` one in its clone or temp dir.
 */
function removeTree(path: string): void {
  const dirs = [path];
  while (dirs.length > 0) {
    const dir = dirs.pop()!;
    const stat = lstatSync(dir, { throwIfNoEntry: false });
    if (!stat?.isDirectory()) continue;
    if ((stat.mode & 0o700) !== 0o700) chmodSync(dir, (stat.mode & 0o7777) | 0o700);
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) dirs.push(join(dir, entry.name));
    }
  }
  rmSync(path, { recursive: true, force: true });
}

/** Deletes job `jobId`'s clone, then its `.base`, `.tmp` and, last, `.merged` (and its `.new`); those missing are skipped. */
export function removeClone(home: string, jobId: string): void {
  const clone = cloneDir(home, jobId);
  for (const path of [clone, ...SIDE_FILES.map((suffix) => `${clone}${suffix}`)]) removeTree(path);
}

/**
 * Whether a job's clone (and its leftovers) are still needed: `"active"` while its job may yet use it, `"finished"` once
 * that's done, undefined when no such job is known.
 */
export type JobLife = "active" | "finished" | undefined;

/**
 * The `JobLife` of each of `jobs`, by id: queued, running, needs_input or publishing jobs are active, other ones
 * finished.
 */
export function jobLife(jobs: Record<string, Job>): (jobId: string) => JobLife {
  return (jobId) => {
    if (!Object.hasOwn(jobs, jobId)) return undefined;
    const { status, publishing } = jobs[jobId]!;
    const active = status === "queued" || status === "running" || status === "needs_input" || publishing !== undefined;
    return active ? "active" : "finished";
  };
}

/**
 * Deletes the clones in `<home>/.jobs`, with their `.base`, `.tmp` and `.merged`, by their job's `life`: an active
 * job's never, a finished one's after 7 days (by the clone dir's mtime: `keepCloneFromNow` sets it when the job ends)
 * or when left without its clone, an unknown one's at once. The staging archive goes by age only. An entry that can't
 * be deleted is logged and left; the rest are still pruned.
 */
export function pruneClones(home: string, life: (jobId: string) => JobLife, now = Date.now()): void {
  const dir = jobsDir(home);
  if (!existsSync(dir)) return;
  const old = (path: string) => statSync(path).mtimeMs < now - KEEP_MS;
  const names = readdirSync(dir);
  const ids = new Set(names.map((name) => name.replace(/\.(base|tmp|merged|merged\.new)$/, "")));
  for (const id of ids) {
    const clone = join(dir, id);
    try {
      let prune: boolean;
      if (id === STAGING_ARCHIVE) prune = existsSync(clone) && old(clone);
      else {
        const state = life(id);
        prune = state === undefined || (state === "finished" && (!existsSync(clone) || old(clone)));
      }
      if (!prune) continue;
    } catch (error) {
      console.error(`Couldn't check ${clone} for pruning: ${(error as Error).message}`);
      continue;
    }
    for (const path of [clone, ...SIDE_FILES.map((suffix) => `${clone}${suffix}`)]) {
      try {
        removeTree(path);
      } catch (error) {
        console.error(`Couldn't remove ${path}: ${(error as Error).message}`);
      }
    }
  }
}

/**
 * Deletes from the real repo the `refs/japa/jobs/<id>` refs left by a publish the daemon didn't finish, except those
 * of jobs `life` deems active. Run under the workspace lock. A ref that can't be deleted is left; returns those
 * failures, also logged.
 */
export function pruneJobRefs(home: string, life: (jobId: string) => JobLife): string[] {
  const prefix = "refs/japa/jobs/";
  const errors: string[] = [];
  for (const ref of git(home, "for-each-ref", "--format=%(refname)", prefix).split("\n")) {
    if (ref === "" || life(ref.slice(prefix.length)) === "active") continue;
    try {
      git(home, "update-ref", "-d", ref);
    } catch (error) {
      const text = `Couldn't delete ${ref}: ${gitError(error)}`;
      console.error(text);
      errors.push(text);
    }
  }
  return errors;
}
