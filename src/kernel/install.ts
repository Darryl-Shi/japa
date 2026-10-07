import { StringEnum, Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-durable";
import { cpSync, rmSync } from "node:fs";
import { join } from "node:path";
import { logChange } from "./changes.ts";
import { CHECK_KINDS, check } from "./check.ts";
import { KEBAB_CASE } from "./extension.ts";
import type { LoadError } from "./loader.ts";
import { commit, revert } from "./workspace.ts";

const reply = (text: string) => ({ content: [{ type: "text" as const, text }] });

/**
 * The CoS's `install` tool: checks a skill, worker profile or extension in `<home>/.staging`, copies it into the
 * workspace, commits and reconciles it; when it fails to load, reverts and reconciles again. `loaded` tells whether a
 * skill or worker profile is loaded.
 */
export function installTool(
  home: string,
  reconcile: () => Promise<{ errors: LoadError[]; notices: string[] }>,
  loaded: (kind: "skill" | "worker", name: string) => boolean,
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
      const path = kind === "worker" ? `workers/${name}.md` : `${kind}s/${name}`;
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
      return reply([`Installed ${kind} ${name}. (change ${id})`, ...notices].join(" "));
    },
  });
}
