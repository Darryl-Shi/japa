// The desktop container: the docker runner, the image build, create/start/health/recreate, exec, and the status line.
import { spawn } from "node:child_process";
import { createHash, randomInt } from "node:crypto";
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
  dispose(): void;
};

export const STARTING = "The desktop is starting (building its image) — try again in a few minutes.";
export const BUILDING = "Building the desktop's image (first use or an upgrade; a few minutes).";
export const UPGRADED =
  "The desktop was recreated with a new image or settings: software installed with apt is gone; everything under /home/japa is kept.";
const NOT_STARTED = "The desktop did not start within 60 s.";
const needsDocker = (reason: string) => `The desktop needs Docker: ${reason}`;
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
  let queue: Promise<unknown> = Promise.resolve();

  const settings = () => kernel().settings() as { cpus?: number; memory?: string; shm?: string; bind?: string };
  const bind = () => settings().bind ?? "127.0.0.1";
  const firstLine = (text: string) => text.trim().split("\n")[0]!;
  const fail = (message: string): never => {
    problem = message;
    throw new Error(message);
  };
  const run = async (args: string[]) => {
    const result = await docker(args);
    if (result.code !== 0) fail(couldNotStart(firstLine(result.stderr) || `exit code ${result.code}`));
  };
  const exec = (argv: string[], input?: string) =>
    docker(["exec", ...(input === undefined ? [] : ["-i"]), "-u", "japa", name, ...argv], { input });

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
      const result = await docker(args, { signal: abort.signal });
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
    const found = inspected.code === 0;
    const [running, label] = inspected.stdout.toString().trim().split(" ");
    if (found && label === hash) {
      if (running !== "true") {
        await run(["start", name]);
        await healthy();
      }
      return;
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
    await run(["run", "-d", "--label", `japa.desktop.hash=${hash}`, ...args]);
    if (found) await kernel().trigger.emit({ key: `upgrade:${hash}`, text: UPGRADED });
    await healthy();
  }

  /** Runs `bringUp` after any earlier one finishes. */
  const serialized = () => {
    const result = queue.then(bringUp);
    queue = result.catch(() => {});
    return result;
  };

  return {
    async ready(wait) {
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
    },
    exec,
    status: () =>
      building
        ? BUILDING
        : (failed ?? problem ?? `noVNC: http://${bind()}:${config.vncPort}/vnc.html (password: secret desktop.vncPassword)`),
    dispose: () => abort.abort(),
  };
}
