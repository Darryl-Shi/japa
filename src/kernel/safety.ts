import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { type Conversation, defineExtension, type Extension, hook, ToolTask } from "@earendil-works/pi-durable";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { logChange } from "./changes.ts";
import { rollBack } from "./install.ts";
import { message } from "./loader.ts";
import type { Settings } from "./settings.ts";
import { LKG, tag } from "./workspace.ts";

/**
 * Last-known-good tagging and runtime auto-rollback: the `japa-safety` extension counts each workspace extension's
 * tool errors in a row (via `built`, the extension-built Pi Durable extensions by name) and rolls the extension back
 * to `LKG` when they reach `settings.safety.toolErrorThreshold`. Background failures go to `report`.
 */
export function createSafety(input: {
  home: string;
  settings: Settings;
  built: () => ReadonlyMap<string, Extension>;
  reconcile: () => Promise<unknown>;
  root: () => Conversation;
  report: (error: string) => void;
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

  async function autoRollback(name: string, reason: string) {
    const sha = rollBack(home, "extension", name);
    if (sha === undefined) return; // already the last known good version
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
