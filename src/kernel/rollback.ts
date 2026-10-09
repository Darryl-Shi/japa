import { StringEnum, Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-durable";
import { type Commit, logChange } from "./changes.ts";
import { KEBAB_CASE } from "./extension.ts";
import type { LoadError } from "./loader.ts";
import type { WorkspaceLock } from "./workspace-lock.ts";
import { commit, LKG, restorePath } from "./workspace.ts";

/** What can be rolled back: a skill or an extension in the workspace. */
export const ROLLBACK_KINDS = ["skill", "extension"] as const;

type Kind = (typeof ROLLBACK_KINDS)[number];
type Reconcile = () => Promise<{ errors: LoadError[]; notices: string[] }>;

const reply = (text: string) => ({ content: [{ type: "text" as const, text }] });

/** Restores a skill or extension as it is at `to` and commits it; the sha, or undefined if unchanged. */
export function rollBack(home: string, kind: Kind, name: string, to = LKG): string | undefined {
  const path = `${kind}s/${name}`;
  restorePath(home, to, path);
  return commit(home, [path], `Roll back ${kind} ${name}`);
}

/**
 * Under `lock`, `rollBack`, then reconciles and logs the change; the reply for the user, with the reconcile's notices.
 */
export function rollBackAndLog(
  home: string,
  kind: Kind,
  name: string,
  to: string | undefined,
  reconcile: Reconcile,
  commit: Commit,
  lock: WorkspaceLock,
): Promise<string> {
  return lock(async () => {
    const sha = rollBack(home, kind, name, to);
    if (sha === undefined) return `${kind} ${name} is already at that version.`;
    const { notices } = await reconcile();
    const change = { title: `Rolled back ${kind} ${name}`, howToUse: "", undo: { commits: [sha] } };
    await commit((tx) => logChange(tx, change));
    return [`Rolled back ${kind} ${name}.`, ...notices].join(" ");
  });
}

/** The CoS's `rollback` tool: `rollBackAndLog`. */
export function rollbackTool(home: string, reconcile: Reconcile, lock: WorkspaceLock) {
  return defineTool({
    name: "rollback",
    description:
      "Roll a skill or extension back to its last known good version, or to the git ref `to`. Logged as a change you can undo.",
    parameters: Type.Object({
      kind: StringEnum(ROLLBACK_KINDS),
      name: Type.String({ pattern: KEBAB_CASE.source }),
      to: Type.Optional(Type.String()),
    }),
    execute: async ({ kind, name, to }, api, context) =>
      reply(await rollBackAndLog(home, kind, name, to, reconcile, (change) => api.commit(change, context), lock)),
  });
}
