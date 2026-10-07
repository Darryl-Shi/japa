import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { boot } from "../src/kernel/boot.ts";
import { enterSafeMode } from "../src/kernel/safety.ts";
import { readUserSettings } from "../src/kernel/settings.ts";
import { commit, ensureWorkspace, LKG, tag } from "../src/kernel/workspace.ts";
import { REPO_EXTENSIONS, tempHome, testKit, waitFor } from "./helpers.ts";
import { texts } from "./jobs-helpers.ts";

const NOTICE = "[japa] I restarted in safe mode after repeated crashes and restored the last working setup.";

function write(home: string, path: string, text: string) {
  mkdirSync(join(home, path, ".."), { recursive: true });
  writeFileSync(join(home, path), text);
}

test("repeated crashes boot in safe mode, at the last known good workspace", async () => {
  const kit = testKit();
  const home = tempHome({ storage: { adapter: "memory" }, models: { cos: kit.model } });
  ensureWorkspace(home);
  write(home, "extensions/good/index.ts", `export default { name: "good", summary: "Good" };\n`);
  commit(home, ["extensions/good"], "Install extension good");
  tag(home, LKG);
  write(home, "extensions/broken/index.ts", `throw new Error("boom");\n`);
  const now = Date.now();
  writeFileSync(join(home, "boots.json"), JSON.stringify([now - 3000, now - 2000, now - 1000]));

  const extensionDirs = [REPO_EXTENSIONS, join(home, "extensions")];
  const daemon = await boot({ home, extensionDirs, extensions: [kit.extension] });
  expect(existsSync(join(home, "extensions", "broken"))).toBe(false);
  expect(daemon.status().extensions.map((e) => e.name)).toContain("good");
  await waitFor(async () => (await texts(daemon.root, "user")).includes(NOTICE));
  await daemon.close();
  expect(existsSync(join(home, "boots.json"))).toBe(false);
});

test("a broken boot adapter names safe mode, which restores the default adapters", async () => {
  const kit = testKit();
  const home = tempHome({ storage: { adapter: "broken" }, models: { cos: kit.model } });
  await expect(boot({ home, extensions: [kit.extension] })).rejects.toThrow(
    'No storage adapter "broken" is installed — run "japa safe-mode --default-adapters" to restore the defaults.',
  );

  enterSafeMode(home, { defaultAdapters: true });
  expect(readUserSettings(home).storage).toEqual({ adapter: "sqlite" });
  const daemon = await boot({ home, extensions: [kit.extension] });
  await daemon.close();
});
