import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { type Conversation, defineExtension, type Extension, hook, ToolTask } from "@earendil-works/pi-durable";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { logChange } from "./changes.ts";
import { message } from "./loader.ts";
import { rollBack } from "./rollback.ts";
import { readUserSettings, saveSettings, setPath, type Settings } from "./settings.ts";
import type { WorkspaceLock } from "./workspace-lock.ts";
import { commit, hasTag, head, LKG, matches, restorePath, tag } from "./workspace.ts";

const bootsFile = (home: string) => join(home, "boots.json");
const readBoots = (home: string): number[] =>
  existsSync(bootsFile(home)) ? JSON.parse(readFileSync(bootsFile(home), "utf8")) : [];

/** Whether `<home>/boots.json` holds 3 boots from the last 5 minutes: the daemon keeps crashing. */
export const crashLooping = (home: string) => readBoots(home).filter((t) => Date.now() - t < 5 * 60_000).length >= 3;

/** Appends this boot's time to `<home>/boots.json`; cleared when the daemon stays up or closes cleanly. */
export const recordBoot = (home: string) =>
  writeFileSync(bootsFile(home), JSON.stringify([...readBoots(home), Date.now()]));

export const clearBoots = (home: string) => rmSync(bootsFile(home), { force: true });

/**
 * Restores the workspace's extensions, skills and worker profiles to `LKG` and, with `defaultAdapters`, selects the
 * packaged storage and secrets adapters; commits and clears the crash log. Returns the new HEAD, or undefined when
 * there was nothing to restore: the crash log is just cleared.
 */
export function enterSafeMode(home: string, { defaultAdapters }: { defaultAdapters: boolean }): string | undefined {
  const paths = ["extensions", "skills", "workers"];
  if (!defaultAdapters && hasTag(home, LKG) && matches(home, LKG, paths)) {
    clearBoots(home);
    return undefined;
  }
  if (hasTag(home, LKG)) {
    for (const path of paths) {
      rmSync(join(home, path), { recursive: true, force: true }); // untracked files too
      restorePath(home, LKG, path);
    }
  }
  if (defaultAdapters) {
    const user = readUserSettings(home);
    setPath(user, "storage.adapter", "sqlite");
    setPath(user, "secrets.adapter", "file");
    saveSettings(home, user);
  }
  commit(home, ["."], "Safe mode: restored last-known-good");
  clearBoots(home);
  return head(home);
}

/**
 * Last-known-good tagging and runtime auto-rollback: the `japa-safety` extension counts each workspace extension's
 * tool errors in a row (via `built`, the extension-built Pi Durable extensions by name) and rolls the extension back
 * to `LKG` when they reach `settings.safety.toolErrorThreshold`, under `lock`. Background failures go to `report`.
 */
export function createSafety(input: {
  home: string;
  settings: Settings;
  built: () => ReadonlyMap<string, Extension>;
  reconcile: () => Promise<unknown>;
  root: () => Conversation;
  report: (error: string) => void;
  lock: WorkspaceLock;
}) {
  const { home, settings, report } = input;
  const failures = new Map<string, number>();
  let timer: NodeJS.Timeout | undefined;

  const markGood = () => tag(home, LKG);

  /** Tags `LKG` at HEAD `goodAfterMinutes` after the latest call, unless an auto-rollback happens first; resets `name`'s failures. */
  function scheduleGood(name?: string) {
    if (name !== undefined) failures.delete(name);
    clearTimeout(timer);
    const fire = () => {
      try {
        markGood();
      } catch (err) {
        report(`tagging the last known good setup: ${message(err)}`);
      }
    };
    timer = setTimeout(fire, settings.safety.goodAfterMinutes * 60_000).unref();
  }

  const autoRollback = (name: string, reason: string) => input.lock(() => rollBackLocked(name, reason));

  async function rollBackLocked(name: string, reason: string) {
    const sha = rollBack(home, "extension", name);
    if (sha === undefined) {
      const content = `[japa] ${name} keeps failing and has no earlier working version: ${reason}`;
      return input.root().submit({ type: "input", content, requestId: `rollback-none:${name}:${head(home)}` }, ctx);
    }
    clearTimeout(timer);
    await input.reconcile();
    const root = input.root();
    const content = existsSync(join(home, "extensions", name))
      ? `[japa] I rolled back ${name} to its last working version: ${reason}`
      : `[japa] I removed ${name} (new since the last working setup): ${reason}`;
    await root.submit({ type: "input", content, requestId: `rollback:${sha}` }, ctx);
    await root.commit((tx) => logChange(tx, { title: `Rolled back ${name}`, howToUse: "", undo: { commits: [sha] } }), ctx);
  }

  const extension = defineExtension({
    name: "japa-safety",
    hooks: [
      hook(ToolTask, {
        afterTool: (call, result) => {
          const name = [...input.built()].find(([, e]) => e.tools?.some((t) => t.name === call.name))?.[0];
          if (name === undefined || !existsSync(join(home, "extensions", name))) return undefined;
          const count = result.isError ? (failures.get(name) ?? 0) + 1 : 0;
          failures.set(name, count);
          if (count >= settings.safety.toolErrorThreshold) {
            failures.delete(name);
            // Outside the tool task: reconciling reconfigures the conversations this task runs in.
            const reason = `its tool ${call.name} failed ${count} times in a row`;
            setImmediate(() => autoRollback(name, reason).catch((err) => report(`auto-rollback of ${name}: ${message(err)}`)));
          }
          return undefined;
        },
      }),
    ],
  });

  return { extension, markGood, scheduleGood, close: () => clearTimeout(timer) };
}
