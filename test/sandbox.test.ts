import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { expect, onTestFinished, test } from "vitest";
import { probeSandbox, readOnlyPaths, runSandboxed, type SandboxSpec } from "../src/kernel/sandbox/bwrap.ts";
import { tempHome } from "./helpers.ts";

const ALLOWED = ["PATH", "HOME", "USER", "SHELL", "LANG", "TZ", "TERM"];

const git = (dir: string, ...args: string[]) =>
  execFileSync("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@localhost", "-c", "commit.gpgsign=false", ...args], {
    encoding: "utf8",
  }).trim();

/**
 * A home with `secrets/x`, `state.db` and a shared folder, and `marker` and `skills/s` committed; its clone at
 * `.jobs/1`; outside it a read-only file and a hidden dir, plus a missing path of each kind.
 */
function sandbox() {
  const home = tempHome();
  mkdirSync(join(home, "secrets"));
  writeFileSync(join(home, "secrets", "x"), "secret");
  writeFileSync(join(home, "state.db"), "db");
  mkdirSync(join(home, "desktop", "shared"), { recursive: true });
  writeFileSync(join(home, ".gitignore"), "secrets/\nstate.db\n/desktop/\n.jobs/\n");
  writeFileSync(join(home, "marker"), "m");
  mkdirSync(join(home, "skills", "s"), { recursive: true });
  writeFileSync(join(home, "skills", "s", "SKILL.md"), "s");
  git(home, "init", "-q", "-b", "main");
  git(home, "add", "-A");
  git(home, "commit", "-qm", "init");
  const clone = join(home, ".jobs", "1");
  execFileSync("git", ["clone", "-q", "--local", home, clone]);

  const outside = mkdtempSync(join(tmpdir(), "japa-sandbox-"));
  const readOnly = join(outside, "app.ts");
  writeFileSync(readOnly, "app");
  const hidden = join(outside, "secrets");
  mkdirSync(hidden);
  writeFileSync(join(hidden, "key"), "k");

  const spec: SandboxSpec = {
    home,
    clone,
    readOnly: [readOnly, join(outside, "missing")],
    hidden: [hidden, join(outside, "absent")],
    shared: [join(home, "desktop", "shared")],
  };
  const run = (script: string, o: { timeoutMs?: number; cwd?: string } = {}) =>
    runSandboxed(spec, ["bash", "-c", script], { timeoutMs: o.timeoutMs ?? 10_000, cwd: o.cwd });
  return { home, clone, outside, readOnly, hidden, spec, run };
}

test("probe passes here, fails with JAPA_BWRAP=/nonexistent", () => {
  expect(probeSandbox()).toBeUndefined();
  const saved = process.env.JAPA_BWRAP;
  process.env.JAPA_BWRAP = "/nonexistent";
  try {
    expect(probeSandbox()).toMatch(/\S/);
  } finally {
    if (saved === undefined) delete process.env.JAPA_BWRAP;
    else process.env.JAPA_BWRAP = saved;
  }
});

test("readOnlyPaths covers the app dir (with its Node), the launcher and the service unit", () => {
  const unit = "/u/.config/systemd/user/japa.service";
  expect(readOnlyPaths("/u/.local/share/japa/app", "/u")).toEqual(["/u/.local/share/japa", "/u/.local/bin/japa", unit]);
  expect(readOnlyPaths("/src/japa", "/u")).toEqual(["/src/japa", "/u/.local/bin/japa", unit]);
});

test("the real home is replaced by the clone", async () => {
  const { home, run } = sandbox();
  const { output } = await run(`for f in secrets/x state.db marker; do test -e "${home}/$f" && echo $f; done`);
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

test("read-only paths can't be written", async () => {
  const { readOnly, run } = sandbox();
  const { output } = await run(`if echo x 2>/dev/null > "${readOnly}"; then echo written; else echo refused; fi`);
  expect(output.trim()).toBe("refused");
  expect(readFileSync(readOnly, "utf8")).toBe("app");
});

test("hidden dirs are empty", async () => {
  const { outside, hidden, run } = sandbox();
  const { output } = await run(`ls -A "${hidden}"; echo "ls=$?"`);
  expect(output.trim()).toBe("ls=0");
  expect(readdirSync(hidden)).toEqual(["key"]);
  expect(existsSync(join(outside, "absent"))).toBe(false);
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
  try {
    const procs = await run("ls /proc | grep -c '^[0-9]'");
    expect(procs.output.trim()).toMatch(/^[1-4]$/);
    const env = await runSandboxed(spec, ["env"], { timeoutMs: 10_000 });
    const lines = env.output.trim().split("\n");
    const names = lines.map((line) => line.split("=")[0]);
    expect(names).not.toContain("FOO_SECRET");
    // bwrap itself sets PWD to the directory it changed to.
    expect(lines).toContain(`PWD=${homedir()}`);
    expect(names.sort()).toEqual([...ALLOWED.filter((name) => process.env[name] !== undefined), "PWD"].sort());
  } finally {
    delete process.env.FOO_SECRET;
  }
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

test("cwd", async () => {
  const { home, run } = sandbox();
  expect((await run("pwd", { cwd: join(home, "skills") })).output.trim()).toBe(join(home, "skills"));
  expect((await run("pwd")).output.trim()).toBe(homedir());
});
