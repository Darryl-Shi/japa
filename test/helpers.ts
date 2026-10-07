import type { FauxProviderHandle } from "@earendil-works/pi-ai";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { boot, type Daemon } from "../src/kernel/boot.ts";
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

/** Polls `fn` every 20 ms until it returns true; throws `waitFor timed out` after `timeoutMs`. */
export async function waitFor(fn: () => Promise<boolean> | boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await fn())) {
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
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
