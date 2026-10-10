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
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, onTestFinished, test, vi } from "vitest";
import { cloneDir } from "../src/kernel/jobs/clone.ts";
import { jobEnv } from "../src/kernel/sandbox/bwrap.ts";
import { createJobSandboxes, hiddenPaths } from "../src/kernel/sandbox/jobs.ts";
import { ensureWorkspace } from "../src/kernel/workspace.ts";
import { NO_BWRAP, sandboxScratch, waitFor } from "./helpers.ts";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));

/**
 * A japa workspace and a user home (`HOME`, until the test finishes) outside `/tmp`, which jobs see replaced by their
 * own, and the job sandboxes on them; with `o.node`, `<outside>/node` stands in for the daemon's Node dir. The missing
 * `<outside>/prefix/lib/node` (`lib` exists) always stands in for its `lib/node`, never touched in tests. Hidden are
 * `<outside>/vault`, which has a `key`, and the missing `<outside>/absent`; `o.secret(home)` are the secret paths. All
 * closed and removed when the test finishes.
 */
function setup(
  o: { node?: boolean; refuse?: (jobId: string) => Promise<string | undefined>; secret?: (home: string) => string[] } = {},
) {
  const outside = sandboxScratch("japa-job-sandboxes-");
  const [home, user, node] = [join(outside, "home"), join(outside, "user"), join(outside, "node")];
  const [vault, absent] = [join(outside, "vault"), join(outside, "absent")];
  for (const dir of [home, user, node, vault]) mkdirSync(dir);
  writeFileSync(join(vault, "key"), "sk-1");
  ensureWorkspace(home);
  const saved = process.env.HOME;
  process.env.HOME = user;
  const nodeLib = join(outside, "prefix", "lib", "node");
  mkdirSync(dirname(nodeLib), { recursive: true });
  const nodeDirs = o.node ? { nodeDir: node, nodeLib } : { nodeLib };
  const sandboxes = createJobSandboxes({
    home,
    packageRoot,
    hidden: [vault, absent],
    env: jobEnv(),
    ...nodeDirs,
    ...(o.refuse && { refuse: o.refuse }),
    ...(o.secret && { secret: o.secret(home) }),
  });
  onTestFinished(() => {
    sandboxes.closeAll();
    process.env.HOME = saved;
    rmSync(outside, { recursive: true, force: true });
  });
  return { outside, home, user, node, nodeLib, vault, absent, sandboxes };
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

// Jobs can write `~/.node_modules`, `~/.node_libraries` and NODE_PATH's dirs: a dependency's optional `require` of a
// module that isn't installed (`supports-color` from `debug`, `bufferutil` from `ws`) mustn't load one from there.
/**
 * A temp `home` with `.node_modules/probe` and `.node_libraries/probe3`, and `extra` with `probe2`, for NODE_PATH;
 * `load` is a script that `require`s the three, as if from `<root>/main.js`, into `loaded`: each module's name, or
 * its error's code.
 */
function requireProbes() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "japa-require-")));
  onTestFinished(() => rmSync(root, { recursive: true, force: true }));
  const [home, extra] = [join(root, "home"), join(root, "extra")];
  const probes = [
    [join(home, ".node_modules"), "probe"],
    [extra, "probe2"],
    [join(home, ".node_libraries"), "probe3"],
  ];
  for (const [dir, name] of probes) {
    mkdirSync(join(dir!, name!), { recursive: true });
    writeFileSync(join(dir!, name!, "index.js"), `module.exports = "${name}";`);
  }
  const load = [
    `const require = createRequire(${JSON.stringify(join(root, "main.js"))});`,
    "const tryLoad = (name) => { try { return require(name); } catch (error) { return error.code; } };",
    'const loaded = ["probe", "probe2", "probe3"].map(tryLoad);',
  ].join("\n");
  const env = { PATH: process.env.PATH, HOME: home, NODE_PATH: extra };
  return { root, home, extra, load, env };
}

const MISSING = "MODULE_NOT_FOUND";

test("narrowRequire: require no longer looks in ~/.node_modules, ~/.node_libraries or NODE_PATH", () => {
  const { home, extra, load, env } = requireProbes();
  const jobs = new URL("../src/kernel/sandbox/jobs.ts", import.meta.url).href;
  const run = (narrow: boolean) => {
    const script = [
      `import { createRequire } from "node:module";`,
      narrow ? `import { narrowRequire } from ${JSON.stringify(jobs)}; narrowRequire();` : "",
      load,
      "console.log(JSON.stringify([...loaded, process.env.HOME, process.env.NODE_PATH ?? null]));",
    ].join("\n");
    const output = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
      env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return JSON.parse(output);
  };
  // Found there without it: the probes are where Node looks.
  expect(run(false)).toEqual(["probe", "probe2", "probe3", home, extra]);
  // HOME is restored; NODE_PATH stays unset, for the daemon's own children too.
  expect(run(true)).toEqual([MISSING, MISSING, MISSING, home, null]);
});

// `japa check` and the other commands load the daemon's code too.
test("the CLI narrows require before running a command", () => {
  const { root, home, load, env } = requireProbes();
  // After the command, as the process exits: what a dependency's optional `require` would find then.
  const preload = join(root, "preload.mjs");
  const result = join(root, "result.json");
  const write = `writeFileSync(${JSON.stringify(result)}, JSON.stringify([...loaded, process.env.HOME]))`;
  writeFileSync(
    preload,
    [
      `import { createRequire } from "node:module";`,
      `import { writeFileSync } from "node:fs";`,
      `process.on("exit", () => {`,
      load,
      `${write};`,
      "});",
    ].join("\n"),
  );
  const main = fileURLToPath(new URL("../src/cli/main.ts", import.meta.url));
  const args = ["--disable-warning=ExperimentalWarning", "--import", preload, main, "--version"];
  const output = execFileSync(process.execPath, args, { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  expect(output).toMatch(/^japa /);
  expect(JSON.parse(readFileSync(result, "utf8"))).toEqual([MISSING, MISSING, MISSING, home]);
});

test("a job's spec has the daemon's Node dir and its lib/node read-only, by real path; tests' JAPA_NODE_LIB", () => {
  const bin = realpathSync(dirname(process.execPath));
  const saved = process.env.JAPA_NODE_LIB;
  onTestFinished(() => {
    if (saved === undefined) delete process.env.JAPA_NODE_LIB;
    else process.env.JAPA_NODE_LIB = saved;
  });
  // Only specs: no sandbox starts, so nothing is mounted in the real prefix.
  const readOnly = () => createJobSandboxes({ home: "/h", packageRoot, hidden: [], env: {} }).spec("1").readOnly;
  delete process.env.JAPA_NODE_LIB;
  expect(readOnly()).toContainEqual({ path: bin, dir: true });
  // Where `require` still looks last, after narrowRequire.
  expect(readOnly()).toContainEqual({ path: resolve(bin, "..", "lib", "node"), dir: true });
  // The tests' stand-in, set for every test file (test/setup.ts).
  process.env.JAPA_NODE_LIB = "/stand-in/lib/node";
  expect(readOnly()).toContainEqual({ path: "/stand-in/lib/node", dir: true });
  expect(readOnly()).not.toContainEqual({ path: resolve(bin, "..", "lib", "node"), dir: true });
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

  test("a job can't create a module in the daemon's Node's lib/node, missing as it usually is", async () => {
    const { outside, nodeLib, sandboxes } = setup({ node: true });
    expect(sandboxes.spec("1").readOnly).toContainEqual({ path: nodeLib, dir: true });
    const planted = join(nodeLib, "supports-color", "index.js");
    const script = `mkdir -p "${dirname(planted)}" && echo x > "${planted}"; touch "${join(outside, "ran")}"`;
    expect((await sandboxes.env("c", "1").exec(script, undefined, ctx)).ok).toBe(true);
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

  test("a sandbox doesn't start while refused; one closed while asking is asked again", async () => {
    const GOING_LIVE = "Job 1 is going live; message it after its report.";
    let reason: string | undefined = GOING_LIVE;
    let hold = false;
    let answer: (() => void) | undefined;
    const asked: string[] = [];
    const { home, sandboxes } = setup({
      refuse: async (jobId) => {
        asked.push(jobId);
        const given = reason; // as read before the wait: stale once it ends
        if (hold) await new Promise<void>((resolve) => (answer = resolve));
        return given;
      },
    });
    const env = sandboxes.env("c", "1");
    expect(await env.exec("true", undefined, ctx)).toMatchObject({ ok: false, error: { message: GOING_LIVE } });
    expect(sandboxPids(home, "1")).toEqual([]);
    expect(existsSync(cloneDir(home, "1"))).toBe(false);

    // Allowed when asked, but closed (to publish, say) before the answer: asked again, and refused.
    reason = undefined;
    hold = true;
    const call = env.exec("true", undefined, ctx);
    await waitFor(() => answer !== undefined);
    sandboxes.close("1");
    reason = GOING_LIVE;
    hold = false;
    answer!();
    expect(await call).toMatchObject({ ok: false, error: { message: GOING_LIVE } });
    expect(asked).toEqual(["1", "1", "1"]);
    expect(sandboxPids(home, "1")).toEqual([]);

    // Allowed: it starts, and isn't asked again while it runs.
    reason = undefined;
    expect((await env.exec("true", undefined, ctx)).ok).toBe(true);
    expect((await env.exec("true", undefined, ctx)).ok).toBe(true);
    expect(asked).toHaveLength(4);
  });

  test("a job reads the real attachments and current settings, but can't change them", async () => {
    const { outside, home, sandboxes } = setup();
    expect(existsSync(join(home, "attachments"))).toBe(false); // made when the sandbox starts
    writeFileSync(join(home, "settings.json"), '{"now":true}\n'); // not committed: the clone has the older one
    const env = sandboxes.env("c", "1");
    expect((await env.exec("true", undefined, ctx)).ok).toBe(true);
    mkdirSync(join(home, "attachments", "2026-10-10"), { recursive: true });
    writeFileSync(join(home, "attachments", "2026-10-10", "a.png"), "png");
    const script = [
      `cat "${home}/attachments/2026-10-10/a.png"; echo`,
      `cat "${home}/settings.json"`,
      `echo x > "${home}/attachments/new" 2>/dev/null && echo wrote-attachment`,
      `echo x > "${home}/settings.json" 2>/dev/null && echo wrote-settings`,
      "true",
    ].join("; ");
    const out = join(outside, "out");
    expect((await env.exec(`{ ${script}; } > "${out}"`, undefined, ctx)).ok).toBe(true);
    expect(readFileSync(out, "utf8")).toBe('png\n{"now":true}\n');
    expect(existsSync(join(home, "attachments", "new"))).toBe(false);
    expect(readFileSync(join(home, "settings.json"), "utf8")).toBe('{"now":true}\n');
    expect(sandboxes.spec("1").readOnlyShared).toEqual([join(home, "attachments"), join(home, "settings.json")]);
  });

  test("a shared path that links to, into or above a secrets dir isn't mounted: the job can't read through it", async () => {
    const { outside, home, user, vault, sandboxes } = setup({ secret: (home) => [join(home, "secrets")] });
    mkdirSync(join(home, "secrets"));
    writeFileSync(join(home, "secrets", "token"), "tok-1");
    symlinkSync(join(home, "secrets"), join(home, "attachments")); // a secrets dir in the home, which isn't hidden
    symlinkSync(join(vault, "key"), join(home, "settings.json")); // into a hidden one
    mkdirSync(join(home, "desktop"));
    symlinkSync(outside, join(home, "desktop", "shared")); // above one, and the home
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    onTestFinished(() => errors.mockRestore());
    const spec = sandboxes.spec("1");
    expect(spec.shared).toEqual([]);
    expect(spec.readOnlyShared).toEqual([]);
    for (const path of ["attachments", "settings.json", "desktop/shared"]) {
      expect(errors).toHaveBeenCalledWith(expect.stringContaining(`Jobs don't get ${join(home, path)}: `));
    }
    const out = join(user, "out");
    const script = [
      `cat "${home}/attachments/token"`,
      `cat "${home}/settings.json"`,
      `cat "${home}/desktop/shared/vault/key"`,
      `cat "${home}/desktop/shared/home/secrets/token"`,
      "echo end",
    ].join("; ");
    expect((await sandboxes.env("c", "1").exec(`{ ${script}; } > "${out}" 2>/dev/null`, undefined, ctx)).ok).toBe(true);
    expect(readFileSync(out, "utf8")).toBe("end\n");

    // Nor elsewhere in the home (its database, say); but a folder elsewhere outside it is shared.
    rmSync(join(home, "settings.json"));
    writeFileSync(join(home, "state.db"), "db");
    symlinkSync(join(home, "state.db"), join(home, "settings.json"));
    rmSync(join(home, "attachments"));
    mkdirSync(join(user, "pictures"));
    symlinkSync(join(user, "pictures"), join(home, "attachments"));
    expect(sandboxes.spec("1").readOnlyShared).toEqual([join(home, "attachments")]);
    expect(errors).toHaveBeenCalledWith(
      `Jobs don't get ${join(home, "settings.json")}: ${join(home, "state.db")} is elsewhere in the japa home`,
    );
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
