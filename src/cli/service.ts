// `japa service`: a systemd user unit running `japa daemon` in the background (japa runs on Linux only).
// Setup, update and uninstall call the functions below directly; `serviceCommand` is the `japa service <...>` CLI
// dispatcher (see docs/superpowers/specs/2026-10-08-japa-install-design.md §7).
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { japaHome } from "../kernel/settings.ts";
import { statusText } from "../kernel/status.ts";
import { daemonStatus, foregroundPid } from "./daemon.ts";
import { exec, type Exec } from "./exec.ts";
import { APP, launcherPointsAt, type Layout, layoutOf } from "./layout.ts";

export type ServiceEnv = {
  platform: NodeJS.Platform;
  userHome: string;
  configHome: string;
  /** The daemon's command line (`daemonCommand`). */
  command: string[];
  japaHome: string;
  customHome: boolean;
  path: string;
  user: string;
  exec: Exec;
};

/**
 * The command line that runs `layout.app`'s daemon: the launcher when it points at that checkout, else `node` on its
 * main.ts directly -- a checkout without a launcher (`npm link`) or beside another install's must run its own code.
 */
export function daemonCommand(layout: Layout, node = process.execPath): string[] {
  if (launcherPointsAt(layout)) return [layout.launcher, "daemon"];
  return [node, "--disable-warning=ExperimentalWarning", join(layout.app, "src/cli/main.ts"), "daemon"];
}

/** `ServiceEnv` from the current process and OS, for the checkout at `layout` (e.g. `layoutOf(APP)`). */
export function serviceEnv(layout: Layout): ServiceEnv {
  return {
    platform: process.platform,
    userHome: homedir(),
    configHome: process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"),
    command: daemonCommand(layout),
    japaHome: japaHome(),
    customHome: process.env.JAPA_HOME !== undefined,
    path: process.env.PATH ?? "",
    user: process.env.USER ?? String(process.getuid?.() ?? ""),
    exec,
  };
}

export function unitPath(env: ServiceEnv): string {
  return join(env.configHome, "systemd", "user", "japa.service");
}

/** Quotes `s` as a systemd unit value: wraps it in `"..."`, escaping `\` and `"`, and `%` (a specifier) as `%%`. */
function systemdQuote(s: string): string {
  return `"${s.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("%", "%%")}"`;
}

/** Quotes `s` as an `ExecStart=` argument: also `$` as `$$`, since systemd expands `$VAR` there (not in the executable). */
function execArg(s: string): string {
  return systemdQuote(s.replaceAll("$", () => "$$"));
}

/** The systemd user unit's text (design doc §7.1). */
export function unitText(env: ServiceEnv): string {
  const [executable, ...args] = env.command;
  const lines = [
    "[Unit]",
    "Description=japa",
    "After=network-online.target",
    "",
    "[Service]",
    `ExecStart=${[systemdQuote(executable!), ...args.map(execArg)].join(" ")}`,
    "Restart=on-failure",
    "RestartSec=5",
    `Environment=${systemdQuote(`PATH=${env.path}`)}`,
  ];
  if (env.customHome) lines.push(`Environment=${systemdQuote(`JAPA_HOME=${env.japaHome}`)}`);
  lines.push("", "[Install]", "WantedBy=default.target");
  return `${lines.join("\n")}\n`;
}

const WSL_HINT =
  'systemd is not running for your user (WSL: add "[boot]\\nsystemd=true" to /etc/wsl.conf and run "wsl --shutdown"); run "japa daemon" yourself';

/** Why the platform's service manager isn't usable here, or undefined when it is. */
export async function unavailable(env: ServiceEnv): Promise<string | undefined> {
  if (env.platform === "linux") {
    const r = await env.exec("systemctl", ["--user", "show-environment"]);
    return r.code === 0 ? undefined : WSL_HINT;
  }
  return "no supported service manager";
}

/** Whether the unit file is on disk. */
export function isInstalled(env: ServiceEnv): boolean {
  return env.platform === "linux" && existsSync(unitPath(env));
}

/**
 * The service's state: "inactive" only when stopped (systemd's inactive), "failed" when it should run but doesn't
 * (failed, or auto-restarting).
 */
export async function serviceState(env: ServiceEnv): Promise<"active" | "inactive" | "failed" | "not installed"> {
  if (!isInstalled(env)) return "not installed";
  const state = (await env.exec("systemctl", ["--user", "is-active", "japa"])).stdout.trim();
  return state === "active" || state === "inactive" ? state : "failed";
}

/** Writes `path` (creating its directory) only when its content differs from `text`; whether it wrote. */
function writeIfChanged(path: string, text: string): boolean {
  if (existsSync(path) && readFileSync(path, "utf8") === text) return false;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  return true;
}

/**
 * Installs the unit (rewriting it, and reloading systemd, only when its content changed), enables and starts it, and
 * keeps it running after logout. `log` receives the "enable lingering yourself" line when that fails.
 */
export async function installService(env: ServiceEnv, log: (s: string) => void): Promise<void> {
  if (env.platform !== "linux") return;
  if (writeIfChanged(unitPath(env), unitText(env))) await env.exec("systemctl", ["--user", "daemon-reload"]);
  await env.exec("systemctl", ["--user", "enable", "japa"]);
  await startService(env, log);
  const linger = await env.exec("loginctl", ["enable-linger", env.user]);
  if (linger.code !== 0) log(`to keep japa running after you log out: sudo loginctl enable-linger ${env.user}`);
}

/** Stops, disables and removes the unit. */
export async function uninstallService(env: ServiceEnv, log: (s: string) => void): Promise<void> {
  if (env.platform !== "linux") return;
  await env.exec("systemctl", ["--user", "disable", "--now", "japa"]);
  rmSync(unitPath(env), { force: true });
  await env.exec("systemctl", ["--user", "daemon-reload"]);
}

/** Refuses with the foreground message while `daemon.lock` is held by a live process the service manager didn't start. */
export async function startService(env: ServiceEnv, log: (s: string) => void): Promise<void> {
  if ((await serviceState(env)) !== "active") {
    const pid = foregroundPid(env.japaHome);
    if (pid !== undefined) throw new Error(`japa is already running in the foreground (pid ${pid}); stop it first`);
  }
  if (env.platform === "linux") await env.exec("systemctl", ["--user", "start", "japa"]);
}

export async function stopService(env: ServiceEnv): Promise<void> {
  if (env.platform === "linux") await env.exec("systemctl", ["--user", "stop", "japa"]);
}

export async function restartService(env: ServiceEnv): Promise<void> {
  if (env.platform === "linux") await env.exec("systemctl", ["--user", "restart", "japa"]);
}

export function logsCommand(): [string, string[]] {
  return ["journalctl", ["--user", "-u", "japa", "-f"]];
}

/**
 * `install`'s logic, shared by `serviceCommand` and setup's rerun Service menu (design spec §4.3): logs why the
 * platform's service manager isn't usable and stops, or installs it.
 */
export async function installAction(env: ServiceEnv, log: (s: string) => void): Promise<void> {
  const reason = await unavailable(env);
  if (reason !== undefined) {
    log(reason);
    return;
  }
  return installService(env, log);
}

/**
 * `status`'s logic, shared by `serviceCommand` and setup's rerun Service menu (design spec §4.3): the service
 * manager's state, then the daemon's status line when the socket answers.
 */
export async function statusAction(env: ServiceEnv, home: string, log: (s: string) => void): Promise<void> {
  log(await serviceState(env));
  try {
    log(statusText(await daemonStatus(home)));
  } catch {
    // The socket didn't answer; the state line above already said so.
  }
}

const SERVICE_USAGE = "Usage: japa service <install|uninstall|start|stop|restart|status|logs>";

/** The `japa service <...>` CLI dispatcher. Setup, update and uninstall call the functions above directly instead. */
export async function serviceCommand(home: string, args: string[]): Promise<void> {
  const env = serviceEnv(layoutOf(APP));
  const log = (s: string) => console.log(s);
  switch (args[0]) {
    case "install":
      return installAction(env, log);
    case "uninstall":
      return uninstallService(env, log);
    case "start":
      return startService(env, log);
    case "stop":
      return stopService(env);
    case "restart":
      return restartService(env);
    case "status":
      return statusAction(env, home, log);
    case "logs": {
      const [cmd, cmdArgs] = logsCommand();
      await env.exec(cmd, cmdArgs, { stdio: "inherit" });
      return;
    }
    default:
      throw new Error(SERVICE_USAGE);
  }
}
