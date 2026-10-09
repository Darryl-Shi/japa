import type { ChildProcess, SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, fstatSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import type { Exec } from "../src/cli/exec.ts";
import { type ServiceEnv, unitPath } from "../src/cli/service.ts";
import { chatUpdater, launchPlan } from "../src/cli/update-launch.ts";
import { CONTRACTS, type MessagingContext } from "../src/kernel/contracts.ts";
import { readUpdateState, type Updater, updateLog, writeUpdateState } from "../src/kernel/update-state.ts";
import { bootTest, probe, testKit } from "./helpers.ts";

const tmp = () => mkdtempSync(join(tmpdir(), "japa-update-launch-"));

const FROM = "a".repeat(40);
const TO = "b".repeat(40);
const CHAT = { adapter: "telegram", chat: "42" };

afterEach(() => {
  vi.restoreAllMocks();
});

/** `launchPlan`'s input for a Linux host whose service is active; `overrides` change it. */
const plan = (overrides: Partial<Parameters<typeof launchPlan>[0]> = {}) =>
  launchPlan({
    platform: "linux",
    serviceActive: true,
    node: "/opt/japa/node/bin/node",
    app: "/opt/japa/app",
    home: "/home/x/.japa",
    customHome: false,
    path: "/usr/bin:/bin",
    to: TO,
    rollback: false,
    now: 1_700_000_000_000,
    ...overrides,
  });

/** The `japa update` command line every plan runs: fast-forward only unless it's a Roll back. */
const UPDATE = ["/opt/japa/node/bin/node", "--disable-warning=ExperimentalWarning", "/opt/japa/app/src/cli/main.ts", "update", "--to", TO, "--from-chat"];

test("with the systemd service active, the update runs as its own transient unit, logging to update.log", () => {
  expect(plan()).toEqual({
    cmd: "systemd-run",
    args: [
      "--user",
      "--collect",
      "--unit",
      "japa-update-1700000000000",
      "--setenv=PATH=/usr/bin:/bin",
      "--property=StandardOutput=append:/home/x/.japa/logs/update.log",
      "--property=StandardError=append:/home/x/.japa/logs/update.log",
      ...UPDATE,
      "--ff-only",
    ],
    detached: false,
  });
});

test("JAPA_HOME is passed only for a custom home", () => {
  expect(plan().args.some((arg) => arg.includes("JAPA_HOME"))).toBe(false);
  const custom = plan({ customHome: true }).args;
  expect(custom.slice(4, 6)).toEqual(["--setenv=PATH=/usr/bin:/bin", "--setenv=JAPA_HOME=/home/x/.japa"]);
});

test("on macOS, or without the service, the update is a detached process", () => {
  const detached = { cmd: "/opt/japa/node/bin/node", args: [...UPDATE.slice(1), "--ff-only"], detached: true };
  expect(plan({ platform: "darwin" })).toEqual(detached);
  expect(plan({ serviceActive: false })).toEqual(detached);
});

test("a Roll back may move the branch back: it isn't fast-forward only", () => {
  expect(plan({ rollback: true }).args.slice(-UPDATE.length)).toEqual(UPDATE);
  expect(plan({ rollback: true, serviceActive: false }).args).toEqual(UPDATE.slice(1));
});

/** A Linux `ServiceEnv` with the unit installed whose `systemctl --user is-active japa` answers `state`, and whose other
 * commands answer `answer`; `calls` records them. */
function service(state: "active" | "inactive", answer: { code: number; stderr: string } = { code: 0, stderr: "" }) {
  const calls: { cmd: string; args: string[] }[] = [];
  const exec: Exec = async (cmd, args) => {
    calls.push({ cmd, args });
    if (args.includes("is-active")) return { code: 0, stdout: `${state}\n`, stderr: "" };
    return { ...answer, stdout: "" };
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
    exec,
  };
  mkdirSync(dirname(unitPath(env)), { recursive: true });
  writeFileSync(unitPath(env), "placeholder");
  return { env, calls };
}

/** A fake `spawn` whose child emits `event` ("spawn", or "error" with `error`); `calls` records each spawn. */
function fakeSpawn(event: "spawn" | "error" = "spawn", error = new Error("spawn node ENOENT")) {
  const calls: { cmd: string; args: string[]; options: SpawnOptions; unrefed: boolean }[] = [];
  const spawn = (cmd: string, args: string[], options: SpawnOptions) => {
    const call = { cmd, args, options, unrefed: false };
    calls.push(call);
    const child = Object.assign(new EventEmitter(), { unref: () => void (call.unrefed = true) });
    setImmediate(() => (event === "spawn" ? child.emit("spawn") : child.emit("error", error)));
    return child as unknown as ChildProcess;
  };
  return { spawn, calls };
}

/** A japa home whose update.log holds the previous run's output. */
function homeWithLog(): string {
  const home = tmp();
  mkdirSync(dirname(updateLog(home)), { recursive: true });
  writeFileSync(updateLog(home), "the previous run\n");
  return home;
}

test("with the service active, launch starts the update with systemd-run, on a fresh update.log", async () => {
  const home = homeWithLog();
  const { env, calls } = service("active");
  const { spawn, calls: spawned } = fakeSpawn();

  await chatUpdater("/opt/japa/app", home, { env, spawn }).launch(TO, false);

  const run = calls.find((c) => c.cmd === "systemd-run")!;
  expect(run.args).toContain(`--property=StandardOutput=append:${updateLog(home)}`);
  expect(run.args.slice(-8)).toEqual([process.execPath, ...UPDATE.slice(1), "--ff-only"]);
  expect(spawned).toEqual([]);
  expect(readFileSync(updateLog(home), "utf8")).toBe("");
});

test("a systemd-run that fails is an error with what it said", async () => {
  const { env } = service("active", { code: 1, stderr: "Failed to start transient service unit: Access denied\n" });

  await expect(chatUpdater("/opt/japa/app", tmp(), { env, spawn: fakeSpawn().spawn }).launch(TO, false)).rejects.toThrow(
    "systemd-run exited with code 1: Failed to start transient service unit: Access denied",
  );
});

test("without the service, launch spawns the update detached, its output appended to update.log", async () => {
  const home = tmp();
  const { env, calls } = service("inactive");
  const { spawn, calls: spawned } = fakeSpawn();

  await chatUpdater("/opt/japa/app", home, { env, spawn }).launch(TO, true);

  expect(calls.some((c) => c.cmd === "systemd-run")).toBe(false);
  expect(spawned).toHaveLength(1);
  const [{ cmd, args, options, unrefed }] = spawned;
  expect(cmd).toBe(process.execPath);
  expect(args).toEqual(UPDATE.slice(1));
  expect(options.detached).toBe(true);
  const [stdin, stdout, stderr] = options.stdio as [string, number, number];
  expect(stdin).toBe("ignore");
  expect(typeof stdout).toBe("number");
  expect(stderr).toBe(stdout);
  expect(unrefed).toBe(true);
  // The log exists (with its directory), and the daemon's copy of its descriptor is closed.
  expect(existsSync(updateLog(home))).toBe(true);
  expect(() => fstatSync(stdout)).toThrow();
});

test("an update that can't be spawned is an error", async () => {
  const { env } = service("inactive");
  const { spawn } = fakeSpawn("error", new Error("spawn /gone/node ENOENT"));

  await expect(chatUpdater("/opt/japa/app", tmp(), { env, spawn }).launch(TO, false)).rejects.toThrow("spawn /gone/node ENOENT");
});

test("current is the checkout's commit, from git without fetching", async () => {
  const { env } = service("inactive");
  const calls: { cmd: string; args: string[] }[] = [];
  const answers = [{ code: 0, stdout: `${FROM}\n`, stderr: "" }, { code: 128, stdout: "", stderr: "fatal: not a git repository\n" }];
  env.exec = async (cmd, args) => {
    calls.push({ cmd, args });
    return answers.shift()!;
  };
  const updater = chatUpdater("/opt/japa/app", tmp(), { env, spawn: fakeSpawn().spawn });

  expect(await updater.current()).toBe(FROM);
  await expect(updater.current()).rejects.toThrow("git rev-parse HEAD exited with code 128: fatal: not a git repository");

  expect(calls).toEqual([1, 2].map(() => ({ cmd: "git", args: ["-C", "/opt/japa/app", "rev-parse", "HEAD"] })));
});

/** A fake `Updater`: `check` finds one new commit, `current` is FROM; `launch` records its arguments, then runs
 * `launched`. */
function fakeUpdater(launched: () => Promise<void> = async () => {}) {
  const launches: [string, boolean][] = [];
  const updater: Updater = {
    check: async () => ({ current: FROM, target: TO, commits: ["bbbbbbb two"] }),
    current: async () => FROM,
    launch: async (to, rollback) => {
      launches.push([to, rollback]);
      await launched();
    },
  };
  return { updater, launches };
}

/** Boots with `updater` (none when undefined) and returns the daemon, its home and the `MessagingContext`'s `update`. */
async function bootUpdating(updater: Updater | undefined) {
  const contract = CONTRACTS.get("surface")! as { activate: (...args: unknown[]) => Promise<unknown> };
  const activate = contract.activate;
  let messaging: MessagingContext | undefined;
  vi.spyOn(contract, "activate").mockImplementation((c, k, m) => {
    messaging = m as MessagingContext;
    return activate(c, k, m);
  });
  const { daemon, home } = await bootTest({}, [probe().extension], testKit(), {}, { updater });
  return { daemon, home, update: messaging!.update };
}

test("start records the running update, then launches it", async () => {
  const { updater, launches } = fakeUpdater();
  const { daemon, update } = await bootUpdating(updater);

  await update.start(CHAT, FROM, TO, true);

  expect(launches).toEqual([[TO, true]]);
  const state = await update.state();
  expect(state).toEqual({ state: "running", started: expect.any(Number), chat: CHAT, from: FROM, to: TO, rollback: true, reported: false });
  expect(state?.pid).toBeUndefined();
  await daemon.close();
});

test("start refuses while an update runs and launches nothing", async () => {
  const { updater, launches } = fakeUpdater();
  const { daemon, update } = await bootUpdating(updater);
  await update.start(CHAT, FROM, TO, false);
  const running = await update.state();

  await expect(update.start(CHAT, FROM, TO, false)).rejects.toThrow("An update is already running (started <1m ago).");

  expect(launches).toHaveLength(1);
  expect(await update.state()).toEqual(running);
  await daemon.close();
});

test("an interrupted update doesn't stop a new one", async () => {
  const { updater, launches } = fakeUpdater();
  const { daemon, home, update } = await bootUpdating(updater);
  // Running, but with no pid a minute after it started: it never got going.
  writeUpdateState(home, { state: "running", started: Date.now() - 61_000, chat: CHAT, from: FROM, to: FROM, rollback: false, reported: false });

  await update.start(CHAT, FROM, TO, false);

  expect(launches).toEqual([[TO, false]]);
  expect(await update.state()).toMatchObject({ state: "running", to: TO, reported: false });
  await daemon.close();
});

test("a launch that throws leaves the state failed with its reason, reported (the caller shows the error)", async () => {
  const { updater } = fakeUpdater(async () => {
    throw new Error("systemd-run exited with code 1: Access denied");
  });
  const { daemon, update } = await bootUpdating(updater);

  await expect(update.start(CHAT, FROM, TO, false)).rejects.toThrow("systemd-run exited with code 1: Access denied");

  expect(await update.state()).toMatchObject({
    state: "failed",
    summary: "systemd-run exited with code 1: Access denied",
    finished: expect.any(Number),
    reported: true,
  });
  await daemon.close();
});

test("check and current ask the updater; markReported marks the recorded update reported, if it is the one reported", async () => {
  const { updater } = fakeUpdater();
  const { daemon, home, update } = await bootUpdating(updater);
  expect(await update.state()).toBeUndefined();

  expect(await update.check()).toEqual({ current: FROM, target: TO, commits: ["bbbbbbb two"] });
  expect(await update.current()).toBe(FROM);
  await update.markReported(1); // nothing recorded: nothing to mark
  expect(await update.state()).toBeUndefined();
  await update.start(CHAT, FROM, TO, false);
  const { started } = (await update.state())!;
  await update.markReported(started - 1); // a report of the run before: this one still needs its own
  expect(readUpdateState(home)?.reported).toBe(false);
  await update.markReported(started);

  expect(readUpdateState(home)?.reported).toBe(true);
  await daemon.close();
});

test("without an updater, check says it isn't available", async () => {
  const { daemon, update } = await bootUpdating(undefined);
  const unavailable = "Updating from chat isn't available: japa wasn't started as a daemon.";

  await expect(update.check()).rejects.toThrow(unavailable);
  await expect(update.current()).rejects.toThrow(unavailable);
  await expect(update.start(CHAT, FROM, TO, false)).rejects.toThrow(unavailable);

  expect(await update.state()).toBeUndefined();
  await daemon.close();
});
