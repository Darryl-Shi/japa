import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, onTestFinished, test } from "vitest";
import { cloneDir } from "../src/kernel/jobs/clone.ts";
import { jobEnv } from "../src/kernel/sandbox/bwrap.ts";
import { createJobSandboxes, hiddenPaths } from "../src/kernel/sandbox/jobs.ts";
import { ensureWorkspace } from "../src/kernel/workspace.ts";
import { NO_BWRAP, waitFor } from "./helpers.ts";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));

/**
 * A japa workspace and a user home (`HOME`, until the test finishes) outside `/tmp`, which jobs see replaced by their
 * own, and the job sandboxes on them; with `o.node`, `<outside>/node` stands in for the daemon's Node dir. Hidden are
 * `<outside>/vault`, which has a `key`, and the missing `<outside>/absent`. All closed and removed when the test
 * finishes.
 */
function setup(o: { node?: boolean } = {}) {
  const cache = join(realpathSync(fileURLToPath(new URL("../node_modules", import.meta.url))), ".cache");
  mkdirSync(cache, { recursive: true });
  const outside = mkdtempSync(join(cache, "japa-job-sandboxes-"));
  const [home, user, node] = [join(outside, "home"), join(outside, "user"), join(outside, "node")];
  const [vault, absent] = [join(outside, "vault"), join(outside, "absent")];
  for (const dir of [home, user, node, vault]) mkdirSync(dir);
  writeFileSync(join(vault, "key"), "sk-1");
  ensureWorkspace(home);
  const saved = process.env.HOME;
  process.env.HOME = user;
  const nodeDir = o.node ? { nodeDir: node } : {};
  const sandboxes = createJobSandboxes({ home, packageRoot, hidden: [vault, absent], env: jobEnv(), ...nodeDir });
  onTestFinished(() => {
    sandboxes.closeAll();
    process.env.HOME = saved;
    rmSync(outside, { recursive: true, force: true });
  });
  return { outside, home, user, node, vault, absent, sandboxes };
}

/** The processes running job `jobId`'s sandbox in `home`: bwrap's, by the clone on its command line. */
function sandboxPids(home: string, jobId: string): number[] {
  const found = spawnSync("pgrep", ["-f", "--", cloneDir(home, jobId)], { encoding: "utf8" }).stdout;
  return found.split("\n").filter(Boolean).map(Number).sort((a, b) => a - b);
}

/** `pids` and all their descendants. */
function withDescendants(pids: number[]): number[] {
  const table = execFileSync("ps", ["-eo", "pid=,ppid="], { encoding: "utf8" })
    .trim()
    .split("\n")
    .map((line) => line.trim().split(/\s+/).map(Number) as [number, number]);
  const all = new Set(pids);
  for (let grew = true; grew; ) {
    grew = false;
    for (const [pid, ppid] of table) {
      if (all.has(ppid) && !all.has(pid)) {
        all.add(pid);
        grew = true;
      }
    }
  }
  return [...all];
}

/** Whether process `pid` still runs (a zombie doesn't). */
function alive(pid: number): boolean {
  try {
    return !/^\d+ \(.*\) Z /.test(readFileSync(`/proc/${pid}/stat`, "utf8"));
  } catch {
    return false;
  }
}

test("hiddenPaths: those outside the home by real path, a symlink inside it to outside included", () => {
  const outside = realpathSync(mkdtempSync(join(tmpdir(), "japa-hidden-")));
  onTestFinished(() => rmSync(outside, { recursive: true, force: true }));
  const home = join(outside, "home");
  const vault = join(outside, "vault");
  mkdirSync(join(home, "inside"), { recursive: true });
  mkdirSync(vault);
  symlinkSync(vault, join(home, "secrets"));
  const db = join(outside, "db", "state.db");
  mkdirSync(dirname(db));
  writeFileSync(db, "db");
  writeFileSync(`${db}-wal`, "wal");
  // The home itself reached through a symlink.
  const link = join(outside, "link");
  symlinkSync(home, link);
  const paths = [
    join(link, "secrets"),
    join(link, "inside"),
    join(home, "missing"),
    join(link, "..", "later"),
    db,
    `${db}-wal`,
    `${db}-shm`,
  ];
  // Missing ones are kept, resolved as far as they exist: the sandbox hides them once they do.
  expect(hiddenPaths(link, paths)).toEqual({
    hidden: [vault, join(outside, "later"), db, `${db}-wal`, `${db}-shm`],
    holdingHome: [],
  });
});

test("hiddenPaths: one that is or holds the home, by real path, isn't hidden but returned apart", () => {
  const outside = realpathSync(mkdtempSync(join(tmpdir(), "japa-hidden-")));
  onTestFinished(() => rmSync(outside, { recursive: true, force: true }));
  const home = join(outside, "a", "home");
  mkdirSync(home, { recursive: true });
  mkdirSync(join(outside, "vault"));
  symlinkSync(join(outside, "a"), join(outside, "link"));
  // A mask there would cover the clone mounted over the home.
  const paths = [join(outside, "link"), home, join(outside, "a"), join(outside, "vault"), join(home, "secrets")];
  expect(hiddenPaths(home, paths)).toEqual({
    hidden: [join(outside, "vault")],
    holdingHome: [join(outside, "a"), home],
  });
});

test("a job's spec has the daemon's Node dir read-only, by real path", () => {
  const { sandboxes } = setup();
  expect(sandboxes.spec("1").readOnly).toContainEqual({ path: realpathSync(dirname(process.execPath)), dir: true });
});

describe.skipIf(NO_BWRAP)("a job's sandbox", () => {
  // The daemon's PATH starts with it; outside the app dir (nvm, a dev checkout), it would be writable otherwise.
  test("a job can't create files in the daemon's Node dir", async () => {
    const { outside, node, sandboxes } = setup({ node: true });
    expect(sandboxes.spec("1").readOnly).toContainEqual({ path: node, dir: true });
    const env = sandboxes.env("c", "1");
    const planted = join(node, "git");
    const result = await env.exec(`touch "${planted}"; touch "${join(outside, "ran")}"`, undefined, ctx);
    expect(result.ok).toBe(true);
    expect(existsSync(join(outside, "ran"))).toBe(true);
    expect(existsSync(planted)).toBe(false);
  });

  // Renamed away, it would no longer be found to hide, and so read at its new name.
  test("a sandbox doesn't start while a hidden path there at creation is missing", async () => {
    const { home, vault, absent, sandboxes } = setup();
    const env = sandboxes.env("c", "1");
    expect((await env.exec("true", undefined, ctx)).ok).toBe(true);
    sandboxes.close("1");
    renameSync(vault, `${vault}2`);
    const refused = await env.exec(`cat "${vault}2/key"`, undefined, ctx);
    expect(refused).toMatchObject({
      ok: false,
      error: { message: `The job's sandbox can't start: ${vault} is missing` },
    });
    expect(sandboxPids(home, "1")).toEqual([]);
    // Back in place, it starts; a path missing at creation doesn't stop it.
    renameSync(`${vault}2`, vault);
    expect(existsSync(absent)).toBe(false);
    let output = "";
    const onOutput = (text: string) => void (output += text);
    const result = await env.exec(`ls -A "${vault}"; echo end`, { onOutput }, ctx);
    expect(result).toMatchObject({ ok: true, value: { exitCode: 0 } });
    expect(output).toBe("end\n");
  });

  test("a job's calls share one sandbox, and closeAll stops it", async () => {
    const { home, sandboxes } = setup();
    const env = sandboxes.env("c", "1");
    expect((await env.exec("true", undefined, ctx)).ok).toBe(true);
    const first = sandboxPids(home, "1");
    expect(first).not.toEqual([]);
    expect((await env.exec("true", undefined, ctx)).ok).toBe(true);
    expect(sandboxPids(home, "1")).toEqual(first);
    // The env server, and anything it runs, too.
    const all = withDescendants(first);
    expect(all.length).toBeGreaterThan(first.length);
    sandboxes.closeAll();
    await waitFor(() => all.every((pid) => !alive(pid)), 10_000);
  });
});
