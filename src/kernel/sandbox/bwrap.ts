// The bubblewrap sandbox jobs run in: the host as the user sees it, with the job's clone in place of the japa home,
// japa's own code and the config it runs under read-only, and nothing of the daemon's processes or environment, nor
// a socket (the user's runtime dir, Docker's) that would run a command outside it.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

/** The variables a sandbox gets from the daemon's environment, when set. */
const ENV = ["PATH", "HOME", "USER", "SHELL", "LANG", "TZ", "TERM"];

/** Docker's sockets: reaching one means running a container with the host mounted. */
const DOCKER_SOCKETS = ["/run/docker.sock", "/var/run/docker.sock"];

/** How much of a command's output `runSandboxed` keeps: the last 1 MB (as UTF-16 code units). */
const MAX_OUTPUT = 1024 * 1024;

/** `clone` is mounted over `home`; `hidden` dirs get an empty tmpfs; `shared` paths under `home` stay the real ones. */
export type SandboxSpec = { home: string; clone: string; readOnly: string[]; hidden: string[]; shared: string[] };

const bwrap = () => process.env.JAPA_BWRAP ?? "bwrap";

/** Why `bwrap --ro-bind / / true` fails here (stderr's last line, or the spawn error); undefined when it works. */
export function probeSandbox(): string | undefined {
  const result = spawnSync(bwrap(), ["--ro-bind", "/", "/", "true"], { encoding: "utf8", timeout: 10_000 });
  if (result.error) return result.error.message;
  if (result.status === 0) return undefined;
  return result.stderr.trim().split("\n").at(-1) || `bwrap exited with ${result.status ?? result.signal}`;
}

/**
 * The app directory (its parent in the installed layout, which includes Node), the launcher, and the user's systemd
 * and git config (`XDG_CONFIG_HOME` resolved as `serviceEnv` does): code the daemon runs, outside the sandbox.
 */
export function readOnlyPaths(packageRoot: string, userHome = homedir(), env: NodeJS.ProcessEnv = process.env): string[] {
  const app = basename(packageRoot) === "app" ? dirname(packageRoot) : packageRoot;
  const config = env.XDG_CONFIG_HOME ?? join(userHome, ".config");
  const launcher = join(userHome, ".local", "bin", "japa");
  return [app, launcher, join(config, "systemd"), join(userHome, ".gitconfig"), join(config, "git")];
}

/** The bwrap arguments before the command (spec §3.2); later mounts cover earlier ones. */
export function sandboxArgs(spec: SandboxSpec, cwd = homedir()): string[] {
  const args = ["--bind", "/", "/", "--dev", "/dev", "--unshare-pid", "--proc", "/proc", "--bind", spec.clone, spec.home];
  for (const path of spec.shared) args.push("--bind-try", path, path);
  // The user's runtime dir holds D-Bus, the systemd user manager, ssh-agent and the keyring.
  const hidden = [join("/run/user", String(process.getuid?.())), ...spec.hidden];
  for (const path of hidden.filter((path) => existsSync(path))) args.push("--tmpfs", path);
  // Masked by real path, once each (`/var/run` is usually `/run`); only existing ones, as bwrap can't create them.
  const sockets = new Set(DOCKER_SOCKETS.filter((path) => existsSync(path)).map((path) => realpathSync(path)));
  for (const path of sockets) args.push("--ro-bind-try", "/dev/null", path);
  for (const path of spec.readOnly) args.push("--ro-bind-try", path, path);
  args.push("--die-with-parent", "--new-session", "--clearenv");
  for (const name of ENV) {
    const value = process.env[name];
    if (value !== undefined) args.push("--setenv", name, value);
  }
  return [...args, "--chdir", cwd];
}

/**
 * Runs `command` in a sandbox, killing it after `timeoutMs`; its exit code and its combined stdout and stderr, of
 * which only the last 1 MB is kept.
 */
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
    const append = (chunk: string) => {
      output += chunk;
      if (output.length > MAX_OUTPUT) output = output.slice(-MAX_OUTPUT);
    };
    for (const stream of [child.stdout, child.stderr]) {
      stream.setEncoding("utf8");
      stream.on("data", append);
    }
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
