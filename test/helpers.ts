import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import type { FauxProviderHandle } from "@earendil-works/pi-ai";
import { type EntryRecord, ResetEntry } from "@earendil-works/pi-durable";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { boot, type Daemon } from "../src/kernel/boot.ts";
import type { SurfaceContext } from "../src/kernel/contracts.ts";
import type { JapaExtension } from "../src/kernel/extension.ts";
import { fauxKit } from "../src/kernel/kit.ts";

export const REPO_EXTENSIONS = fileURLToPath(new URL("../extensions", import.meta.url));

/** Creates a temp `japa` home dir; writes `settings.json` when `settings` is given. */
export function tempHome(settings?: object): string {
  const home = mkdtempSync(join(tmpdir(), "japa-"));
  if (settings !== undefined) {
    writeFileSync(join(home, "settings.json"), JSON.stringify(settings));
  }
  return home;
}

export const testKit = fauxKit;

/** Writes `<home>/.staging/<path>` with `text`. */
export function stage(home: string, path: string, text: string) {
  mkdirSync(join(home, ".staging", path, ".."), { recursive: true });
  writeFileSync(join(home, ".staging", path), text);
}

/** Extension `echo`: tool `echo` replies `reply`; its trigger fails to start while `<home>/<reply>.busy` exists. */
export const echo = (reply: string) => `import { existsSync } from "node:fs";
import { join } from "node:path";
import { defineJapaExtension, defineTool, type TriggerContext, Type } from "japa/sdk";

export default defineJapaExtension({
  name: "echo",
  summary: "Echoes",
  examples: ["echo"],
  docs: "Echo.",
  provides: {
    tool: [defineTool({
      name: "echo",
      description: "Echo",
      parameters: Type.Object({}),
      execute: async () => ({ content: [{ type: "text", text: "${reply}" }] }),
    })],
    trigger: [{
      name: "tick",
      start: async ({ home }: TriggerContext) => {
        if (existsSync(join(home, "${reply}.busy"))) throw new Error("busy");
        return () => {};
      },
    }],
  },
});
`;

/** Polls `fn` every 20 ms until it returns true; throws `waitFor timed out` after `timeoutMs`. */
export async function waitFor(fn: () => Promise<boolean> | boolean, timeoutMs = 15000): Promise<void> {
  const deadline = performance.now() + timeoutMs; // not Date.now(): this host's wall clock jumps by ~20-40 s
  while (!(await fn())) {
    if (performance.now() > deadline) throw new Error("waitFor timed out");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** The carry-over of the latest reset, waiting until the turn in flight has reset. */
export async function carryOver(daemon: Daemon): Promise<string | undefined> {
  let newest: EntryRecord | undefined;
  await waitFor(async () => {
    newest = (await daemon.root.entries({}, 1, undefined, ctx)).items[0];
    return newest?.kind === ResetEntry.kind;
  });
  const content = newest!.model?.[0]?.content;
  return typeof content === "string" ? content : undefined;
}

/** Boots a daemon in a temp home on in-memory storage, with the faux model as `models.cos`. */
export async function bootTest(
  settings: object = {},
  extra: JapaExtension[] = [],
  kit = testKit(),
): Promise<{ daemon: Daemon; faux: FauxProviderHandle; home: string }> {
  const home = tempHome({ storage: { adapter: "memory" }, models: { cos: kit.model }, ...settings });
  const daemon = await boot({ home, extensionDirs: [REPO_EXTENSIONS], extensions: [kit.extension, ...extra] });
  return { daemon, faux: kit.faux, home };
}

/** A surface that hands its `SurfaceContext` to the test. */
export function probe() {
  let surface: SurfaceContext | undefined;
  const extension: JapaExtension = {
    name: "probe",
    summary: "Test",
    provides: {
      surface: [
        {
          name: "probe",
          start: async (c: SurfaceContext) => {
            surface = c;
            return () => {};
          },
        },
      ],
    },
  };
  return { extension, surface: () => surface! };
}
