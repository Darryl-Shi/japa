import { execFileSync, spawnSync } from "node:child_process";
import {
  accessSync,
  chmodSync,
  constants,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { describe, expect, onTestFinished, test } from "vitest";
import {
  jobEnv,
  jobPath,
  launcherPath,
  probeSandbox,
  readOnlyPaths,
  runSandboxed,
  runtimeDirs,
  sandboxArgs,
  type SandboxSpec,
  within,
} from "../src/kernel/sandbox/bwrap.ts";
import { NO_BWRAP, sandboxScratch, tempHome, waitFor } from "./helpers.ts";

const ALLOWED = ["PATH", "HOME", "USER", "SHELL", "LANG", "TZ", "TERM", "JAPA_HOME"];

const git = (dir: string, ...args: string[]) =>
  execFileSync("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@localhost", "-c", "commit.gpgsign=false", ...args], {
    encoding: "utf8",
  }).trim();

/** Runs `fn` with `process.env[name]` set to `value` (unset when undefined), then restores it. */
function withEnv<T>(name: string, value: string | undefined, fn: () => T): T {
  const saved = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  try {
    return fn();
  } finally {
    if (saved === undefined) delete process.env[name];
    else process.env[name] = saved;
  }
}

const NO_SYSTEMD_RUN = spawnSync("systemd-run", ["--version"]).status !== 0;
const DOCKER_SOCKETS = ["/run/docker.sock", "/var/run/docker.sock"].filter((path) => existsSync(path));
const RUNTIME_DIR = `/run/user/${process.getuid?.()}`;

/** A script that tries to create or overwrite each of `paths`: prints `wrote <path>` for each that worked, then `done`. */
function tryWrites(paths: string[]): string {
  const write = `(mkdir -p "$(dirname "$f")" && echo x > "$f") 2>/dev/null && echo "wrote $f"`;
  return `for f in ${paths.map((f) => `"${f}"`).join(" ")}; do ${write}; done; echo done`;
}

/**
 * A japa home with `secrets/x`, `state.db`, `japa.sock` and a shared folder, and `marker` and `skills/s` committed;
 * its clone at `.jobs/1`. Outside `/tmp`: the sandbox's `/tmp`; a user home with an installed app (and its Node), the
 * launcher and the service unit, but no `.local/share/systemd` or `.config/environment.d`; a hidden dir, plus a
 * missing one. All removed when the test finishes. The japa home is a temp dir, or `o.japaHome` under the user home;
 * `o.env(user)` is the environment the protected paths are resolved with.
 */
function sandbox(o: { japaHome?: string; env?: (user: string) => NodeJS.ProcessEnv } = {}) {
  const outside = sandboxScratch("japa-sandbox-");
  const user = join(outside, "user");
  const home = o.japaHome === undefined ? tempHome() : join(user, o.japaHome);
  mkdirSync(home, { recursive: true });
  onTestFinished(() => {
    rmSync(home, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });
  mkdirSync(join(home, "secrets"));
  writeFileSync(join(home, "secrets", "x"), "secret");
  writeFileSync(join(home, "state.db"), "db");
  writeFileSync(join(home, "japa.sock"), "");
  mkdirSync(join(home, "desktop", "shared"), { recursive: true });
  writeFileSync(join(home, ".gitignore"), "secrets/\nstate.db\njapa.sock\n/desktop/\n.jobs/\n");
  writeFileSync(join(home, "marker"), "m");
  mkdirSync(join(home, "skills", "s"), { recursive: true });
  writeFileSync(join(home, "skills", "s", "SKILL.md"), "s");
  git(home, "init", "-q", "-b", "main");
  git(home, "add", "-A");
  git(home, "commit", "-qm", "init");
  const clone = join(home, ".jobs", "1");
  execFileSync("git", ["clone", "-q", "--local", home, clone]);

  const app = join(user, ".local", "share", "japa", "app");
  const units = join(user, ".config", "systemd", "user");
  for (const [path, text] of [
    [join(app, "main.ts"), "app"],
    [join(user, ".local", "share", "japa", "node", "node"), "node"],
    [join(user, ".local", "bin", "japa"), "launcher"],
    [join(units, "japa.service"), "unit"],
  ] as const) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
  }
  const hidden = join(outside, "secrets");
  mkdirSync(hidden);
  writeFileSync(join(hidden, "key"), "hidden-secret");
  const tmp = join(outside, "tmp");
  mkdirSync(tmp);

  const spec: SandboxSpec = {
    home,
    userHome: user,
    clone,
    tmp,
    readOnly: readOnlyPaths(app, user, o.env?.(user) ?? {}),
    hidden: [hidden, join(outside, "absent")],
    shared: [join(home, "desktop", "shared")],
    env: jobEnv(),
  };
  const run = (script: string, o: { timeoutMs?: number; cwd?: string } = {}) =>
    runSandboxed(spec, ["bash", "-c", script], { timeoutMs: o.timeoutMs ?? 10_000, cwd: o.cwd });
  return { home, clone, outside, user, app, units, hidden, tmp, spec, run };
}

test("probe fails with JAPA_BWRAP=/nonexistent", () => {
  expect(withEnv("JAPA_BWRAP", "/nonexistent", probeSandbox)).toMatch(/\S/);
});

test("the probe's reason has no trailing period, as messages add their own", () => {
  const dir = mkdtempSync(join(tmpdir(), "japa-fake-bwrap-"));
  const fake = join(dir, "bwrap");
  writeFileSync(fake, "#!/bin/sh\necho 'bwrap: No permissions to create a new namespace.' >&2\nexit 1\n");
  chmodSync(fake, 0o755);
  expect(withEnv("JAPA_BWRAP", fake, probeSandbox)).toBe("bwrap: No permissions to create a new namespace");
});

test("readOnlyPaths covers the app dir (with its Node), the launcher, the user's systemd and environment.d", () => {
  const dir = (path: string) => ({ path, dir: true });
  const file = (path: string) => ({ path, dir: false });
  const paths = (app: string, config = "/u/.config", data = "/u/.local/share") => [
    dir(app),
    dir(`${config}/systemd`),
    dir(`${config}/environment.d`),
    dir(`${data}/systemd`),
    file("/u/.local/bin/japa"),
  ];
  expect(readOnlyPaths("/u/.local/share/japa/app", "/u", {})).toEqual(paths("/u/.local/share/japa"));
  expect(readOnlyPaths("/src/japa", "/u", {})).toEqual(paths("/src/japa"));
  // Set, they add to the defaults, which the user's systemd may still read; empty or the default, they change nothing.
  const xdg = { XDG_CONFIG_HOME: "/x", XDG_DATA_HOME: "/d" };
  expect(readOnlyPaths("/src/japa", "/u", xdg)).toEqual([
    dir("/src/japa"),
    dir("/x/systemd"),
    dir("/x/environment.d"),
    dir("/u/.config/systemd"),
    dir("/u/.config/environment.d"),
    dir("/d/systemd"),
    dir("/u/.local/share/systemd"),
    file("/u/.local/bin/japa"),
  ]);
  expect(readOnlyPaths("/src/japa", "/u", { XDG_CONFIG_HOME: "", XDG_DATA_HOME: "" })).toEqual(paths("/src/japa"));
  const defaults = { XDG_CONFIG_HOME: "/u/.config", XDG_DATA_HOME: "/u/.local/share/" };
  expect(readOnlyPaths("/src/japa", "/u", defaults)).toEqual(paths("/src/japa"));
});

/** A user home under the system temp dir, removed when the test finishes. */
function tempUser(): string {
  const user = realpathSync(mkdtempSync(join(tmpdir(), "japa-sandbox-")));
  onTestFinished(() => rmSync(user, { recursive: true, force: true }));
  return user;
}

/** The paths `args` binds onto themselves with `--bind`, but `/`. */
const pins = (args: string[]) =>
  args.flatMap((arg, i) => (arg === "--bind" && args[i + 1] === args[i + 2] && args[i + 1] !== "/" ? [args[i + 1]] : []));

/** Those of `pins` that are `user` or under it (the writable folders above a temp user home are pinned too). */
const pinsIn = (args: string[], user: string) => pins(args).filter((dir) => dir === user || dir.startsWith(`${user}/`));

/** A spec with nothing to protect, for a japa home `/h` and a user home `/u` that don't exist. */
const bare: SandboxSpec = {
  home: "/h",
  userHome: "/u",
  clone: "/h/.jobs/1",
  tmp: "/t",
  readOnly: [],
  hidden: [],
  shared: [],
  env: {},
};

test("jobEnv passes JAPA_HOME when it's set", () => {
  expect(jobEnv({ PATH: "/p", JAPA_HOME: "/h/.japa", OTHER: "x" })).toEqual({ PATH: "/p", JAPA_HOME: "/h/.japa" });
});

test("jobPath appends the daemon's Node dir and the launcher's dir, once each", () => {
  expect(jobPath("/usr/bin:/bin", "/n/bin", "/u/.local/bin")).toBe("/usr/bin:/bin:/n/bin:/u/.local/bin");
  expect(jobPath("/n/bin:/usr/bin", "/n/bin", "/u/.local/bin")).toBe("/n/bin:/usr/bin:/u/.local/bin");
  expect(jobPath(undefined, "/n/bin", "/u/.local/bin")).toBe("/n/bin:/u/.local/bin");
  expect(launcherPath("/u")).toBe("/u/.local/bin/japa");
});

test("jobEnv keeps the allowed variables that are set", () => {
  const env = { PATH: "/p", HOME: "/u", TERM: undefined, FOO_SECRET: "1", ANTHROPIC_API_KEY: "k" };
  expect(jobEnv(env)).toEqual({ PATH: "/p", HOME: "/u" });
});

test("sandboxArgs sets the allowed variables from the spec's env, not the daemon's", () => {
  const spec = { ...bare, env: { PATH: "/job/bin", HOME: "/u", FOO_SECRET: "1" } };
  const set = (args: string[]) => args.flatMap((arg, i) => (args[i - 1] === "--setenv" ? [`${arg}=${args[i + 1]}`] : []));
  expect(set(sandboxArgs(spec))).toEqual(["PATH=/job/bin", "HOME=/u"]);
  expect(set(sandboxArgs({ ...bare, env: {} }))).toEqual([]);
});

test("sandboxArgs masks each existing docker socket once, by its real path", () => {
  const spec = bare;
  const args = sandboxArgs(spec);
  const masked = args.flatMap((arg, i) => (arg === "/dev/null" && args[i - 1] === "--ro-bind-try" ? [args[i + 1]] : []));
  // A missing mount point would make bwrap fail ("Can't create file at /run/docker.sock").
  expect(masked).toEqual([...new Set(DOCKER_SOCKETS.map((path) => realpathSync(path)))]);
});

test("sandboxArgs mounts in order: pins, link dirs, protected paths, /tmp, the clone, shared, hidden, runtime, docker", () => {
  const user = tempUser();
  for (const dir of [".config/environment.d", ".local/share/japa/app", ".local/bin", "dotfiles/systemd", "hidden"]) {
    mkdirSync(join(user, dir), { recursive: true });
  }
  writeFileSync(join(user, ".local", "bin", "japa"), "launcher");
  symlinkSync(join(user, "dotfiles", "systemd"), join(user, ".config", "systemd"));
  // The japa home inside a protected dir: its clone must come after the protected binds, or they'd cover it.
  const home = join(user, ".local", "share", "japa", "home");
  const spec: SandboxSpec = {
    home,
    userHome: user,
    clone: join(home, ".jobs", "1"),
    tmp: join(user, "tmp"),
    readOnly: readOnlyPaths(join(user, ".local", "share", "japa", "app"), user, {}),
    hidden: [join(user, "hidden")],
    shared: [join(home, "shared")],
    env: {},
  };
  const args = sandboxArgs(spec);
  const index = (flag: string, path: string) => {
    const i = args.findIndex((arg, j) => args[j - 1] === flag && arg === path);
    expect(i, `${flag} ${path}`).toBeGreaterThan(-1);
    return i;
  };
  const order = [
    index("--proc", "/proc"),
    index("--bind", user),
    index("--bind", join(user, ".config")),
    index("--bind", join(user, ".local", "share")),
    index("--ro-bind", join(user, ".config")),
    index("--ro-bind", join(user, ".local", "share", "japa")),
    index("--ro-bind", join(user, "dotfiles", "systemd")),
    index("--ro-bind", join(user, ".local", "bin", "japa")),
    index("--bind", spec.tmp),
    index("--bind", spec.clone),
    index("--bind-try", join(home, "shared")),
    index("--tmpfs", join(user, "hidden")),
    ...runtimeDirs()
      .filter((path) => existsSync(path))
      .map((path) => index("--tmpfs", path)),
    ...(DOCKER_SOCKETS.length > 0 ? [index("--ro-bind-try", "/dev/null")] : []),
  ];
  expect(order).toEqual([...order].sort((a, b) => a - b));
});

test("sandboxArgs pins the user's home and the existing folders between it and each protected path, the job home's too", () => {
  const user = tempUser();
  for (const dir of [".config/systemd", ".local/share/japa", ".local/bin", ".local/jobs"]) {
    mkdirSync(join(user, dir), { recursive: true });
  }
  const home = join(user, ".local", "jobs");
  const spec: SandboxSpec = {
    home,
    userHome: user,
    clone: join(home, ".jobs", "1"),
    tmp: "/t",
    readOnly: readOnlyPaths(join(user, ".local", "share", "japa", "app"), user, {}),
    hidden: [],
    shared: [],
    env: {},
  };
  const args = sandboxArgs(spec);
  // `.local` holds the job home, which the clone (bound later) still covers; so does the user's home.
  const local = join(user, ".local");
  expect(pinsIn(args, user)).toEqual([user, join(user, ".config"), local, join(local, "bin"), join(local, "share")]);
  const at = (path: string) => args.findIndex((arg, i) => arg === path && args[i - 1] === "--bind");
  expect(at(user)).toBeGreaterThan(args.indexOf("/proc"));
  expect(at(user)).toBeLessThan(at(join(user, ".config")));
  expect(at(join(user, ".config"))).toBeGreaterThan(args.indexOf("/proc"));
  expect(at(local)).toBeLessThan(args.indexOf(spec.clone));
});

test("sandboxArgs creates missing placeholders and their folders first, and pins those folders too", () => {
  const user = tempUser();
  mkdirSync(join(user, ".config", "systemd"), { recursive: true });
  // Not `app`: that would make its parent, the user's home, the protected app dir.
  mkdirSync(join(user, "src"));
  const spec: SandboxSpec = {
    home: join(user, "japa"),
    userHome: user,
    clone: join(user, "japa", ".jobs", "1"),
    tmp: "/t",
    readOnly: readOnlyPaths(join(user, "src"), user, {}),
    hidden: [],
    shared: [],
    env: {},
  };
  const args = sandboxArgs(spec);
  const local = join(user, ".local");
  expect(readFileSync(join(local, "bin", "japa"), "utf8")).toBe("");
  expect(pinsIn(args, user)).toEqual([user, join(user, ".config"), local, join(local, "bin"), join(local, "share")]);
  const systemd = join(local, "share", "systemd");
  expect(args.join(" ")).toContain(`--tmpfs ${systemd} --remount-ro ${systemd}`);
});

/** A missing dir only root could create (bwrap can't make a mount point there either); undefined as root. */
const ROOTS_ONLY =
  process.getuid?.() === 0 || !existsSync("/usr/lib") ? undefined : `/usr/lib/japa-missing-${process.pid}`;

// Node's `<prefix>/lib/node`, usually missing: in the app dir with japa's own Node, under /usr with the system's.
test("sandboxArgs leaves out a missing protected dir inside another protected one, or only root's", () => {
  const user = tempUser();
  const app = join(user, "app");
  mkdirSync(app);
  const inApp = join(app, "node", "lib", "node");
  const readOnly = [inApp, app, ...(ROOTS_ONLY ? [ROOTS_ONLY] : [])].map((path) => ({ path, dir: true }));
  const args = sandboxArgs({ ...bare, userHome: user, readOnly });
  expect(args).toContain(app);
  expect(args.filter((arg) => arg === inApp || arg === ROOTS_ONLY)).toEqual([]);
  expect(existsSync(join(app, "node"))).toBe(false);
});

/**
 * A folder this user neither owns nor can write, in one it can write (the system temp dir), preferably one it can't
 * even enter (systemd's private tmp dirs); undefined if none.
 */
const FOREIGN = (() => {
  const can = (path: string, mode: number) => {
    try {
      accessSync(path, mode);
      return true;
    } catch {
      return false;
    }
  };
  if (process.getuid?.() === 0 || !can(tmpdir(), constants.W_OK)) return undefined;
  const found = readdirSync(tmpdir())
    .map((name) => join(tmpdir(), name))
    .filter((path) => {
      const stat = statSync(path, { throwIfNoEntry: false });
      return stat?.isDirectory() && stat.uid !== process.getuid?.() && !can(path, constants.W_OK);
    });
  return found.find((path) => !can(path, constants.X_OK)) ?? found[0];
})();

// Left out (no mount point can be made in it), the path stays out of reach only while that folder can't be moved
// away and recreated as the user's own.
test.skipIf(FOREIGN === undefined)(
  "sandboxArgs pins the folders above a missing protected dir it leaves out (skipped: no foreign folder in tmp)",
  () => {
    const path = join(FOREIGN!, "lib", "node");
    const args = sandboxArgs({ ...bare, readOnly: [{ path, dir: true }] });
    expect(args).not.toContain(path);
    expect(pins(args)).toContain(FOREIGN);
  },
);

test("sandboxArgs hides a dir with an empty tmpfs and a file with /dev/null, those that exist", () => {
  const user = tempUser();
  mkdirSync(join(user, "dir"));
  writeFileSync(join(user, "file"), "secret");
  const hidden = [join(user, "dir"), join(user, "file"), join(user, "absent")];
  const args = sandboxArgs({ ...bare, userHome: user, hidden }).join(" ");
  expect(args).toContain(`--tmpfs ${join(user, "dir")}`);
  // Not `--ro-bind`: bwrap mounts that nodev, so the file couldn't be read at all.
  expect(args).toContain(`--dev-bind /dev/null ${join(user, "file")}`);
  expect(args).not.toContain(join(user, "absent"));
});

test("sandboxArgs pins the existing folders between the user's home and each hidden path, a missing one's too", () => {
  const user = tempUser();
  const secrets = join(user, ".config", "japa", "secrets");
  mkdirSync(secrets, { recursive: true });
  mkdirSync(join(user, "data", "db"), { recursive: true });
  // A missing `-wal`, which the database may create later: its folders are pinned already.
  const wal = join(user, "data", "db", "state.db-wal");
  const args = sandboxArgs({ ...bare, userHome: user, hidden: [secrets, wal, "/elsewhere/secrets"] });
  const config = join(user, ".config");
  const data = join(user, "data");
  expect(pinsIn(args, user)).toEqual([user, config, join(config, "japa"), data, join(data, "db")]);
});

test("sandboxArgs pins every writable folder above a protected or hidden path, outside the user's home too", () => {
  const root = tempUser();
  const user = join(root, "user");
  const secrets = join(root, "elsewhere", "a", "secrets");
  const app = join(root, "elsewhere", "b", "app");
  for (const dir of [user, secrets, app]) mkdirSync(dir, { recursive: true });
  const readOnly = [
    { path: app, dir: true },
    { path: "/usr/bin", dir: true },
  ];
  const args = sandboxArgs({ ...bare, userHome: user, readOnly, hidden: [secrets, "/elsewhere/secrets"] });
  const elsewhere = join(root, "elsewhere");
  expect(pinsIn(args, root)).toEqual([root, elsewhere, join(elsewhere, "a"), join(elsewhere, "b"), user]);
  // Not `/`, nor a folder this user can't write (unless it runs as root).
  expect(pins(args)).not.toContain("/");
  if (process.getuid?.() !== 0) expect(pins(args)).not.toContain("/usr");
  // Before the clone, which covers any that holds the japa home.
  expect(args.lastIndexOf(join(elsewhere, "a"))).toBeLessThan(args.indexOf(bare.clone));
});

test("sandboxArgs pins a folder it can't write in one it can but doesn't own (sticky /tmp, a group's)", () => {
  const locked = tempUser(); // directly in the system temp dir, which root owns
  mkdirSync(join(locked, "secrets"));
  chmodSync(locked, 0o555);
  try {
    expect(pins(sandboxArgs({ ...bare, hidden: [join(locked, "secrets")] }))).toContain(locked);
  } finally {
    chmodSync(locked, 0o755);
  }
});

// Pinned, the host's /dev/shm would replace the sandbox's empty one; a mask there is pointless, or fails (/proc/1).
test("sandboxArgs neither pins nor masks under /dev or /proc: the sandbox has its own", () => {
  const shm = existsSync("/dev/shm") ? mkdtempSync("/dev/shm/japa-sandbox-") : undefined;
  if (shm !== undefined) onTestFinished(() => rmSync(shm, { recursive: true, force: true }));
  const secrets = shm === undefined ? [] : [join(shm, "secrets")];
  for (const dir of secrets) mkdirSync(dir);
  const readOnly = shm === undefined ? [] : [{ path: shm, dir: true }];
  const args = sandboxArgs({ ...bare, readOnly, hidden: [...secrets, "/proc/1", "/proc/self/fd"] });
  expect(pins(args).filter((dir) => within(dir, "/dev") || within(dir, "/proc"))).toEqual([]);
  expect(args.filter((arg) => [...secrets, "/proc/1", "/proc/self/fd"].includes(arg))).toEqual([]);
});

test("sandboxArgs masks the runtime dirs that exist: the user's, and screen's sockets", () => {
  expect(runtimeDirs()).toEqual([`/run/user/${process.getuid?.()}`, "/run/screen"]);
  const args = sandboxArgs(bare);
  const masked = args.flatMap((arg, i) => (args[i - 1] === "--tmpfs" ? [arg] : []));
  // Only existing ones: bwrap can't create a mount point under /run.
  expect(masked).toEqual(runtimeDirs().filter((path) => existsSync(path)));
});

test("runSandboxed resolves with the error when the sandbox can't be set up", async () => {
  const user = tempUser();
  writeFileSync(join(user, ".local"), "not a dir");
  const spec: SandboxSpec = {
    home: join(user, "japa"),
    userHome: user,
    clone: join(user, "japa", ".jobs", "1"),
    tmp: "/t",
    readOnly: [{ path: join(user, ".local", "bin", "japa"), dir: false }],
    hidden: [],
    shared: [],
    env: {},
  };
  const result = await runSandboxed(spec, ["true"], { timeoutMs: 1000 });
  expect(result).toEqual({ code: null, output: expect.stringMatching(/ENOTDIR|EEXIST/), timedOut: false });
});

test("runSandboxed resolves with the error when the command can't be spawned", async () => {
  const user = tempUser();
  const spec = { ...bare, userHome: user };
  // Node refuses an argument with a NUL byte before running anything.
  const result = await runSandboxed(spec, ["echo", "a\0b"], { timeoutMs: 1000 });
  expect(result).toEqual({ code: null, output: expect.stringContaining("null bytes"), timedOut: false });
});

describe.skipIf(NO_BWRAP)("the sandbox", () => {
  test("probe passes here", () => {
    expect(probeSandbox()).toBeUndefined();
  });

  test("the real home is replaced by the clone", async () => {
    const { home, run } = sandbox();
    const { output } = await run(`for f in secrets/x state.db japa.sock marker; do test -e "${home}/$f" && echo $f; done`);
    expect(output.trim()).toBe("marker");
  });

  test("git works in the clone, the real repo is unreachable", async () => {
    const { home, run } = sandbox();
    writeFileSync(join(home, "later"), "l");
    git(home, "add", "later");
    git(home, "commit", "-qm", "later on main");
    const { output } = await run(
      `git -C "${home}" log --oneline >/dev/null; echo "log=$?"; git -C "${home}" fetch -q; git -C "${home}" log --all --format=%s`,
    );
    expect(output).toContain("log=0");
    expect(output).toContain("init");
    expect(output).not.toContain("later on main");
  });

  test("read-only paths can't be written, nor files created in them", async () => {
    const { user, app, units, run } = sandbox();
    const targets = [
      join(app, "main.ts"),
      join(app, "new.ts"),
      join(dirname(app), "node", "node"),
      join(user, ".local", "bin", "japa"),
      join(units, "japa.service"),
      join(units, "japa.service.d", "x.conf"),
      join(units, "evil.service"),
    ];
    const { output } = await run(tryWrites(targets));
    expect(output.trim()).toBe("done");
    expect(readFileSync(join(app, "main.ts"), "utf8")).toBe("app");
    expect(existsSync(join(units, "japa.service.d"))).toBe(false);
  });

  test("missing protected paths can't be created", async () => {
    const { user, run } = sandbox();
    const launcher = join(user, ".local", "bin", "japa");
    rmSync(launcher);
    const config = join(user, ".config");
    const targets = [
      launcher,
      join(user, ".local", "share", "systemd", "user", "japa.service.d", "x.conf"),
      join(config, "environment.d", "x.conf"),
    ];
    const { output } = await run(tryWrites(targets));
    expect(output.trim()).toBe("done");
    // At most an empty placeholder is left behind.
    expect(existsSync(launcher) ? readFileSync(launcher, "utf8") : "").toBe("");
    for (const dir of [join(user, ".local", "share", "systemd"), join(config, "environment.d")]) {
      expect(existsSync(dir) ? readdirSync(dir) : []).toEqual([]);
    }
  });

  test("a sandbox starts with a missing protected dir inside another protected one, or only root's", async () => {
    const { app, spec } = sandbox();
    const inApp = join(dirname(app), "node", "lib", "node");
    const missing = [inApp, ...(ROOTS_ONLY ? [ROOTS_ONLY] : [])].map((path) => ({ path, dir: true }));
    const script = `mkdir -p "${inApp}" 2>/dev/null; echo "mkdir=$?"`;
    const result = await runSandboxed({ ...spec, readOnly: [...spec.readOnly, ...missing] }, ["bash", "-c", script], {
      timeoutMs: 10_000,
    });
    expect(result).toMatchObject({ code: 0, output: expect.stringMatching(/^mkdir=[1-9]\n$/) });
    expect(existsSync(inApp)).toBe(false);
  });

  test("the folders holding protected paths can't be renamed away and recreated", async () => {
    const { user, units, run } = sandbox();
    const config = join(user, ".config");
    const local = join(user, ".local");
    const moves = await run(
      `mv "${config}" "${config}.old" 2>/dev/null; echo "config=$?"; mv "${local}" "${local}.old" 2>/dev/null; echo "local=$?"`,
    );
    expect(moves.output).toMatch(/config=[1-9]/);
    expect(moves.output).toMatch(/local=[1-9]/);
    const attempt = await run(
      `mv "${config}" "${config}.old"; mkdir -p "${units}"; echo changed > "${join(units, "japa.service")}"; echo ran`,
    );
    expect(attempt.output).toMatch(/\bran\n$/);
    expect(readFileSync(join(units, "japa.service"), "utf8")).toBe("unit");
    expect(existsSync(`${config}.old`)).toBe(false);
    expect(existsSync(`${local}.old`)).toBe(false);
  });

  test("the user's home can't be renamed away and recreated", async () => {
    const { user, units, run } = sandbox();
    const unit = join(units, "japa.service");
    const { output } = await run(
      [
        `mv "${user}" "${user}.old" 2>/dev/null; echo "mv=$?"`,
        `(mkdir -p "${units}" && echo changed > "${unit}") 2>/dev/null`,
        "echo end",
      ].join("; "),
    );
    expect(output).toMatch(/^mv=[1-9]\nend\n$/);
    expect(existsSync(`${user}.old`)).toBe(false);
    expect(readFileSync(unit, "utf8")).toBe("unit");
  });

  test("a protected path that is a symlink: its target can't be written, nor the link replaced", async () => {
    const { user, units, run } = sandbox();
    const link = join(user, ".config", "systemd");
    const target = join(user, "dotfiles", "systemd");
    mkdirSync(dirname(target));
    renameSync(link, target);
    symlinkSync(target, link);
    // A dangling one too: its target can't be created.
    const env = join(user, ".config", "environment.d");
    const envTarget = join(user, "dotfiles", "environment.d");
    symlinkSync(envTarget, env);
    const writes = [join(target, "user", "evil.service"), join(target, "user", "japa.service"), join(envTarget, "x.conf")];
    const script = [
      tryWrites(writes),
      `rm "${link}" 2>/dev/null && echo removed`,
      `ln -sfn /tmp "${link}" 2>/dev/null && echo replaced`,
      `mv "${link}" "${link}.old" 2>/dev/null && echo moved`,
      `mv "${dirname(target)}" "${dirname(target)}.old" 2>/dev/null && echo "moved target"`,
      "echo end",
    ].join("; ");
    const { code, output } = await run(script);
    expect({ code, output: output.trim() }).toEqual({ code: 0, output: "done\nend" });
    expect(readlinkSync(link)).toBe(target);
    expect(readFileSync(join(units, "japa.service"), "utf8")).toBe("unit");
    expect(readdirSync(join(target, "user"))).toEqual(["japa.service"]);
    expect(existsSync(envTarget) ? readdirSync(envTarget) : []).toEqual([]);
  });

  test("/tmp and /var/tmp are the job's own", async () => {
    const { tmp, run } = sandbox();
    const name = `japa-sandbox-${process.pid}-${Date.now()}`;
    writeFileSync(join("/tmp", `${name}.host`), "host");
    onTestFinished(() => {
      for (const path of [`/tmp/${name}.host`, `/tmp/${name}`, `/var/tmp/${name}.var`]) rmSync(path, { force: true });
    });
    const { output } = await run(
      `echo a > /tmp/${name}; echo b > /var/tmp/${name}.var; test -e /tmp/${name}.host && echo "host /tmp visible"; echo done`,
    );
    expect(output.trim()).toBe("done");
    expect(readFileSync(join(tmp, name), "utf8")).toBe("a\n");
    expect(readFileSync(join(tmp, `${name}.var`), "utf8")).toBe("b\n");
    expect(existsSync(`/tmp/${name}`)).toBe(false);
    expect(existsSync(`/var/tmp/${name}.var`)).toBe(false);
  });

  test("hidden files read empty, and writes don't reach them", async () => {
    const { outside, spec } = sandbox();
    const db = join(outside, "state.db");
    writeFileSync(db, "db-secret");
    const script = `cat "${db}"; echo "cat=$?"; echo x > "${db}" 2>/dev/null; cat "${db}"; echo end`;
    const { output } = await runSandboxed({ ...spec, hidden: [...spec.hidden, db] }, ["bash", "-c", script], {
      timeoutMs: 10_000,
    });
    expect(output).toBe("cat=0\nend\n");
    expect(readFileSync(db, "utf8")).toBe("db-secret");
  });

  // Renamed, the folder would take the mask with it, and a new sandbox would find nothing to hide at the old path.
  test("the folders holding a hidden path can't be renamed", async () => {
    const { user, spec } = sandbox();
    const japa = join(user, ".config", "japa");
    const secrets = join(japa, "secrets");
    mkdirSync(secrets, { recursive: true });
    writeFileSync(join(secrets, "key"), "hidden-secret");
    const script = `mv "${japa}" "${japa}2" 2>/dev/null; echo "mv=$?"; ls -A "${secrets}"; echo end`;
    const { output } = await runSandboxed({ ...spec, hidden: [...spec.hidden, secrets] }, ["bash", "-c", script], {
      timeoutMs: 10_000,
    });
    expect(output).toMatch(/^mv=[1-9]\nend\n$/);
    expect(existsSync(`${japa}2`)).toBe(false);
    expect(readdirSync(secrets)).toEqual(["key"]);
  });

  test("writable folders holding a hidden or protected path outside the user's home can't be renamed", async () => {
    const { outside, spec } = sandbox();
    const root = join(outside, "elsewhere");
    const [a, b] = [join(root, "a"), join(root, "b")];
    const secrets = join(a, "secrets");
    const app = join(b, "app");
    for (const dir of [secrets, app]) mkdirSync(dir, { recursive: true });
    writeFileSync(join(secrets, "key"), "hidden-secret");
    writeFileSync(join(app, "main.ts"), "app");
    const moves = [a, b, root].map((dir) => `mv "${dir}" "${dir}2" 2>/dev/null; echo "${basename(dir)}=$?"`);
    const readOnly = [...spec.readOnly, { path: app, dir: true }];
    const withPaths = { ...spec, hidden: [...spec.hidden, secrets], readOnly };
    const { output } = await runSandboxed(withPaths, ["bash", "-c", `${moves.join("; ")}; echo end`], {
      timeoutMs: 10_000,
    });
    expect(output).toMatch(/^a=[1-9]\nb=[1-9]\nelsewhere=[1-9]\nend\n$/);
    for (const dir of [a, b, root]) expect(existsSync(`${dir}2`)).toBe(false);
    expect(readdirSync(secrets)).toEqual(["key"]);
  });

  // Renaming a folder takes write access to its parent, not to itself; owning the parent, the job could chmod it.
  test("read-only folders holding a hidden path can't be renamed in a writable parent or the user's", async () => {
    const { outside, spec } = sandbox();
    const root = join(outside, "elsewhere");
    const [c, d] = [join(root, "c"), join(root, "d")];
    const e = join(d, "e");
    const hidden = [join(c, "secrets"), join(e, "secrets")];
    for (const dir of hidden) mkdirSync(dir, { recursive: true });
    for (const dir of [c, e, d]) chmodSync(dir, 0o555);
    try {
      const script = [
        `mv "${c}" "${c}2" 2>/dev/null; echo "c=$?"`,
        `chmod u+w "${d}"; mv "${e}" "${e}2" 2>/dev/null; echo "e=$?"`,
        "echo end",
      ].join("; ");
      const { output } = await runSandboxed({ ...spec, hidden: [...spec.hidden, ...hidden] }, ["bash", "-c", script], {
        timeoutMs: 10_000,
      });
      expect(output).toMatch(/^c=[1-9]\ne=[1-9]\nend\n$/);
      expect([existsSync(`${c}2`), existsSync(`${e}2`)]).toEqual([false, false]);
    } finally {
      for (const dir of [c, `${c}2`, d, e, `${e}2`]) if (existsSync(dir)) chmodSync(dir, 0o755);
    }
  });

  test("hidden dirs are empty", async () => {
    const { outside, hidden, run } = sandbox();
    const { output } = await run(`ls -A "${hidden}"; echo "ls=$?"`);
    expect(output.trim()).toBe("ls=0");
    expect(readdirSync(hidden)).toEqual(["key"]);
    expect(existsSync(join(outside, "absent"))).toBe(false);
  });

  // Without it on the host, there is nothing to mask (the args test covers that it isn't mounted then).
  test.skipIf(!existsSync(RUNTIME_DIR))(
    "the user's runtime dir is empty: no D-Bus, systemd, ssh-agent or keyring (skipped: no /run/user/<uid> here)",
    async () => {
      const { run } = sandbox();
      const { output } = await run(`ls -A "${RUNTIME_DIR}"; echo "ls=$?"`);
      expect(output.trim()).toBe("ls=0");
    },
  );

  test.each([".config/systemd/japa-home", ".local/share/japa/home"])(
    "a japa home inside a protected dir (%s) is still replaced by the clone",
    async (japaHome) => {
      const { home, run } = sandbox({ japaHome });
      const { output } = await run(
        `for f in secrets/x state.db japa.sock marker; do test -e "${home}/$f" && echo $f; done; echo end`,
      );
      expect(output.trim()).toBe("marker\nend");
    },
  );

  test("with the japa home under ~/.config, ~/.config is pinned too, and the clone still covers the home", async () => {
    const { home, user, units, run } = sandbox({ japaHome: ".config/japa" });
    const config = join(user, ".config");
    const unit = join(units, "japa.service");
    const { output } = await run(
      [
        `mv "${config}" "${config}.old" 2>/dev/null; echo "mv=$?"`,
        `(mkdir -p "${units}" && echo changed > "${unit}") 2>/dev/null`,
        `for f in secrets/x marker; do test -e "${home}/$f" && echo $f; done; echo end`,
      ].join("; "),
    );
    expect(output).toMatch(/^mv=[1-9]\nmarker\nend\n$/);
    expect(readFileSync(unit, "utf8")).toBe("unit");
    expect(existsSync(`${config}.old`)).toBe(false);
  });

  test("with XDG_CONFIG_HOME set, both its systemd config and the default one are protected", async () => {
    const { user, units, run } = sandbox({ env: (user) => ({ XDG_CONFIG_HOME: join(user, "xdg") }) });
    const xdg = join(user, "xdg");
    const targets = [
      join(units, "japa.service"),
      join(units, "evil.service"),
      join(xdg, "systemd", "user", "evil.service"),
      join(xdg, "environment.d", "x.conf"),
    ];
    const { output } = await run(`${tryWrites(targets)}; mv "${xdg}" "${xdg}.old" 2>/dev/null; echo "mv=$?"`);
    expect(output).toMatch(/^done\nmv=[1-9]\n$/);
    expect(readFileSync(join(units, "japa.service"), "utf8")).toBe("unit");
    expect(readdirSync(units)).toEqual(["japa.service"]);
  });

  test.skipIf(NO_SYSTEMD_RUN)("systemd-run --user can't run a command on the host", async () => {
    const { hidden, run } = sandbox();
    const { output } = await run(
      `XDG_RUNTIME_DIR=/run/user/$UID systemd-run --user --pipe --wait cat "${hidden}/key"; echo "systemd-run=$?"`,
    );
    expect(output).not.toContain("hidden-secret");
    expect(output).toMatch(/systemd-run=[1-9]/);
  });

  test.skipIf(DOCKER_SOCKETS.length === 0)("docker's socket is masked", async () => {
    const { run } = sandbox();
    const script = `for f in ${DOCKER_SOCKETS.join(" ")}; do test -S "$f" && echo "socket $f"; done; echo done`;
    const { output } = await run(script);
    expect(output.trim()).toBe("done");
  });

  test("shared dirs are the real ones", async () => {
    const { home, clone, run } = sandbox();
    await run(`echo hi > "${home}/desktop/shared/f"`);
    expect(readFileSync(join(home, "desktop", "shared", "f"), "utf8")).toBe("hi\n");
    expect(existsSync(join(clone, "desktop", "shared", "f"))).toBe(false);
  });

  test("node and japa are found in a sandbox whose original PATH lacks them; JAPA_HOME reaches it", async () => {
    const { outside, home, spec } = sandbox();
    const [empty, node, launcher] = ["empty", "node-bin", "launcher-bin"].map((name) => join(outside, name));
    for (const dir of [empty, node, launcher]) mkdirSync(dir);
    writeFileSync(join(node, "node"), "#!/bin/sh\n", { mode: 0o755 });
    writeFileSync(join(launcher, "japa"), "#!/bin/sh\n", { mode: 0o755 });
    const env = jobEnv({ ...spec.env, PATH: jobPath(empty, node, launcher), JAPA_HOME: home });
    const script = 'command -v node; command -v japa; echo "$JAPA_HOME"';
    const { output } = await runSandboxed({ ...spec, env }, ["/bin/sh", "-c", script], { timeoutMs: 10_000 });
    expect(output).toBe(`${join(node, "node")}\n${join(launcher, "japa")}\n${home}\n`);
  });

  test("read-only shared paths are the real ones, and can't be written", async () => {
    const { home, clone, spec } = sandbox();
    mkdirSync(join(home, "attachments"));
    writeFileSync(join(home, "attachments", "a"), "real");
    writeFileSync(join(home, "settings.json"), "real settings");
    writeFileSync(join(clone, "settings.json"), "clone settings");
    const readOnlyShared = [join(home, "attachments"), join(home, "settings.json"), join(home, "missing")];
    const script = [
      `cat "${home}/attachments/a" "${home}/settings.json"; echo`,
      `{ echo x > "${home}/attachments/b"; } 2>/dev/null && echo wrote`,
      `{ echo x > "${home}/settings.json"; } 2>/dev/null && echo wrote`,
      "true",
    ].join("; ");
    const { output } = await runSandboxed({ ...spec, readOnlyShared }, ["bash", "-c", script], { timeoutMs: 10_000 });
    expect(output).toBe("realreal settings\n");
    expect(readFileSync(join(home, "settings.json"), "utf8")).toBe("real settings");
    expect(existsSync(join(home, "attachments", "b"))).toBe(false);
  });

  test("no daemon in /proc, minimal env", async () => {
    const { spec, run } = sandbox();
    process.env.FOO_SECRET = "1";
    onTestFinished(() => void delete process.env.FOO_SECRET);
    const procs = await run("ls /proc | grep -c '^[0-9]'");
    expect(procs.output.trim()).toMatch(/^[1-4]$/);
    const env = await runSandboxed(spec, ["env"], { timeoutMs: 10_000 });
    const lines = env.output.trim().split("\n");
    const names = lines.map((line) => line.split("=")[0]);
    expect(names).not.toContain("FOO_SECRET");
    // bwrap itself sets PWD to the directory it changed to.
    expect(lines).toContain(`PWD=${homedir()}`);
    expect(names.sort()).toEqual([...ALLOWED.filter((name) => process.env[name] !== undefined), "PWD"].sort());
  });

  test("the daemon's environment isn't readable in /proc, not even bwrap's own", async () => {
    const value = `japa-env-${process.pid}-${Date.now()}`;
    process.env.JAPA_TEST_LEAK = value;
    onTestFinished(() => void delete process.env.JAPA_TEST_LEAK);
    const { run } = sandbox();
    const { output } = await run("tr '\\0' '\\n' </proc/1/environ; cat /proc/*/environ 2>/dev/null; echo end");
    expect(output).toMatch(/end\n$/);
    expect(output).not.toContain(value);
  });

  // A spawn with the sandbox's environment would look bwrap up in the job's PATH, where a job can put its own.
  test.skipIf(process.env.JAPA_BWRAP !== undefined)("bwrap is looked up in the daemon's PATH, not the job's", async () => {
    const { outside, spec } = sandbox();
    const bin = join(outside, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "bwrap"), `#!/bin/sh\ntouch "${join(outside, "ran")}"\n`, { mode: 0o755 });
    const result = await runSandboxed({ ...spec, env: { ...spec.env, PATH: `${bin}:${spec.env.PATH}` } }, ["true"], {
      timeoutMs: 10_000,
    });
    expect(result.code).toBe(0);
    expect(existsSync(join(outside, "ran"))).toBe(false);
  });

  test("processes die with the sandbox", async () => {
    const { run } = sandbox();
    const marker = `sleep 300.${process.pid}`;
    onTestFinished(() => void spawnSync("pkill", ["-f", marker]));
    const { output } = await run(`${marker} >/dev/null 2>&1 & test -d /proc/$! && echo "running $!"`);
    expect(output).toMatch(/running \d+/);
    expect(spawnSync("pgrep", ["-f", marker], { encoding: "utf8" }).stdout).toBe("");
  });

  test("timeout", async () => {
    const { run } = sandbox();
    const started = performance.now(); // not Date.now(): this host's wall clock jumps
    const result = await run("sleep 5", { timeoutMs: 200 });
    expect(result).toMatchObject({ code: null, timedOut: true });
    expect(performance.now() - started).toBeLessThan(4000);
  });

  test("an abort kills the sandbox at once, with every process in it, and rejects", async () => {
    const { spec, outside } = sandbox();
    const marker = `sleep 301.${process.pid}`;
    onTestFinished(() => void spawnSync("pkill", ["-f", marker]));
    const ran = join(outside, "ran");
    const controller = new AbortController();
    const script = `${marker} >/dev/null 2>&1 & echo x > "${ran}"; sleep 30`;
    const run = runSandboxed(spec, ["bash", "-c", script], { timeoutMs: 60_000, signal: controller.signal });
    await waitFor(() => existsSync(ran));
    const started = performance.now();
    controller.abort();
    await expect(run).rejects.toMatchObject({ name: "AbortError" });
    expect(performance.now() - started).toBeLessThan(4000);
    expect(spawnSync("pgrep", ["-f", marker], { encoding: "utf8" }).stdout).toBe("");
  });

  test("a run already aborted runs nothing", async () => {
    const { spec, outside } = sandbox();
    const ran = join(outside, "ran");
    const signal = AbortSignal.abort();
    await expect(runSandboxed(spec, ["touch", ran], { timeoutMs: 10_000, signal })).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(existsSync(ran)).toBe(false);
  });

  test("output is UTF-8 across chunks, and only its last 1 MB is kept", async () => {
    const { run } = sandbox();
    // 3-byte characters, so 64 KB pipe chunks split them.
    expect((await run("yes € | head -n 100000 | tr -d '\\n'")).output).toBe("€".repeat(100_000));
    const { output } = await run("head -c 1500000 /dev/zero | tr '\\0' a; printf END");
    expect(output).toBe(`${"a".repeat(1024 * 1024 - 3)}END`);
  });

  test("cwd", async () => {
    const { home, run } = sandbox();
    expect((await run("pwd", { cwd: join(home, "skills") })).output.trim()).toBe(join(home, "skills"));
    expect((await run("pwd")).output.trim()).toBe(homedir());
  });
});
