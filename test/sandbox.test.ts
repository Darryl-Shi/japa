import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, onTestFinished, test } from "vitest";
import { probeSandbox, readOnlyPaths, runSandboxed, sandboxArgs, type SandboxSpec } from "../src/kernel/sandbox/bwrap.ts";
import { tempHome } from "./helpers.ts";

const ALLOWED = ["PATH", "HOME", "USER", "SHELL", "LANG", "TZ", "TERM"];

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

/** Whether the real bwrap works here; the sandbox tests are skipped where it doesn't (spec §8). */
const NO_BWRAP = withEnv("JAPA_BWRAP", undefined, () => probeSandbox() !== undefined);
const NO_SYSTEMD_RUN = spawnSync("systemd-run", ["--version"]).status !== 0;
const DOCKER_SOCKETS = ["/run/docker.sock", "/var/run/docker.sock"].filter((path) => existsSync(path));

/**
 * A japa home with `secrets/x`, `state.db`, `japa.sock` and a shared folder, and `marker` and `skills/s` committed;
 * its clone at `.jobs/1`. Outside it: a user home with an installed app (and its Node), the launcher, the service
 * unit and `.gitconfig` (no `.config/git`, a missing read-only path); a hidden dir, plus a missing one. All removed
 * when the test finishes.
 */
function sandbox() {
  const home = tempHome();
  const outside = mkdtempSync(join(tmpdir(), "japa-sandbox-"));
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

  const user = join(outside, "user");
  const app = join(user, ".local", "share", "japa", "app");
  const units = join(user, ".config", "systemd", "user");
  for (const [path, text] of [
    [join(app, "main.ts"), "app"],
    [join(user, ".local", "share", "japa", "node", "node"), "node"],
    [join(user, ".local", "bin", "japa"), "launcher"],
    [join(units, "japa.service"), "unit"],
    [join(user, ".gitconfig"), "gitconfig"],
  ] as const) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
  }
  const hidden = join(outside, "secrets");
  mkdirSync(hidden);
  writeFileSync(join(hidden, "key"), "hidden-secret");

  const spec: SandboxSpec = {
    home,
    clone,
    readOnly: readOnlyPaths(app, user, {}),
    hidden: [hidden, join(outside, "absent")],
    shared: [join(home, "desktop", "shared")],
  };
  const run = (script: string, o: { timeoutMs?: number; cwd?: string } = {}) =>
    runSandboxed(spec, ["bash", "-c", script], { timeoutMs: o.timeoutMs ?? 10_000, cwd: o.cwd });
  return { home, clone, outside, user, app, units, hidden, spec, run };
}

test("probe fails with JAPA_BWRAP=/nonexistent", () => {
  expect(withEnv("JAPA_BWRAP", "/nonexistent", probeSandbox)).toMatch(/\S/);
});

test("readOnlyPaths covers the app dir (with its Node), the launcher, systemd's and git's user config", () => {
  const tail = ["/u/.local/bin/japa", "/u/.config/systemd", "/u/.gitconfig", "/u/.config/git"];
  expect(readOnlyPaths("/u/.local/share/japa/app", "/u", {})).toEqual(["/u/.local/share/japa", ...tail]);
  expect(readOnlyPaths("/src/japa", "/u", {})).toEqual(["/src/japa", ...tail]);
  const xdg = ["/src/japa", "/u/.local/bin/japa", "/x/systemd", "/u/.gitconfig", "/x/git"];
  expect(readOnlyPaths("/src/japa", "/u", { XDG_CONFIG_HOME: "/x" })).toEqual(xdg);
});

test("sandboxArgs masks each existing docker socket once, by its real path", () => {
  const args = sandboxArgs({ home: "/h", clone: "/h/.jobs/1", readOnly: [], hidden: [], shared: [] });
  const masked = args.flatMap((arg, i) => (arg === "/dev/null" && args[i - 1] === "--ro-bind-try" ? [args[i + 1]] : []));
  // A missing mount point would make bwrap fail ("Can't create file at /run/docker.sock").
  expect(masked).toEqual([...new Set(DOCKER_SOCKETS.map((path) => realpathSync(path)))]);
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
      join(user, ".gitconfig"),
    ];
    const write = `(mkdir -p "$(dirname "$f")" && echo x > "$f") 2>/dev/null && echo "wrote $f"`;
    const { output } = await run(`for f in ${targets.map((f) => `"${f}"`).join(" ")}; do ${write}; done; echo done`);
    expect(output.trim()).toBe("done");
    expect(readFileSync(join(app, "main.ts"), "utf8")).toBe("app");
    expect(existsSync(join(units, "japa.service.d"))).toBe(false);
  });

  test("hidden dirs are empty", async () => {
    const { outside, hidden, run } = sandbox();
    const { output } = await run(`ls -A "${hidden}"; echo "ls=$?"`);
    expect(output.trim()).toBe("ls=0");
    expect(readdirSync(hidden)).toEqual(["key"]);
    expect(existsSync(join(outside, "absent"))).toBe(false);
  });

  test("the user's runtime dir is empty: no D-Bus, systemd, ssh-agent or keyring", async () => {
    const { run } = sandbox();
    const { output } = await run(`ls -A "/run/user/$UID" 2>/dev/null | wc -l`);
    expect(output.trim()).toBe("0");
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
    const started = Date.now();
    const result = await run("sleep 5", { timeoutMs: 200 });
    expect(result).toMatchObject({ code: null, timedOut: true });
    expect(Date.now() - started).toBeLessThan(4000);
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
