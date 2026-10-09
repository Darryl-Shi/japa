// The bubblewrap sandbox jobs run in: the host as the user sees it, with the job's clone in place of the japa home and
// its own /tmp, japa's own code and the config it runs under read-only, and nothing of the daemon's processes or
// environment, nor a socket (the user's runtime dir, Docker's) that would run a command outside it.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readlinkSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

/** The variables a sandbox gets from the daemon's environment, when set. */
const ENV = ["PATH", "HOME", "USER", "SHELL", "LANG", "TZ", "TERM"];

/** Docker's sockets: reaching one means running a container with the host mounted. */
const DOCKER_SOCKETS = ["/run/docker.sock", "/var/run/docker.sock"];

/** How much of a command's output `runSandboxed` keeps: the last 1 MB (as UTF-16 code units). */
const MAX_OUTPUT = 1024 * 1024;

/** A path a job can read but not change, nor create while it's missing; `dir` tells whether it is a directory. */
export type ReadOnlyPath = { path: string; dir: boolean };

/**
 * `clone` is mounted over `home`, and `tmp` (a host dir) at `/tmp` and `/var/tmp`; `hidden` dirs get an empty tmpfs;
 * `shared` paths under `home` stay the real ones. `userHome` is the user's home, the rest of which stays writable.
 */
export type SandboxSpec = {
  home: string;
  userHome: string;
  clone: string;
  tmp: string;
  readOnly: ReadOnlyPath[];
  hidden: string[];
  shared: string[];
};

const bwrap = () => process.env.JAPA_BWRAP ?? "bwrap";

/** Creates `path` as an empty file (and its parent dirs), leaving it as it is if it appeared meanwhile. */
function placeholder(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, "", { flag: "a" });
}

/** Whether `path` is `dir` or under it. */
function within(path: string, dir: string): boolean {
  const rel = relative(dir, path);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !rel.startsWith(sep));
}

/**
 * `path` with every symlink resolved, dangling ones included, and its missing tail kept as it is; undefined for a
 * symlink loop.
 */
function realPath(path: string, depth = 0): string | undefined {
  if (depth > 40) return undefined;
  try {
    return realpathSync(path);
  } catch {}
  const parent = dirname(path);
  if (parent === path) return path;
  const realParent = realPath(parent, depth + 1);
  if (realParent === undefined) return undefined;
  const real = join(realParent, basename(path));
  let link: string;
  try {
    link = readlinkSync(real);
  } catch {
    return real; // missing, or not a symlink
  }
  return realPath(resolve(realParent, link), depth + 1);
}

/** Whether `path` itself is a symlink. */
function isSymlink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

/** The existing directories strictly between `home` and `path`, when `path` is under it. */
function between(home: string, path: string): string[] {
  const dirs: string[] = [];
  if (!within(path, home)) return dirs;
  for (let dir = dirname(path); dir !== home && within(dir, home); dir = dirname(dir)) {
    if (existsSync(dir)) dirs.push(dir);
  }
  return dirs;
}

/** Why `bwrap --ro-bind / / true` fails here (stderr's last line, or the spawn error); undefined when it works. */
export function probeSandbox(): string | undefined {
  const result = spawnSync(bwrap(), ["--ro-bind", "/", "/", "true"], { encoding: "utf8", timeout: 10_000 });
  if (result.error) return result.error.message;
  if (result.status === 0) return undefined;
  return result.stderr.trim().split("\n").at(-1) || `bwrap exited with ${result.status ?? result.signal}`;
}

/**
 * What the daemon runs outside the sandbox: the app directory (its parent in the installed layout, which includes
 * Node), the user's systemd units (config and data) and environment.d, and the launcher. `XDG_CONFIG_HOME` and
 * `XDG_DATA_HOME` are resolved as `serviceEnv` does. Not git config: the daemon's git runs without it.
 */
export function readOnlyPaths(
  packageRoot: string,
  userHome = homedir(),
  env: NodeJS.ProcessEnv = process.env,
): ReadOnlyPath[] {
  const app = basename(packageRoot) === "app" ? dirname(packageRoot) : packageRoot;
  const config = env.XDG_CONFIG_HOME ?? join(userHome, ".config");
  const data = env.XDG_DATA_HOME ?? join(userHome, ".local", "share");
  const dirs = [app, join(config, "systemd"), join(config, "environment.d"), join(data, "systemd")];
  return [...dirs.map((path) => ({ path, dir: true })), { path: join(userHome, ".local", "bin", "japa"), dir: false }];
}

/**
 * Where the read-only paths are mounted: `pinned` dirs are bound onto themselves (a mount point can't be renamed, so
 * the protected paths under them can't be moved away and recreated); a protected symlink's directory is in
 * `readOnlyDirs`, so the link can't be replaced, and its target in `paths`, by real path.
 */
function readOnlyMounts(spec: SandboxSpec) {
  const home = realPath(spec.userHome) ?? spec.userHome;
  const jobHome = realPath(spec.home) ?? spec.home;
  const pinned = new Set<string>();
  const readOnlyDirs = new Set<string>();
  const paths: ReadOnlyPath[] = [];
  const pin = (path: string) => {
    for (const dir of between(home, path)) if (!within(jobHome, dir)) pinned.add(dir);
  };
  for (const { path, dir } of spec.readOnly) {
    const linkDir = isSymlink(path) ? realPath(dirname(path)) : undefined;
    if (linkDir !== undefined) {
      readOnlyDirs.add(linkDir);
      pin(linkDir);
    }
    const real = realPath(path);
    if (real === undefined) continue; // a symlink loop: nothing to protect behind it
    pin(real);
    paths.push({ path: real, dir });
  }
  // Parents first: binding one covers the mounts already under it.
  return { pinned: [...pinned].sort(), readOnlyDirs: [...readOnlyDirs].sort(), paths };
}

/**
 * The bwrap arguments before the command (spec §3.2); later mounts cover earlier ones. A missing read-only file is
 * first created empty on the host, as bwrap would leave one behind for its mount point anyway.
 */
export function sandboxArgs(spec: SandboxSpec, cwd = homedir()): string[] {
  const args = ["--bind", "/", "/", "--dev", "/dev", "--unshare-pid", "--proc", "/proc"];
  const { pinned, readOnlyDirs, paths } = readOnlyMounts(spec);
  for (const dir of pinned) args.push("--bind", dir, dir);
  // Before the mounts below: a bind takes the host's dir, which would uncover them.
  for (const dir of readOnlyDirs) args.push("--ro-bind", dir, dir);
  for (const dir of ["/tmp", "/var/tmp"].filter((dir) => existsSync(dir))) args.push("--bind", spec.tmp, dir);
  args.push("--bind", spec.clone, spec.home);
  for (const path of spec.shared) args.push("--bind-try", path, path);
  // The user's runtime dir holds D-Bus, the systemd user manager, ssh-agent and the keyring.
  const hidden = [join("/run/user", String(process.getuid?.())), ...spec.hidden];
  for (const path of hidden.filter((path) => existsSync(path))) args.push("--tmpfs", path);
  // Masked by real path, once each (`/var/run` is usually `/run`); only existing ones, as bwrap can't create them.
  const sockets = new Set(DOCKER_SOCKETS.filter((path) => existsSync(path)).map((path) => realpathSync(path)));
  for (const path of sockets) args.push("--ro-bind-try", "/dev/null", path);
  for (const { path, dir } of paths) {
    // Nothing can be created under a read-only dir, nor can bwrap create a mount point there.
    if (!existsSync(path) && readOnlyDirs.some((readOnly) => within(path, readOnly))) continue;
    if (!existsSync(path) && dir) {
      args.push("--tmpfs", path, "--remount-ro", path);
      continue;
    }
    // Not `--ro-bind /dev/null`: bwrap mounts it nodev, so it can't be read (nor run, for the launcher).
    if (!existsSync(path)) placeholder(path);
    args.push("--ro-bind", path, path);
  }
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
