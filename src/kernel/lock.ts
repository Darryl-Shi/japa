import { closeSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs";
import { join } from "node:path";

/** True if `pid` names a live process (checked with the null signal). */
export function isAlive(pid: number): boolean {
  if (!Number.isInteger(pid)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but we can't signal it: still alive.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function writeLockFile(path: string): void {
  const fd = openSync(path, "wx");
  writeSync(fd, String(process.pid));
  closeSync(fd);
}

/**
 * Acquires `<home>/daemon.lock`, taking over a lock left by a dead pid.
 * Throws if the daemon holding the lock is alive. Returns a release function.
 */
export function acquireLock(home: string): () => void {
  const path = join(home, "daemon.lock");

  try {
    writeLockFile(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const holder = Number(readFileSync(path, "utf8").trim());
    if (isAlive(holder)) throw new Error(`japa daemon is already running (pid ${holder})`);
    unlinkSync(path);
    writeLockFile(path);
  }

  const pid = process.pid;
  return () => {
    try {
      if (Number(readFileSync(path, "utf8").trim()) === pid) unlinkSync(path);
    } catch {
      // Already released or removed; nothing to do.
    }
  };
}
