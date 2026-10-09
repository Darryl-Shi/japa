// Each job's sandbox: an env server under bwrap, on the job's own clone of the japa home, started on the job's first
// tool call and again after it stops. All of a job's file and shell operations run there, none in the daemon.
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { cloneDir, cloneTmp, ensureClone } from "../jobs/clone.ts";
import { bwrap, jobEnv, probeSandbox, readOnlyPaths, sandboxArgs, type SandboxSpec } from "./bwrap.ts";
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
 * The jobs' sandboxes for japa home `home`: each mounts the job's clone over it, and its own temp dir at /tmp; japa's
 * code at `packageRoot` and what the daemon runs are read-only, and the `hidden` dirs (a secrets dir outside `home`)
 * empty. `env` is the environment the jobs get.
 */
export function createJobSandboxes(o: {
  home: string;
  packageRoot: string;
  hidden: string[];
  env: Record<string, string>;
}): JobSandboxes {
  const { home, packageRoot } = o;
  const problem = probeSandbox();
  const servers = new Map<string, EnvServer>();

  const spec = (jobId: string): SandboxSpec => ({
    home,
    userHome: homedir(),
    clone: cloneDir(home, jobId),
    tmp: cloneTmp(home, jobId),
    readOnly: readOnlyPaths(packageRoot),
    hidden: o.hidden,
    shared: [join(home, "desktop", "shared")],
    env: o.env,
  });

  /** Job `jobId`'s running server, started (after its clone is made) if it has none. */
  const server = async (jobId: string): Promise<EnvServer> => {
    if (problem !== undefined) throw new Error(sandboxRefusal(problem));
    const running = servers.get(jobId);
    if (running !== undefined && !running.closed) return running;
    ensureClone(home, packageRoot, jobId);
    const started = startEnvServer([bwrap(), ...sandboxArgs(spec(jobId)), process.execPath, SERVER, ENV_MODULE], LOST);
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
