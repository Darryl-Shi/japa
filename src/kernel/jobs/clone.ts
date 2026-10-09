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
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { linkSdk } from "../loader.ts";
import { git } from "../workspace.ts";

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
const SIDE_FILES = [".base", ".tmp", ".merged"];

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

/** Deletes job `jobId`'s clone, then its `.base`, `.tmp` and `.merged`; those missing are skipped. */
export function removeClone(home: string, jobId: string): void {
  const clone = cloneDir(home, jobId);
  for (const path of [clone, ...SIDE_FILES.map((suffix) => `${clone}${suffix}`)]) removeTree(path);
}

/**
 * Deletes, with their `.base`, `.tmp` and `.merged`, the clones in `<home>/.jobs` older than 7 days (by the clone dir's
 * mtime) or whose job `keep` rejects, and any of those files left without its clone. The staging archive goes by age
 * only. An entry that can't be deleted is logged and left; the rest are still pruned.
 */
export function pruneClones(home: string, keep: (jobId: string) => boolean, now = Date.now()): void {
  const dir = jobsDir(home);
  if (!existsSync(dir)) return;
  const old = (path: string) => statSync(path).mtimeMs < now - KEEP_MS;
  const names = readdirSync(dir);
  const ids = new Set(names.map((name) => name.replace(/\.(base|tmp|merged)$/, "")));
  for (const id of ids) {
    const clone = join(dir, id);
    try {
      const prune =
        id === STAGING_ARCHIVE
          ? existsSync(clone) && old(clone)
          : !existsSync(clone) || old(clone) || !keep(id);
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
