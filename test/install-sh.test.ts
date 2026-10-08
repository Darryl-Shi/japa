// install.sh end to end: a local bare repo seeded with the mini-japa fixture stands in for the real japa repo, so
// these tests exercise the real clone / Node-detection / npm ci / launcher-writing logic without network access.
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { launcherText } from "../src/cli/layout.ts";
import { NODE_MARKER } from "../src/cli/node.ts";

const INSTALL_SH = fileURLToPath(new URL("../install.sh", import.meta.url));
const FIXTURE = fileURLToPath(new URL("fixtures/mini-japa", import.meta.url));

const tmp = () => mkdtempSync(join(tmpdir(), "japa-install-sh-"));

/** The test's own Node plus the system tools install.sh needs (git, curl/wget, tar, sha256sum...). */
const basePath = () => [dirname(process.execPath), "/usr/bin", "/bin"].join(":");

/** A dir of symlinks to just the tools install.sh uses besides Node -- in particular no npm -- to build a PATH from. */
function toolsWithoutNode(): string {
  const dir = tmp();
  for (const name of ["sh", "uname", "git", "tar", "gzip", "curl", "cat", "rm", "mkdir", "awk", "sha256sum", "tr", "dirname", "chmod", "grep"]) {
    symlinkSync(execFileSync("sh", ["-c", `command -v ${name}`], { encoding: "utf8" }).trim(), join(dir, name));
  }
  return dir;
}

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

/**
 * Same as runInstall, but non-blocking: spawnSync freezes this process's event loop, so a child that calls back
 * into an HTTP server hosted in this same process (the download test below) would deadlock against it. Only
 * needed there; every other test's child talks to git/the filesystem, not back into this process.
 */
function runInstallAsync(args: string[], env: NodeJS.ProcessEnv): Promise<{ status: number | null; output: string }> {
  return new Promise((resolve) => {
    const child = spawn("sh", [INSTALL_SH, ...args], { env });
    let output = "";
    child.stdout.on("data", (d: Buffer) => (output += d));
    child.stderr.on("data", (d: Buffer) => (output += d));
    child.on("close", (status) => resolve({ status, output }));
  });
}

/** Builds `node-v<version>-<dist>.tar.gz` in `dir`: bin/node and bin/npm both wrap this test's real Node (and, for
 * npm, its real npm-cli.js) by absolute path, so a tarball "downloaded" from the local server below can actually
 * run `npm ci` and the launcher, the same way a real nodejs.org tarball would. */
function buildFakeNodeTarball(dir: string, version: string, dist: string): { tarball: string; name: string } {
  const top = `node-v${version}-${dist}`;
  const name = `${top}.tar.gz`;
  const binDir = join(dir, top, "bin");
  mkdirSync(binDir, { recursive: true });
  const npmCli = execFileSync("sh", ["-c", "command -v npm"], { encoding: "utf8" }).trim();
  const nodePath = join(binDir, "node");
  writeFileSync(nodePath, `#!/bin/sh\nexec "${process.execPath}" "$@"\n`);
  chmodSync(nodePath, 0o755);
  const npmPath = join(binDir, "npm");
  writeFileSync(npmPath, `#!/bin/sh\nexec "${process.execPath}" "${npmCli}" "$@"\n`);
  chmodSync(npmPath, 0o755);
  const tarball = join(dir, name);
  execFileSync("tar", ["-czf", tarball, "-C", dir, top]);
  return { tarball, name };
}

/** A local HTTP server answering fixed routes (`"/path"` -> status/body, else 404). Mirrors test/node.test.ts's helper. */
async function serve(routes: Record<string, { status: number; body: Buffer | string }>) {
  const server = createServer((req, res) => {
    const route = routes[req.url ?? ""];
    if (route === undefined) {
      res.writeHead(404).end("not found");
      return;
    }
    res.writeHead(route.status).end(route.body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { baseUrl, close: () => server.close() };
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

  const first = runInstall(["--dir", dir, "--repo", bare, "--branch", "main", "--non-interactive", "--skip-setup"], env);
  expect(first.status, first.output).toBe(0);

  // No --branch given on this run (nor JAPA_BRANCH): update must not be forced onto any particular branch.
  const second = runInstall(["--dir", dir, "--repo", bare, "--non-interactive", "--skip-setup"], env);
  expect(second.status, second.output).toBe(0);
  expect(second.output).toContain("update called");
  expect(second.output).not.toMatch(/--branch/);
});

test("a rerun without a launcher writes it, then runs update through it", () => {
  const bare = fixtureRepo();
  const home = tmp();
  const dir = join(tmp(), "d");
  const env = { HOME: home, PATH: basePath(), SHELL: "/bin/sh" };
  const launcherPath = join(home, ".local", "bin", "japa");

  const first = runInstall(["--dir", dir, "--repo", bare, "--non-interactive", "--skip-setup"], env);
  expect(first.status, first.output).toBe(0);
  rmSync(launcherPath); // e.g. an install interrupted before its launcher step

  const second = runInstall(["--dir", dir, "--repo", bare, "--non-interactive", "--skip-setup"], env);

  expect(second.status, second.output).toBe(0);
  const node = execFileSync("sh", ["-c", "command -v node"], { encoding: "utf8", env }).trim();
  expect(readFileSync(launcherPath, "utf8")).toBe(launcherText(node, join(dir, "app")));
  expect(second.output).toContain("update called");
});

test("a rerun whose launcher points at another install rewrites it", () => {
  const bare = fixtureRepo();
  const home = tmp();
  const dir = join(tmp(), "d");
  const env = { HOME: home, PATH: basePath(), SHELL: "/bin/sh" };
  const launcherPath = join(home, ".local", "bin", "japa");

  const first = runInstall(["--dir", dir, "--repo", bare, "--non-interactive", "--skip-setup"], env);
  expect(first.status, first.output).toBe(0);
  writeFileSync(launcherPath, launcherText("/elsewhere/node/bin/node", "/elsewhere/app"));

  const second = runInstall(["--dir", dir, "--repo", bare, "--non-interactive", "--skip-setup"], env);

  expect(second.status, second.output).toBe(0);
  expect(readFileSync(launcherPath, "utf8")).toContain(join(dir, "app", "src/cli/main.ts"));
  expect(second.output).toContain("update called");
});

test("a second run with --branch forwards it to update", () => {
  const bare = fixtureRepo();
  const home = tmp();
  const dir = join(tmp(), "d");
  const env = { HOME: home, PATH: basePath(), SHELL: "/bin/sh" };

  const first = runInstall(["--dir", dir, "--repo", bare, "--branch", "main", "--non-interactive", "--skip-setup"], env);
  expect(first.status, first.output).toBe(0);

  const second = runInstall(["--dir", dir, "--repo", bare, "--branch", "dev", "--non-interactive", "--skip-setup"], env);
  expect(second.status, second.output).toBe(0);
  expect(second.output).toContain("update called --branch dev");
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

test("a failed install leaves a node/ it didn't create", () => {
  const home = tmp();
  const dir = join(tmp(), "apps");
  mkdirSync(join(dir, "node"), { recursive: true });
  writeFileSync(join(dir, "node", "keep.txt"), "mine");
  const env = { HOME: home, PATH: basePath(), SHELL: "/bin/sh" };

  const result = runInstall(["--dir", dir, "--repo", join(tmp(), "nope.git"), "--non-interactive", "--skip-setup"], env);

  expect(result.status).not.toBe(0);
  expect(readFileSync(join(dir, "node", "keep.txt"), "utf8")).toBe("mine");
});

test("a node/ japa didn't install is never replaced", () => {
  const bare = fixtureRepo();
  const home = tmp();
  const dir = join(tmp(), "apps");
  mkdirSync(join(dir, "node"), { recursive: true });
  writeFileSync(join(dir, "node", "keep.txt"), "mine");
  const fakeBin = tmp();
  writeFileSync(join(fakeBin, "node"), "#!/bin/sh\necho 20.0.0\n"); // too old: install.sh wants its own Node
  chmodSync(join(fakeBin, "node"), 0o755);
  const env = { HOME: home, PATH: `${fakeBin}:${basePath()}`, SHELL: "/bin/sh", JAPA_NODE_DIST: "http://127.0.0.1:9" };

  const result = runInstall(["--dir", dir, "--repo", bare, "--non-interactive", "--skip-setup"], env);

  expect(result.status).not.toBe(0);
  expect(result.output).toContain(`${join(dir, "node")} exists and wasn't installed by japa`);
  expect(readFileSync(join(dir, "node", "keep.txt"), "utf8")).toBe("mine");
  expect(existsSync(join(dir, "app"))).toBe(false); // what this run did create is still cleaned up
});

test("a --dir whose app/ isn't a git checkout is refused", () => {
  const bare = fixtureRepo();
  const home = tmp();
  const dir = join(tmp(), "apps");
  mkdirSync(join(dir, "app"), { recursive: true });
  writeFileSync(join(dir, "app", "keep.txt"), "mine");
  const env = { HOME: home, PATH: basePath(), SHELL: "/bin/sh" };

  const result = runInstall(["--dir", dir, "--repo", bare, "--non-interactive", "--skip-setup"], env);

  expect(result.status).not.toBe(0);
  expect(result.output).toContain(`${join(dir, "app")} exists and isn't a japa checkout`);
  expect(readFileSync(join(dir, "app", "keep.txt"), "utf8")).toBe("mine");
  expect(existsSync(join(home, ".local", "bin", "japa"))).toBe(false);
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

test("a --dir with a trailing slash still produces the canonical launcher", () => {
  const bare = fixtureRepo();
  const home = tmp();
  const dir = join(tmp(), "d");
  const env = { HOME: home, PATH: basePath(), SHELL: "/bin/sh" };

  const result = runInstall(["--dir", `${dir}/`, "--repo", bare, "--branch", "main", "--non-interactive", "--skip-setup"], env);
  expect(result.status, result.output).toBe(0);

  const node = execFileSync("sh", ["-c", "command -v node"], { encoding: "utf8", env }).trim();
  const launcherPath = join(home, ".local", "bin", "japa");
  // A trailing slash on --dir must not survive into the launcher: join(dir, "app") (no "//") is the canonical form.
  expect(readFileSync(launcherPath, "utf8")).toBe(launcherText(node, join(dir, "app")));
});

test("a system node below the minimum triggers a private download the launcher then uses", async () => {
  const bare = fixtureRepo();
  const home = tmp();
  const dir = join(tmp(), "d");
  const version = "24.14.1"; // test/fixtures/mini-japa/.node-version
  const dist = `${process.platform}-${process.arch}`; // matches install.sh's OS-ARCH naming (linux|darwin, x64|arm64)

  const { tarball, name } = buildFakeNodeTarball(tmp(), version, dist);
  const bytes = readFileSync(tarball);
  const hash = createHash("sha256").update(bytes).digest("hex");

  // A fake `node` first on PATH, reporting a version below the minimum, so ensure_node() falls through to a
  // download instead of using it -- the download itself is served from a local HTTP server, not nodejs.org.
  const fakeBin = tmp();
  writeFileSync(join(fakeBin, "node"), "#!/bin/sh\necho 20.0.0\n");
  chmodSync(join(fakeBin, "node"), 0o755);

  const { baseUrl, close } = await serve({
    [`/v${version}/${name}`]: { status: 200, body: bytes },
    [`/v${version}/SHASUMS256.txt`]: { status: 200, body: `${hash}  ${name}\n` },
  });
  try {
    const env = { HOME: home, PATH: `${fakeBin}:${basePath()}`, SHELL: "/bin/sh", JAPA_NODE_DIST: baseUrl };
    const result = await runInstallAsync(["--dir", dir, "--repo", bare, "--branch", "main", "--non-interactive", "--skip-setup"], env);
    expect(result.status, result.output).toBe(0);

    const launcherPath = join(home, ".local", "bin", "japa");
    expect(readFileSync(launcherPath, "utf8")).toBe(launcherText(join(dir, "node", "bin", "node"), join(dir, "app")));
    expect(execFileSync(launcherPath, ["--version"], { encoding: "utf8" })).toBe("japa 0.0.0 (fixture)\n");
    expect(existsSync(join(dir, "node", NODE_MARKER))).toBe(true); // japa's, as src/cli/node.ts marks it
  } finally {
    close();
  }
});

test("a system Node 24 without npm triggers a private download", async () => {
  const bare = fixtureRepo();
  const home = tmp();
  const dir = join(tmp(), "d");
  const version = "24.14.1";
  const { tarball, name } = buildFakeNodeTarball(tmp(), version, `${process.platform}-${process.arch}`);
  const bytes = readFileSync(tarball);
  const hash = createHash("sha256").update(bytes).digest("hex");
  // A good enough Node, but no npm beside it or anywhere on PATH (e.g. Arch's split nodejs/npm packages).
  const nodeOnly = tmp();
  writeFileSync(join(nodeOnly, "node"), `#!/bin/sh\nexec "${process.execPath}" "$@"\n`);
  chmodSync(join(nodeOnly, "node"), 0o755);

  const { baseUrl, close } = await serve({
    [`/v${version}/${name}`]: { status: 200, body: bytes },
    [`/v${version}/SHASUMS256.txt`]: { status: 200, body: `${hash}  ${name}\n` },
  });
  try {
    const env = { HOME: home, PATH: `${nodeOnly}:${toolsWithoutNode()}`, SHELL: "/bin/sh", JAPA_NODE_DIST: baseUrl };
    const result = await runInstallAsync(["--dir", dir, "--repo", bare, "--non-interactive", "--skip-setup"], env);

    expect(result.status, result.output).toBe(0);
    const launcherPath = join(home, ".local", "bin", "japa");
    expect(readFileSync(launcherPath, "utf8")).toBe(launcherText(join(dir, "node", "bin", "node"), join(dir, "app")));
  } finally {
    close();
  }
});

test("a rerun without a launcher reuses japa's private node/ instead of downloading again", async () => {
  const bare = fixtureRepo();
  const home = tmp();
  const dir = join(tmp(), "d");
  const version = "24.14.1";
  const { tarball, name } = buildFakeNodeTarball(tmp(), version, `${process.platform}-${process.arch}`);
  const bytes = readFileSync(tarball);
  const hash = createHash("sha256").update(bytes).digest("hex");
  const fakeBin = tmp();
  writeFileSync(join(fakeBin, "node"), "#!/bin/sh\necho 20.0.0\n");
  chmodSync(join(fakeBin, "node"), 0o755);
  const launcherPath = join(home, ".local", "bin", "japa");
  const args = ["--dir", dir, "--repo", bare, "--non-interactive", "--skip-setup"];

  const { baseUrl, close } = await serve({
    [`/v${version}/${name}`]: { status: 200, body: bytes },
    [`/v${version}/SHASUMS256.txt`]: { status: 200, body: `${hash}  ${name}\n` },
  });
  try {
    const env = { HOME: home, PATH: `${fakeBin}:${basePath()}`, SHELL: "/bin/sh", JAPA_NODE_DIST: baseUrl };
    const first = await runInstallAsync(args, env);
    expect(first.status, first.output).toBe(0);
  } finally {
    close();
  }
  rmSync(launcherPath);

  // Nothing to download from now: the rerun has to reuse <dir>/node.
  const env = { HOME: home, PATH: `${fakeBin}:${basePath()}`, SHELL: "/bin/sh", JAPA_NODE_DIST: "http://127.0.0.1:9" };
  const second = runInstall(args, env);

  expect(second.status, second.output).toBe(0);
  expect(second.output).not.toContain("Downloading Node.js");
  expect(readFileSync(launcherPath, "utf8")).toBe(launcherText(join(dir, "node", "bin", "node"), join(dir, "app")));
  expect(second.output).toContain("update called");
});

test("Ctrl-C during npm ci removes what the install created", async () => {
  const bare = fixtureRepo();
  const home = tmp();
  const dir = join(tmp(), "d");
  // A Node >= 24 whose npm hangs, so the install is interrupted mid-dependencies.
  const fakeBin = tmp();
  const started = join(tmp(), "npm-started");
  writeFileSync(join(fakeBin, "node"), `#!/bin/sh\nexec "${process.execPath}" "$@"\n`);
  writeFileSync(join(fakeBin, "npm"), `#!/bin/sh\n: >"${started}"\nsleep 30\n`);
  chmodSync(join(fakeBin, "node"), 0o755);
  chmodSync(join(fakeBin, "npm"), 0o755);
  const env = { HOME: home, PATH: `${fakeBin}:${basePath()}`, SHELL: "/bin/sh" };

  // Its own process group, signalled as a whole, as a terminal's Ctrl-C is.
  const child = spawn("sh", [INSTALL_SH, "--dir", dir, "--repo", bare, "--non-interactive", "--skip-setup"], { env, detached: true });
  let output = "";
  child.stdout.on("data", (d: Buffer) => (output += d));
  child.stderr.on("data", (d: Buffer) => (output += d));
  const closed = new Promise<number | null>((resolve) => child.on("close", resolve));
  for (let i = 0; i < 400 && !existsSync(started); i++) await new Promise((resolve) => setTimeout(resolve, 50));
  expect(existsSync(started), output).toBe(true);

  process.kill(-child.pid!, "SIGINT");
  const status = await closed;

  expect(status, output).toBe(130);
  expect(existsSync(join(dir, "app"))).toBe(false);
  expect(output).toContain("install failed at: dependencies");
}, 30_000);

test("install.sh without a controlling terminal skips setup with the finish message", () => {
  const bare = fixtureRepo();
  const home = tmp();
  const dir = join(tmp(), "d");
  const env = { HOME: home, PATH: basePath(), SHELL: "/bin/sh" };

  // setsid detaches from any controlling terminal, so install.sh can't open /dev/tty -- the same situation as
  // `curl | sh` in CI/Docker/cloud-init. Neither --skip-setup nor --non-interactive is given: only the tty probe
  // decides this.
  const result = spawnSync("setsid", ["-w", "sh", INSTALL_SH, "--dir", dir, "--repo", bare, "--branch", "main"], { encoding: "utf8", env });
  const output = `${result.stdout}${result.stderr}`;
  expect(result.status, output).toBe(0);
  expect(existsSync(join(dir, "app", ".git"))).toBe(true);
  expect(output).toContain("run `japa setup` to finish");
});

test("--non-interactive without --skip-setup still skips setup with the finish message", () => {
  const bare = fixtureRepo();
  const home = tmp();
  const dir = join(tmp(), "d");
  const env = { HOME: home, PATH: basePath(), SHELL: "/bin/sh" };

  const result = runInstall(["--dir", dir, "--repo", bare, "--branch", "main", "--non-interactive"], env);

  expect(result.status, result.output).toBe(0);
  expect(result.output).toContain("run `japa setup` to finish");
});

test("sh -n accepts install.sh (syntax check)", () => {
  const result = spawnSync("sh", ["-n", INSTALL_SH], { encoding: "utf8" });
  expect(result.status, result.stderr).toBe(0);
});
