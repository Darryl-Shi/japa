import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { boot } from "../src/kernel/boot.ts";
import { enterSafeMode } from "../src/kernel/safety.ts";
import { readUserSettings } from "../src/kernel/settings.ts";
import { commit, ensureWorkspace, head, LKG, tag } from "../src/kernel/workspace.ts";
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

test("repeated failed boots with nothing changed since the last known good setup neither commit nor post", async () => {
  const kit = testKit();
  const home = tempHome({ storage: { adapter: "memory" }, models: { cos: kit.model } });
  ensureWorkspace(home);
  const before = head(home);
  const now = Date.now();
  writeFileSync(join(home, "boots.json"), JSON.stringify([now - 3000, now - 2000, now - 1000]));

  const daemon = await boot({ home, extensionDirs: [REPO_EXTENSIONS], extensions: [kit.extension] });
  expect(head(home)).toBe(before);
  expect(await texts(daemon.root, "user")).toEqual([]);
  await daemon.close();
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

test("a boot tags the last known good setup once it has run for goodAfterMinutes", async () => {
  const kit = testKit();
  const safety = { toolErrorThreshold: 5, goodAfterMinutes: 0.001 };
  const home = tempHome({ storage: { adapter: "memory" }, models: { cos: kit.model }, safety });
  ensureWorkspace(home);
  write(home, "skills/s/SKILL.md", "---\nname: s\ndescription: S\n---\nDo s.");
  commit(home, ["skills"], "Install skill s"); // installed, but the daemon stopped before its tag
  const lkg = () => execFileSync("git", ["-C", home, "rev-parse", `${LKG}^{commit}`], { encoding: "utf8" }).trim();
  expect(lkg()).not.toBe(head(home));

  const daemon = await boot({ home, extensionDirs: [REPO_EXTENSIONS], extensions: [kit.extension] });
  await waitFor(() => lkg() === head(home));
  await daemon.close();
});

test("safe mode commits only the extensions and skills it restores", () => {
  const home = tempHome({ storage: { adapter: "broken" } });
  ensureWorkspace(home);
  write(home, "notes.txt", "one\n");
  commit(home, ["notes.txt"], "notes");
  tag(home, LKG);
  write(home, "skills/new/SKILL.md", "---\nname: new\ndescription: N\n---\n");
  commit(home, ["skills"], "Install skill new");
  write(home, "notes.txt", "two\n");
  const before = head(home);
  const after = enterSafeMode(home, { defaultAdapters: true })!;
  const git = (...args: string[]) => execFileSync("git", ["-C", home, ...args], { encoding: "utf8" }).trim();
  expect(after).not.toBe(before);
  expect(existsSync(join(home, "skills", "new"))).toBe(false);
  expect(readUserSettings(home).storage).toEqual({ adapter: "sqlite" });
  expect(git("status", "--porcelain").split("\n").map((line) => line.trim())).toEqual(["M notes.txt", "M settings.json"]);
});
