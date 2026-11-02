// The daemon's own watchdog: a worker thread that ends the process when its event loop stops turning, so the service
// manager (the unit's Restart=) starts a fresh daemon instead of leaving a frozen one running.
import { Worker } from "node:worker_threads";

/** How long the event loop may stay stuck before the daemon is ended. */
export const STALL_MS = 120_000;

// Counts the checks in a row that saw no beat rather than wall-clock time, so a machine waking from sleep (its clock
// jumped, the main thread not yet run) isn't taken for a stall. Writes to fd 2 itself: a worker's console goes through
// the main thread, which is the one stuck. getBuiltinModule works whether Node runs the code as CommonJS or as a module.
const WORKER = `
const { workerData } = process.getBuiltinModule("node:worker_threads");
const { writeSync } = process.getBuiltinModule("node:fs");
const { beats, stallMs, checkMs } = workerData;
let seen = Atomics.load(beats, 0);
let still = 0;
setInterval(() => {
  const now = Atomics.load(beats, 0);
  if (now !== seen) {
    seen = now;
    still = 0;
    return;
  }
  if (++still * checkMs < stallMs) return;
  writeSync(2, "japa: the daemon stopped responding for " + Math.round(stallMs / 1000) + " s; ending it so that it restarts\\n");
  process.kill(process.pid, "SIGKILL");
}, checkMs);
`;

/**
 * Starts the watchdog: the main thread bumps a shared counter every `beatMs`, and a worker thread checks it every
 * `checkMs`; once it hasn't moved for `stallMs`, the worker logs a line and kills the process (SIGKILL). Neither keeps
 * the process alive. `JAPA_STALL_WATCHDOG=0` turns it off (say, to pause the daemon in a debugger). Answers a stop.
 */
export function watchForStalls(o: { stallMs?: number; checkMs?: number; beatMs?: number } = {}): () => void {
  if (process.env.JAPA_STALL_WATCHDOG === "0") return () => {};
  const { stallMs = STALL_MS, checkMs = 5_000, beatMs = 1_000 } = o;
  const beats = new Int32Array(new SharedArrayBuffer(4));
  const beat = setInterval(() => Atomics.add(beats, 0, 1), beatMs);
  beat.unref();
  const worker = new Worker(WORKER, { eval: true, workerData: { beats, stallMs, checkMs } });
  worker.unref();
  return () => {
    clearInterval(beat);
    void worker.terminate();
  };
}
