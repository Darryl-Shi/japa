// The desktop container: the docker runner, the image build, create/start/health/recreate, exec, and the status line.
import { spawn } from "node:child_process";
import { createHash, randomInt, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import type { KernelContext } from "../../src/sdk.ts";

export type ExecResult = { code: number; stdout: Buffer; stderr: string };
/** Runs the docker command; rejects only when it can't be started. */
export type Docker = (args: string[], options?: { input?: string; signal?: AbortSignal }) => Promise<ExecResult>;
export type DesktopConfig = { name: string; vncPort: number; cdpPort: number; docker: Docker };
export type Desktop = {
  /** Builds, creates or starts the container as needed; during a build, waits when `wait`, else throws STARTING. */
  ready(wait: boolean): Promise<void>;
  /** Runs `argv` as japa in the container, with `input` on stdin. */
  exec(argv: string[], input?: string): Promise<ExecResult>;
  status(): string;
  /**
   * Its state for the web UI's Desktop panel: its image building, a failure (last start or build), up (the last
   * start succeeded), being started, or not started.
   */
  state(): "ready" | "starting" | "building" | "failed" | "stopped";
  /** The VNC password (the `desktop.vncPassword` secret), generated and stored if unset. */
  password(): Promise<string>;
  /**
   * One watchdog check (the extension runs it every minute), only while the desktop is up. Each of its `PARTS` that
   * fails `HUNG_CHECKS` checks in a row is restarted; one that fails again after that, a dead screen, or a container
   * that doesn't answer at all restarts the whole container (a stopped one is started again). The chief of staff is
   * told when the browser or the whole desktop restarts. With memory use at `MEMORY_HIGH` of the limit or more, the
   * tabs beyond the `KEPT_TABS` most recently active are closed.
   */
  watch(): Promise<void>;
  dispose(): void;
};

export const STARTING = "The desktop is starting (building its image) — try again in a few minutes.";
export const BUILDING = "Building the desktop's image (first use or an upgrade; a few minutes).";
export const UPGRADED =
  "The desktop was recreated with a new image or settings: software installed with apt is gone; everything under /home/japa is kept.";
export const RECREATED =
  "The desktop's container was broken and has been recreated: software installed with apt is gone; everything under /home/japa is kept.";
export const BROWSER_RESTARTED =
  "The desktop's browser stopped answering for a few minutes and was restarted: its open tabs are gone; its logins are kept.";
export const DESKTOP_RESTARTED =
  "The desktop stopped answering for a few minutes and was restarted: its open windows and tabs are gone; everything under /home/japa is kept.";
const NOT_STARTED = "The desktop did not start within 60 s.";
/**
 * The parts of the desktop the watchdog checks, by supervisord program, each with the shell command (run as japa in the
 * container) that succeeds while it works: the screen answers, the window manager runs, the VNC server greets, noVNC
 * serves its page, the browser and its DevTools forward answer.
 */
export const PARTS = {
  xvfb: "timeout 10 xdotool getmouselocation",
  xfce: "pgrep -x xfwm4",
  x11vnc: "timeout 10 bash -c 'exec 3<>/dev/tcp/127.0.0.1/5900 && head -c 3 <&3 | grep -q RFB'",
  novnc: "curl -sf -m 10 -o /dev/null http://127.0.0.1:6080/vnc.html",
  chromium: "curl -sf -m 10 -o /dev/null http://127.0.0.1:9222/json/version",
  cdp: "curl -sf -m 10 -o /dev/null http://127.0.0.1:9223/json/version",
};
type Part = keyof typeof PARTS;
/** The probe's last line: it ran to the end. */
const PROBED = "probed";
/** Runs every part's check at once (≤ 10 s) and prints the name of each that failed, then `PROBED`. */
export const PROBE = [
  ...Object.entries(PARTS).map(([part, check]) => `(${check}) >/dev/null 2>&1 || echo ${part} &`),
  "wait",
  `echo ${PROBED}`,
].join("\n");
/** Watchdog checks in a row a part (or the container) must fail before it's restarted. */
export const HUNG_CHECKS = 3;
/** The share of the container's memory limit at which the watchdog closes idle tabs. */
export const MEMORY_HIGH = 0.75;
/** The most recently active tabs the watchdog keeps open. */
export const KEPT_TABS = 5;
/** The browser's DevTools endpoint, inside the container. */
const CDP = "http://127.0.0.1:9222";
/** How long one of the watchdog's docker calls may take. */
const WATCH_TIMEOUT = 30_000;
/** The least time between two whole-container restarts by the watchdog, doubled after each that didn't help. */
const RESTART_BACKOFF = 120_000;
const needsDocker = (reason: string) =>
  `The desktop needs Docker: ${reason}` +
  (/permission denied/i.test(reason)
    ? " (let japa's user use Docker: sudo usermod -aG docker $USER, then restart japa from a new login)"
    : /not found/i.test(reason)
      ? " (install it: https://docs.docker.com/engine/install/)"
      : "");
const couldNotStart = (line: string) => `The desktop could not start: ${line}`;
const buildFailed = (line: string) => `The desktop image failed to build: ${line}`;

/** This directory: the image's build context. */
export const DESKTOP_DIR = dirname(fileURLToPath(import.meta.url));
const sha12 = (data: string | Buffer) => createHash("sha256").update(data).digest("hex").slice(0, 12);
export const IMAGE_HASH = sha12(
  Buffer.concat([readFileSync(join(DESKTOP_DIR, "Dockerfile")), readFileSync(join(DESKTOP_DIR, "supervisord.conf"))]),
);

const FORMAT = '{{.State.Running}} {{index .Config.Labels "japa.desktop.hash"}}';
const PASSWORD_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

export const dockerCli: Docker = (args, options = {}) =>
  new Promise((resolve, reject) => {
    const child = spawn("docker", args);
    const stdout: Buffer[] = [];
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk));
    child.on("error", (error: NodeJS.ErrnoException) =>
      reject(new Error(error.code === "ENOENT" ? "the docker command was not found" : error.message)));
    child.on("close", (code) => resolve({ code: code ?? 1, stdout: Buffer.concat(stdout), stderr }));
    options.signal?.addEventListener("abort", () => child.kill());
    child.stdin.on("error", () => {}); // the process exited before reading its input; its exit code tells
    child.stdin.end(options.input);
  });

export function desktopContainer(config: DesktopConfig, kernel: () => KernelContext): Desktop {
  const { name, docker } = config;
  const image = `${name}:${IMAGE_HASH}`;
  const abort = new AbortController();
  let building: Promise<void> | undefined;
  let failed: string | undefined; // a failed build, not yet reported by `ready`
  let problem: string | undefined;
  // The recovery tried since the desktop last came up: a broken container removed, or its image too (and rebuilt).
  let recovery: "container" | "image" | undefined;
  let replaced = false; // a container was lost to a recovery: tell the chief of staff once its replacement runs
  let queue: Promise<unknown> = Promise.resolve();
  let starting = 0; // ready() calls in flight
  let up = false; // the last bringUp brought the container up
  const misses = new Map<Part | "container", number>(); // watchdog checks in a row each failed
  const restarted = new Set<Part>(); // parts the watchdog restarted that haven't answered since
  let restarts = 0; // whole-container restarts since every part last answered
  let quietUntil = 0; // no container restart before this: backing off while restarts don't help
  let watching = false; // a watchdog check in flight

  const settings = () => kernel().settings() as { cpus?: number; memory?: string; shm?: string; bind?: string };
  const bind = () => settings().bind ?? "127.0.0.1";
  const firstLine = (text: string) => text.trim().split("\n")[0]!;
  const fail = (message: string): never => {
    problem = message;
    throw new Error(message);
  };
  /** Runs a docker command; answers its failure as a status line. */
  const attempt = async (args: string[]) => {
    const result = await docker(args);
    return result.code === 0 ? undefined : couldNotStart(firstLine(result.stderr) || `exit code ${result.code}`);
  };
  const run = async (args: string[]) => {
    const error = await attempt(args);
    if (error) fail(error);
  };
  const exec = (argv: string[], input?: string) =>
    docker(["exec", ...(input === undefined ? [] : ["-i"]), "-u", "japa", name, ...argv], { input });
  /** A watchdog docker call: given up (a failure) after `WATCH_TIMEOUT`, so a stuck docker can't stall the checks. */
  const watchCall = (args: string[]) => docker(args, { signal: AbortSignal.timeout(WATCH_TIMEOUT) });
  const cdp = (path: string) => watchCall(["exec", "-u", "japa", name, "curl", "-sf", "-m", "10", `${CDP}${path}`]);

  async function watch() {
    if (!up || building || starting > 0 || watching) return;
    watching = true;
    try {
      const lines = (await watchCall(["exec", "-u", "japa", name, "sh", "-c", PROBE])).stdout.toString().split("\n");
      if (!lines.includes(PROBED)) {
        // The container is down, or too stuck to run the probe.
        if (missed("container")) await restartContainer();
        return;
      }
      misses.delete("container");
      const failing = new Set(lines.filter((line): line is Part => Object.hasOwn(PARTS, line)));
      if (failing.size === 0) restarts = quietUntil = 0;
      // Blame the cause alone: a dead screen takes every other part with it, a dead browser its DevTools forward.
      const blamed = failing.has("xvfb")
        ? new Set<Part>(["xvfb"])
        : new Set([...failing].filter((part) => part !== "cdp" || !failing.has("chromium")));
      for (const part of Object.keys(PARTS) as Part[]) {
        if (!blamed.has(part)) {
          misses.delete(part);
          if (!failing.has(part)) restarted.delete(part);
          continue;
        }
        if (!missed(part)) continue;
        // Everything runs on the screen; and a part its restart didn't mend needs a fresh container.
        if (part === "xvfb" || restarted.has(part)) {
          await restartContainer();
          return;
        }
        restarted.add(part);
        await restartPart(part);
      }
      if (!failing.has("chromium")) await closeIdleTabs();
    } finally {
      watching = false;
    }
  }

  /** Counts a failed check of `part`: whether it has now failed `HUNG_CHECKS` in a row (and starts counting again). */
  function missed(part: Part | "container") {
    const count = (misses.get(part) ?? 0) + 1;
    misses.set(part, count);
    if (count < HUNG_CHECKS) return false;
    misses.delete(part);
    return true;
  }

  /** Restarts one part through supervisord; the browser by killing all of Chromium (supervisord starts it again). */
  async function restartPart(part: Part) {
    if (part === "chromium") {
      // Every Chromium process, a crash handler holding one included.
      const killed = await watchCall(["exec", "-u", "japa", name, "pkill", "-KILL", "-f", "^/usr/lib/chromium/"]);
      if (killed.code !== 0) return; // no browser to kill: it's restarting, or supervisord gave up (next time: the container)
      console.error("desktop: the browser stopped answering; restarted it");
      await kernel().trigger.emit({ key: `browser-restart:${randomUUID()}`, text: BROWSER_RESTARTED });
      return;
    }
    const result = await watchCall(["exec", "-u", "root", name, "supervisorctl", "restart", part]);
    console.error(`desktop: ${part} stopped answering; ${result.code === 0 ? "restarted it" : "couldn't restart it"}`);
  }

  /**
   * Restarts the whole container, or brings it up again (as `ready` does) when it isn't running. While restarts don't
   * help, each waits twice as long as the last (2 min, 4, ... 32), and only the first tells the chief of staff.
   */
  async function restartContainer() {
    misses.clear();
    restarted.clear();
    if (Date.now() < quietUntil) return;
    restarts++;
    quietUntil = Date.now() + RESTART_BACKOFF * 2 ** Math.min(restarts - 1, 4);
    const inspected = await watchCall(["container", "inspect", "--format", "{{.State.Running}}", name]);
    if (inspected.stdout.toString().trim() !== "true") {
      console.error("desktop: the container isn't running; starting it");
      await serialized().catch(() => {}); // a failure shows in the status line, as for `ready`
      return;
    }
    const result = await watchCall(["restart", "-t", "10", name]);
    if (result.code !== 0) {
      console.error(`desktop: the container stopped answering; couldn't restart it: ${firstLine(result.stderr)}`);
      return;
    }
    console.error("desktop: the container stopped answering; restarted it");
    if (restarts === 1) await kernel().trigger.emit({ key: `desktop-restart:${randomUUID()}`, text: DESKTOP_RESTARTED });
  }

  /** With memory use high, closes the tabs beyond the `KEPT_TABS` most recently active (CDP lists those first). */
  async function closeIdleTabs() {
    const stats = await watchCall(["stats", "--no-stream", "--format", "{{.MemPerc}}", name]);
    const used = Number.parseFloat(stats.stdout.toString()) / 100;
    if (stats.code !== 0 || !(used >= MEMORY_HIGH)) return;
    const listed = await cdp("/json/list");
    let targets: unknown;
    try {
      targets = JSON.parse(listed.stdout.toString());
    } catch {
      return;
    }
    if (listed.code !== 0 || !Array.isArray(targets)) return;
    const idle = targets
      .filter((t): t is { id: string } => t?.type === "page" && typeof t.id === "string" && /^[A-Za-z0-9]+$/.test(t.id))
      .slice(KEPT_TABS);
    for (const tab of idle) await cdp(`/json/close/${tab.id}`);
    if (idle.length) {
      console.error(`desktop: memory at ${Math.round(used * 100)}% of its limit; closed ${idle.length} idle browser tabs`);
    }
  }

  async function password() {
    const k = kernel();
    let value = await k.secret("desktop.vncPassword");
    if (value === undefined) {
      value = Array.from({ length: 16 }, () => PASSWORD_CHARS[randomInt(PASSWORD_CHARS.length)]).join("");
      await k.setSecret("desktop.vncPassword", value);
    }
    return value;
  }

  /** Waits up to 60 s for X and CDP; X alone is enough at the end, as the browser reports CDP itself. */
  async function healthy() {
    const deadline = Date.now() + 60_000;
    for (;;) {
      const x = await exec(["xdotool", "getmouselocation"]);
      const cdp = await exec(["curl", "-sf", "http://127.0.0.1:9222/json/version"]);
      if (x.code === 0 && cdp.code === 0) return;
      if (Date.now() >= deadline) {
        if (x.code === 0) return;
        fail(NOT_STARTED);
      }
      await sleep(500);
    }
  }

  async function build() {
    try {
      const args = ["build", "-t", image, "--label", `japa.desktop.hash=${IMAGE_HASH}`, DESKTOP_DIR];
      let result = await docker(args, { signal: abort.signal });
      if (result.code !== 0 && !abort.signal.aborted) {
        // A build cache whose layers are gone from the image store fails every build: prune it and try once more.
        await docker(["builder", "prune", "-af"], { signal: abort.signal });
        result = await docker(args, { signal: abort.signal });
      }
      if (result.code !== 0) failed = buildFailed(result.stderr.trim().split("\n").at(-1)!.trim());
    } catch (error) {
      failed = needsDocker((error as Error).message);
    } finally {
      building = undefined;
    }
  }

  /** Makes the container current and running, or starts a build and answers "build". */
  async function bringUp(): Promise<"build" | undefined> {
    if (building || failed) return "build"; // an earlier call started a build
    const { home } = kernel();
    const s = settings();
    const args = [
      "--name", name, "--restart", "unless-stopped", "--network", `${name}-net`,
      "--cpus", String(s.cpus ?? 2), "--memory", s.memory ?? "4g", "--shm-size", s.shm ?? "2g",
      "-p", `${bind()}:${config.vncPort}:6080`, "-p", `127.0.0.1:${config.cdpPort}:9223`,
      "-v", `${name}-home:/home/japa`, "-v", `${home}/desktop/shared:/home/japa/shared`,
      "-v", `${home}/attachments:/home/japa/attachments:ro`,
      "-e", `VNC_PASSWORD=${await password()}`, image,
    ];
    const hash = sha12(JSON.stringify(args));
    const inspected = await docker(["container", "inspect", "--format", FORMAT, name]).catch((error: Error) =>
      fail(needsDocker(error.message)));
    if (inspected.code !== 0 && !/No such (object|container)/i.test(inspected.stderr)) {
      fail(needsDocker(firstLine(inspected.stderr)));
    }
    problem = undefined;
    let found = inspected.code === 0;
    const [running, label] = inspected.stdout.toString().trim().split(" ");
    if (found && label === hash) {
      const error = running === "true" ? undefined : await attempt(["start", name]);
      if (!error) {
        if (running !== "true") await healthy();
        recovery = undefined;
        return;
      }
      if (recovery) fail(error);
      // Its layers may be gone (say, the image store was lost): create it afresh, on the same home volume.
      recovery = "container";
      replaced = true;
      await docker(["rm", "-f", name]);
      found = false;
    }
    if ((await docker(["image", "inspect", image])).code !== 0) {
      building = build();
      return "build";
    }
    if (found) {
      await run(["stop", name]);
      await run(["rm", name]);
    }
    mkdirSync(join(home, "desktop/shared"), { recursive: true });
    chmodSync(join(home, "desktop/shared"), 0o777);
    mkdirSync(join(home, "attachments"), { recursive: true });
    await docker(["network", "create", `${name}-net`]); // fails harmlessly when it exists
    const error = await attempt(["run", "-d", "--label", `japa.desktop.hash=${hash}`, ...args]);
    if (error) {
      if (recovery === "image") fail(error);
      // The image may be unusable (its metadata present, its layers gone): remove it and rebuild it, once.
      recovery = "image";
      replaced ||= found;
      await docker(["rm", "-f", name]);
      await docker(["image", "rm", "-f", image]);
      building = build();
      return "build";
    }
    if (found) await kernel().trigger.emit({ key: `upgrade:${hash}`, text: UPGRADED });
    else if (replaced) await kernel().trigger.emit({ key: `recreate:${randomUUID()}`, text: RECREATED });
    replaced = false;
    await healthy();
    recovery = undefined;
  }

  /** Runs `bringUp` after any earlier one finishes. */
  const serialized = () => {
    const result = queue.then(bringUp).then(
      (outcome) => {
        up = outcome === undefined;
        return outcome;
      },
      (error: unknown) => {
        up = false;
        throw error;
      },
    );
    queue = result.catch(() => {});
    return result;
  };

  return {
    async ready(wait) {
      starting++;
      try {
        await bringUpOrWait(wait);
      } finally {
        starting--;
      }
    },
    exec,
    status: () =>
      building
        ? BUILDING
        : (failed ?? problem ?? `noVNC: http://${bind()}:${config.vncPort}/vnc.html (password: secret desktop.vncPassword)`),
    // Up wins over a check in flight: every tool call checks the desktop with ready() first.
    state: () => {
      if (building) return "building";
      if (failed !== undefined || problem !== undefined) return "failed";
      if (up) return "ready";
      return starting > 0 ? "starting" : "stopped";
    },
    password,
    watch,
    dispose: () => abort.abort(),
  };

  /** `ready`: brings the container up, waiting for a build when `wait`. */
  async function bringUpOrWait(wait: boolean): Promise<void> {
    for (;;) {
      if (failed !== undefined) {
        problem = failed; // a failed build is reported once
        failed = undefined;
        throw new Error(problem);
      }
      if (building) {
        if (!wait) throw new Error(STARTING);
        await building;
        continue;
      }
      if ((await serialized()) !== "build") return;
      if (!wait) throw new Error(STARTING); // even when the build already ended: the next call reports it
    }
  }
}
