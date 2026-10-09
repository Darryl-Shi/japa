// Launching a chat-started `japa update` (design doc §4.4) where restarting the daemon can't kill it: a transient
// systemd unit beside the service, else a detached process. The daemon gets `chatUpdater` through `boot`.
import { type ChildProcess, spawn, type SpawnOptions } from "node:child_process";
import { closeSync, mkdirSync, openSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { type Updater, updateLog } from "../kernel/update-state.ts";
import { layoutOf } from "./layout.ts";
import { serviceEnv, type ServiceEnv, serviceState } from "./service.ts";
import { checkForUpdate } from "./update.ts";

export type LaunchPlan = { cmd: string; args: string[]; detached: boolean };

export type LaunchDeps = {
  /** Whether the service is active, its PATH, whether the home is custom, and `exec` for `systemd-run`. */
  env: ServiceEnv;
  spawn: (cmd: string, args: string[], options: SpawnOptions) => ChildProcess;
};

/**
 * How to run `japa update --to <to> --from-chat` (with `--ff-only` unless it's a Roll back). Under the active systemd
 * service: as a transient unit, outside `japa.service`'s cgroup, which its restart would kill, logging to
 * update.log. Otherwise (macOS, a foreground daemon, no service): a detached process, in its own session.
 */
export function launchPlan(o: {
  platform: NodeJS.Platform;
  serviceActive: boolean;
  node: string;
  app: string;
  home: string;
  customHome: boolean;
  path: string;
  to: string;
  rollback: boolean;
  now: number;
}): LaunchPlan {
  const update = [o.node, "--disable-warning=ExperimentalWarning", join(o.app, "src/cli/main.ts"), "update"];
  update.push("--to", o.to, "--from-chat", ...(o.rollback ? [] : ["--ff-only"]));
  if (o.platform !== "linux" || !o.serviceActive) {
    const [node, ...args] = update;
    return { cmd: node!, args, detached: true };
  }
  const log = updateLog(o.home);
  const args = ["--user", "--collect", "--unit", `japa-update-${o.now}`, `--setenv=PATH=${o.path}`];
  if (o.customHome) args.push(`--setenv=JAPA_HOME=${o.home}`);
  args.push(`--property=StandardOutput=append:${log}`, `--property=StandardError=append:${log}`, ...update);
  return { cmd: "systemd-run", args, detached: false };
}

/** Spawns `plan` in its own session with its output appended to `log`; resolves once it runs, rejects if it can't. */
async function spawnDetached(plan: LaunchPlan, log: string, run: LaunchDeps["spawn"]): Promise<void> {
  const fd = openSync(log, "a");
  let child: ChildProcess;
  try {
    child = run(plan.cmd, plan.args, { detached: true, stdio: ["ignore", fd, fd] });
  } finally {
    closeSync(fd); // the child has its own copy
  }
  // Unheard, a spawn error (e.g. the Node in use was replaced) would take the daemon down.
  await new Promise<void>((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
  child.unref();
}

/** The daemon's `Updater` for the checkout at `app` and the japa home `home`. */
export function chatUpdater(app: string, home: string, overrides: Partial<LaunchDeps> = {}): Updater {
  const envOf = () => overrides.env ?? serviceEnv(layoutOf(app));
  return {
    check: () => checkForUpdate(app),
    current: async () => {
      const r = await envOf().exec("git", ["-C", app, "rev-parse", "HEAD"]);
      if (r.code !== 0) {
        const said = r.stderr.trim();
        throw new Error(`git rev-parse HEAD exited with code ${r.code}${said === "" ? "" : `: ${said}`}`);
      }
      return r.stdout.trim();
    },
    launch: async (to, rollback) => {
      const env = envOf();
      const log = updateLog(home);
      mkdirSync(dirname(log), { recursive: true });
      writeFileSync(log, ""); // one run per log
      const plan = launchPlan({
        platform: env.platform,
        serviceActive: (await serviceState(env)) === "active",
        node: process.execPath,
        app,
        home,
        customHome: env.customHome,
        path: env.path,
        to,
        rollback,
        now: Date.now(),
      });
      if (plan.detached) return spawnDetached(plan, log, overrides.spawn ?? spawn);
      const r = await env.exec(plan.cmd, plan.args);
      if (r.code !== 0) {
        const said = (r.stderr.trim() === "" ? r.stdout : r.stderr).trim();
        throw new Error(`${plan.cmd} exited with code ${r.code}${said === "" ? "" : `: ${said}`}`);
      }
    },
  };
}
