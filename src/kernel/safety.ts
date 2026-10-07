import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { type Conversation, defineExtension, type Extension, hook, ToolTask } from "@earendil-works/pi-durable";
import { logChange } from "./changes.ts";
import { rollBack } from "./install.ts";
import type { Settings } from "./settings.ts";
import { LKG, tag } from "./workspace.ts";

/**
 * Last-known-good tagging and runtime auto-rollback: the `japa-safety` extension counts each extension's tool errors
 * in a row (via `built`, the extension-built Pi Durable extensions by name) and rolls the extension back to `LKG` when
 * they reach `settings.safety.toolErrorThreshold`.
 */
export function createSafety(input: {
  home: string;
  settings: Settings;
  built: () => ReadonlyMap<string, Extension>;
  reconcile: () => Promise<unknown>;
  root: () => Conversation;
}) {
  const { home, settings } = input;
  const failures = new Map<string, number>();
  let rollbacks = 0;

  const markGood = () => tag(home, LKG);

  /** Tags `LKG` at HEAD after `goodAfterMinutes`, unless an auto-rollback happens first. */
  function scheduleGood() {
    const seen = rollbacks;
    setTimeout(() => rollbacks === seen && markGood(), settings.safety.goodAfterMinutes * 60_000).unref();
  }

  async function autoRollback(name: string, reason: string) {
    rollbacks++;
    const sha = rollBack(home, "extension", name);
    if (sha === undefined) return; // already the last known good version
    await input.reconcile();
    const root = input.root();
    const content = `[japa] I rolled back ${name} to its last working version: ${reason}`;
    await root.submit({ type: "input", content, requestId: `rollback:${sha}` }, ctx);
    await root.commit((tx) => logChange(tx, { title: `Rolled back ${name}`, howToUse: "", undo: { commits: [sha] } }), ctx);
  }

  const extension = defineExtension({
    name: "japa-safety",
    hooks: [
      hook(ToolTask, {
        afterTool: (call, result) => {
          const name = [...input.built()].find(([, e]) => e.tools?.some((t) => t.name === call.name))?.[0];
          if (name === undefined) return undefined;
          const count = result.isError ? (failures.get(name) ?? 0) + 1 : 0;
          failures.set(name, count);
          if (count >= settings.safety.toolErrorThreshold) {
            failures.delete(name);
            // Outside the tool task: reconciling reconfigures the conversations this task runs in.
            const reason = `its tool ${call.name} failed ${count} times in a row`;
            setImmediate(() => autoRollback(name, reason).catch(() => {}));
          }
          return undefined;
        },
      }),
    ],
  });

  return { extension, markGood, scheduleGood };
}
