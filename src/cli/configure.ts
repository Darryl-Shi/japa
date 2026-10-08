// The extensions step of `japa setup` (design spec §4.4): per-extension secrets and settings, prompted from the
// manifest's declared `secrets` and settings schema, and the `setup.json` bookkeeping (§5.2) that lets
// `japa update` announce secrets and settings a later manifest adds.
import type { JsonValue } from "@earendil-works/chord";
import type { TSchema } from "@earendil-works/pi-ai";
import type { JsonObject } from "@earendil-works/pi-durable";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type JapaExtension, secretDescription, secretNames } from "../kernel/extension.ts";
import { message } from "../kernel/loader.ts";
import { settingsSchema } from "../kernel/settings-tools.ts";
import { readUserSettings, saveSettings, setPath, validateExtensionSettings } from "../kernel/settings.ts";
import type { SetupContext } from "./context.ts";
import type { Choice, Prompter } from "./prompt.ts";

type ObjectSchema = { properties?: Record<string, TSchema> };
type PropSchema = {
  type?: string;
  description?: string;
  default?: unknown;
  enum?: unknown[];
  anyOf?: { const?: unknown }[];
};

const propertiesOf = (schema: TSchema | undefined): Record<string, TSchema> =>
  (schema as ObjectSchema | undefined)?.properties ?? {};

/** The extensions with something to configure: a declared secret, or a settings schema -- `settingsSchema`, so a
 * messaging extension with no schema of its own still counts, for its added `owner` property. */
export function configurable(extensions: JapaExtension[]): JapaExtension[] {
  return extensions.filter((e) => secretNames(e).length > 0 || settingsSchema(e) !== undefined);
}

/** Whether `e`'s header should show "(configured)" (design spec §4.4): every declared secret is set and, if it
 * has a settings schema, `extensions.<name>` has been saved (to anything, not necessarily every property). */
export async function isConfigured(ctx: SetupContext, e: JapaExtension): Promise<boolean> {
  for (const name of secretNames(e)) {
    if ((await ctx.secrets.get(name)) === undefined) return false;
  }
  const schema = settingsSchema(e);
  if (schema === undefined) return true;
  const extensions = readUserSettings(ctx.home).extensions as Record<string, unknown> | undefined;
  return extensions?.[e.name] !== undefined;
}

/** "secret:<name>" for each declared secret, then "setting:<prop>" for each top-level settings property: what
 * `markOffered` records and `unseen` compares against. */
export function offerKeys(e: JapaExtension): string[] {
  const props = Object.keys(propertiesOf(settingsSchema(e)));
  return [...secretNames(e).map((name) => `secret:${name}`), ...props.map((prop) => `setting:${prop}`)];
}

type SetupFile = { offered: Record<string, string[]> };

/** `<home>/setup.json`; a missing or empty file means nothing has been offered yet. */
function readSetupFile(home: string): SetupFile {
  const path = join(home, "setup.json");
  if (!existsSync(path)) return { offered: {} };
  const text = readFileSync(path, "utf8").trim();
  return text === "" ? { offered: {} } : (JSON.parse(text) as SetupFile);
}

function writeSetupFile(home: string, data: SetupFile): void {
  writeFileSync(join(home, "setup.json"), `${JSON.stringify(data, null, 2)}\n`);
}

/** Records every one of `extensions`' `offerKeys` as offered in `<home>/setup.json`, merging with (never
 * dropping) what was already there, for other extensions or more keys of the same one. */
export function markOffered(home: string, extensions: JapaExtension[]): void {
  const data = readSetupFile(home);
  for (const e of extensions) {
    const seen = new Set(data.offered[e.name] ?? []);
    for (const key of offerKeys(e)) seen.add(key);
    data.offered[e.name] = [...seen];
  }
  writeSetupFile(home, data);
}

export type Unseen = { extension: JapaExtension; keys: string[]; isNew: boolean };

/**
 * Each configurable extension with secrets or settings `setup.json` hasn't recorded as offered (design spec
 * §5.2): a brand new extension, or new secrets/settings on one already offered. `isNew` is true only for the
 * former (no entry for it at all).
 */
export async function unseen(ctx: SetupContext): Promise<Unseen[]> {
  const { offered } = readSetupFile(ctx.home);
  const result: Unseen[] = [];
  for (const e of configurable(ctx.extensions)) {
    const already = offered[e.name];
    const keys = offerKeys(e).filter((key) => !already?.includes(key));
    if (keys.length > 0) result.push({ extension: e, keys, isNew: already === undefined });
  }
  return result;
}

/** The literal values of an `enum` or a union of literal `const`s; undefined for anything else. */
function enumValues(schema: PropSchema): unknown[] | undefined {
  if (Array.isArray(schema.enum)) return schema.enum;
  if (Array.isArray(schema.anyOf) && schema.anyOf.every((s) => "const" in s)) return schema.anyOf.map((s) => s.const);
  return undefined;
}

const YES_NO: Choice<boolean>[] = [
  { label: "Yes", value: true },
  { label: "No", value: false },
];

/**
 * Prompts for one property of a settings schema, by its type (design spec §4.4), updating `next[prop]` in
 * place; returns whether it actually changed. A blank text answer unsets an already-set property, or leaves an
 * unset one alone. A number/integer property re-prompts on a non-number answer. Other types (objects, arrays)
 * are not prompted: `next` is left untouched and the wizard notes where to edit them instead.
 */
async function promptProperty(
  p: Prompter,
  extensionName: string,
  next: JsonObject,
  prop: string,
  raw: TSchema,
): Promise<boolean> {
  const schema = raw as PropSchema;
  const help = schema.description;
  const before = next[prop];
  const initial = before ?? (schema.default as JsonValue | undefined);
  const prefill = initial === undefined ? undefined : String(initial);

  const values = enumValues(schema);
  if (values !== undefined) {
    const choices: Choice<JsonValue>[] = values.map((value) => ({ label: String(value), value: value as JsonValue }));
    const value = await p.select(prop, choices, initial);
    next[prop] = value;
    return value !== before;
  }

  switch (schema.type) {
    case "string": {
      const text = await p.text(prop, { initial: prefill, help });
      if (text === "") {
        if (before === undefined) return false;
        delete next[prop];
        return true;
      }
      next[prop] = text;
      return text !== before;
    }
    case "number":
    case "integer":
      for (;;) {
        const text = await p.text(prop, { initial: prefill, help });
        if (text === "") {
          if (before === undefined) return false;
          delete next[prop];
          return true;
        }
        const n = Number(text);
        if (Number.isNaN(n)) {
          p.note(`${prop} must be a number`);
          continue;
        }
        next[prop] = n;
        return n !== before;
      }
    case "boolean": {
      const value = await p.select(prop, YES_NO, initial as boolean | undefined);
      next[prop] = value;
      return value !== before;
    }
    default:
      p.note(`edit extensions.${extensionName}.${prop} in settings.json or ask the CoS`);
      return false;
  }
}

/** The top-level property named by the first path in a `validateExtensionSettings` error message. */
function failingProperty(error: string, extensionName: string): string {
  const path = error.split("; ")[0]!.split(":")[0]!.trim();
  const prefix = `extensions.${extensionName}.`;
  const rest = path.startsWith(prefix) ? path.slice(prefix.length) : path;
  return rest.split(".")[0]!;
}

/**
 * Prompts for `e`'s secrets and settings (design spec §4.4): each secret as masked input with its description as
 * help (blank leaves it unset), then each settings property by type. The resulting `extensions.<name>` is
 * validated; on failure the wizard shows the error and re-prompts the failing property. Returns whether anything
 * was actually written.
 */
export async function configureExtension(ctx: SetupContext, p: Prompter, e: JapaExtension): Promise<boolean> {
  let saved = false;

  for (const name of secretNames(e)) {
    const value = await p.secret(name, secretDescription(e, name));
    if (value === "") continue;
    await ctx.secrets.set(name, value);
    saved = true;
  }

  const schema = settingsSchema(e);
  if (schema === undefined) return saved;

  const properties = propertiesOf(schema);
  const user = readUserSettings(ctx.home);
  const extensions = (user.extensions as Record<string, JsonObject> | undefined) ?? {};
  const next: JsonObject = { ...(extensions[e.name] ?? {}) };

  let changed = false;
  for (const prop of Object.keys(properties)) {
    if (await promptProperty(p, e.name, next, prop, properties[prop]!)) changed = true;
  }

  let valid: JsonObject;
  for (;;) {
    try {
      valid = validateExtensionSettings(e.name, schema, next);
      break;
    } catch (error) {
      const text = message(error);
      p.note(text);
      const prop = failingProperty(text, e.name);
      if (await promptProperty(p, e.name, next, prop, properties[prop]!)) changed = true;
    }
  }

  if (changed) {
    setPath(user, `extensions.${e.name}`, valid);
    saveSettings(ctx.home, user);
    saved = true;
  }

  return saved;
}

/**
 * The extensions step (design spec §4.4): for each of `only` (default every configurable extension), in name
 * order, shows its header and asks whether to configure it. Afterwards records every configurable extension as
 * offered (§5.2), whether or not the user configured it. Returns whether anything was saved.
 */
export async function configureStep(ctx: SetupContext, p: Prompter, only?: JapaExtension[]): Promise<boolean> {
  const all = configurable(ctx.extensions);
  let saved = false;

  for (const e of (only ?? all).toSorted((a, b) => a.name.localeCompare(b.name))) {
    const configured = await isConfigured(ctx, e);
    p.note(`${e.name}: ${e.summary}${configured ? " (configured)" : ""}`);
    if (await p.confirm(`Configure ${e.name}?`, false)) {
      if (await configureExtension(ctx, p, e)) saved = true;
    }
  }

  markOffered(ctx.home, all);
  return saved;
}
