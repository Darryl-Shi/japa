import { StringEnum, Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-durable";
import { cpSync, rmSync } from "node:fs";
import { join } from "node:path";
import { logChange } from "./changes.ts";
import { CHECK_KINDS, check } from "./check.ts";
import { KEBAB_CASE } from "./extension.ts";
import type { LoadError } from "./loader.ts";
import { commit, LKG, restorePath, revert } from "./workspace.ts";

type Kind = (typeof CHECK_KINDS)[number];

const reply = (text: string) => ({ content: [{ type: "text" as const, text }] });
const pathOf = (kind: Kind, name: string) => (kind === "worker" ? `workers/${name}.md` : `${kind}s/${name}`);

/** Restores a skill, worker profile or extension as it is at `to` and commits it; the sha, or undefined if unchanged. */
export function rollBack(home: string, kind: Kind, name: string, to = LKG): string | undefined {
  const path = pathOf(kind, name);
  restorePath(home, to, path);
  return commit(home, [path], `Roll back ${kind} ${name}`);
}

/**
 * The CoS's `install` tool: checks a skill, worker profile or extension in `<home>/.staging`, copies it into the
 * workspace, commits and reconciles it; when it fails to load, reverts and reconciles again. `loaded` tells whether a
 * skill or worker profile is loaded; `installed` runs after a successful install.
 */
export function installTool(
  home: string,
  reconcile: () => Promise<{ errors: LoadError[]; notices: string[] }>,
  loaded: (kind: "skill" | "worker", name: string) => boolean,
  installed: () => void,
) {
  return defineTool({
    name: "install",
    description:
      "Check and install the skill, worker profile or extension a builder job wrote to the staging workspace. Logged as a change you can undo.",
    parameters: Type.Object({ kind: StringEnum(CHECK_KINDS), name: Type.String({ pattern: KEBAB_CASE.source }) }),
    execute: async ({ kind, name }, api, context) => {
      const staging = join(home, ".staging");
      const problems = await check(kind, name, staging, home);
      if (problems.length > 0) return reply(`Not installed: ${problems.join("\n")}`);
      const path = pathOf(kind, name);
      rmSync(join(home, path), { recursive: true, force: true });
      cpSync(join(staging, path), join(home, path), { recursive: true });
      const sha = commit(home, [path], `Install ${kind} ${name}`);
      if (sha === undefined) return reply("Already installed.");

      const { errors, notices } = await reconcile();
      const failed = errors.filter((e) => e.name === (kind === "extension" ? name : `${kind}:${name}`)).map((e) => e.error);
      if (kind !== "extension" && failed.length === 0 && !loaded(kind, name)) failed.push("did not load");
      if (failed.length > 0) {
        revert(home, [sha]);
        await reconcile();
        return reply(`Not installed — ${failed.join("; ")}. Nothing changed.`);
      }
      const change = { title: `Installed ${kind} ${name}`, howToUse: "", undo: { commits: [sha] } };
      const id = await api.commit((tx) => logChange(tx, change), context);
      installed();
      return reply([`Installed ${kind} ${name}. (change ${id})`, ...notices].join(" "));
    },
  });
}

/** The CoS's `rollback` tool: restores a skill, worker profile or extension as it is at `to`, commits and reconciles. */
export function rollbackTool(home: string, reconcile: () => Promise<unknown>) {
  return defineTool({
    name: "rollback",
    description:
      "Roll a skill, worker profile or extension back to its last known good version, or to the git ref `to`. Logged as a change you can undo.",
    parameters: Type.Object({
      kind: StringEnum(CHECK_KINDS),
      name: Type.String({ pattern: KEBAB_CASE.source }),
      to: Type.Optional(Type.String()),
    }),
    execute: async ({ kind, name, to }, api, context) => {
      const sha = rollBack(home, kind, name, to);
      if (sha === undefined) return reply(`${kind} ${name} is already at that version.`);
      await reconcile();
      const change = { title: `Rolled back ${kind} ${name}`, howToUse: "", undo: { commits: [sha] } };
      await api.commit((tx) => logChange(tx, change), context);
      return reply(`Rolled back ${kind} ${name}.`);
    },
  });
}
