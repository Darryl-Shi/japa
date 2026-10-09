// The bubblewrap sandbox jobs run in: the host as the user sees it, with the job's clone in place of the japa home and
// its own /tmp, japa's own code and the config it runs under read-only, and nothing of the daemon's processes or
// environment, nor a socket (the user's runtime dir, Docker's) that would run a command outside it.
import { type ChildProcessByStdio, spawn, spawnSync } from "node:child_process";
import {
  accessSync,
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  readlinkSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import type { Readable } from "node:stream";

/**
 * The only variables a sandbox gets: from the daemon's environment as it started, when set. `JAPA_HOME` too, so
 * `japa check` in a job finds the japa home (the job's clone, mounted there).
 */
const ENV = ["PATH", "HOME", "USER", "SHELL", "LANG", "TZ", "TERM", "JAPA_HOME"];

/** Docker's sockets: reaching one means running a container with the host mounted. */
const DOCKER_SOCKETS = ["/run/docker.sock", "/var/run/docker.sock"];

/**
 * Whether `path` is in the sandbox's own `/dev` or `/proc` (`--dev`, `--proc`), where the host's paths aren't seen:
 * pinning a folder there would bring the host's in (its `/dev/shm`), and a mask there is pointless.
 */
const inOwnMount = (path: string) => within(path, "/dev") || within(path, "/proc");

/** How much of a command's output `runSandboxed` keeps: the last 1 MB (as UTF-16 code units). */
const MAX_OUTPUT = 1024 * 1024;

/** A path a job can read but not change, nor create while it's missing; `dir` tells whether it is a directory. */
export type ReadOnlyPath = { path: string; dir: boolean };

/**
 * `clone` is mounted over `home`, and `tmp` (a host dir) at `/tmp` and `/var/tmp`; `hidden` dirs get an empty tmpfs
 * and `hidden` files read empty; `shared` paths under `home` stay the real ones, and `readOnlyShared` ones too,
 * read-only (those that exist). `userHome` is the user's home, the rest of which stays writable. `env` is the
 * sandbox's whole environment (see `jobEnv`); only its allowed names are set.
 */
export type SandboxSpec = {
  home: string;
  userHome: string;
  clone: string;
  tmp: string;
  readOnly: ReadOnlyPath[];
  hidden: string[];
  shared: string[];
  readOnlyShared?: string[];
  env: Record<string, string>;
};

/**
 * The bwrap binary: `JAPA_BWRAP`, or `bwrap` as found in the daemon's own PATH; throws when there is none. Resolved
 * here: bwrap is spawned with the sandbox's environment, so a spawn would look it up in the job's PATH, where a job
 * can put its own.
 */
export function bwrap(): string {
  const command = process.env.JAPA_BWRAP ?? "bwrap";
  if (command.includes("/")) return command;
  for (const dir of (process.env.PATH ?? "").split(":").filter((dir) => isAbsolute(dir))) {
    const path = join(dir, command);
    try {
      accessSync(path, constants.X_OK);
      if (statSync(path).isFile()) return path;
    } catch {}
  }
  throw new Error(`${command}: not found in ${process.env.PATH ?? "an empty PATH"}`);
}

/** The `japa` launcher the installer writes for the user whose home is `userHome`. */
export function launcherPath(userHome = homedir()): string {
  return join(userHome, ".local", "bin", "japa");
}

/**
 * A job's PATH: `original` (the daemon's from before `narrowPath`), then the daemon's Node dir and the launcher's dir
 * where it lacks them, so `node` and `japa check` work in a job whatever PATH the daemon was started with.
 */
export function jobPath(
  original: string | undefined,
  nodeDir = dirname(process.execPath),
  launcherDir = dirname(launcherPath()),
): string {
  const dirs = original === undefined || original === "" ? [] : original.split(":");
  for (const dir of [nodeDir, launcherDir]) if (!dirs.includes(dir)) dirs.push(dir);
  return dirs.join(":");
}

/** The variables of `env` a sandbox may get: `PATH HOME USER SHELL LANG TZ TERM JAPA_HOME`, those that are set. */
export function jobEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  return Object.fromEntries(ENV.flatMap((name) => (env[name] === undefined ? [] : [[name, env[name]]])));
}

/**
 * The runtime dirs masked with an empty tmpfs where they exist: the user's (D-Bus, the systemd user manager,
 * ssh-agent, the keyring) and screen's sockets.
 */
export function runtimeDirs(): string[] {
  return [join("/run/user", String(process.getuid?.())), "/run/screen"];
}

/** Creates `path` as an empty file (and its parent dirs), leaving it as it is if it appeared meanwhile. */
function placeholder(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, "", { flag: "a" });
}

/** Whether `path` is `dir` or under it. */
export function within(path: string, dir: string): boolean {
  const rel = relative(dir, path);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !rel.startsWith(sep));
}

/**
 * `path` with every symlink resolved, dangling ones included, and its missing tail kept as it is; undefined for a
 * symlink loop.
 */
export function realPath(path: string, depth = 0): string | undefined {
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

/** Whether this user can write `path`. */
function writable(path: string): boolean {
  try {
    accessSync(path, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether this user could move `dir` (an existing directory): it can write it, or its parent (renaming takes write
 * access to the parent, not to the folder), or owns the parent, which it could make writable.
 */
function movable(dir: string): boolean {
  const parent = dirname(dir);
  return writable(dir) || writable(parent) || statSync(parent, { throwIfNoEntry: false })?.uid === process.getuid?.();
}

/** Whether this user could create missing `path`: its nearest existing folder is one it can write, or owns. */
function creatable(path: string): boolean {
  let dir = dirname(path);
  while (!existsSync(dir)) dir = dirname(dir);
  return writable(dir) || statSync(dir).uid === process.getuid?.();
}

/** The existing directories above `path`, `/` aside, that this user could move (see `movable`). */
function movableAncestors(path: string): string[] {
  const dirs: string[] = [];
  for (let dir = dirname(path); dir !== dirname(dir); dir = dirname(dir)) {
    if (isDirectory(dir) && movable(dir)) dirs.push(dir);
  }
  return dirs;
}

/** Whether `path` is a directory this user can reach: not one inside a folder it can't enter (EACCES). */
function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Why `bwrap --ro-bind / / true` fails here (stderr's last line, or the spawn error), without a trailing period: the
 * messages showing it add their own; undefined when it works.
 */
export function probeSandbox(): string | undefined {
  const reason = probeFailure();
  return reason === undefined ? undefined : reason.trim().replace(/\.+$/, "") || "bwrap failed";
}

function probeFailure(): string | undefined {
  let command: string;
  try {
    command = bwrap();
  } catch (error) {
    return (error as Error).message;
  }
  const result = spawnSync(command, ["--ro-bind", "/", "/", "true"], { encoding: "utf8", timeout: 10_000 });
  if (result.error) return result.error.message;
  if (result.status === 0) return undefined;
  return result.stderr.trim().split("\n").at(-1) || `bwrap exited with ${result.status ?? result.signal}`;
}

/**
 * What the daemon runs outside the sandbox: the app directory (its parent in the installed layout, which includes
 * Node), the user's systemd units (config and data) and environment.d, and the launcher. Those under
 * `XDG_CONFIG_HOME` and `XDG_DATA_HOME`, when set (absolute and not empty), and the default ones too. Not git config:
 * the daemon's git runs without it.
 */
export function readOnlyPaths(
  packageRoot: string,
  userHome = homedir(),
  env: NodeJS.ProcessEnv = process.env,
): ReadOnlyPath[] {
  const app = basename(packageRoot) === "app" ? dirname(packageRoot) : packageRoot;
  const xdg = (name: string, fallback: string) => {
    const value = env[name];
    return [...new Set([value && isAbsolute(value) ? normalize(value).replace(/(.)\/+$/, "$1") : fallback, fallback])];
  };
  const configs = xdg("XDG_CONFIG_HOME", join(userHome, ".config"));
  const datas = xdg("XDG_DATA_HOME", join(userHome, ".local", "share"));
  const dirs = [
    app,
    ...configs.flatMap((config) => [join(config, "systemd"), join(config, "environment.d")]),
    ...datas.map((data) => join(data, "systemd")),
  ];
  return [...dirs.map((path) => ({ path, dir: true })), { path: launcherPath(userHome), dir: false }];
}

/**
 * Where the read-only paths are mounted: `pinned` dirs are bound onto themselves (a mount point can't be renamed, so
 * the protected paths under them, and the hidden ones, can't be moved away and recreated); a protected symlink's
 * directory is in `readOnlyDirs`, so the link can't be replaced, and its target in `paths`, by real path. A missing
 * protected file is created empty, and a missing dir's parents, before the pins are computed, so the folders they need
 * are pinned too; `missing` dirs get a read-only tmpfs.
 */
function readOnlyMounts(spec: SandboxSpec) {
  const readOnlyDirs = new Set<string>();
  const resolved: ReadOnlyPath[] = [];
  for (const { path, dir } of spec.readOnly) {
    const linkDir = isSymlink(path) ? realPath(dirname(path)) : undefined;
    if (linkDir !== undefined) readOnlyDirs.add(linkDir);
    const real = realPath(path);
    if (real !== undefined) resolved.push({ path: real, dir }); // else a symlink loop: nothing to protect behind it
  }
  const paths: (ReadOnlyPath & { missing: boolean })[] = [];
  for (const { path, dir } of resolved) {
    const missing = !existsSync(path);
    if (missing) {
      // Nothing can be created under a read-only dir (a link's, or another protected one), nor can bwrap create a
      // mount point there; nor where only root could (Node's `/usr/lib/node`): the job can't either.
      const others = resolved.flatMap((other) => (other.dir && other.path !== path ? [other.path] : []));
      if ([...readOnlyDirs, ...others].some((readOnly) => within(path, readOnly)) || !creatable(path)) continue;
      // Not `--ro-bind /dev/null`: bwrap mounts it nodev, so it can't be read (nor run, for the launcher).
      if (dir) mkdirSync(dirname(path), { recursive: true });
      else placeholder(path);
    }
    paths.push({ path, dir, missing: missing && dir });
  }
  // Every folder above them the user could move, wherever it is, the japa home's too: the clone, bound after them,
  // still covers it. The user's home as well, which could otherwise be renamed away whole where its own parent is
  // writable. A hidden path's too: renamed, a folder would take the mask with it, and the next sandbox would find
  // nothing to hide where it was. And a protected path left out above's: it stays out of reach only while the folder
  // the user can't create in (another user's, in one it can write) can't be moved away and recreated as its own.
  const home = realPath(spec.userHome) ?? spec.userHome;
  const targets = [...readOnlyDirs, ...resolved.map(({ path }) => path), ...spec.hidden];
  const pinTargets = targets.filter((path) => !inOwnMount(path));
  const parents = pinTargets.flatMap((path) => movableAncestors(path));
  const pinned = new Set([...(existsSync(home) ? [home] : []), ...parents]);
  // Parents first: binding one covers the mounts already under it.
  return { pinned: [...pinned].sort(), readOnlyDirs: [...readOnlyDirs].sort(), paths };
}

/**
 * The bwrap arguments before the command (spec §3.2); later mounts cover earlier ones. A missing read-only file is
 * first created empty on the host, as bwrap would leave one behind for its mount point anyway.
 *
 * The read-only mounts come first: each binds the host's dir, which would uncover the clone, or a mask, mounted under
 * it earlier (a japa home inside a protected dir, with `JAPA_HOME`). Mounted after them, those cover the host's copy.
 */
export function sandboxArgs(spec: SandboxSpec, cwd = homedir()): string[] {
  const args = ["--bind", "/", "/", "--dev", "/dev", "--unshare-pid", "--proc", "/proc"];
  const { pinned, readOnlyDirs, paths } = readOnlyMounts(spec);
  for (const dir of pinned) args.push("--bind", dir, dir);
  for (const dir of readOnlyDirs) args.push("--ro-bind", dir, dir);
  for (const { path, missing } of paths) {
    if (missing) args.push("--tmpfs", path, "--remount-ro", path);
    else args.push("--ro-bind", path, path);
  }
  for (const dir of ["/tmp", "/var/tmp"].filter((dir) => existsSync(dir))) args.push("--bind", spec.tmp, dir);
  args.push("--bind", spec.clone, spec.home);
  for (const path of spec.shared) args.push("--bind-try", path, path);
  for (const path of spec.readOnlyShared ?? []) args.push("--ro-bind-try", path, path);
  // A hidden dir gets an empty tmpfs; a file (a database outside the home) reads as /dev/null and writes go there.
  // Not `--ro-bind /dev/null`: bwrap mounts that nodev, where /dev/null can't even be opened.
  for (const path of [...spec.hidden.filter((path) => !inOwnMount(path)), ...runtimeDirs()]) {
    const stat = statSync(path, { throwIfNoEntry: false });
    if (stat?.isDirectory()) args.push("--tmpfs", path);
    else if (stat !== undefined) args.push("--dev-bind", "/dev/null", path);
  }
  // Masked by real path, once each (`/var/run` is usually `/run`); only existing ones, as bwrap can't create them.
  const sockets = new Set(DOCKER_SOCKETS.filter((path) => existsSync(path)).map((path) => realpathSync(path)));
  for (const path of sockets) args.push("--ro-bind-try", "/dev/null", path);
  args.push("--die-with-parent", "--new-session", "--clearenv");
  for (const name of ENV) {
    const value = spec.env[name];
    if (value !== undefined) args.push("--setenv", name, value);
  }
  return [...args, "--chdir", cwd];
}

/**
 * Runs `command` in a sandbox, killing it after `timeoutMs`; its exit code and its combined stdout and stderr, of
 * which only the last 1 MB is kept. Once `signal` aborts, the sandbox is killed, and the promise rejects with its
 * reason when it's gone; an aborted `signal` runs nothing.
 */
export function runSandboxed(
  spec: SandboxSpec,
  command: string[],
  o: { timeoutMs: number; cwd?: string; signal?: AbortSignal },
): Promise<{ code: number | null; output: string; timedOut: boolean }> {
  const { signal } = o;
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    let child: ChildProcessByStdio<null, Readable, Readable>;
    try {
      // Setting it up touches the host (realpath, placeholders): EACCES, ENOTDIR, a race. And spawn throws, before
      // running anything, on an argument with a NUL byte. bwrap gets only the sandbox's environment: its own is
      // readable in the sandbox, at /proc/1/environ. In its own process group, so that killing it kills that.
      child = spawn(bwrap(), [...sandboxArgs(spec, o.cwd), ...command], {
        stdio: ["ignore", "pipe", "pipe"],
        env: spec.env,
        detached: true,
      });
    } catch (error) {
      resolve({ code: null, output: error instanceof Error ? error.message : String(error), timedOut: false });
      return;
    }
    // bwrap's group: what's in the sandbox dies with it (`--die-with-parent`, and its PID namespace ends).
    const kill = () => {
      try {
        process.kill(-child.pid!, "SIGKILL");
      } catch {
        child.kill("SIGKILL"); // the group is gone already, or never was
      }
    };
    const onAbort = () => kill();
    signal?.addEventListener("abort", onAbort, { once: true });
    let output = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, o.timeoutMs);
    const settle = (result: { code: number | null; output: string; timedOut: boolean }) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (signal?.aborted) reject(signal.reason);
      else resolve(result);
    };
    const append = (chunk: string) => {
      output += chunk;
      if (output.length > MAX_OUTPUT) output = output.slice(-MAX_OUTPUT);
    };
    for (const stream of [child.stdout, child.stderr]) {
      stream.setEncoding("utf8");
      stream.on("data", append);
    }
    child.on("error", (error) => settle({ code: null, output: `${output}${error.message}`, timedOut }));
    child.on("close", (code) => settle({ code, output, timedOut }));
  });
}
