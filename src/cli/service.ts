// `japa service`: a systemd user unit (Linux) or launchd agent (macOS) running `japa daemon` in the background.
// Setup, update and uninstall call the functions below directly; `serviceCommand` is the `japa service <...>` CLI
// dispatcher (see docs/superpowers/specs/2026-10-08-japa-install-design.md §7).
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { japaHome } from "../kernel/settings.ts";
import { statusText } from "../kernel/status.ts";
import { daemonStatus, foregroundPid } from "./daemon.ts";
import { exec, type Exec } from "./exec.ts";
import { APP, layoutOf } from "./layout.ts";

export type ServiceEnv = {
  platform: NodeJS.Platform;
  userHome: string;
  configHome: string;
  launcher: string;
  japaHome: string;
  customHome: boolean;
  path: string;
  user: string;
  /** Numeric uid, for launchctl's `gui/<uid>` domain. */
  uid: number;
  exec: Exec;
};

/** The launchd label and the systemd unit's description name. */
const LABEL = "dev.japa.daemon";

/** `ServiceEnv` from the current process and OS, for `launcher` (e.g. `layoutOf(APP).launcher`). */
export function serviceEnv(launcher: string): ServiceEnv {
  return {
    platform: process.platform,
    userHome: homedir(),
    configHome: process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"),
    launcher,
    japaHome: japaHome(),
    customHome: process.env.JAPA_HOME !== undefined,
    path: process.env.PATH ?? "",
    user: process.env.USER ?? String(process.getuid?.() ?? ""),
    uid: process.getuid?.() ?? 0,
    exec,
  };
}

export function unitPath(env: ServiceEnv): string {
  return join(env.configHome, "systemd", "user", "japa.service");
}

export function plistPath(env: ServiceEnv): string {
  return join(env.userHome, "Library", "LaunchAgents", `${LABEL}.plist`);
}

/** Quotes `s` as a systemd unit value: wraps it in `"..."`, escaping `\` and `"`. */
function systemdQuote(s: string): string {
  return `"${s.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

/** The systemd user unit's text (design doc §7.1). */
export function unitText(env: ServiceEnv): string {
  const lines = [
    "[Unit]",
    "Description=japa",
    "After=network-online.target",
    "",
    "[Service]",
    `ExecStart=${systemdQuote(env.launcher)} daemon`,
    "Restart=on-failure",
    "RestartSec=5",
    `Environment=${systemdQuote(`PATH=${env.path}`)}`,
  ];
  if (env.customHome) lines.push(`Environment=${systemdQuote(`JAPA_HOME=${env.japaHome}`)}`);
  lines.push("", "[Install]", "WantedBy=default.target");
  return `${lines.join("\n")}\n`;
}

function xmlEscape(s: string): string {
  return s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
}

/** The launchd agent plist's text (design doc §7.2). */
export function plistText(env: ServiceEnv): string {
  const logPath = join(env.japaHome, "logs", "daemon.log");
  const envVars: [string, string][] = [["PATH", env.path]];
  if (env.customHome) envVars.push(["JAPA_HOME", env.japaHome]);
  const envXml = envVars.map(([k, v]) => `\t\t<key>${xmlEscape(k)}</key>\n\t\t<string>${xmlEscape(v)}</string>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
\t<key>Label</key>
\t<string>${LABEL}</string>
\t<key>ProgramArguments</key>
\t<array>
\t\t<string>${xmlEscape(env.launcher)}</string>
\t\t<string>daemon</string>
\t</array>
\t<key>RunAtLoad</key>
\t<true/>
\t<key>KeepAlive</key>
\t<dict>
\t\t<key>SuccessfulExit</key>
\t\t<false/>
\t</dict>
\t<key>EnvironmentVariables</key>
\t<dict>
${envXml}
\t</dict>
\t<key>StandardOutPath</key>
\t<string>${xmlEscape(logPath)}</string>
\t<key>StandardErrorPath</key>
\t<string>${xmlEscape(logPath)}</string>
</dict>
</plist>
`;
}

const WSL_HINT =
  'systemd is not running for your user (WSL: add "[boot]\\nsystemd=true" to /etc/wsl.conf and run "wsl --shutdown"); run "japa daemon" yourself';

/** Why the platform's service manager isn't usable here, or undefined when it is. */
export async function unavailable(env: ServiceEnv): Promise<string | undefined> {
  if (env.platform === "linux") {
    const r = await env.exec("systemctl", ["--user", "show-environment"]);
    return r.code === 0 ? undefined : WSL_HINT;
  }
  if (env.platform === "darwin") return undefined;
  return "no supported service manager";
}

/** Whether the unit or plist file is on disk. */
export function isInstalled(env: ServiceEnv): boolean {
  if (env.platform === "linux") return existsSync(unitPath(env));
  if (env.platform === "darwin") return existsSync(plistPath(env));
  return false;
}

export async function serviceState(env: ServiceEnv): Promise<"active" | "inactive" | "not installed"> {
  if (!isInstalled(env)) return "not installed";
  if (env.platform === "linux") {
    const r = await env.exec("systemctl", ["--user", "is-active", "japa"]);
    return r.stdout.trim() === "active" ? "active" : "inactive";
  }
  if (env.platform === "darwin") {
    const r = await env.exec("launchctl", ["print", `gui/${env.uid}/${LABEL}`]);
    return r.code === 0 && /^\s*state = running\s*$/m.test(r.stdout) ? "active" : "inactive";
  }
  return "not installed";
}

/** Writes `path` (creating its directory) only when its content differs from `text`; whether it wrote. */
function writeIfChanged(path: string, text: string): boolean {
  if (existsSync(path) && readFileSync(path, "utf8") === text) return false;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  return true;
}

/**
 * Installs the unit/plist (rewriting it, and reloading systemd, only when its content changed), enables and starts
 * it, and keeps it running after logout. `log` receives the "enable lingering yourself" line when that fails.
 */
export async function installService(env: ServiceEnv, log: (s: string) => void): Promise<void> {
  if (env.platform === "linux") {
    if (writeIfChanged(unitPath(env), unitText(env))) await env.exec("systemctl", ["--user", "daemon-reload"]);
    await env.exec("systemctl", ["--user", "enable", "japa"]);
    await startService(env, log);
    const linger = await env.exec("loginctl", ["enable-linger", env.user]);
    if (linger.code !== 0) log(`to keep japa running after you log out: sudo loginctl enable-linger ${env.user}`);
    return;
  }
  if (env.platform === "darwin") {
    const path = plistPath(env);
    // A changed plist must take effect even if the job is currently loaded: bootout (ignore failure) before
    // ensuring it's running. An unchanged plist only needs the unconditional "ensure running" step below.
    if (writeIfChanged(path, plistText(env))) await env.exec("launchctl", ["bootout", `gui/${env.uid}`, path]);
    await startService(env, log);
  }
}

/** Stops, disables and removes the unit/plist. */
export async function uninstallService(env: ServiceEnv, log: (s: string) => void): Promise<void> {
  if (env.platform === "linux") {
    await env.exec("systemctl", ["--user", "disable", "--now", "japa"]);
    rmSync(unitPath(env), { force: true });
    await env.exec("systemctl", ["--user", "daemon-reload"]);
    return;
  }
  if (env.platform === "darwin") {
    await env.exec("launchctl", ["bootout", `gui/${env.uid}`, plistPath(env)]);
    rmSync(plistPath(env), { force: true });
  }
}

/** Refuses with the foreground message while `daemon.lock` is held by a live process the service manager didn't start. */
export async function startService(env: ServiceEnv, log: (s: string) => void): Promise<void> {
  if ((await serviceState(env)) !== "active") {
    const pid = foregroundPid(env.japaHome);
    if (pid !== undefined) throw new Error(`japa is already running in the foreground (pid ${pid}); stop it first`);
  }
  if (env.platform === "linux") {
    await env.exec("systemctl", ["--user", "start", "japa"]);
  } else if (env.platform === "darwin") {
    const r = await env.exec("launchctl", ["bootstrap", `gui/${env.uid}`, plistPath(env)]);
    // A loaded-but-stopped job (KeepAlive.SuccessfulExit is false, so a non-zero exit leaves it loaded) makes
    // bootstrap fail because it's already loaded; kickstart (no -k, so it won't kill an already-running job) starts it.
    if (r.code !== 0) await env.exec("launchctl", ["kickstart", `gui/${env.uid}/${LABEL}`]);
  }
}

export async function stopService(env: ServiceEnv): Promise<void> {
  if (env.platform === "linux") await env.exec("systemctl", ["--user", "stop", "japa"]);
  else if (env.platform === "darwin") await env.exec("launchctl", ["bootout", `gui/${env.uid}`, plistPath(env)]);
}

export async function restartService(env: ServiceEnv): Promise<void> {
  if (env.platform === "linux") await env.exec("systemctl", ["--user", "restart", "japa"]);
  else if (env.platform === "darwin") await env.exec("launchctl", ["kickstart", "-k", `gui/${env.uid}/${LABEL}`]);
}

export function logsCommand(env: ServiceEnv): [string, string[]] {
  if (env.platform === "linux") return ["journalctl", ["--user", "-u", "japa", "-f"]];
  return ["tail", ["-f", join(env.japaHome, "logs", "daemon.log")]];
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
  const env = serviceEnv(layoutOf(APP).launcher);
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
      const [cmd, cmdArgs] = logsCommand(env);
      await env.exec(cmd, cmdArgs, { stdio: "inherit" });
      return;
    }
    default:
      throw new Error(SERVICE_USAGE);
  }
}
