import { execFileSync } from "node:child_process";
import { existsSync, fstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, test } from "vitest";
import type { Exec } from "../src/cli/exec.ts";
import { launcherText, layoutOf, writeLauncher } from "../src/cli/layout.ts";
import { type ServiceEnv, unitPath } from "../src/cli/service.ts";
import {
  checkForUpdate,
  restartAfterUpdate,
  update,
  type UpdateDeps,
  UpdateFailed,
  type UpdateOptions,
} from "../src/cli/update.ts";
import type { Restarted, UpdateState } from "../src/kernel/update-state.ts";

const tmp = () => mkdtempSync(join(tmpdir(), "japa-update-"));

/** Runs git in `cwd` with a fixed identity, so the fixtures' commits work without a global git config. */
function git(cwd: string, ...args: string[]): string {
  const config = ["-c", "user.name=japa", "-c", "user.email=japa@localhost", "-c", "commit.gpgsign=false"];
  return execFileSync("git", ["-C", cwd, ...config, ...args], { encoding: "utf8" }).trim();
}

const head = (dir: string) => git(dir, "rev-parse", "HEAD");
const short = (sha: string) => sha.slice(0, 7);

/** The three files every fixture commit carries (design doc §5.1 looks at `.node-version` and `package-lock.json`). */
const FIRST = { "package-lock.json": '{ "lockfileVersion": 1 }\n', ".node-version": "24.0.0\n", README: "one\n" };

/** Writes `files` in `dir` and commits them; the new sha. */
function commitFiles(dir: string, message: string, files: Record<string, string>): string {
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), text);
  }
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", message);
  return head(dir);
}

type Checkout = { root: string; seed: string; app: string; home: string; userHome: string; branch: string };

/**
 * A bare origin on `branch` with one commit, cloned to `<root>/<where>` (by default the managed `share/japa/app`),
 * a japa home (with `setup.json` unless `setupJson` is false) and an empty user home for the launcher.
 */
function checkout(opts: { where?: string; branch?: string; setupJson?: boolean } = {}): Checkout {
  const { where = join("share", "japa", "app"), branch = "main", setupJson = true } = opts;
  const root = tmp();
  const seed = join(root, "seed");
  mkdirSync(seed, { recursive: true });
  git(seed, "init", "-q", "-b", branch);
  commitFiles(seed, "one", FIRST);
  const origin = join(root, "origin.git");
  execFileSync("git", ["clone", "-q", "--bare", seed, origin]);
  git(seed, "remote", "add", "origin", origin);

  const app = join(root, where);
  mkdirSync(join(app, ".."), { recursive: true });
  execFileSync("git", ["clone", "-q", "--branch", branch, origin, app]);

  const home = join(root, "home");
  mkdirSync(home, { recursive: true });
  if (setupJson) writeFileSync(join(home, "setup.json"), '{ "offered": {} }\n');
  return { root, seed, app, home, userHome: join(root, "user"), branch };
}

/** Commits `files` on the origin's branch; the new sha. */
function push(c: Checkout, message: string, files: Record<string, string>): string {
  const sha = commitFiles(c.seed, message, files);
  git(c.seed, "push", "-q", "origin", c.branch);
  return sha;
}

/** Commits `files` on `branch` (created the first time) and pushes it, leaving the seed back on its own branch. */
function pushTo(c: Checkout, branch: string, message: string, files: Record<string, string>): string {
  const known = git(c.seed, "branch", "--list", branch) !== "";
  git(c.seed, "checkout", "-q", ...(known ? [branch] : ["-b", branch]));
  const sha = commitFiles(c.seed, message, files);
  git(c.seed, "push", "-q", "origin", branch);
  git(c.seed, "checkout", "-q", c.branch);
  return sha;
}

/** A local `dev` at `origin/dev`, one commit ahead of the checked-out branch; its sha. */
function localDev(c: Checkout): string {
  const at = pushTo(c, "dev", "dev one", { README: "dev one\n" });
  git(c.app, "fetch", "-q", "origin", "dev");
  git(c.app, "branch", "dev", "origin/dev");
  return at;
}

/** A local `dev` behind `origin/dev`; the sha it sits at and the sha origin moved on to. */
function localDevBehind(c: Checkout): { at: string; origin: string } {
  const at = localDev(c);
  return { at, origin: pushTo(c, "dev", "dev two", { README: "dev two\n" }) };
}

type Call = { name: string; args: unknown[]; head: string };

/** A private Node dir whose `bin/node` holds `text`, as `ensurePrivateNode` leaves it; the binary's path. */
function privateNode(nodeDir: string, text: string): string {
  mkdirSync(join(nodeDir, "bin"), { recursive: true });
  writeFileSync(join(nodeDir, "bin", "node"), text);
  return join(nodeDir, "bin", "node");
}

/**
 * `update`'s options and recording stub deps over `c`; `fail` makes that one step throw, `whatsNew` and `restarted`
 * are what those steps answer. `patches` collects what `update` records, `patchHeads` HEAD at each.
 */
function harness(
  c: Checkout,
  setup: {
    options?: Partial<UpdateOptions>;
    node?: string;
    fail?: "ensureNode" | "npmCi" | "validate" | "restart";
    whatsNew?: string[];
    restarted?: Restarted;
  } = {},
) {
  const logs: string[] = [];
  const calls: Call[] = [];
  const patches: Partial<UpdateState>[] = [];
  const patchHeads: string[] = [];
  const record = (name: string, ...args: unknown[]) => {
    calls.push({ name, args, head: head(c.app) });
    if (name === setup.fail) throw new Error("boom");
  };
  const node = setup.node ?? "/usr/bin/node";
  const deps: UpdateDeps = {
    node,
    ensureNode: async (version, nodeDir) => {
      record("ensureNode", version, nodeDir);
      if (existsSync(nodeDir)) renameSync(nodeDir, `${nodeDir}.old`); // as ensurePrivateNode does
      return privateNode(nodeDir, version);
    },
    npmCi: async (app, usedNode) => record("npmCi", app, usedNode),
    validate: async (app, usedNode) => record("validate", app, usedNode),
    baseline: async (home) => record("baseline", home),
    whatsNew: async (app, usedNode, interactive) => {
      record("whatsNew", app, usedNode, interactive);
      return setup.whatsNew ?? [];
    },
    restart: async () => {
      record("restart");
      return setup.restarted ?? "none";
    },
  };
  const o: UpdateOptions = {
    app: c.app,
    home: c.home,
    check: false,
    restart: true,
    interactive: false,
    userHome: c.userHome,
    log: (s) => logs.push(s),
    record: (patch) => {
      patches.push(patch);
      patchHeads.push(head(c.app));
    },
    ...setup.options,
  };
  return { o, deps, logs, calls, patches, patchHeads, names: () => calls.map((call) => call.name) };
}

test("up to date changes nothing", async () => {
  const c = checkout();
  const before = head(c.app);
  const h = harness(c);

  const result = await update(h.o, h.deps);

  expect(result).toBe("up to date");
  expect(h.logs).toEqual([`japa is up to date (${short(before)})`]);
  expect(h.calls).toEqual([]);
  expect(head(c.app)).toBe(before);
});

test("--check lists incoming commits and changes nothing", async () => {
  const c = checkout();
  const before = head(c.app);
  push(c, "two", { README: "two\n" });
  push(c, "three", { README: "three\n" });
  const h = harness(c, { options: { check: true } });

  const result = await update(h.o, h.deps);

  expect(result).toBe("checked");
  expect(h.logs[0]).toBe("2 new commits");
  expect(h.logs[1]).toContain("two");
  expect(h.logs[1]).toContain("three");
  expect(h.calls).toEqual([]);
  expect(head(c.app)).toBe(before);
});

test("fast-forward updates, skips npm when the lockfile is unchanged, runs whatsNew then restart", async () => {
  const c = checkout();
  const old = head(c.app);
  const target = push(c, "two", { README: "two\n" });
  const h = harness(c);

  const result = await update(h.o, h.deps);

  expect(result).toBe("updated");
  expect(head(c.app)).toBe(target);
  expect(h.names()).toEqual(["validate", "whatsNew", "restart"]);
  expect(h.calls[0].args).toEqual([c.app, "/usr/bin/node"]);
  expect(h.calls[1].args).toEqual([c.app, "/usr/bin/node", false]);
  expect(h.calls[1].head).toBe(target); // what's new runs on the new code
  expect(h.logs).toContain(`${short(old)} → ${short(target)}`);
  expect(h.logs.join("\n")).toContain("two");
});

test("a changed lockfile runs npm ci", async () => {
  const c = checkout();
  push(c, "two", { "package-lock.json": '{ "lockfileVersion": 2 }\n' });
  const h = harness(c);

  await update(h.o, h.deps);

  expect(h.names()).toEqual(["npmCi", "validate", "whatsNew", "restart"]);
  expect(h.calls[0].args).toEqual([c.app, "/usr/bin/node"]);
});

test("diverged history refuses and leaves HEAD", async () => {
  const c = checkout();
  push(c, "two", { README: "upstream\n" });
  const local = commitFiles(c.app, "local", { README: "local\n" });
  const h = harness(c);

  await expect(update(h.o, h.deps)).rejects.toThrow("your checkout has diverged from origin/main; nothing changed");

  expect(head(c.app)).toBe(local);
  expect(h.calls).toEqual([]);
});

test("local edits are stashed and restored", async () => {
  const c = checkout();
  writeFileSync(join(c.app, "README"), "mine\n");
  writeFileSync(join(c.app, "scratch.txt"), "scratch\n");
  const target = push(c, "two", { "package-lock.json": '{ "lockfileVersion": 2 }\n' });
  const h = harness(c);

  await update(h.o, h.deps);

  expect(head(c.app)).toBe(target);
  expect(readFileSync(join(c.app, "README"), "utf8")).toBe("mine\n");
  expect(readFileSync(join(c.app, "scratch.txt"), "utf8")).toBe("scratch\n");
  expect(git(c.app, "stash", "list")).toBe("");
});

test("local edits that conflict stay in the stash", async () => {
  const c = checkout();
  writeFileSync(join(c.app, "README"), "mine\n");
  push(c, "two", { README: "two\n" });
  const h = harness(c);

  await update(h.o, h.deps);

  expect(h.logs).toContain(`your local changes are kept in git stash; run: git -C ${c.app} stash pop`);
  expect(git(c.app, "stash", "list")).toMatch(/japa update \d{4}-\d{2}-\d{2}T[\d:.]+Z/); // dated, per design doc §5.1
});

test("--check leaves a dirty tree alone", async () => {
  const c = checkout();
  writeFileSync(join(c.app, "README"), "mine\n");
  writeFileSync(join(c.app, "scratch.txt"), "scratch\n");
  push(c, "two", { README: "two\n" });
  const h = harness(c, { options: { check: true } });

  await update(h.o, h.deps);

  expect(readFileSync(join(c.app, "README"), "utf8")).toBe("mine\n");
  expect(readFileSync(join(c.app, "scratch.txt"), "utf8")).toBe("scratch\n");
  expect(git(c.app, "stash", "list")).toBe("");
});

test("a failing validate rolls back to the old sha and re-runs npm ci when the lockfile changed", async () => {
  const c = checkout();
  const old = head(c.app);
  writeFileSync(join(c.app, "scratch.txt"), "scratch\n");
  push(c, "two", { "package-lock.json": '{ "lockfileVersion": 2 }\n' });
  const h = harness(c, { fail: "validate" });

  await expect(update(h.o, h.deps)).rejects.toThrow(`update failed at validation: boom; still on ${short(old)}`);

  expect(head(c.app)).toBe(old);
  expect(h.names()).toEqual(["npmCi", "validate", "npmCi"]);
  expect(readFileSync(join(c.app, "package-lock.json"), "utf8")).toBe(FIRST["package-lock.json"]);
  expect(readFileSync(join(c.app, "scratch.txt"), "utf8")).toBe("scratch\n");
  expect(git(c.app, "stash", "list")).toBe("");
});

test("a new version that crashes reports the command and its error, not Node's trailer", async () => {
  const c = checkout();
  const old = head(c.app);
  push(c, "broken", { "src/cli/main.ts": 'throw new Error("broken build");\n' });
  const h = harness(c, { node: process.execPath });
  const { validate: _, ...deps } = h.deps; // the real validate: runs the new main.ts --version

  const error = (await update(h.o, deps).catch((e: unknown) => e)) as Error;

  const [first, ...rest] = error.message.split("\n");
  expect(first).toMatch(/^update failed at validation: \S+ .*src\/cli\/main\.ts --version exited with code 1; still on /);
  expect(first).toContain(`still on ${short(old)}`);
  expect(rest).toContain("Error: broken build");
  expect(error.message).not.toMatch(/Node\.js v\d/);
  expect(error.message).not.toMatch(/^\s+at /m);
  expect(head(c.app)).toBe(old);
});

test("the new code runs with Node's experimental warnings off", async () => {
  const c = checkout();
  const runs = join(c.root, "runs.txt");
  // A main.ts that appends "<node flags> | <args>" to runs.txt each time it runs.
  const main = [
    'import { appendFileSync } from "node:fs";',
    `appendFileSync(${JSON.stringify(runs)}, process.execArgv.join(" ") + " | " + process.argv.slice(2).join(" ") + "\\n");`,
  ].join("\n");
  push(c, "records its runs", { "src/cli/main.ts": main });
  const h = harness(c, { node: process.execPath });
  const { validate: _v, whatsNew: _w, ...deps } = h.deps; // the real ones: run the new main.ts

  await update(h.o, deps);

  expect(readFileSync(runs, "utf8")).toBe(
    "--disable-warning=ExperimentalWarning | --version\n--disable-warning=ExperimentalWarning | setup --whats-new --non-interactive\n",
  );
});

test("a rollback that fails itself keeps the original error and the local edits", async () => {
  const c = checkout();
  const old = head(c.app);
  writeFileSync(join(c.app, "scratch.txt"), "scratch\n");
  push(c, "two", { "package-lock.json": '{ "lockfileVersion": 2 }\n' });
  const h = harness(c, { fail: "npmCi" }); // the rollback's own `npm ci` throws too

  await expect(update(h.o, h.deps)).rejects.toThrow(`update failed at dependencies: boom; still on ${short(old)}`);

  expect(h.names()).toEqual(["npmCi", "npmCi"]);
  expect(head(c.app)).toBe(old);
  expect(readFileSync(join(c.app, "scratch.txt"), "utf8")).toBe("scratch\n");
  expect(git(c.app, "stash", "list")).toBe("");
});

test("--no-restart updates and runs whatsNew without restarting", async () => {
  const c = checkout();
  const target = push(c, "two", { README: "two\n" });
  const h = harness(c, { options: { restart: false }, restarted: "service" });

  await update(h.o, h.deps);

  expect(h.names()).toEqual(["validate", "whatsNew"]);
  expect(head(c.app)).toBe(target);
  expect(h.patches.at(-1)).toMatchObject({ state: "updated", restarted: "none" });
});

test("--branch checks out a branch we don't have yet and leaves the current one alone", async () => {
  const c = checkout();
  const old = head(c.app);
  const target = pushTo(c, "dev", "dev one", { README: "dev\n" });
  const h = harness(c, { options: { branch: "dev" } });

  const result = await update(h.o, h.deps);

  expect(result).toBe("updated");
  expect(git(c.app, "symbolic-ref", "--short", "HEAD")).toBe("dev");
  expect(head(c.app)).toBe(target);
  expect(readFileSync(join(c.app, "README"), "utf8")).toBe("dev\n");
  expect(git(c.app, "rev-parse", "main")).toBe(old);
  expect(h.names()).toEqual(["validate", "whatsNew", "restart"]);
});

test("--branch fast-forwards a local branch that is behind", async () => {
  const c = checkout();
  const old = head(c.app);
  const dev = localDevBehind(c);
  const h = harness(c, { options: { branch: "dev" } });

  await update(h.o, h.deps);

  expect(git(c.app, "symbolic-ref", "--short", "HEAD")).toBe("dev");
  expect(head(c.app)).toBe(dev.origin);
  expect(readFileSync(join(c.app, "README"), "utf8")).toBe("dev two\n");
  expect(git(c.app, "rev-parse", "main")).toBe(old);
});

test("--branch switches to a branch whose code is already current", async () => {
  const c = checkout();
  const old = head(c.app);
  const dev = localDev(c);
  const h = harness(c, { options: { branch: "dev" } });

  const result = await update(h.o, h.deps);

  expect(result).toBe("updated");
  expect(git(c.app, "symbolic-ref", "--short", "HEAD")).toBe("dev");
  expect(head(c.app)).toBe(dev);
  expect(readFileSync(join(c.app, "README"), "utf8")).toBe("dev one\n");
  expect(git(c.app, "rev-parse", "main")).toBe(old);
  expect(h.names()).toEqual(["validate", "whatsNew", "restart"]);
});

test("--check --branch reports the switch and changes nothing", async () => {
  const c = checkout();
  const old = head(c.app);
  const dev = localDev(c);
  const h = harness(c, { options: { branch: "dev", check: true } });

  const result = await update(h.o, h.deps);

  expect(result).toBe("checked");
  expect(h.logs[0]).toBe(`would switch to dev (${short(dev)})`);
  expect(h.logs[1]).toBe("1 new commits");
  expect(h.logs[2]).toContain("dev one");
  expect(git(c.app, "symbolic-ref", "--short", "HEAD")).toBe("main");
  expect(head(c.app)).toBe(old);
  expect(git(c.app, "rev-parse", "dev")).toBe(dev);
  expect(h.calls).toEqual([]);
});

test("a failing validate after switching branches comes back to the original branch", async () => {
  const c = checkout();
  const old = head(c.app);
  const dev = localDevBehind(c);
  const h = harness(c, { options: { branch: "dev" }, fail: "validate" });

  await expect(update(h.o, h.deps)).rejects.toThrow(`update failed at validation: boom; still on ${short(old)}`);

  expect(git(c.app, "symbolic-ref", "--short", "HEAD")).toBe("main");
  expect(head(c.app)).toBe(old);
  expect(git(c.app, "rev-parse", "dev")).toBe(dev.at); // never force-moved, never left at main's sha
  expect(readFileSync(join(c.app, "README"), "utf8")).toBe("one\n");
});

test("--to checks out an older commit", async () => {
  const c = checkout();
  const first = head(c.app);
  push(c, "two", { README: "two\n" });
  git(c.app, "fetch", "-q", "origin", "main");
  git(c.app, "merge", "-q", "--ff-only", "origin/main");
  const h = harness(c, { options: { to: first } });

  const result = await update(h.o, h.deps);

  expect(result).toBe("updated");
  expect(head(c.app)).toBe(first);
  expect(git(c.app, "symbolic-ref", "--short", "HEAD")).toBe("main");
  expect(readFileSync(join(c.app, "README"), "utf8")).toBe("one\n");
  expect(h.names()).toEqual(["validate", "whatsNew", "restart"]);
});

test("offline, --to (a Roll back) goes to a commit the checkout has; --ff-only, no --to or an unknown commit still fail", async () => {
  const c = checkout();
  const first = head(c.app);
  push(c, "two", { README: "two\n" });
  git(c.app, "fetch", "-q", "origin", "main");
  git(c.app, "merge", "-q", "--ff-only", "origin/main");
  const two = head(c.app);
  git(c.app, "remote", "set-url", "origin", join(c.root, "missing.git")); // unreachable
  const unreachable = /^could not fetch origin main: /;

  for (const options of [{ to: first, ffOnly: true }, {}, { to: "f".repeat(40) }]) {
    const failing = harness(c, { options });
    await expect(update(failing.o, failing.deps)).rejects.toThrow(unreachable);
    await expect(update(failing.o, failing.deps)).rejects.toBeInstanceOf(UpdateFailed);
    expect(head(c.app)).toBe(two);
    expect(failing.calls).toEqual([]);
  }

  const h = harness(c, { options: { to: first } });
  expect(await update(h.o, h.deps)).toBe("updated");

  expect(head(c.app)).toBe(first);
  expect(git(c.app, "symbolic-ref", "--short", "HEAD")).toBe("main");
  expect(readFileSync(join(c.app, "README"), "utf8")).toBe("one\n");
  expect(h.logs[0]).toMatch(/^could not fetch origin main: [\s\S]+; rolling back with what's here$/);
  expect(h.names()).toEqual(["validate", "whatsNew", "restart"]);
});

test("--to --ff-only fast-forwards to exactly that commit, not the branch tip", async () => {
  const c = checkout();
  const two = push(c, "two", { README: "two\n" });
  push(c, "three", { README: "three\n" });
  const h = harness(c, { options: { to: two, ffOnly: true } });

  const result = await update(h.o, h.deps);

  expect(result).toBe("updated");
  expect(head(c.app)).toBe(two);
  expect(git(c.app, "symbolic-ref", "--short", "HEAD")).toBe("main");
  expect(readFileSync(join(c.app, "README"), "utf8")).toBe("two\n");
  expect(h.names()).toEqual(["validate", "whatsNew", "restart"]);
});

test("--to --ff-only on diverged history refuses, keeps the local commit and edits", async () => {
  const c = checkout();
  const two = push(c, "two", { README: "upstream\n" });
  const local = commitFiles(c.app, "local", { README: "local\n" });
  writeFileSync(join(c.app, "scratch.txt"), "scratch\n");
  const h = harness(c, { options: { to: two, ffOnly: true } });

  await expect(update(h.o, h.deps)).rejects.toThrow("your checkout has diverged from origin/main; nothing changed");

  expect(head(c.app)).toBe(local);
  expect(git(c.app, "symbolic-ref", "--short", "HEAD")).toBe("main");
  expect(readFileSync(join(c.app, "scratch.txt"), "utf8")).toBe("scratch\n");
  expect(git(c.app, "stash", "list")).toBe("");
  expect(h.calls).toEqual([]);
});

test("checkForUpdate lists incoming commits newest first and changes nothing", async () => {
  const c = checkout();
  const before = head(c.app);
  const two = push(c, "two", { README: "two\n" });
  const three = push(c, "three", { README: "three\n" });

  const check = await checkForUpdate(c.app);

  expect(check).toEqual({ current: before, target: three, commits: [`${short(three)} three`, `${short(two)} two`] });
  expect(head(c.app)).toBe(before);
  expect(git(c.app, "status", "--porcelain")).toBe("");
  expect(git(c.app, "stash", "list")).toBe("");
});

test("commit lines are the short sha and subject, whatever the user's git config decorates or colours", async () => {
  const c = checkout();
  git(c.app, "config", "log.decorate", "short");
  git(c.app, "config", "color.ui", "always");
  const two = push(c, "two", { README: "two\n" });
  const h = harness(c);

  expect((await checkForUpdate(c.app)).commits).toEqual([`${short(two)} two`]);
  await update(h.o, h.deps);
  expect(h.patches.at(-1)?.commits).toEqual([`${short(two)} two`]);
});

test("checkForUpdate on a current checkout lists nothing, and fails as update does", async () => {
  const c = checkout();
  const before = head(c.app);

  expect(await checkForUpdate(c.app)).toEqual({ current: before, target: before, commits: [] });
  await expect(checkForUpdate(c.app, "nope")).rejects.toThrow(/^could not fetch origin nope: /);
  await expect(checkForUpdate(c.app, "nope")).rejects.toBeInstanceOf(UpdateFailed);

  git(c.app, "checkout", "-q", "--detach", "HEAD");
  await expect(checkForUpdate(c.app)).rejects.toThrow(new UpdateFailed("not on a branch"));
});

test("record gets the pid first and the result last: updated, with commits, whatsNew and restarted", async () => {
  const c = checkout();
  const two = push(c, "two", { README: "two\n" });
  const h = harness(c, { restarted: "service", whatsNew: ["new extension: demo"] });

  await update(h.o, h.deps);

  expect(h.patches).toEqual([
    { pid: process.pid },
    {
      state: "updated",
      to: two,
      commits: [`${short(two)} two`],
      whatsNew: ["new extension: demo"],
      restarted: "service",
      finished: expect.any(Number),
    },
  ]);
});

test("record keeps the newest 20 commits", async () => {
  const c = checkout();
  const shas = Array.from({ length: 22 }, (_, i) => push(c, `commit ${i}`, { README: `${i}\n` }));
  const h = harness(c);

  await update(h.o, h.deps);

  const commits = h.patches.at(-1)?.commits ?? [];
  expect(commits).toHaveLength(20);
  expect(commits[0]).toBe(`${short(shas[21])} commit 21`);
  expect(commits[19]).toBe(`${short(shas[2])} commit 2`);
});

test("record gets up to date", async () => {
  const c = checkout();
  const old = head(c.app);
  const h = harness(c);

  await update(h.o, h.deps);

  expect(h.patches).toEqual([{ pid: process.pid }, { state: "up to date", to: old, finished: expect.any(Number) }]);
});

test("record gets each failure with its summary and output, after the rollback", async () => {
  const cases = [
    { fail: "ensureNode", step: "node", files: { ".node-version": "99.9.9\n" } },
    { fail: "npmCi", step: "dependencies", files: { "package-lock.json": '{ "lockfileVersion": 2 }\n' } },
    { fail: "validate", step: "validation", files: { README: "two\n" } },
  ] as const;
  for (const { fail, step, files } of cases) {
    const c = checkout();
    const old = head(c.app);
    // Only a private Node is ours to replace, so only it reaches ensureNode.
    const node = fail === "ensureNode" ? privateNode(layoutOf(c.app, c.userHome).nodeDir!, "old node") : undefined;
    push(c, "two", files);
    const h = harness(c, { node, fail });

    await expect(update(h.o, h.deps), fail).rejects.toThrow(UpdateFailed);

    expect(h.patches, fail).toEqual([
      { pid: process.pid },
      { state: "failed", summary: `update failed at ${step}: boom; still on ${short(old)}`, finished: expect.any(Number) },
    ]);
    expect(h.patchHeads.at(-1), fail).toBe(old); // recorded once the checkout is back
  }

  // A failed command's output goes below its summary.
  const c = checkout();
  const old = head(c.app);
  push(c, "broken", { "src/cli/main.ts": 'throw new Error("broken build");\n' });
  const h = harness(c, { node: process.execPath });
  const { validate: _, ...deps } = h.deps; // the real validate: runs the new main.ts --version

  await expect(update(h.o, deps)).rejects.toThrow(UpdateFailed);

  const failed = h.patches.at(-1)!;
  expect(failed.state).toBe("failed");
  expect(failed.summary).toMatch(/^update failed at validation: \S+ .*src\/cli\/main\.ts --version exited with code 1; still on /);
  expect(failed.summary).not.toContain("\n");
  expect(failed.output?.split("\n")).toContain("Error: broken build");
  expect(h.patchHeads.at(-1)).toBe(old);
});

/** A `record` that keeps the pid and fails to write any result, as a full disk would. */
function failingRecord(h: { patches: Partial<UpdateState>[] }) {
  return (patch: Partial<UpdateState>) => {
    h.patches.push(patch);
    if (patch.state !== undefined) throw new Error("ENOSPC: no space left on device");
  };
}

test("a result that can't be recorded is logged, and the update still succeeds", async () => {
  const c = checkout();
  const two = push(c, "two", { README: "two\n" });
  const h = harness(c);
  h.o.record = failingRecord(h);

  expect(await update(h.o, h.deps)).toBe("updated");

  expect(head(c.app)).toBe(two);
  expect(h.patches.map((p) => p.state)).toEqual([undefined, "updated"]); // never re-recorded as failed
  expect(h.logs).toContain("could not record the update: ENOSPC: no space left on device");

  const current = harness(c);
  current.o.record = failingRecord(current);

  expect(await update(current.o, current.deps)).toBe("up to date");
  expect(current.logs).toContain("could not record the update: ENOSPC: no space left on device");
});

test("a failure that can't be recorded still throws the original reason", async () => {
  const c = checkout();
  const old = head(c.app);
  push(c, "two", { README: "two\n" });
  const h = harness(c, { fail: "validate" });
  h.o.record = failingRecord(h);

  const error = await update(h.o, h.deps).catch((e: unknown) => e);

  expect(error).toBeInstanceOf(UpdateFailed);
  expect((error as Error).message).toBe(`update failed at validation: boom; still on ${short(old)}`);
  expect(h.patches.map((p) => p.state)).toEqual([undefined, "failed"]);
  expect(h.logs).toContain("could not record the update: ENOSPC: no space left on device");
  expect(head(c.app)).toBe(old);
});

test("record gets a refusal and an unexpected error as failures", async () => {
  const diverged = checkout();
  push(diverged, "two", { README: "upstream\n" });
  commitFiles(diverged.app, "local", { README: "local\n" });
  const refused = harness(diverged);

  await expect(update(refused.o, refused.deps)).rejects.toThrow(UpdateFailed);

  expect(refused.patches).toEqual([
    { pid: process.pid },
    { state: "failed", summary: "your checkout has diverged from origin/main; nothing changed", finished: expect.any(Number) },
  ]);

  const c = checkout();
  push(c, "two", { README: "two\n" });
  const h = harness(c, { fail: "restart" });

  await expect(update(h.o, h.deps)).rejects.toThrow("boom");

  expect(h.patches).toEqual([{ pid: process.pid }, { state: "failed", summary: "boom", finished: expect.any(Number) }]);
});

test("record gets the rollback move when --to names the previous commit", async () => {
  const c = checkout();
  const first = head(c.app);
  push(c, "two", { README: "two\n" });
  git(c.app, "fetch", "-q", "origin", "main");
  git(c.app, "merge", "-q", "--ff-only", "origin/main");
  const h = harness(c, { options: { to: first }, restarted: "service" });

  await update(h.o, h.deps);

  expect(h.patches).toEqual([
    { pid: process.pid },
    { state: "updated", to: first, commits: [], whatsNew: [], restarted: "service", finished: expect.any(Number) },
  ]);
});

test("without a terminal, what's new is logged and recorded line by line", async () => {
  const c = checkout();
  const main = 'if (process.argv.includes("--whats-new")) console.log("demo is new\\n\\nrun `japa setup` to configure");\n';
  push(c, "has news", { "src/cli/main.ts": main });
  const h = harness(c, { node: process.execPath });
  const { validate: _v, whatsNew: _w, ...deps } = h.deps; // the real ones: run the new main.ts

  await update(h.o, deps);

  expect(h.logs.slice(0, 2)).toEqual(["demo is new", "run `japa setup` to configure"]);
  expect(h.patches.at(-1)).toMatchObject({ state: "updated", whatsNew: ["demo is new", "run `japa setup` to configure"] });
});

test("in a terminal, what's new talks to the user directly and records nothing", async () => {
  const c = checkout();
  const seen = join(c.root, "stdout.txt");
  // A main.ts that, for --whats-new, writes which file its stdout is (its inode) instead of printing.
  const main = [
    'import { fstatSync, writeFileSync } from "node:fs";',
    `if (process.argv.includes("--whats-new")) writeFileSync(${JSON.stringify(seen)}, String(fstatSync(1).ino));`,
  ].join("\n");
  push(c, "checks its stdout", { "src/cli/main.ts": main });
  const h = harness(c, { node: process.execPath, options: { interactive: true } });
  const { validate: _v, whatsNew: _w, ...deps } = h.deps;

  await update(h.o, deps);

  expect(readFileSync(seen, "utf8")).toBe(String(fstatSync(1).ino)); // our own stdout, inherited
  expect(h.patches.at(-1)).toMatchObject({ state: "updated", whatsNew: [] });
});

test("a changed .node-version on a private Node downloads it and rewrites the launcher", async () => {
  const c = checkout();
  const layout = layoutOf(c.app, c.userHome);
  const nodeDir = layout.nodeDir!;
  const node = privateNode(nodeDir, "old node");
  writeLauncher(layout, "/old/bin/node");
  push(c, "two", { ".node-version": "99.9.9\n" });
  const h = harness(c, { node });

  await update(h.o, h.deps);

  expect(h.names()).toEqual(["ensureNode", "validate", "whatsNew", "restart"]);
  expect(h.calls[0].args).toEqual(["99.9.9", nodeDir]);
  expect(h.calls[1].args).toEqual([c.app, node]);
  expect(readFileSync(node, "utf8")).toBe("99.9.9");
  expect(existsSync(`${nodeDir}.old`)).toBe(false); // dropped once the new code validated
  expect(readFileSync(layout.launcher, "utf8")).toBe(launcherText(node, c.app));
});

test("a failing validate puts the old Node and launcher back", async () => {
  const c = checkout();
  const old = head(c.app);
  const layout = layoutOf(c.app, c.userHome);
  const nodeDir = layout.nodeDir!;
  const node = privateNode(nodeDir, "old node");
  writeLauncher(layout, "/old/bin/node");
  push(c, "two", { ".node-version": "99.9.9\n" });
  const h = harness(c, { node, fail: "validate" });

  await expect(update(h.o, h.deps)).rejects.toThrow(`update failed at validation: boom; still on ${short(old)}`);

  expect(head(c.app)).toBe(old);
  expect(readFileSync(node, "utf8")).toBe("old node");
  expect(existsSync(`${nodeDir}.old`)).toBe(false);
  expect(readFileSync(layout.launcher, "utf8")).toBe(launcherText("/old/bin/node", c.app));
});

test("a dev checkout updates its own branch and writes no launcher", async () => {
  const c = checkout({ where: join("projects", "japa"), branch: "dev" });
  const target = push(c, "two", { ".node-version": "99.9.9\n", README: "two\n" });
  const h = harness(c);

  const result = await update(h.o, h.deps);

  expect(result).toBe("updated");
  expect(head(c.app)).toBe(target);
  expect(git(c.app, "symbolic-ref", "--short", "HEAD")).toBe("dev");
  expect(h.names()).toEqual(["validate", "whatsNew", "restart"]);
  expect(existsSync(layoutOf(c.app, c.userHome).launcher)).toBe(false);
});

test("a home without setup.json gets the old manifests as baseline", async () => {
  const c = checkout({ setupJson: false });
  const old = head(c.app);
  const target = push(c, "two", { README: "two\n" });
  const h = harness(c);

  await update(h.o, h.deps);

  expect(h.names()).toEqual(["baseline", "validate", "whatsNew", "restart"]);
  expect(h.calls[0].args).toEqual([c.home]);
  expect(h.calls[0].head).toBe(old); // the pre-update manifests are what gets recorded
  expect(head(c.app)).toBe(target);
});

test("a no-op update writes no baseline", async () => {
  const c = checkout({ setupJson: false });
  const uptodate = harness(c);

  expect(await update(uptodate.o, uptodate.deps)).toBe("up to date");
  expect(uptodate.names()).toEqual([]);

  push(c, "two", { README: "two\n" });
  const checked = harness(c, { options: { check: true } });

  expect(await update(checked.o, checked.deps)).toBe("checked");
  expect(checked.names()).toEqual([]);
  expect(existsSync(join(c.home, "setup.json"))).toBe(false);
});

test("a detached HEAD is refused", async () => {
  const c = checkout();
  git(c.app, "checkout", "-q", "--detach", "HEAD");
  const h = harness(c);

  await expect(update(h.o, h.deps)).rejects.toThrow("not on a branch");
});

/** A Linux `ServiceEnv` whose `systemctl --user is-active japa` answers `state`, with the unit installed unless
 * `state` is "not installed"; `calls` records every command. */
function service(state: "active" | "activating" | "failed" | "inactive" | "not installed") {
  const calls: string[] = [];
  const exec: Exec = async (cmd, args) => {
    calls.push([cmd, ...args].join(" "));
    return { code: 0, stdout: args.includes("is-active") ? `${state}\n` : "", stderr: "" };
  };
  const env: ServiceEnv = {
    platform: "linux",
    userHome: tmp(),
    configHome: tmp(),
    command: ["/home/x/.local/bin/japa", "daemon"],
    japaHome: tmp(),
    customHome: false,
    path: "/usr/bin",
    user: "alice",
    uid: 1000,
    exec,
  };
  if (state !== "not installed") {
    mkdirSync(dirname(unitPath(env)), { recursive: true });
    writeFileSync(unitPath(env), "placeholder");
  }
  return { env, calls };
}

test("a running service is restarted", async () => {
  const { env, calls } = service("active");
  const logs: string[] = [];

  expect(await restartAfterUpdate(env, tmp(), (s) => logs.push(s), 50)).toBe("service");

  expect(calls).toContain("systemctl --user restart japa");
  expect(logs).toEqual(["japa didn't answer within 30 s; see: japa service logs"]); // nothing listens in this test
});

test("a stopped service is left stopped", async () => {
  const { env, calls } = service("inactive");
  const logs: string[] = [];

  expect(await restartAfterUpdate(env, tmp(), (s) => logs.push(s), 50)).toBe("stopped");

  expect(calls).not.toContain("systemctl --user restart japa");
  expect(logs).toEqual(["japa's service is stopped, so it was left stopped; start it with: japa service start"]);
});

test("a crash-looping or failed service is restarted, not reported as stopped", async () => {
  for (const state of ["activating", "failed"] as const) {
    const { env, calls } = service(state);
    const logs: string[] = [];

    expect(await restartAfterUpdate(env, tmp(), (s) => logs.push(s), 50), state).toBe("service");

    expect(calls, state).toContain("systemctl --user restart japa");
    expect(logs, state).toEqual(["japa didn't answer within 30 s; see: japa service logs"]); // nothing listens in this test
  }
});

test("a foreground daemon is told about, never restarted", async () => {
  // A service failing beside it (it holds daemon.lock) isn't restarted either.
  for (const state of ["inactive", "failed"] as const) {
    const { env, calls } = service(state);
    const home = tmp();
    writeFileSync(join(home, "daemon.lock"), String(process.pid));
    const logs: string[] = [];

    expect(await restartAfterUpdate(env, home, (s) => logs.push(s), 50), state).toBe("foreground");

    expect(calls, state).not.toContain("systemctl --user restart japa");
    expect(logs, state).toEqual(["restart `japa daemon` to apply"]);
  }
});

test("no service and no daemon: nothing to restart", async () => {
  const { env, calls } = service("not installed");
  const logs: string[] = [];

  expect(await restartAfterUpdate(env, tmp(), (s) => logs.push(s), 50)).toBe("none");

  expect(calls).toEqual([]);
  expect(logs).toEqual([]);
});
