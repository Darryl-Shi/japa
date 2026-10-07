import { MemoryStorage, type ModelRef } from "@earendil-works/pi-durable";
import { type FauxProviderHandle, fauxProvider } from "@earendil-works/pi-ai";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { boot, type Daemon } from "../src/kernel/boot.ts";
import type { JapaExtension } from "../src/kernel/extension.ts";

const REPO_EXTENSIONS = fileURLToPath(new URL("../extensions", import.meta.url));

/** Creates a temp `japa` home dir; writes `settings.json` when `settings` is given. */
export function tempHome(settings?: object): string {
  const home = mkdtempSync(join(tmpdir(), "japa-"));
  if (settings !== undefined) {
    writeFileSync(join(home, "settings.json"), JSON.stringify(settings));
  }
  return home;
}

/** A faux model provider and in-memory storage, packaged as the extension "test-kit". */
export function testKit(): { faux: FauxProviderHandle; extension: JapaExtension; model: ModelRef } {
  const faux = fauxProvider();
  const extension: JapaExtension = {
    name: "test-kit",
    summary: "Faux models and in-memory storage for tests",
    provides: {
      storage: [{ name: "memory", open: async () => new MemoryStorage() }],
      provider: [faux.provider],
    },
  };
  const { provider, id } = faux.getModel();
  return { faux, extension, model: { provider, modelId: id } };
}

/** Boots a daemon in a temp home on in-memory storage, with the faux model as `models.cos`. */
export async function bootTest(
  settings: object = {},
  extra: JapaExtension[] = [],
): Promise<{ daemon: Daemon; faux: FauxProviderHandle; home: string }> {
  const kit = testKit();
  const home = tempHome({ storage: { adapter: "memory" }, models: { cos: kit.model }, ...settings });
  const daemon = await boot({ home, extensionDirs: [REPO_EXTENSIONS], extensions: [kit.extension, ...extra] });
  return { daemon, faux: kit.faux, home };
}
