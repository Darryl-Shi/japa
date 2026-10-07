import { type Models, Type } from "@earendil-works/pi-ai";
import { configure, defineTool, type JsonObject, ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { ChangesDoc, type ConfigOp, logChange } from "./changes.ts";
import type { JapaExtension } from "./extension.ts";
import { message } from "./loader.ts";
import {
  checkModel,
  getPath,
  mergeSettings,
  readUserSettings,
  type Settings,
  saveSettings,
  setPath,
  validateSettings,
} from "./settings.ts";

const reply = (text: string) => ({ content: [{ type: "text" as const, text }] });

/**
 * The CoS's tools to read and change settings (live, in place) and to list and undo changes; `changed` runs after
 * each settings change.
 */
export function settingsTools(
  home: string,
  settings: Settings,
  models: Models,
  extensions: JapaExtension[],
  changed: () => void,
) {
  const schemas = Object.fromEntries(extensions.flatMap((e) => (e.settings ? [[e.name, e.settings]] : [])));
  const validate = (user: JsonObject) => {
    const next = validateSettings(mergeSettings(user), schemas);
    for (const ref of Object.values(next.models)) if (ref !== undefined) checkModel(models, ref);
    return next;
  };

  const settingsGet = defineTool({
    name: "settings_get",
    description: "Show the settings, or the value at a dotted path such as jobs.maxConcurrent.",
    parameters: Type.Object({ path: Type.Optional(Type.String()) }),
    execute: async ({ path }) =>
      reply(JSON.stringify(path === undefined ? settings : getPath(settings, path), null, 2) ?? "Not set."),
  });

  const settingsSet = defineTool({
    name: "settings_set",
    description:
      "Set the JSON value at a dotted settings path, such as jobs.maxConcurrent. Logged as a change you can undo.",
    parameters: Type.Object({
      path: Type.String(),
      value: Type.Unknown(),
      title: Type.Optional(Type.String()),
      howToUse: Type.Optional(Type.String()),
    }),
    execute: async ({ path, value, title, howToUse }, api, context) => {
      const user = readUserSettings(home);
      const before = getPath(user, path) as ConfigOp["before"];
      let next: Settings;
      try {
        setPath(user, path, value);
        next = validate(user);
      } catch (error) {
        return reply(`Not changed: ${message(error)}`);
      }
      const valid = getPath(next, path);
      if (typeof valid !== "object") setPath(user, path, valid); // as validated, e.g. "2" converted to 2
      saveSettings(home, user);
      Object.assign(settings, next);
      changed();
      const configOps = [before === undefined ? { path } : { path, before }];
      const change = { title: title ?? `Set ${path}`, howToUse: howToUse ?? "", undo: { commits: [], configOps } };
      const id = await api.commit(async (tx) => {
        await configure(tx, ROOT_CONVERSATION_ID, { model: next.models.cos! });
        return logChange(tx, change);
      }, context);
      const restart = ["storage", "secrets"].includes(path.split(".")[0]!) ? " Takes effect after a restart." : "";
      return reply(`Set ${path}. (change ${id})${restart}`);
    },
  });

  const changesList = defineTool({
    name: "changes_list",
    description: "List the changes made to japa, newest first.",
    parameters: Type.Object({}),
    execute: async (_args, api, context) => {
      const { changes } = (await api.snapshot(ChangesDoc, ROOT_CONVERSATION_ID, context))!;
      const lines = changes.toReversed().map((c) => `${c.id} ${new Date(c.at).toISOString()} ${c.title}`);
      return reply(lines.length ? lines.join("\n") : "No changes yet.");
    },
  });

  const changeUndo = defineTool({
    name: "change_undo",
    description: "Undo the change with this id.",
    parameters: Type.Object({ id: Type.String() }),
    execute: async ({ id }, api, context) => {
      const { changes } = (await api.snapshot(ChangesDoc, ROOT_CONVERSATION_ID, context))!;
      const change = changes.find((c) => c.id === id);
      if (change === undefined) return reply(`No change ${id}.`);
      if (change.undo.commits.length > 0) return reply("Can't undo that yet.");
      const user = readUserSettings(home);
      for (const op of (change.undo.configOps ?? []).toReversed()) setPath(user, op.path, op.before);
      let next: Settings;
      try {
        next = validate(user);
      } catch (error) {
        return reply(`Not undone: ${message(error)}`);
      }
      saveSettings(home, user);
      Object.assign(settings, next);
      changed();
      await api.commit(async (tx) => {
        await configure(tx, ROOT_CONVERSATION_ID, { model: next.models.cos! });
        const doc = await tx.doc(ChangesDoc, ROOT_CONVERSATION_ID);
        doc.changes = doc.changes.filter((c) => c.id !== id);
      }, context);
      return reply(`Undid: ${change.title}`);
    },
  });

  return [settingsGet, settingsSet, changesList, changeUndo];
}
