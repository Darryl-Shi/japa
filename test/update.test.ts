import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { launcherText, layoutOf, writeLauncher } from "../src/cli/layout.ts";
import { update, type UpdateDeps, type UpdateOptions } from "../src/cli/update.ts";

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
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
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

type Call = { name: string; args: unknown[]; head: string };

/** A private Node dir whose `bin/node` holds `text`, as `ensurePrivateNode` leaves it; the binary's path. */
function privateNode(nodeDir: string, text: string): string {
  mkdirSync(join(nodeDir, "bin"), { recursive: true });
  writeFileSync(join(nodeDir, "bin", "node"), text);
  return join(nodeDir, "bin", "node");
}

/** `update`'s options and recording stub deps over `c`; `fail` makes that one step throw. */
function harness(
  c: Checkout,
  setup: { options?: Partial<UpdateOptions>; node?: string; fail?: "ensureNode" | "npmCi" | "validate" } = {},
) {
  const logs: string[] = [];
  const calls: Call[] = [];
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
    whatsNew: async (app, usedNode, interactive) => record("whatsNew", app, usedNode, interactive),
    restart: async () => record("restart"),
  };
  const o: UpdateOptions = {
    app: c.app,
    home: c.home,
    check: false,
    restart: true,
    interactive: false,
    userHome: c.userHome,
    log: (s) => logs.push(s),
    ...setup.options,
  };
  return { o, deps, logs, calls, names: () => calls.map((call) => call.name) };
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
  expect(git(c.app, "stash", "list")).toContain("japa update");
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

test("a detached HEAD is refused", async () => {
  const c = checkout();
  git(c.app, "checkout", "-q", "--detach", "HEAD");
  const h = harness(c);

  await expect(update(h.o, h.deps)).rejects.toThrow("not on a branch");
});
