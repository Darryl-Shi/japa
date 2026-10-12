// install.sh's mode selection and Docker mode (docs/spec.md §4), against a fake `docker` on PATH
// (test/fake-docker.ts). Runs are under `setsid -w`, so the script has no controlling terminal and /dev/tty can't be
// opened, unless a test drives a pseudo-terminal with `script`.
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { createFakeDocker, type FakeDocker, type FakeState, fakePath, instance, writeFakeTool } from "./fake-docker.ts";

const INSTALL_SH = fileURLToPath(new URL("../install.sh", import.meta.url));
const FIXTURE = fileURLToPath(new URL("fixtures/mini-japa", import.meta.url));
const REPO = "https://example.invalid/japa.git";

const tmp = (prefix = "japa-install-docker-") => mkdtempSync(join(tmpdir(), prefix));

/** A /proc/net stand-in: tcp and tcp6 with the given LISTEN ports (none by default), so free ports are deterministic. */
function procNet(listening: number[] = []): string {
  const dir = tmp("japa-proc-net-");
  const header = "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n";
  const rows = listening.map(
    (p, i) => `   ${i}: 0100007F:${p.toString(16).toUpperCase().padStart(4, "0")} 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 1 1 0000000000000000 100 0 0 10 0\n`,
  );
  // An established (01) connection on 6082: not a listening port.
  rows.push(`   9: 0100007F:17C2 0100007F:9C40 01 00000000:00000000 00:00000000 00000000  1000        0 2 1 0000000000000000 20 4 30 10 -1\n`);
  writeFileSync(join(dir, "tcp"), header + rows.join(""));
  writeFileSync(join(dir, "tcp6"), header);
  return dir;
}

interface Ctx {
  fake: FakeDocker;
  home: string;
  env: NodeJS.ProcessEnv;
  run(args: string[], extraEnv?: NodeJS.ProcessEnv): { status: number | null; stdout: string; stderr: string; output: string };
}

function setup(initial: Partial<FakeState> = {}, opts: { listening?: number[]; user?: string } = {}): Ctx {
  const fake = createFakeDocker(initial);
  const home = tmp("japa-install-docker-home-");
  const env: NodeJS.ProcessEnv = {
    HOME: home,
    USER: opts.user ?? "alice",
    PATH: fakePath(fake),
    SHELL: "/bin/sh",
    JAPA_PROC_NET: procNet(opts.listening),
    JAPA_OS_RELEASE: join(home, "no-os-release"),
  };
  return {
    fake,
    home,
    env,
    run(args, extraEnv = {}) {
      const r = spawnSync("setsid", ["-w", "sh", INSTALL_SH, ...args], { encoding: "utf8", env: { ...env, ...extraEnv }, input: "" });
      return { status: r.status, stdout: r.stdout, stderr: r.stderr, output: `${r.stdout}${r.stderr}` };
    },
  };
}

/** The value after `flag` in argv, or every value when `all`. */
const valuesOf = (argv: string[], flag: string): string[] => argv.flatMap((a, i) => (a === flag && i + 1 < argv.length ? [argv[i + 1]] : []));

const innerInstalls = (fake: FakeDocker) => fake.callsOf("exec").filter((c) => c.includes("--skip-setup"));

const hostLauncher = (home: string) => join(home, ".local", "bin", "japa");

function expectSafeRun(run: string[]) {
  expect(run).not.toContain("--privileged");
  for (const a of run) expect(a).not.toMatch(/docker\.sock/);
  for (const v of [...valuesOf(run, "-v"), ...valuesOf(run, "--volume")]) {
    // Named volumes only: a host bind mount's source is a path.
    expect(v.split(":")[0]).toMatch(/^japa-[a-z0-9-]+-(home|docker)$/);
  }
  expect(run.some((a) => a === "--mount" || a.startsWith("--mount="))).toBe(false);
}

describe("fresh Docker install", () => {
  test("no --mode and no terminal picks Docker", () => {
    const c = setup();
    const r = c.run(["--repo", REPO]);
    expect(r.status, r.output).toBe(0);
    expect(c.fake.callsOf("run").length).toBe(1);
    expect(c.fake.state().containers["japa-alice"]).toBeDefined();
    expect(r.stdout).toContain("run `japa --instance alice setup` to finish");
  });

  test("--mode docker creates the network, volumes and the Sysbox container, installs inside and writes the launcher", () => {
    const c = setup();
    const r = c.run(["--mode", "docker", "--instance", "alice", "--repo", REPO, "--branch", "main"]);
    expect(r.status, r.output).toBe(0);

    const st = c.fake.state();
    expect(st.networks).toEqual(["japa-alice-net"]);
    expect(st.volumes.sort()).toEqual(["japa-alice-docker", "japa-alice-home"]);
    expect(Object.keys(st.containers)).toEqual(["japa-alice"]);

    const build = c.fake.callsOf("build");
    expect(build).toEqual([["build", "-t", "japa-host:main", `${REPO}#main:docker`]]);

    const [run] = c.fake.callsOf("run");
    expect(run).toContain("-d");
    expect(run).toContain("--runtime=sysbox-runc");
    expect(valuesOf(run, "--restart")).toEqual(["unless-stopped"]);
    expect(valuesOf(run, "--hostname")).toEqual(["japa-alice"]);
    expect(valuesOf(run, "--name")).toEqual(["japa-alice"]);
    expect(valuesOf(run, "--network")).toEqual(["japa-alice-net"]);
    expect(valuesOf(run, "-p")).toEqual(["127.0.0.1:6080:16080"]);
    expect(valuesOf(run, "-v").sort()).toEqual(["japa-alice-docker:/var/lib/docker", "japa-alice-home:/home/japa"]);
    expect(valuesOf(run, "--label").sort()).toEqual(["japa.branch=main", "japa.desktopPort=6080", "japa.instance=alice"]);
    expect(run[run.length - 1]).toBe("japa-host:main");
    expectSafeRun(run);

    const inner = innerInstalls(c.fake);
    expect(inner.length).toBe(1);
    const [exec] = inner;
    expect(valuesOf(exec, "-u")).toEqual(["japa"]);
    expect(exec).toContain("japa-alice");
    expect(exec.join(" ")).toContain("install.sh");
    const after = exec.slice(exec.indexOf("--mode"));
    expect(after.slice(0, 3)).toEqual(["--mode", "native", "--skip-setup"]);
    expect(valuesOf(exec, "--repo")).toEqual([REPO]);
    expect(valuesOf(exec, "--branch")).toEqual(["main"]);

    // systemd was waited for before the inner install.
    const calls = c.fake.calls().map((x) => x.join(" "));
    const waited = calls.findIndex((x) => x.includes("systemctl is-system-running"));
    expect(waited).toBeGreaterThan(calls.findIndex((x) => x.startsWith("run ")));
    expect(waited).toBeLessThan(calls.findIndex((x) => x.includes("--skip-setup")));

    const launcher = readFileSync(hostLauncher(c.home), "utf8");
    expect(launcher).toContain("# japa-docker-launcher");
    // ~/.local/bin isn't on this PATH: the PATH line is added exactly as a native install does.
    expect(readFileSync(join(c.home, ".bashrc"), "utf8")).toBe('export PATH="$HOME/.local/bin:$PATH"\n');
    expect(r.output).not.toMatch(/not found/);
    expect(r.stdout).toContain("run `japa --instance alice setup` to finish");
    // Nothing else on the host: no native install dir.
    expect(existsSync(join(c.home, ".local", "share", "japa"))).toBe(false);
  });

  test("the default instance is the sanitised $USER", () => {
    const c = setup({}, { user: "Bob.Smith" });
    const r = c.run(["--mode", "docker", "--repo", REPO]);
    expect(r.status, r.output).toBe(0);
    expect(Object.keys(c.fake.state().containers)).toEqual(["japa-bob-smith"]);
    expect(valuesOf(c.fake.callsOf("run")[0], "--label")).toContain("japa.instance=bob-smith");
    expect(c.fake.state().networks).toEqual(["japa-bob-smith-net"]);
    expect(r.stdout).toContain("run `japa --instance bob-smith setup` to finish");
  });

  test("JAPA_INSTANCE names the instance", () => {
    const c = setup();
    const r = c.run(["--mode", "docker", "--repo", REPO], { JAPA_INSTANCE: "tenant1" });
    expect(r.status, r.output).toBe(0);
    expect(Object.keys(c.fake.state().containers)).toEqual(["japa-tenant1"]);
  });

  test("--desktop-port is honoured", () => {
    const c = setup();
    const r = c.run(["--mode", "docker", "--repo", REPO, "--desktop-port", "7123"]);
    expect(r.status, r.output).toBe(0);
    const [run] = c.fake.callsOf("run");
    expect(valuesOf(run, "-p")).toEqual(["127.0.0.1:7123:16080"]);
    expect(valuesOf(run, "--label")).toContain("japa.desktopPort=7123");
  });

  test("--desktop-port already claimed by another instance is refused", () => {
    const c = setup({ containers: Object.fromEntries([instance("bob", { port: 7123 })]) });
    const r = c.run(["--mode", "docker", "--repo", REPO, "--desktop-port", "7123"]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("7123");
    expect(c.fake.callsOf("run")).toEqual([]);
  });

  test("the default port skips ports other instances claimed", () => {
    const c = setup({ containers: Object.fromEntries([instance("bob", { port: 6080 }), instance("carol", { port: 6081, running: false })]) });
    const r = c.run(["--mode", "docker", "--repo", REPO]);
    expect(r.status, r.output).toBe(0);
    expect(valuesOf(c.fake.callsOf("run")[0], "-p")).toEqual(["127.0.0.1:6082:16080"]);
  });

  test("the default port skips ports something on the host listens on", () => {
    const c = setup({ containers: Object.fromEntries([instance("bob", { port: 6081 })]) }, { listening: [6080, 6083] });
    const r = c.run(["--mode", "docker", "--repo", REPO]);
    expect(r.status, r.output).toBe(0);
    // 6080 listening, 6081 claimed, 6082 only has an established connection: free.
    expect(valuesOf(c.fake.callsOf("run")[0], "-p")).toEqual(["127.0.0.1:6082:16080"]);
  });

  test("--dir in Docker mode prints a note and is otherwise ignored", () => {
    const c = setup();
    const dir = join(c.home, "somewhere");
    const r = c.run(["--mode", "docker", "--repo", REPO, "--dir", dir]);
    expect(r.status, r.output).toBe(0);
    expect(r.stdout).toMatch(/--dir is ignored in Docker mode/);
    expect(existsSync(dir)).toBe(false);
  });

  test("an existing pre-created network and docker volume are reused", () => {
    const c = setup({ networks: ["japa-alice-net"], volumes: ["japa-alice-docker"] });
    const r = c.run(["--mode", "docker", "--repo", REPO]);
    expect(r.status, r.output).toBe(0);
    expect(c.fake.callsOf("network").filter((x) => x[1] === "create")).toEqual([]);
    expect(c.fake.callsOf("volume").filter((x) => x[1] === "create").map((x) => x[x.length - 1])).toEqual(["japa-alice-home"]);
  });
});

describe("refusals", () => {
  test("an invalid --instance name", () => {
    for (const name of ["Bad_Name", "-x", "a b", "ALICE"]) {
      const c = setup();
      const r = c.run(["--mode", "docker", "--repo", REPO, "--instance", name]);
      expect(r.status, name).not.toBe(0);
      expect(r.stderr).toContain("invalid instance name");
      expect(c.fake.callsOf("build")).toEqual([]);
      expect(c.fake.callsOf("run")).toEqual([]);
    }
  });

  test("a container named japa-<n> that isn't a japa instance", () => {
    const c = setup({ containers: { "japa-alice": { labels: { other: "x" }, image: "sha256:x", running: true } } });
    const before = c.fake.state();
    const r = c.run(["--mode", "docker", "--repo", REPO]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/japa-alice already exists and isn't a japa instance/);
    expect(c.fake.state()).toEqual(before);
    expect(c.fake.callsOf("build")).toEqual([]);
    expect(c.fake.callsOf("rm")).toEqual([]);
  });

  test("Docker not usable: usermod guidance", () => {
    const c = setup({ infoFails: true });
    const r = c.run(["--mode", "docker", "--repo", REPO]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("usermod -aG docker");
    expect(c.fake.callsOf("build")).toEqual([]);
  });

  test("Docker missing altogether", () => {
    const c = setup();
    // A PATH without any docker: just this Node and a few tools.
    const bin = tmp();
    for (const t of ["sh", "setsid", "uname", "tr", "id", "cat", "awk", "grep"]) {
      const p = execFileSync("sh", ["-c", `command -v ${t}`], { encoding: "utf8" }).trim();
      writeFakeTool(bin, t, `exec ${p} "$@"`);
    }
    const r = c.run(["--mode", "docker", "--repo", REPO], { PATH: bin });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/Docker is required/);
  });

  test("no Sysbox, no terminal, on Ubuntu with apt: names Sysbox and --install-sysbox", () => {
    const c = setup({ runtimes: ["runc"] });
    const osRelease = join(c.home, "os-release");
    writeFileSync(osRelease, 'NAME="Ubuntu"\nID=ubuntu\nID_LIKE=debian\nVERSION_ID="24.04"\n');
    writeFakeTool(c.fake.binDir, "apt-get", 'echo "fake apt-get $*" >&2; exit 1');
    writeFakeTool(c.fake.binDir, "sudo", 'echo "fake sudo $*" >&2; exit 1');
    const r = c.run(["--mode", "docker", "--repo", REPO], { JAPA_OS_RELEASE: osRelease });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/Sysbox/);
    expect(r.stderr).toContain("--install-sysbox");
    expect(r.output).not.toContain("fake sudo");
    expect(c.fake.callsOf("build")).toEqual([]);
  });

  test("no Sysbox, no terminal, unsupported distro: names Sysbox and links its install docs", () => {
    const c = setup({ runtimes: ["runc"] });
    const r = c.run(["--repo", REPO]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/Sysbox/);
    expect(r.stderr).toMatch(/https:\/\/github\.com\/nestybox\/sysbox\S*install/);
    expect(c.fake.callsOf("build")).toEqual([]);
  });

  test("a local-path --repo in Docker mode", () => {
    const c = setup();
    const r = c.run(["--mode", "docker", "--repo", join(c.home, "japa.git")]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/--repo/);
    expect(c.fake.callsOf("build")).toEqual([]);
    expect(c.fake.callsOf("run")).toEqual([]);
  });

  test("an unknown --mode", () => {
    const c = setup();
    const r = c.run(["--mode", "podman", "--repo", REPO]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("unknown mode: podman");
    expect(c.fake.calls()).toEqual([]);
  });

  test("an unknown JAPA_INSTALL_MODE", () => {
    const c = setup();
    const r = c.run(["--repo", REPO], { JAPA_INSTALL_MODE: "kube" });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("unknown mode: kube");
  });
});

describe("a failed step removes what the run created, and only that", () => {
  test("the image build fails", () => {
    const c = setup({ buildFails: true });
    const r = c.run(["--mode", "docker", "--repo", REPO]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("install failed at: image");
    const st = c.fake.state();
    expect(st.containers).toEqual({});
    expect(st.volumes).toEqual([]);
    expect(st.networks).toEqual([]);
    expect(existsSync(hostLauncher(c.home))).toBe(false);
  });

  test("the inner install fails: container, volumes, network removed, no launcher", () => {
    const c = setup({ execRules: [{ match: ["--skip-setup"], stderr: "npm ci failed\n", status: 1 }] });
    const r = c.run(["--mode", "docker", "--repo", REPO]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("install failed at: install japa inside");
    const st = c.fake.state();
    expect(st.containers).toEqual({});
    expect(st.volumes).toEqual([]);
    expect(st.networks).toEqual([]);
    expect(existsSync(hostLauncher(c.home))).toBe(false);
    expect(c.fake.calls().map((x) => x.join(" "))).toContain("rm -f japa-alice");
  });

  test("a pre-existing network and docker volume are kept", () => {
    const c = setup({
      networks: ["japa-alice-net", "unrelated-net"],
      volumes: ["japa-alice-docker", "unrelated"],
      containers: { other: { labels: {}, image: "x", running: true } },
      execRules: [{ match: ["--skip-setup"], status: 1 }],
    });
    const r = c.run(["--mode", "docker", "--repo", REPO]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("install failed at: install japa inside");
    const st = c.fake.state();
    expect(Object.keys(st.containers)).toEqual(["other"]);
    expect(st.networks).toEqual(["japa-alice-net", "unrelated-net"]);
    expect(st.volumes).toEqual(["japa-alice-docker", "unrelated"]);
  });

  test("a pre-existing launcher is kept", () => {
    const c = setup({ execRules: [{ match: ["--skip-setup"], status: 1 }] });
    // A Docker launcher from another instance's install: it isn't this run's to remove.
    mkdirSync(join(c.home, ".local", "bin"), { recursive: true });
    writeFileSync(hostLauncher(c.home), "#!/bin/sh\n# japa-docker-launcher\n");
    const r = c.run(["--mode", "docker", "--repo", REPO]);
    expect(r.status).not.toBe(0);
    expect(readFileSync(hostLauncher(c.home), "utf8")).toBe("#!/bin/sh\n# japa-docker-launcher\n");
  });

  test("the container fails to start", () => {
    const c = setup({ runFails: true });
    const r = c.run(["--mode", "docker", "--repo", REPO]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("install failed at: instance");
    const st = c.fake.state();
    expect(st.volumes).toEqual([]);
    expect(st.networks).toEqual([]);
  });
});

describe("re-running on an existing Docker instance upgrades it", () => {
  const existing = (image = "sha256:image1", extra: Partial<FakeState> = {}): Partial<FakeState> => ({
    containers: Object.fromEntries([instance("alice", { port: 6085, image, branch: "main" })]),
    volumes: ["japa-alice-home", "japa-alice-docker"],
    networks: ["japa-alice-net"],
    images: { "japa-host:main": image },
    buildImageId: "sha256:image1",
    ...extra,
  });

  test("without --mode, the image unchanged: rebuild, no recreate, inner update without --branch", () => {
    const c = setup(existing("sha256:image1"));
    const r = c.run(["--repo", REPO]);
    expect(r.status, r.output).toBe(0);
    expect(c.fake.callsOf("build").length).toBe(1);
    expect(c.fake.callsOf("rm")).toEqual([]);
    expect(c.fake.callsOf("run")).toEqual([]);
    const inner = innerInstalls(c.fake);
    expect(inner.length).toBe(1);
    expect(inner[0]).not.toContain("--branch");
    expect(inner[0].slice(inner[0].indexOf("--mode"), inner[0].indexOf("--mode") + 3)).toEqual(["--mode", "native", "--skip-setup"]);
    expect(valuesOf(inner[0], "-u")).toEqual(["japa"]);
    expect(readFileSync(hostLauncher(c.home), "utf8")).toContain("# japa-docker-launcher");
    expect(readFileSync(join(c.home, ".bashrc"), "utf8")).toBe('export PATH="$HOME/.local/bin:$PATH"\n');
    expect(r.output).not.toMatch(/not found/);
  });

  test("the image changed: rm -f then run again with the same name, volumes, network, labels and port", () => {
    const c = setup(existing("sha256:old"));
    const r = c.run(["--mode", "docker", "--repo", REPO]);
    expect(r.status, r.output).toBe(0);
    const calls = c.fake.calls().map((x) => x.join(" "));
    const rm = calls.indexOf("rm -f japa-alice");
    const run = calls.findIndex((x) => x.startsWith("run "));
    expect(rm).toBeGreaterThanOrEqual(0);
    expect(run).toBeGreaterThan(rm);
    const [runArgv] = c.fake.callsOf("run");
    expect(valuesOf(runArgv, "--name")).toEqual(["japa-alice"]);
    expect(valuesOf(runArgv, "--network")).toEqual(["japa-alice-net"]);
    expect(valuesOf(runArgv, "-v").sort()).toEqual(["japa-alice-docker:/var/lib/docker", "japa-alice-home:/home/japa"]);
    expect(valuesOf(runArgv, "-p")).toEqual(["127.0.0.1:6085:16080"]);
    expect(valuesOf(runArgv, "--label").sort()).toEqual(["japa.branch=main", "japa.desktopPort=6085", "japa.instance=alice"]);
    expect(runArgv).toContain("--runtime=sysbox-runc");
    expectSafeRun(runArgv);
    const st = c.fake.state();
    expect(st.containers["japa-alice"].image).toBe("sha256:image1");
    expect(st.volumes).toEqual(["japa-alice-home", "japa-alice-docker"]);
    expect(c.fake.callsOf("volume").filter((x) => x[1] === "rm" || x[1] === "create")).toEqual([]);
    // The inner install runs after the recreate, without --branch.
    const inner = calls.findIndex((x) => x.includes("--skip-setup"));
    expect(inner).toBeGreaterThan(run);
    expect(innerInstalls(c.fake)[0]).not.toContain("--branch");
  });

  test("--branch given: rebuilt for that branch, recreated, and forwarded to the inner update", () => {
    const c = setup(existing("sha256:image1"));
    const r = c.run(["--mode", "docker", "--repo", REPO, "--branch", "dev"]);
    expect(r.status, r.output).toBe(0);
    expect(c.fake.callsOf("build")).toEqual([["build", "-t", "japa-host:dev", `${REPO}#dev:docker`]]);
    expect(valuesOf(c.fake.callsOf("run")[0], "--label")).toContain("japa.branch=dev");
    expect(valuesOf(innerInstalls(c.fake)[0], "--branch")).toEqual(["dev"]);
  });

  test("a stopped instance with an unchanged image is started", () => {
    const c = setup({ ...existing("sha256:image1"), containers: Object.fromEntries([instance("alice", { port: 6085, running: false })]) });
    const r = c.run(["--mode", "docker", "--repo", REPO]);
    expect(r.status, r.output).toBe(0);
    expect(c.fake.callsOf("start")).toEqual([["start", "japa-alice"]]);
    expect(c.fake.callsOf("run")).toEqual([]);
  });

  test("the inner update fails: non-zero naming the step, the instance is kept", () => {
    const c = setup(existing("sha256:image1", { execRules: [{ match: ["--skip-setup"], status: 4 }] }));
    const r = c.run(["--mode", "docker", "--repo", REPO]);
    expect(r.status).toBe(4);
    expect(r.stderr).toContain("upgrade failed at: update japa inside");
    const st = c.fake.state();
    expect(Object.keys(st.containers)).toEqual(["japa-alice"]);
    expect(st.volumes).toEqual(["japa-alice-home", "japa-alice-docker"]);
  });

  test("the container is gone but the home volume is kept (after uninstall): recreated with the volumes", () => {
    const c = setup({ volumes: ["japa-alice-home", "japa-alice-docker"] });
    const r = c.run(["--repo", REPO]);
    expect(r.status, r.output).toBe(0);
    const st = c.fake.state();
    expect(Object.keys(st.containers)).toEqual(["japa-alice"]);
    expect(st.volumes).toEqual(["japa-alice-home", "japa-alice-docker"]);
    expect(st.networks).toEqual(["japa-alice-net"]);
    expect(c.fake.callsOf("volume").filter((x) => x[1] === "create" || x[1] === "rm")).toEqual([]);
    const [runArgv] = c.fake.callsOf("run");
    expect(valuesOf(runArgv, "-v").sort()).toEqual(["japa-alice-docker:/var/lib/docker", "japa-alice-home:/home/japa"]);
    expectSafeRun(runArgv);
    // japa is already in the home volume: it's updated, not freshly installed on a forced branch.
    expect(innerInstalls(c.fake).length).toBe(1);
    expect(innerInstalls(c.fake)[0]).not.toContain("--branch");
  });

  test("the recreated instance's port skips ports other instances claimed", () => {
    const c = setup({ volumes: ["japa-alice-home", "japa-alice-docker"], containers: Object.fromEntries([instance("bob", { port: 6080 })]) });
    const r = c.run(["--mode", "docker", "--repo", REPO]);
    expect(r.status, r.output).toBe(0);
    expect(valuesOf(c.fake.callsOf("run")[0], "-p")).toEqual(["127.0.0.1:6081:16080"]);
  });
});

// --- Native and Docker side by side (§4.1, §5.4) ---

function gitIn(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t.test", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t.test" },
  });
}

/** A local bare repo seeded with the mini-japa fixture on `main` (as test/install-sh.test.ts does). */
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

describe("native and Docker installs side by side", () => {
  test("an existing native install at --dir is upgraded natively without asking, with no docker calls", () => {
    const c = setup();
    const bare = fixtureRepo();
    const dir = join(c.home, "d");
    const first = c.run(["--mode", "native", "--dir", dir, "--repo", bare, "--branch", "main", "--skip-setup"]);
    expect(first.status, first.output).toBe(0);
    c.fake.clearLog();

    const r = c.run(["--dir", dir, "--repo", bare]);
    expect(r.status, r.output).toBe(0);
    expect(r.stdout).toContain("Updating existing install");
    expect(r.stdout).toContain("update called");
    expect(c.fake.calls()).toEqual([]);
  });

  test("native over a Docker launcher, without a terminal, writes japa-native and keeps the Docker one", () => {
    const c = setup();
    const bare = fixtureRepo();
    const dir = join(c.home, "d");
    mkdirSync(join(c.home, ".local", "bin"), { recursive: true });
    const dockerLauncher = "#!/bin/sh\n# japa-docker-launcher\necho docker launcher\n";
    writeFileSync(hostLauncher(c.home), dockerLauncher);
    chmodSync(hostLauncher(c.home), 0o755);

    const r = c.run(["--mode", "native", "--dir", dir, "--repo", bare, "--branch", "main", "--skip-setup"]);
    expect(r.status, r.output).toBe(0);
    expect(readFileSync(hostLauncher(c.home), "utf8")).toBe(dockerLauncher);
    const nativeLauncher = join(c.home, ".local", "bin", "japa-native");
    expect(readFileSync(nativeLauncher, "utf8")).toContain(join(dir, "app", "src", "cli", "main.ts"));
    expect(execFileSync(nativeLauncher, ["--version"], { encoding: "utf8" })).toBe("japa 0.0.0 (fixture)\n");
  });

  test("Docker over a native launcher, without a terminal, writes japa-docker and keeps the native one", () => {
    const c = setup();
    mkdirSync(join(c.home, ".local", "bin"), { recursive: true });
    const nativeLauncher = "#!/bin/sh\nexec '/usr/bin/node' '/x/app/src/cli/main.ts' \"$@\"\n";
    writeFileSync(hostLauncher(c.home), nativeLauncher);
    chmodSync(hostLauncher(c.home), 0o755);

    const r = c.run(["--mode", "docker", "--repo", REPO]);
    expect(r.status, r.output).toBe(0);
    expect(readFileSync(hostLauncher(c.home), "utf8")).toBe(nativeLauncher);
    expect(readFileSync(join(c.home, ".local", "bin", "japa-docker"), "utf8")).toContain("# japa-docker-launcher");
    expect(r.stdout).toContain("run `japa-docker --instance alice setup` to finish");
  });
});

// --- With a terminal (a pseudo-terminal from util-linux `script`) ---

const hasScript = spawnSync("sh", ["-c", "command -v script"]).status === 0;

/** Runs install.sh in a pseudo-terminal, typing `input` (lines, written one at a time as the script asks). */
function runInPty(c: Ctx, args: string[], input: string, extraEnv: NodeJS.ProcessEnv = {}) {
  const cmd = ["sh", INSTALL_SH, ...args].map((a) => `'${a.replace(/'/g, `'\\''`)}'`).join(" ");
  // The answers are fed with small delays, so each arrives once the script is reading /dev/tty.
  const feeder = input
    .split("\n")
    .slice(0, -1)
    .map((line) => `sleep 1; printf '%s\\n' '${line}'`)
    .join("; ");
  const r = spawnSync("sh", ["-c", `{ ${feeder}; sleep 3; } | script -qec "${cmd.replace(/"/g, '\\"')}" /dev/null`], {
    encoding: "utf8",
    env: { ...c.env, ...extraEnv },
    timeout: 60_000,
  });
  return { status: r.status, output: `${r.stdout}${r.stderr}` };
}

// With a terminal the installer menu comes first (docs/spec.md "installer menu"): each run's answers start with the
// menu's (Enter: Install on a fresh machine), then the mode question and the rest.
describe("with a terminal", () => {
  test.skipIf(!hasScript)("pressing Enter at the mode question picks Docker", () => {
    const c = setup();
    const r = runInPty(c, ["--repo", REPO, "--skip-setup"], "\n\n");
    expect(r.output).toContain("Choose [1]:");
    expect(r.output).toContain("Install japa via Docker (recommended) or natively?");
    expect(r.status, r.output).toBe(0);
    expect(Object.keys(c.fake.state().containers)).toEqual(["japa-alice"]);
    expect(readFileSync(hostLauncher(c.home), "utf8")).toContain("# japa-docker-launcher");
  });

  test.skipIf(!hasScript)("declining the Sysbox install offers the native install instead", () => {
    const c = setup({ runtimes: ["runc"] });
    const osRelease = join(c.home, "os-release");
    writeFileSync(osRelease, "ID=debian\n");
    writeFakeTool(c.fake.binDir, "apt-get", "exit 1");
    writeFakeTool(c.fake.binDir, "sudo", 'echo "fake sudo $*"; exit 1');
    const r = runInPty(c, ["--mode", "docker", "--repo", REPO, "--skip-setup"], "\nn\nn\n", { JAPA_OS_RELEASE: osRelease });
    expect(r.output).toContain("Install Sysbox now?");
    expect(r.output).toContain("Install japa natively instead?");
    expect(r.output).not.toContain("fake sudo");
    expect(r.status).not.toBe(0);
    expect(c.fake.callsOf("build")).toEqual([]);
  });

  test.skipIf(!hasScript)("with a terminal, the menu marks the instance installed and Enter (Update) upgrades it", () => {
    const c = setup({
      containers: Object.fromEntries([instance("alice", { port: 6085, image: "sha256:image1", branch: "main" })]),
      volumes: ["japa-alice-home", "japa-alice-docker"],
      networks: ["japa-alice-net"],
      images: { "japa-host:main": "sha256:image1" },
      buildImageId: "sha256:image1",
    });
    const r = runInPty(c, ["--repo", REPO], "1\n\n");
    expect(r.status, r.output).toBe(0);
    expect(r.output).toContain("Docker instance alice installed)");
    expect(r.output).toContain("Choose [2]:");
    expect(r.output).toContain("japa is already installed as Docker instance alice; choose Update");
    expect(r.output).not.toContain("Install japa via Docker (recommended) or natively?");
    expect(c.fake.callsOf("run")).toEqual([]);
    expect(innerInstalls(c.fake).length).toBe(1);
  });
});
