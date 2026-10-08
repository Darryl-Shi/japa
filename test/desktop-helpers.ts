import type { JsonObject } from "@earendil-works/pi-durable";
import type { KernelContext } from "../src/kernel/contracts.ts";
import type { DesktopConfig, Docker, ExecResult } from "../extensions/desktop/container.ts";
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
