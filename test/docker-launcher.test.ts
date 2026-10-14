// The Docker-mode host launcher (docs/spec.md §5), extracted from install.sh's docker_launcher_text() heredoc and
// run against a fake `docker` on PATH (test/fake-docker.ts).
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { createFakeDocker, type FakeDocker, type FakeState, fakePath, instance, launcherFromInstallSh } from "./fake-docker.ts";

const INSTALL_SH = fileURLToPath(new URL("../install.sh", import.meta.url));
const LAUNCHER_TEXT = launcherFromInstallSh(INSTALL_SH);

const INNER = "/home/japa/.local/bin/japa";
const EXEC_PREFIX = [
  "exec",
  "-i",
  "-u",
  "japa",
  "-w",
  "/home/japa",
  "-e",
  "HOME=/home/japa",
  "-e",
  "USER=japa",
  "-e",
  "XDG_RUNTIME_DIR=/run/user/1000",
  "-e",
  "DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus",
  "-e",
  "TERM",
  "-e",
  "LANG",
  "-e",
  "TZ",
];

interface Setup {
  fake: FakeDocker;
  home: string;
  launcher: string;
  run(args: string[], env?: NodeJS.ProcessEnv, opts?: { setsid?: boolean }): { status: number | null; stdout: string; stderr: string; output: string };
}

function setup(initial: Partial<FakeState> = {}): Setup {
  const fake = createFakeDocker(initial);
  const home = mkdtempSync(join(tmpdir(), "japa-launcher-home-"));
  const binDir = join(home, ".local", "bin");
  mkdirSync(binDir, { recursive: true });
  const launcher = join(binDir, "japa");
  writeFileSync(launcher, LAUNCHER_TEXT);
  chmodSync(launcher, 0o755);
  return {
    fake,
    home,
    launcher,
    run(args, env = {}, opts = {}) {
      const fullEnv = { HOME: home, PATH: fakePath(fake), USER: "nobody-here", TERM: "xterm", ...env };
      // setsid: no controlling terminal, so /dev/tty can't be opened (has_tty fails), whatever runs vitest.
      const [cmd, argv] = opts.setsid === false ? [launcher, args] : ["setsid", ["-w", launcher, ...args]];
      const r = spawnSync(cmd, argv, { encoding: "utf8", env: fullEnv, stdio: ["pipe", "pipe", "pipe"], input: "" });
      return { status: r.status, stdout: r.stdout, stderr: r.stderr, output: `${r.stdout}${r.stderr}` };
    },
  };
}

const execsOf = (fake: FakeDocker) => fake.callsOf("exec").filter((c) => !c.includes("is-system-running"));

test("the launcher text is the marked POSIX sh script", () => {
  expect(LAUNCHER_TEXT.startsWith("#!/bin/sh\n")).toBe(true);
  expect(LAUNCHER_TEXT).toContain("# japa-docker-launcher");
  expect(spawnSync("sh", ["-n", "-c", LAUNCHER_TEXT]).status).toBe(0);
});

describe("instance resolution", () => {
  test("--instance <name> as the first argument picks it and is stripped before forwarding", () => {
    const s = setup({ containers: Object.fromEntries([instance("alice"), instance("bob", { port: 6081 })]) });
    const r = s.run(["--instance", "bob", "status"]);
    expect(r.status, r.output).toBe(0);
    expect(execsOf(s.fake)).toEqual([[...EXEC_PREFIX, "japa-bob", INNER, "status"]]);
  });

  test("--instance=<name> works too", () => {
    const s = setup({ containers: Object.fromEntries([instance("alice"), instance("bob", { port: 6081 })]) });
    const r = s.run(["--instance=alice", "status"]);
    expect(r.status, r.output).toBe(0);
    expect(execsOf(s.fake)).toEqual([[...EXEC_PREFIX, "japa-alice", INNER, "status"]]);
  });

  test("--instance later in the argv is forwarded, not interpreted", () => {
    const s = setup({ containers: Object.fromEntries([instance("alice")]) });
    const r = s.run(["chat", "--instance", "bob"]);
    expect(r.status, r.output).toBe(0);
    expect(execsOf(s.fake)).toEqual([[...EXEC_PREFIX, "japa-alice", INNER, "chat", "--instance", "bob"]]);
  });

  test("JAPA_INSTANCE picks the instance", () => {
    const s = setup({ containers: Object.fromEntries([instance("alice"), instance("bob", { port: 6081 })]) });
    const r = s.run(["status"], { JAPA_INSTANCE: "bob", USER: "alice" });
    expect(r.status, r.output).toBe(0);
    expect(execsOf(s.fake)).toEqual([[...EXEC_PREFIX, "japa-bob", INNER, "status"]]);
  });

  test("--instance beats JAPA_INSTANCE", () => {
    const s = setup({ containers: Object.fromEntries([instance("alice"), instance("bob", { port: 6081 })]) });
    const r = s.run(["--instance", "alice", "status"], { JAPA_INSTANCE: "bob" });
    expect(r.status, r.output).toBe(0);
    expect(execsOf(s.fake)[0]).toContain("japa-alice");
  });

  test("the only instance is used when nothing names one", () => {
    const s = setup({ containers: Object.fromEntries([instance("carol")]) });
    const r = s.run(["status"], { USER: "dave" });
    expect(r.status, r.output).toBe(0);
    expect(execsOf(s.fake)).toEqual([[...EXEC_PREFIX, "japa-carol", INNER, "status"]]);
  });

  test("among several, the one named after $USER (sanitised) is used", () => {
    const s = setup({ containers: Object.fromEntries([instance("alice"), instance("bob-smith", { port: 6081 })]) });
    const r = s.run(["status"], { USER: "Bob.Smith" });
    expect(r.status, r.output).toBe(0);
    expect(execsOf(s.fake)).toEqual([[...EXEC_PREFIX, "japa-bob-smith", INNER, "status"]]);
  });

  test("several with no match exits non-zero and lists the names", () => {
    const s = setup({ containers: Object.fromEntries([instance("alice"), instance("bob", { port: 6081 })]) });
    const r = s.run(["chat"], { USER: "carol" });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("alice");
    expect(r.stderr).toContain("bob");
    expect(r.stderr).toContain("--instance");
    expect(execsOf(s.fake)).toEqual([]);
  });

  test("no instances at all exits non-zero and says so", () => {
    const s = setup();
    const r = s.run(["chat"]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/no japa instances/);
    expect(execsOf(s.fake)).toEqual([]);
  });

  test("a named instance that doesn't exist: says so and lists the existing ones", () => {
    const s = setup({ containers: Object.fromEntries([instance("alice"), instance("bob", { port: 6081 })]) });
    const r = s.run(["--instance", "zed", "status"]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("no japa instance named zed");
    expect(r.stderr).toContain("alice");
    expect(r.stderr).toContain("bob");
    expect(execsOf(s.fake)).toEqual([]);
  });

  test("a container named japa-<n> without the japa.instance label isn't an instance", () => {
    const s = setup({ containers: { "japa-zed": { labels: {}, image: "x", running: true } } });
    const r = s.run(["--instance", "zed", "status"]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("no japa instance named zed");
    expect(execsOf(s.fake)).toEqual([]);
  });

  test("a stopped container is started first", () => {
    const s = setup({ containers: Object.fromEntries([instance("alice", { running: false })]) });
    const r = s.run(["status"]);
    expect(r.status, r.output).toBe(0);
    const calls = s.fake.calls().map((c) => c.join(" "));
    const start = calls.indexOf("start japa-alice");
    const forward = calls.findIndex((c) => c.startsWith("exec -i ") && c.endsWith(`${INNER} status`));
    expect(start).toBeGreaterThanOrEqual(0);
    expect(forward).toBeGreaterThan(start);
    expect(s.fake.state().containers["japa-alice"].running).toBe(true);
  });
});

describe("forwarding", () => {
  test("argv is forwarded exactly, spaces and quotes preserved", () => {
    const s = setup({ containers: Object.fromEntries([instance("alice")]) });
    const args = ["chat", "hello world", `it's "quoted"`, "", "$HOME", "a\\b", "*"];
    const r = s.run(args);
    expect(r.status, r.output).toBe(0);
    expect(execsOf(s.fake)).toEqual([[...EXEC_PREFIX, "japa-alice", INNER, ...args]]);
  });

  test("no -t when stdin isn't a terminal", () => {
    const s = setup({ containers: Object.fromEntries([instance("alice")]) });
    s.run(["status"]);
    const [call] = execsOf(s.fake);
    expect(call).toContain("-i");
    expect(call).not.toContain("-t");
    expect(call).not.toContain("-it");
  });

  test("the inner command's output and exit status are the launcher's", () => {
    const s = setup({
      containers: Object.fromEntries([instance("alice")]),
      execRules: [
        { match: [INNER, "check"], stdout: "checking\n", stderr: "1 problem\n", status: 3 },
        { match: [INNER, "--version"], stdout: "japa 0.1.0 (abc1234)\n" },
      ],
    });
    const failed = s.run(["check"]);
    expect(failed.status).toBe(3);
    expect(failed.stdout).toBe("checking\n");
    expect(failed.stderr).toContain("1 problem");
    const version = s.run(["--version"]);
    expect(version.status).toBe(0);
    expect(version.stdout).toBe("japa 0.1.0 (abc1234)\n");
  });

  test("shell execs an interactive login bash as japa", () => {
    const s = setup({ containers: Object.fromEntries([instance("alice")]) });
    const r = s.run(["--instance", "alice", "shell"]);
    expect(r.status, r.output).toBe(0);
    expect(execsOf(s.fake)).toEqual([[...EXEC_PREFIX, "japa-alice", "bash", "-l"]]);
  });
});

describe("instances", () => {
  test("lists name, state, branch, version (only when running), the noVNC URL and the web UI URL", () => {
    const s = setup({
      containers: Object.fromEntries([
        instance("alice", { branch: "main", port: 6080, webuiPort: 7337 }),
        instance("bob", { branch: "dev", port: 6081, webuiPort: 7338, webuiBind: "10.234.31.61", running: false }),
        instance("carol", { branch: "main", port: 6082, webuiPort: 7339, webuiBind: "0.0.0.0", running: false }),
        instance("dave", { branch: "main", port: 6083, webuiPort: null, running: false }),
      ]),
      execRules: [{ match: [INNER, "--version"], stdout: "japa 0.1.0 (abc1234)\n" }],
    });
    const r = s.run(["instances"]);
    expect(r.status, r.output).toBe(0);
    const lines = r.stdout.trim().split("\n");
    expect(lines[0]).toMatch(/NAME\s+STATE\s+BRANCH\s+VERSION\s+DESKTOP\s+WEB UI$/);
    const row = (name: string) => lines.find((l) => l.startsWith(`${name} `));
    expect(row("alice")).toMatch(
      /^alice\s+running\s+main\s+japa 0\.1\.0 \(abc1234\)\s+http:\/\/127\.0\.0\.1:6080\/vnc\.html\s+http:\/\/127\.0\.0\.1:7337$/,
    );
    expect(row("bob")).toMatch(/^bob\s+stopped\s+dev\s+-\s+http:\/\/127\.0\.0\.1:6081\/vnc\.html\s+http:\/\/10\.234\.31\.61:7338$/);
    expect(row("carol")).toMatch(/\s+http:\/\/127\.0\.0\.1:6082\/vnc\.html\s+http:\/\/127\.0\.0\.1:7339$/);
    expect(row("dave")).toMatch(/\s+http:\/\/127\.0\.0\.1:6083\/vnc\.html\s+-$/);
    // The columns line up.
    const webCol = lines[0].indexOf("WEB UI");
    for (const l of lines.slice(1)) expect(l.slice(webCol - 1, webCol + 1)).toMatch(/^ \S$/);
    // The version is asked only of the running instance, and nothing is started.
    const versionExecs = execsOf(s.fake).filter((c) => c.includes("--version"));
    expect(versionExecs.length).toBe(1);
    expect(versionExecs[0]).toContain("japa-alice");
    expect(s.fake.callsOf("start")).toEqual([]);
  });

  test("with no instances says so", () => {
    const s = setup();
    const r = s.run(["instances"]);
    expect(r.status, r.output).toBe(0);
    expect(r.stdout).toContain("no japa instances");
  });

  test("ignores unlabelled containers", () => {
    const s = setup({ containers: { ...Object.fromEntries([instance("alice")]), "japa-other": { labels: {}, image: "x", running: true } } });
    const r = s.run(["instances"]);
    expect(r.stdout).toContain("alice");
    expect(r.stdout).not.toMatch(/^other/m);
  });
});

describe("uninstall", () => {
  const twoInstances = (): Partial<FakeState> => ({
    containers: Object.fromEntries([instance("alice"), instance("bob", { port: 6081 })]),
    volumes: ["japa-alice-home", "japa-alice-docker", "japa-bob-home", "japa-bob-docker"],
    networks: ["japa-alice-net", "japa-bob-net"],
  });

  test("removes the container and network, keeps the volumes and says so", () => {
    const s = setup(twoInstances());
    const r = s.run(["--instance", "alice", "uninstall"]);
    expect(r.status, r.output).toBe(0);
    const st = s.fake.state();
    expect(Object.keys(st.containers)).toEqual(["japa-bob"]);
    expect(st.networks).toEqual(["japa-bob-net"]);
    expect(st.volumes).toEqual(["japa-alice-home", "japa-alice-docker", "japa-bob-home", "japa-bob-docker"]);
    expect(r.stdout).toContain("japa-alice-home");
    expect(r.stdout).toContain("japa-alice-docker");
    expect(r.stdout).toMatch(/kept/);
    expect(s.fake.callsOf("volume").filter((c) => c[1] === "rm")).toEqual([]);
    // Another instance remains: the launcher stays.
    expect(existsSync(s.launcher)).toBe(true);
    expect(execsOf(s.fake)).toEqual([]);
  });

  test("--purge without a terminal refuses and removes nothing", () => {
    const s = setup(twoInstances());
    const before = s.fake.state();
    const r = s.run(["--instance", "alice", "uninstall", "--purge"]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/terminal/);
    expect(s.fake.state()).toEqual(before);
    expect(existsSync(s.launcher)).toBe(true);
  });

  test("the launcher removes itself when no instances remain", () => {
    const s = setup({ containers: Object.fromEntries([instance("alice")]), volumes: ["japa-alice-home", "japa-alice-docker"], networks: ["japa-alice-net"] });
    const r = s.run(["uninstall"]);
    expect(r.status, r.output).toBe(0);
    expect(s.fake.state().containers).toEqual({});
    expect(s.fake.state().volumes).toEqual(["japa-alice-home", "japa-alice-docker"]);
    expect(existsSync(s.launcher)).toBe(false);
  });

  test("an unknown instance: says so, removes nothing", () => {
    const s = setup(twoInstances());
    const before = s.fake.state();
    const r = s.run(["--instance", "zed", "uninstall"]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("no japa instance named zed");
    expect(s.fake.state()).toEqual(before);
  });
});

const hasScript = spawnSync("sh", ["-c", "command -v script"]).status === 0;

describe("uninstall --purge in a terminal", () => {
  /** Runs the launcher in a pseudo-terminal (util-linux `script`), typing `answer` once it asks. */
  function purgeInPty(s: Setup, answer: string) {
    const cmd = `'${s.launcher}' --instance alice uninstall --purge`;
    const r = spawnSync("sh", ["-c", `{ sleep 1; printf '%s\\n' '${answer}'; sleep 2; } | script -qec "${cmd}" /dev/null`], {
      encoding: "utf8",
      env: { HOME: s.home, PATH: fakePath(s.fake), USER: "alice", TERM: "xterm" },
      timeout: 30_000,
    });
    return { status: r.status, output: `${r.stdout}${r.stderr}` };
  }
  const one = (): Partial<FakeState> => ({
    containers: Object.fromEntries([instance("alice")]),
    volumes: ["japa-alice-home", "japa-alice-docker"],
    networks: ["japa-alice-net"],
  });

  test.skipIf(!hasScript)("typing the instance name deletes the volumes too", () => {
    const s = setup(one());
    const r = purgeInPty(s, "alice");
    expect(r.status, r.output).toBe(0);
    expect(r.output).toContain("Type the instance name to confirm");
    const st = s.fake.state();
    expect(st.containers).toEqual({});
    expect(st.volumes).toEqual([]);
    expect(st.networks).toEqual([]);
    expect(existsSync(s.launcher)).toBe(false);
  });

  test.skipIf(!hasScript)("typing anything else removes nothing", () => {
    const s = setup(one());
    const before = s.fake.state();
    const r = purgeInPty(s, "nope");
    expect(r.status).not.toBe(0);
    expect(r.output).toContain("nothing was removed");
    expect(s.fake.state()).toEqual(before);
  });
});
