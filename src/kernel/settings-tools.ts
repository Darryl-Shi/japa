import { type Models, type TSchema, Type } from "@earendil-works/pi-ai";
import { configure, defineTool, type JsonObject, ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { ChangesDoc, type Commit, type ConfigOp, logChange } from "./changes.ts";
import type { JapaExtension } from "./extension.ts";
import { message } from "./loader.ts";
import { revert } from "./workspace.ts";
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

/** The schema for `settings.extensions.<e.name>`: `e.settings`, plus a string `owner` when `e` provides messaging. */
export function settingsSchema(e: JapaExtension): TSchema | undefined {
  if (!e.provides?.messaging) return e.settings;
  const properties = (e.settings as { properties?: Record<string, TSchema> } | undefined)?.properties;
  const description = `Your ${e.name} user id. Leave blank, message the bot, and it replies with your id.`;
  return Type.Object({ ...properties, owner: Type.Optional(Type.String({ description })) });
}

export type SettingsDeps = {
  home: string;
  settings: Settings;
  models: Models;
  extensions: () => JapaExtension[];
  /** Runs after each settings change. */
  changed: () => void;
};

/** The settings `user` gives, validated against the extensions' schemas and the registered models. */
function validate({ models, extensions }: SettingsDeps, user: JsonObject): Settings {
  const schemas = Object.fromEntries(
    extensions().flatMap((e) => {
      const schema = settingsSchema(e);
      return schema ? [[e.name, schema]] : [];
    }),
  );
  const next = validateSettings(mergeSettings(user), schemas);
  for (const ref of Object.values(next.models)) if (ref !== undefined) checkModel(models, ref);
  return next;
}

/**
 * Sets the JSON value at a dotted settings path, live and in place, and logs the change; the reply for the user,
 * `Not changed: <reason>` when it is invalid.
 */
export async function setSetting(
  deps: SettingsDeps,
  path: string,
  value: unknown,
  commit: Commit,
  label: { title?: string; howToUse?: string } = {},
): Promise<string> {
  const { home, settings } = deps;
  const user = readUserSettings(home);
  const before = getPath(user, path) as ConfigOp["before"];
  let next: Settings;
  try {
    setPath(user, path, value);
    next = validate(deps, user);
  } catch (error) {
    return `Not changed: ${message(error)}`;
  }
  const valid = getPath(next, path);
  if (typeof valid !== "object") setPath(user, path, valid); // as validated, e.g. "2" converted to 2
  saveSettings(home, user);
  Object.assign(settings, next);
  deps.changed();
  const configOps = [before === undefined ? { path } : { path, before }];
  const { title = `Set ${path}`, howToUse = "" } = label;
  const change = { title, howToUse, undo: { commits: [], configOps } };
  const id = await commit(async (tx) => {
    await configure(tx, ROOT_CONVERSATION_ID, { model: next.models.cos! });
    return logChange(tx, change);
  });
  const restart = ["storage", "secrets"].includes(path.split(".")[0]!) ? " Takes effect after a restart." : "";
  return `Set ${path}. (change ${id})${restart}`;
}

/** The CoS's tools to read and change settings and to list and undo changes; `reconcile` runs after undoing commits. */
export function settingsTools(deps: SettingsDeps, reconcile: () => Promise<unknown>) {
  const { home, settings, changed } = deps;

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
    execute: async ({ path, value, title, howToUse }, api, context) =>
      reply(await setSetting(deps, path, value, (change) => api.commit(change, context), { title, howToUse })),
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
      const { call } = change.undo;
      if (call) return reply(`To undo this, call ${call.tool} with ${JSON.stringify(call.args)}.`);
      if (change.undo.commits.length > 0) {
        try {
          revert(home, change.undo.commits);
        } catch (error) {
          return reply(`Not undone: ${message(error)}`);
        }
        await reconcile();
      }
      const { configOps } = change.undo;
      let next: Settings | undefined;
      if (configOps) {
        const user = readUserSettings(home);
        for (const op of configOps.toReversed()) setPath(user, op.path, op.before);
        try {
          next = validate(deps, user);
        } catch (error) {
          return reply(`Not undone: ${message(error)}`);
        }
        saveSettings(home, user);
        Object.assign(settings, next);
        changed();
      }
      await api.commit(async (tx) => {
        if (next) await configure(tx, ROOT_CONVERSATION_ID, { model: next.models.cos! });
        const doc = await tx.doc(ChangesDoc, ROOT_CONVERSATION_ID);
        doc.changes = doc.changes.filter((c) => c.id !== id);
      }, context);
      return reply(`Undid: ${change.title}`);
    },
  });

  return [settingsGet, settingsSet, changesList, changeUndo];
}
