// Each job's sandbox: an env server under bwrap, on the job's own clone of the japa home, started on the job's first
// tool call and again after it stops. All of a job's file and shell operations run there, none in the daemon.
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { existsSync, realpathSync } from "node:fs";
import { Module } from "node:module";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { cloneDir, cloneTmp, ensureClone } from "../jobs/clone.ts";
import {
  bwrap,
  jobEnv,
  probeSandbox,
  readOnlyPaths,
  realPath,
  sandboxArgs,
  type SandboxSpec,
  within,
} from "./bwrap.ts";
import { ENV_MODULE, type EnvServer, LOST, remoteEnv, SERVER, startEnvServer } from "./remote-env.ts";

export type JobSandboxes = {
  /** Job `jobId`'s environment: its sandbox, made (with its clone) on its first call. */
  env(conversationId: string, jobId: string): ExecutionEnv;
  spec(jobId: string): SandboxSpec;
  /** Stops job `jobId`'s sandbox, and every process in it; its next call starts another. */
  close(jobId: string): void;
  closeAll(): void;
  /** Why jobs can't run here (the sandbox probe's failure, at creation); undefined when they can. */
  problem: string | undefined;
};

/** The reply to a job that can't run, for `problem`. */
export function sandboxRefusal(problem: string): string {
  return `Jobs can't run: ${problem.replace(/\.$/, "")}. Install bubblewrap: sudo apt install bubblewrap`;
}

/** The system dirs the daemon's own programs come from, after its Node's. */
const SYSTEM_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";

/** The PATH this process had before `narrowPath` changed it, and the one it set. */
let narrowed: { original: string | undefined; path: string } | undefined;

/**
 * Narrows this process's PATH to its Node's dir and the system dirs, so the daemon never runs a program found in a
 * dir a job can write; returns the environment jobs get (see `jobEnv`), with the PATH from before. Called again in the
 * same process, it still returns the original.
 */
export function narrowPath(): Record<string, string> {
  const path = `${dirname(process.execPath)}:${SYSTEM_PATH}`;
  const original = narrowed !== undefined && process.env.PATH === narrowed.path ? narrowed.original : process.env.PATH;
  const env = jobEnv({ ...process.env, PATH: original });
  narrowed = { original, path };
  process.env.PATH = path;
  return env;
}

/**
 * Drops `~/.node_modules`, `~/.node_libraries` and `NODE_PATH`'s dirs from the folders CommonJS `require` looks in
 * last: a job can write there, so a dependency's optional `require` of a module that isn't installed would load the
 * job's code in the daemon. `NODE_PATH` is unset for good; `Module._initPaths` recomputes them (`Module.globalPaths`
 * is only a copy) without `HOME`, which is then restored. Node's `<prefix>/lib/node` stays: jobs get it read-only.
 */
export function narrowRequire(): void {
  delete process.env.NODE_PATH;
  const home = process.env.HOME;
  delete process.env.HOME;
  try {
    (Module as unknown as { _initPaths(): void })._initPaths();
  } finally {
    if (home !== undefined) process.env.HOME = home;
  }
}

/**
 * Which of `paths` (secrets dirs, the storage database and its `-wal` and `-shm`) the clone mounted over `home`
 * doesn't cover: those whose real path isn't inside the home's, by real path. A path inside the home can be a
 * symlink to one outside it. A missing one is kept, resolved as far as it exists: a sandbox hides it once it exists.
 * Those that are the home or hold it are `holdingHome` instead: a mask there would cover the clone, so they can't be.
 */
export function hiddenPaths(home: string, paths: string[]): { hidden: string[]; holdingHome: string[] } {
  const realHome = realPath(home) ?? resolve(home);
  const real = [...new Set(paths.flatMap((path) => realPath(resolve(path)) ?? []))]; // none behind a symlink loop
  return {
    hidden: real.filter((path) => !within(realHome, path) && !within(path, realHome)),
    holdingHome: real.filter((path) => within(realHome, path)),
  };
}

/**
 * The jobs' sandboxes for japa home `home`: each mounts the job's clone over it, and its own temp dir at /tmp; japa's
 * code at `packageRoot`, what the daemon runs, its Node dir `nodeDir` (the first in its PATH) and that Node's
 * `nodeLib`, `<prefix>/lib/node` (where `require` still looks last, see `narrowRequire`), are read-only, and the
 * `hidden` paths (see `hiddenPaths`) empty. `env` is the environment the jobs get.
 *
 * A sandbox doesn't start while a hidden path that existed at creation is missing: moved away (by something outside
 * the sandboxes; in one, its folders are pinned), it would be found nowhere to hide, and read where it went.
 */
export function createJobSandboxes(o: {
  home: string;
  packageRoot: string;
  hidden: string[];
  env: Record<string, string>;
  nodeDir?: string;
  nodeLib?: string;
}): JobSandboxes {
  const { home, packageRoot } = o;
  const nodeDir = o.nodeDir ?? realpathSync(dirname(process.execPath));
  const nodeLib = o.nodeLib ?? resolve(dirname(realpathSync(process.execPath)), "..", "lib", "node");
  const problem = probeSandbox();
  const servers = new Map<string, EnvServer>();
  const present = o.hidden.filter((path) => existsSync(path));

  const spec = (jobId: string): SandboxSpec => ({
    home,
    userHome: homedir(),
    clone: cloneDir(home, jobId),
    tmp: cloneTmp(home, jobId),
    readOnly: [...readOnlyPaths(packageRoot), { path: nodeDir, dir: true }, { path: nodeLib, dir: true }],
    hidden: o.hidden,
    shared: [join(home, "desktop", "shared")],
    env: o.env,
  });

  /** Job `jobId`'s running server, started (after its clone is made) if it has none. */
  const server = async (jobId: string): Promise<EnvServer> => {
    if (problem !== undefined) throw new Error(sandboxRefusal(problem));
    const running = servers.get(jobId);
    if (running !== undefined && !running.closed) return running;
    const missing = present.find((path) => !existsSync(path));
    if (missing !== undefined) throw new Error(`The job's sandbox can't start: ${missing} is missing`);
    ensureClone(home, packageRoot, jobId);
    const s = spec(jobId);
    // bwrap gets only the sandbox's environment: its own is readable in the sandbox, at /proc/1/environ.
    const command = [bwrap(), ...sandboxArgs(s), process.execPath, SERVER, ENV_MODULE];
    const started = startEnvServer(command, { lost: LOST, env: s.env });
    servers.set(jobId, started);
    return started;
  };

  return {
    env: (_conversationId, jobId) => remoteEnv(() => server(jobId), homedir(), `job ${jobId}`),
    spec,
    close: (jobId) => {
      servers.get(jobId)?.close();
      servers.delete(jobId);
    },
    closeAll: () => {
      for (const running of servers.values()) running.close();
      servers.clear();
    },
    problem,
  };
}
