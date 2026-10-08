import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import type { JsonObject, ToolExecutionApi, ToolExecutionResult, ToolRegistration } from "@earendil-works/pi-durable";
import type { KernelContext } from "../src/kernel/contracts.ts";
import type { Desktop, DesktopConfig, Docker, ExecResult } from "../extensions/desktop/container.ts";
import { remoteEnv } from "../extensions/desktop/env.ts";
import { tempHome } from "./helpers.ts";

export const PNG = Buffer.from("fake png");

export function testConfig(docker: Docker): DesktopConfig {
  return { name: "japa-desktop", vncPort: 6080, cdpPort: 9222, docker };
}

/** A `KernelContext` with a temp home, the mutable `settings`, a secrets record, and the emitted trigger events. */
export function stubKernel(settings: JsonObject = {}) {
  const home = tempHome();
  const secrets: Record<string, string> = {};
  const emitted: { key: string; text: string }[] = [];
  const kernel = {
    home,
    settings: () => settings,
    secret: async (name: string) => secrets[name],
    setSecret: async (name: string, value: string) => void (secrets[name] = value),
    trigger: { home, emit: async (event: { key: string; text: string }) => void emitted.push(event) },
  } as unknown as KernelContext;
  return { kernel, home, settings, secrets, emitted };
}

/** A stateful stand-in for the docker command: an image, one container, and overridable replies. */
export function fakeDocker() {
  const calls: string[][] = [];
  const inputs: (string | undefined)[] = [];
  const state: { image: boolean; container?: { running: boolean; hash: string } } = { image: true };
  const replies: { match: (args: string[]) => boolean; result: Partial<ExecResult> | Error }[] = [];
  let held: Promise<void> | undefined;

  const answer = async (args: string[]): Promise<Partial<ExecResult>> => {
    const [command, sub] = args;
    if (command === "container" && sub === "inspect") {
      if (!state.container) return { code: 1, stderr: `Error: No such container: ${args.at(-1)}\n` };
      return { stdout: Buffer.from(`${state.container.running} ${state.container.hash}\n`) };
    }
    if (command === "image") return { code: state.image ? 0 : 1 };
    if (command === "build") {
      await held;
      state.image = true;
    }
    if (command === "run") {
      const label = args.find((a) => a.startsWith("japa.desktop.hash="))!;
      state.container = { running: true, hash: label.slice("japa.desktop.hash=".length) };
    }
    if (command === "start") state.container!.running = true;
    if (command === "stop") state.container!.running = false;
    if (command === "rm") state.container = undefined;
    if (command === "exec" && args.includes("import")) return { stdout: PNG };
    if (command === "exec" && args.includes("getmouselocation")) return { stdout: Buffer.from("X=1\nY=2\nSCREEN=0\nWINDOW=3\n") };
    return {};
  };

  const docker: Docker = async (args, options) => {
    calls.push(args);
    inputs.push(options?.input);
    const reply = replies.find((r) => r.match(args));
    const result = reply ? reply.result : await answer(args);
    if (result instanceof Error) throw result;
    return { code: 0, stdout: Buffer.alloc(0), stderr: "", ...result };
  };

  return {
    docker,
    calls,
    inputs,
    state,
    /** Holds `build` until the returned function is called. */
    holdBuild() {
      let release!: () => void;
      held = new Promise((resolve) => (release = resolve));
      return release;
    },
    reply(match: (args: string[]) => boolean, result: Partial<ExecResult> | Error) {
      replies.unshift({ match, result });
    },
  };
}

/** A `Desktop` that records `ready`'s `wait` and each exec, answering a screenshot, the cursor at 1,2 and "copied". */
export function fakeDesktop() {
  const calls: { argv: string[]; input?: string }[] = [];
  const waits: boolean[] = [];
  const replies: { match: (argv: string[]) => boolean; result: Partial<ExecResult> }[] = [];
  const answer = (argv: string[]): Partial<ExecResult> => {
    if (argv[0] === "import") return { stdout: PNG };
    if (argv[1] === "getmouselocation") return { stdout: Buffer.from("X=1\nY=2\nSCREEN=0\nWINDOW=3\n") };
    if (argv[0] === "xclip" && argv.at(-1) === "-o") return { stdout: Buffer.from("copied") };
    return {};
  };
  const desktop = {
    ready: async (wait: boolean) => void waits.push(wait),
    exec: async (argv: string[], input?: string) => {
      calls.push({ argv, input });
      const result = replies.find((r) => r.match(argv))?.result ?? answer(argv);
      return { code: 0, stdout: Buffer.alloc(0), stderr: "", ...result };
    },
  } as Desktop;
  return {
    desktop,
    calls,
    waits,
    reply(match: (argv: string[]) => boolean, result: Partial<ExecResult>) {
      replies.unshift({ match, result });
    },
  };
}

/**
 * A tool api for job `job` in conversation `conversationId`, whose commits run on `docs`, keyed `<kind>:<conversation>`;
 * its env is the desktop's when `desktop`.
 */
export function fakeApi({ desktop = true, conversationId = 7, job = "1", docs = {} as Record<string, any> } = {}) {
  docs[`japa.job:${conversationId}`] = { jobId: job, environment: "desktop" };
  docs["japa.jobs:1"] ??= { nextId: 2, jobs: { [job]: { id: job, status: "running" } } };
  const tx = {
    doc: async (token: { definition: { kind: string; initial(): unknown } }, id: number) =>
      (docs[`${token.definition.kind}:${id}`] ??= token.definition.initial()),
  };
  const env = desktop ? remoteEnv(() => Promise.reject(new Error("not called")), "/home/japa", "desktop") : undefined;
  const api = { conversationId, env, commit: async (change: (t: typeof tx) => unknown) => change(tx) };
  return { api: api as unknown as ToolExecutionApi, docs };
}

export function run(tool: ToolRegistration, args: object, api: ToolExecutionApi, signal?: AbortSignal) {
  return tool.execute(args, api, signal ? withAbortSignal(signal, BACKGROUND_CONTEXT) : BACKGROUND_CONTEXT);
}

export function resultText(result: ToolExecutionResult) {
  return result.content!.flatMap((c) => (c.type === "text" ? [c.text] : [])).join("\n");
}
