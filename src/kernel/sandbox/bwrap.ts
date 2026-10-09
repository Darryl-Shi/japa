// The bubblewrap sandbox jobs run in: the host as the user sees it, with the job's clone in place of the japa home,
// japa's own code read-only, and nothing of the daemon's processes or environment.
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

/** The variables a sandbox gets from the daemon's environment, when set. */
const ENV = ["PATH", "HOME", "USER", "SHELL", "LANG", "TZ", "TERM"];

/** `clone` is mounted over `home`; `hidden` dirs get an empty tmpfs; `shared` paths under `home` stay the real ones. */
export type SandboxSpec = { home: string; clone: string; readOnly: string[]; hidden: string[]; shared: string[] };

const bwrap = () => process.env.JAPA_BWRAP ?? "bwrap";

/** Why `bwrap --ro-bind / / true` fails here (stderr's last line, or the spawn error); undefined when it works. */
export function probeSandbox(): string | undefined {
  const result = spawnSync(bwrap(), ["--ro-bind", "/", "/", "true"], { encoding: "utf8" });
  if (result.error) return result.error.message;
  if (result.status === 0) return undefined;
  return result.stderr.trim().split("\n").at(-1) || `bwrap exited with ${result.status ?? result.signal}`;
}

/** The app directory (its parent in the installed layout, which includes Node), the launcher and the service unit. */
export function readOnlyPaths(packageRoot: string, userHome = homedir()): string[] {
  const app = basename(packageRoot) === "app" ? dirname(packageRoot) : packageRoot;
  return [app, join(userHome, ".local", "bin", "japa"), join(userHome, ".config", "systemd", "user", "japa.service")];
}

/** The bwrap arguments before the command (spec §3.2); later mounts cover earlier ones. */
export function sandboxArgs(spec: SandboxSpec, cwd = homedir()): string[] {
  const args = ["--bind", "/", "/", "--dev", "/dev", "--unshare-pid", "--proc", "/proc", "--bind", spec.clone, spec.home];
  for (const path of spec.shared) args.push("--bind-try", path, path);
  for (const path of spec.hidden.filter((path) => existsSync(path))) args.push("--tmpfs", path);
  for (const path of spec.readOnly) args.push("--ro-bind-try", path, path);
  args.push("--die-with-parent", "--new-session", "--clearenv");
  for (const name of ENV) {
    const value = process.env[name];
    if (value !== undefined) args.push("--setenv", name, value);
  }
  return [...args, "--chdir", cwd];
}

/** Runs `command` in a sandbox, killing it after `timeoutMs`; its exit code and combined stdout and stderr. */
export function runSandboxed(
  spec: SandboxSpec,
  command: string[],
  o: { timeoutMs: number; cwd?: string },
): Promise<{ code: number | null; output: string; timedOut: boolean }> {
  return new Promise((resolve) => {
    const child = spawn(bwrap(), [...sandboxArgs(spec, o.cwd), ...command], { stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, o.timeoutMs);
    const append = (chunk: Buffer) => (output += chunk);
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ code: null, output: `${output}${error.message}`, timedOut });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, output, timedOut });
    });
  });
}
