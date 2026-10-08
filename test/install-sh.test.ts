// install.sh end to end: a local bare repo seeded with the mini-japa fixture stands in for the real japa repo, so
// these tests exercise the real clone / Node-detection / npm ci / launcher-writing logic without network access.
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { launcherText } from "../src/cli/layout.ts";

const INSTALL_SH = fileURLToPath(new URL("../install.sh", import.meta.url));
const FIXTURE = fileURLToPath(new URL("fixtures/mini-japa", import.meta.url));

const tmp = () => mkdtempSync(join(tmpdir(), "japa-install-sh-"));

/** The test's own Node plus the system tools install.sh needs (git, curl/wget, tar, sha256sum...). */
const basePath = () => [dirname(process.execPath), "/usr/bin", "/bin"].join(":");

function gitIn(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t.test", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t.test" },
  });
}

/** A local bare repo at a tmp path, seeded with the mini-japa fixture committed and pushed to `main`. */
function fixtureRepo(): string {
  const bare = join(tmp(), "mini-japa.git");
  execFileSync("git", ["init", "--bare", "-q", "-b", "main", bare]);
  const work = tmp();
  cpSync(FIXTURE, work, { recursive: true });
  gitIn(work, "init", "-q", "-b", "main");
  gitIn(work, "add", "-A");
  gitIn(work, "-c", "commit.gpgsign=false", "commit", "-q", "-m", "mini-japa");
  gitIn(work, "push", "-q", bare, "main");
  return bare;
}

function runInstall(args: string[], env: NodeJS.ProcessEnv) {
  const result = spawnSync("sh", [INSTALL_SH, ...args], { encoding: "utf8", env });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

test("install.sh installs the fixture", () => {
  const bare = fixtureRepo();
  const home = tmp();
  const dir = join(tmp(), "d");
  const env = { HOME: home, PATH: basePath(), SHELL: "/bin/sh" };

  const result = runInstall(["--dir", dir, "--repo", bare, "--branch", "main", "--non-interactive", "--skip-setup"], env);
  expect(result.status, result.output).toBe(0);

  expect(existsSync(join(dir, "app", ".git"))).toBe(true);
  expect(existsSync(join(dir, "node"))).toBe(false);

  const node = execFileSync("sh", ["-c", "command -v node"], { encoding: "utf8", env }).trim();
  const launcherPath = join(home, ".local", "bin", "japa");
  expect(readFileSync(launcherPath, "utf8")).toBe(launcherText(node, join(dir, "app")));

  expect(execFileSync(launcherPath, ["--version"], { encoding: "utf8" })).toBe("japa 0.0.0 (fixture)\n");
});

test("a second run takes the update path", () => {
  const bare = fixtureRepo();
  const home = tmp();
  const dir = join(tmp(), "d");
  const env = { HOME: home, PATH: basePath(), SHELL: "/bin/sh" };
  const args = ["--dir", dir, "--repo", bare, "--branch", "main", "--non-interactive", "--skip-setup"];

  const first = runInstall(args, env);
  expect(first.status, first.output).toBe(0);

  const second = runInstall(args, env);
  expect(second.status, second.output).toBe(0);
  expect(second.output).toContain("update called");
});

test("a failed clone removes what it created", () => {
  const home = tmp();
  const dir = join(tmp(), "d");
  const env = { HOME: home, PATH: basePath(), SHELL: "/bin/sh" };
  const badRepo = join(tmp(), "does-not-exist.git");

  const result = runInstall(["--dir", dir, "--repo", badRepo, "--branch", "main", "--non-interactive", "--skip-setup"], env);

  expect(result.status).not.toBe(0);
  expect(existsSync(join(dir, "app"))).toBe(false);
  expect(result.output).toContain("install failed at: clone");
});

test("an unsupported platform is refused", () => {
  const fakeBin = tmp();
  writeFileSync(join(fakeBin, "uname"), "#!/bin/sh\necho FreeBSD\n");
  chmodSync(join(fakeBin, "uname"), 0o755);
  const home = tmp();
  const dir = join(tmp(), "d");
  const env = { HOME: home, PATH: `${fakeBin}:${basePath()}`, SHELL: "/bin/sh" };

  const result = runInstall(["--dir", dir, "--non-interactive", "--skip-setup"], env);

  expect(result.status).not.toBe(0);
  expect(result.output).toContain("japa supports Linux and macOS on x64 or arm64");
});

test("an install dir with a space and a quote still produces a working launcher", () => {
  const bare = fixtureRepo();
  const home = tmp();
  const dir = join(tmp(), "d'ir with space");
  const env = { HOME: home, PATH: basePath(), SHELL: "/bin/sh" };

  const result = runInstall(["--dir", dir, "--repo", bare, "--branch", "main", "--non-interactive", "--skip-setup"], env);
  expect(result.status, result.output).toBe(0);

  const node = execFileSync("sh", ["-c", "command -v node"], { encoding: "utf8", env }).trim();
  const launcherPath = join(home, ".local", "bin", "japa");
  expect(readFileSync(launcherPath, "utf8")).toBe(launcherText(node, join(dir, "app")));
  expect(execFileSync(launcherPath, ["--version"], { encoding: "utf8" })).toBe("japa 0.0.0 (fixture)\n");
});

test("sh -n accepts install.sh (syntax check)", () => {
  const result = spawnSync("sh", ["-n", INSTALL_SH], { encoding: "utf8" });
  expect(result.status, result.stderr).toBe(0);
});
