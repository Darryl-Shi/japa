// `japa update`: fast-forwards this checkout, updates its private Node and dependencies, validates the new code,
// and restarts japa -- rolling all of it back when the new code doesn't run (design doc §5).
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join, sep } from "node:path";
import { patchUpdateState, type Restarted, type UpdateCheck, type UpdateState } from "../kernel/update-state.ts";
import { markOffered } from "./configure.ts";
import { openSetupContext } from "./context.ts";
import { foregroundPid, waitForDaemon } from "./daemon.ts";
import { exec, type ExecResult } from "./exec.ts";
import { APP, launcherPointsAt, layoutOf, writeLauncher } from "./layout.ts";
import { dropOldNode, ensurePrivateNode, major, restoreNode } from "./node.ts";
import { restartService, serviceEnv, type ServiceEnv, serviceState } from "./service.ts";

export type UpdateOptions = {
  app: string;
  home: string;
  /** Defaults to the checkout's current branch. */
  branch?: string;
  to?: string;
  /** With `to`: only fast-forward to it, refusing on diverged history as a plain update does (a chat-started update;
   * without it `to` moves the branch there, which is how a Roll back goes back). */
  ffOnly?: boolean;
  check: boolean;
  restart: boolean;
  interactive: boolean;
  userHome?: string;
  log: (s: string) => void;
  /** Gets the run's progress for `update.json` (`--from-chat`): its pid first, then how it ended. */
  record?: (patch: Partial<UpdateState>) => void;
};

export type UpdateDeps = {
  /** The Node in use (`process.execPath`). */
  node: string;
  ensureNode(version: string, nodeDir: string): Promise<string>;
  npmCi(app: string, node: string): Promise<void>;
  validate(app: string, node: string): Promise<void>;
  baseline(home: string): Promise<void>;
  /** What's new in the new code: shown in a terminal (nothing returned), otherwise logged and returned line by line. */
  whatsNew(app: string, node: string, interactive: boolean): Promise<string[]>;
  restart(log: (s: string) => void): Promise<Restarted>;
};

/** An update that stopped with a user-facing reason; everything it had changed is already rolled back. */
export class UpdateFailed extends Error {}

/** `git stash` writes commits, so it needs an identity: an install's user may have no git config at all. */
const GIT_CONFIG = ["-c", "user.name=japa", "-c", "user.email=japa@localhost", "-c", "commit.gpgsign=false"];

/** As the launcher runs japa: without Node's "SQLite is an experimental feature" warning on every run. */
const NO_WARNINGS = "--disable-warning=ExperimentalWarning";

const short = (sha: string) => sha.slice(0, 7);
/** Runs git in `app`, with the identity `git stash` needs. */
const gitIn =
  (app: string) =>
  (...args: string[]) =>
    exec("git", ["-C", app, ...GIT_CONFIG, ...args]);
/** Non-empty lines of `text`. */
const linesOf = (text: string) => text.split("\n").filter((line) => line.trim() !== "");
const bare = (version: string) => (version.startsWith("v") ? version.slice(1) : version);
const under = (path: string, dir: string) => path.startsWith(`${dir}${sep}`);

/** Output lines that tell the user nothing: blanks (npm's bare "npm error" too), stack frames, Node's "Node.js v24.x"
 * trailer and npm's "A complete log of this run..." pointer. */
const NOISE = [/^\s*(npm error|npm ERR!)?\s*$/, /^\s+at /, /^Node\.js v\d/, /A complete log of this run/];

/** The last 10 lines of a failed command's stderr (its stdout when stderr is empty) that say something: git, Node
 * and npm put the reason last. "" when there are none. */
function output(r: ExecResult): string {
  const text = r.stderr.trim() === "" ? r.stdout : r.stderr;
  const lines = text.split("\n").map((line) => line.trimEnd());
  return lines
    .filter((line) => !NOISE.some((noise) => noise.test(line)))
    .slice(-10)
    .join("\n");
}

/** Why a command failed, for a message that already names it. */
function reason(r: ExecResult): string {
  return output(r) || `exit code ${r.code}`;
}

/** A failed command for the user (design doc §9): its command line and exit code, then what it said. */
function commandFailed(cmd: string, args: string[], r: ExecResult): Error {
  const said = output(r);
  return new Error(`${[cmd, ...args].join(" ")} exited with code ${r.code}${said === "" ? "" : `\n${said}`}`);
}

/** `<app>/.node-version`, or undefined when the checkout has none. */
function nodeVersion(app: string): string | undefined {
  let text: string;
  try {
    text = readFileSync(join(app, ".node-version"), "utf8");
  } catch {
    return undefined;
  }
  return text.trim() === "" ? undefined : text.trim();
}

/**
 * Whether the private Node has to be downloaded (design doc §5.1 step 4): the new `.node-version` differs from the
 * Node in use and that Node is ours to replace, or the Node in use is older than what the new code wants.
 */
function needsNode(version: string, node: string, nodeDir: string): boolean {
  if (bare(version) !== bare(process.version) && under(node, nodeDir)) return true;
  return major(process.version) < major(version);
}

function defaultDeps(o: UpdateOptions): UpdateDeps {
  return {
    node: process.execPath,
    ensureNode: (version, nodeDir) => ensurePrivateNode(version, nodeDir),
    npmCi: async (app, node) => {
      const env = { ...process.env, PATH: `${dirname(node)}${delimiter}${process.env.PATH ?? ""}` };
      const r = await exec("npm", ["ci"], { cwd: app, env });
      if (r.code !== 0) throw commandFailed("npm", ["ci"], r);
    },
    validate: async (app, node) => {
      const args = [NO_WARNINGS, join(app, "src/cli/main.ts"), "--version"];
      const r = await exec(node, args);
      if (r.code !== 0) throw commandFailed(node, args, r);
    },
    baseline: async (home) => markOffered(home, (await openSetupContext(home)).extensions),
    whatsNew: async (app, node, interactive) => {
      const args = [NO_WARNINGS, join(app, "src/cli/main.ts"), "setup", "--whats-new"];
      if (interactive) {
        await exec(node, args, { stdio: "inherit" });
        return [];
      }
      args.push("--non-interactive");
      const r = await exec(node, args);
      const lines = linesOf(r.stdout);
      for (const line of lines) o.log(line);
      if (r.code !== 0) o.log(`could not list what's new: ${reason(r)}`);
      return lines;
    },
    restart: (log) => restartAfterUpdate(serviceEnv(layoutOf(o.app, o.userHome)), o.home, log),
  };
}

/**
 * Step 8 (design doc §5.1): restarts the service when it's running or failing and waits for it to answer. A service
 * the user stopped stays stopped, and a foreground `japa daemon` is never killed -- both are only told about.
 * Returns which way it went.
 */
export async function restartAfterUpdate(
  env: ServiceEnv,
  home: string,
  log: (s: string) => void,
  waitMs?: number,
): Promise<Restarted> {
  const state = await serviceState(env);
  const foreground = state !== "active" && foregroundPid(home) !== undefined;
  if (state === "active" || (state === "failed" && !foreground)) {
    await restartService(env);
    if ((await waitForDaemon(home, waitMs)) === undefined) log("japa didn't answer within 30 s; see: japa service logs");
    return "service";
  }
  if (foreground) {
    log("restart `japa daemon` to apply");
    return "foreground";
  }
  if (state === "inactive") {
    log("japa's service is stopped, so it was left stopped; start it with: japa service start");
    return "stopped";
  }
  return "none";
}

/**
 * The commits `old..target` brings, newest first, as `<short sha> <subject>`; the newest `max` of them. Not
 * `--oneline`, which follows the user's git config (decorations, colours).
 */
async function commitsBetween(app: string, old: string, target: string, max?: number): Promise<string[]> {
  const limit = max === undefined ? [] : [`-${max}`];
  return linesOf((await gitIn(app)("log", "--format=%h %s", ...limit, `${old}..${target}`)).stdout);
}

/**
 * Steps 1-2 (design doc §5.1): the branch to stand on and the sha to come back to, then a fetch of origin's `branch`
 * (by default the current one) and the target commit -- `to`, or origin's tip. Changes nothing else.
 */
async function locate(app: string, branch?: string, to?: string) {
  const git = gitIn(app);
  const branchRef = await git("symbolic-ref", "--short", "HEAD");
  if (branchRef.code !== 0) throw new UpdateFailed("not on a branch");
  const original = branchRef.stdout.trim();
  const on = branch ?? original;
  const old = (await git("rev-parse", "HEAD")).stdout.trim();

  const fetched = await git("fetch", "origin", on);
  if (fetched.code !== 0) throw new UpdateFailed(`could not fetch origin ${on}: ${reason(fetched)}`);
  const wanted = to ?? `origin/${on}`;
  const resolved = await git("rev-parse", "--verify", `${wanted}^{commit}`);
  if (resolved.code !== 0) throw new UpdateFailed(`no such commit: ${wanted}`);
  return { original, branch: on, old, target: resolved.stdout.trim() };
}

/** What `japa update` would bring in (design doc §4.3): fetches origin's `branch` and lists its new commits, changing
 * nothing else. Throws `UpdateFailed` as `update` does. */
export async function checkForUpdate(app: string, branch?: string): Promise<UpdateCheck> {
  const { old, target } = await locate(app, branch);
  return { current: old, target, commits: await commitsBetween(app, old, target) };
}

/**
 * Updates the checkout at `o.app` (design doc §5.1). Throws `UpdateFailed` with the reason; nothing is left half-done.
 * `o.record` gets the pid first and how the run ended last -- a failure once everything is put back.
 */
export async function update(o: UpdateOptions, overrides: Partial<UpdateDeps> = {}): Promise<"up to date" | "checked" | "updated"> {
  // Nothing has changed yet, so a pid that can't be recorded may stop the run.
  o.record?.({ pid: process.pid });
  /** Records the run's result. A write that fails is only logged: the outcome (or the reason it failed) wins. */
  const note = (patch: Partial<UpdateState>) => {
    try {
      o.record?.(patch);
    } catch (error) {
      o.log(`could not record the update: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  try {
    return await updateCheckout(o, overrides, note);
  } catch (error) {
    const [summary, ...said] = (error instanceof Error ? error.message : String(error)).split("\n");
    note({ state: "failed", summary, output: said.length === 0 ? undefined : said.join("\n"), finished: Date.now() });
    throw error;
  }
}

async function updateCheckout(
  o: UpdateOptions,
  overrides: Partial<UpdateDeps>,
  note: (patch: Partial<UpdateState>) => void,
): Promise<"up to date" | "checked" | "updated"> {
  const deps = { ...defaultDeps(o), ...overrides };
  const layout = layoutOf(o.app, o.userHome);
  const git = gitIn(o.app);
  const out = async (...args: string[]) => (await git(...args)).stdout.trim();

  /** A step that must not fail the thing it is trying to repair: its failure is logged and swallowed. */
  const attempt = async (what: string, run: () => unknown): Promise<void> => {
    try {
      await run();
    } catch (error) {
      o.log(`could not ${what}: ${(error as Error).message}`);
    }
  };
  /** `git`, but a non-zero exit throws, so `attempt` can report it. */
  const mustGit = async (...args: string[]) => {
    const r = await git(...args);
    if (r.code !== 0) throw new Error(reason(r));
  };
  /** Where the checkout stands, for a message that must not claim more than is known. */
  const describe = async () => {
    const sha = await out("rev-parse", "--short", "HEAD");
    const on = await out("symbolic-ref", "--short", "HEAD");
    if (sha === "") return "in an unknown state";
    return on === "" ? `on a detached HEAD at ${sha}` : `on ${on} at ${sha}`;
  };

  // 1-2. Preflight (a branch to stand on and the sha to come back to), fetch, and pick the target commit.
  const { original, branch, old, target } = await locate(o.app, o.branch, o.to);
  /** `--branch` naming another branch asks to stand on it, which an update always does -- even if its code is current. */
  const switched = branch !== original;

  // Up to date means standing on the target branch at the target commit: a `--branch` elsewhere is still a move.
  if (!switched && target === old) {
    o.log(`japa is up to date (${short(old)})`);
    note({ state: "up to date", to: old, finished: Date.now() });
    return "up to date";
  }
  if (o.check) {
    if (switched) o.log(`would switch to ${branch} (${short(target)})`);
    const incoming = await commitsBetween(o.app, old, target);
    o.log(`${incoming.length} new commits`);
    if (incoming.length > 0) o.log(incoming.join("\n"));
    return "checked";
  }

  // 3. Apply. Nothing above this line touches anything, so the baseline and the stash wait until a change is certain.
  if (!existsSync(join(o.home, "setup.json"))) await deps.baseline(o.home);

  let stashed = false;
  if ((await out("status", "--porcelain")) !== "") {
    const pushed = await git("stash", "push", "-u", "-m", `japa update ${new Date().toISOString()}`);
    if (pushed.code !== 0) throw new UpdateFailed(`could not stash your local changes: ${reason(pushed)}`);
    stashed = true;
  }
  const popStash = async () => {
    if (!stashed) return;
    stashed = false;
    if ((await git("stash", "pop")).code !== 0) {
      o.log(`your local changes are kept in git stash; run: git -C ${o.app} stash pop`);
    }
  };

  /** Where the branch we are updating stands now; undefined when `--branch` names one we don't have yet. */
  const localBranch = await git("rev-parse", "--verify", `refs/heads/${branch}`);
  const tip = localBranch.code === 0 ? localBranch.stdout.trim() : undefined;

  // One we don't have yet is created tracking origin; an existing one is only ever fast-forwarded by the apply
  // below -- never force-moved to where we came from.
  if (switched) {
    const stand = tip === undefined ? ["checkout", "-b", branch, "--track", `origin/${branch}`] : ["checkout", branch];
    const moved = await git(...stand);
    if (moved.code !== 0) {
      await popStash();
      throw new UpdateFailed(`could not check out ${branch}: ${reason(moved)}`);
    }
  }
  /** Undoes the branch switch: `branch` back where it stood (or gone, if we made it) and HEAD on the original. */
  const returnToOriginal = async () => {
    if (!switched) return;
    if (tip !== undefined) await attempt(`put ${branch} back`, () => mustGit("reset", "--hard", tip));
    await attempt(`check out ${original}`, () => mustGit("checkout", "--force", original));
    if (tip === undefined) await attempt(`delete ${branch}`, () => mustGit("branch", "-D", branch));
  };

  // Only `--to` without `--ff-only` (a Roll back) may move the branch anywhere but forward.
  const fastForward = o.to === undefined || o.ffOnly === true;
  const apply = fastForward ? await git("merge", "--ff-only", target) : await git("checkout", "-B", branch, target);
  if (apply.code !== 0) {
    await returnToOriginal();
    await popStash();
    const why = fastForward
      ? `your checkout has diverged from origin/${branch}; nothing changed`
      : `could not check out ${o.to}: ${reason(apply)}`;
    throw new UpdateFailed(why);
  }

  // 4-6. The new code's Node and dependencies, then prove it runs; any failure puts all three back.
  const lockChanged = (await out("diff", "--name-only", old, target, "--", "package-lock.json")) !== "";
  let step: "node" | "dependencies" | "validation" = "node";
  let node = deps.node;
  let replacedNode: string | undefined;
  let launcherBefore: string | undefined;

  /** Puts everything back. No step may throw: the failure that caused the rollback is the one the user needs. */
  const rollback = async (): Promise<string> => {
    await returnToOriginal();
    await attempt(`reset ${original} to ${short(old)}`, () => mustGit("reset", "--hard", old));
    const nodeDir = replacedNode;
    if (nodeDir !== undefined) await attempt("restore the previous node", () => restoreNode(nodeDir));
    const launcher = launcherBefore;
    if (launcher !== undefined) await attempt("restore the launcher", () => writeFileSync(layout.launcher, launcher));
    if (lockChanged) await attempt("reinstall the dependencies", () => deps.npmCi(o.app, deps.node));
    const back = (await out("rev-parse", "HEAD")) === old && (await out("symbolic-ref", "--short", "HEAD")) === original;
    return back ? `still on ${short(old)}` : `rollback failed, the checkout is ${await describe()}`;
  };

  try {
    const version = nodeVersion(o.app);
    if (layout.nodeDir !== undefined && version !== undefined && needsNode(version, deps.node, layout.nodeDir)) {
      node = await deps.ensureNode(version, layout.nodeDir);
      replacedNode = layout.nodeDir;
      if (launcherPointsAt(layout)) {
        launcherBefore = readFileSync(layout.launcher, "utf8");
        writeLauncher(layout, node);
      }
    }
    step = "dependencies";
    if (lockChanged) await deps.npmCi(o.app, node);
    step = "validation";
    await deps.validate(o.app, node);
  } catch (error) {
    let where = "the checkout may be half-updated";
    try {
      where = await rollback();
    } finally {
      await popStash();
    }
    // A failed command's output follows its one-line summary, below the verdict.
    const [summary, ...said] = (error as Error).message.split("\n");
    throw new UpdateFailed([`update failed at ${step}: ${summary}; ${where}`, ...said].join("\n"));
  }
  if (replacedNode !== undefined) dropOldNode(replacedNode);

  // 7-9. What's new in the new code, one restart for code and configuration, then the report.
  let whatsNew: string[];
  let restarted: Restarted = "none";
  try {
    whatsNew = await deps.whatsNew(o.app, node, o.interactive);
    if (o.restart) restarted = await deps.restart(o.log);
  } finally {
    await popStash();
  }
  o.log(`${short(old)} → ${short(target)}`);
  const commits = await commitsBetween(o.app, old, target, 20);
  if (commits.length > 0) o.log(commits.join("\n"));
  note({ state: "updated", to: target, commits, whatsNew, restarted, finished: Date.now() });
  return "updated";
}

/** The value after `name`, or undefined when it isn't given. */
function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
}

/**
 * The `japa update [--check] [--branch <b>] [--to <sha>] [--no-restart]` CLI. Two hidden flags serve a chat-started
 * update (design doc §4.4): `--ff-only` (with `--to`) refuses to move the branch anywhere but forward, and
 * `--from-chat` runs without prompts and records the run in `update.json`.
 */
export async function updateCommand(home: string, args: string[]): Promise<void> {
  const fromChat = args.includes("--from-chat");
  try {
    await update({
      app: APP,
      home,
      branch: flag(args, "--branch"),
      to: flag(args, "--to"),
      ffOnly: args.includes("--ff-only"),
      check: args.includes("--check"),
      restart: !args.includes("--no-restart"),
      interactive: !fromChat && process.stdin.isTTY === true,
      log: (s) => console.log(s),
      record: fromChat ? (patch) => patchUpdateState(home, patch) : undefined,
    });
  } catch (error) {
    if (!(error instanceof UpdateFailed)) throw error;
    console.error(error.message);
    process.exitCode = 1;
  }
}
