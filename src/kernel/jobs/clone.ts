// Each job's private copy of the japa home: a git clone at `<home>/.jobs/<id>`, which its sandbox mounts in place of
// the home. Next to it, outside the job's reach: `<id>.base`, the commit it started from, and `<id>.tmp`, its /tmp.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
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
 * Deletes, with their `.base` and `.tmp`, the clones in `<home>/.jobs` older than 7 days (by the clone dir's mtime) or
 * whose job `keep` rejects, and any `.base` or `.tmp` left without its clone. The staging archive goes by age only.
 */
export function pruneClones(home: string, keep: (jobId: string) => boolean, now = Date.now()): void {
  const dir = jobsDir(home);
  if (!existsSync(dir)) return;
  const old = (path: string) => statSync(path).mtimeMs < now - KEEP_MS;
  const names = readdirSync(dir);
  const ids = new Set(names.map((name) => name.replace(/\.(base|tmp)$/, "")));
  for (const id of ids) {
    const clone = join(dir, id);
    const prune =
      id === STAGING_ARCHIVE
        ? existsSync(clone) && old(clone)
        : !existsSync(clone) || old(clone) || !keep(id);
    if (!prune) continue;
    for (const path of [clone, `${clone}.base`, `${clone}.tmp`]) rmSync(path, { recursive: true, force: true });
  }
}
