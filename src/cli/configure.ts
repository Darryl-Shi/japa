// The extensions step of `japa setup` (design spec §4.4): per-extension secrets and settings, prompted from the
// manifest's declared `secrets` and settings schema, and the `setup.json` bookkeeping (§5.2) that lets
// `japa update` announce new extensions, and secrets and settings a later manifest adds.
import type { JsonValue } from "@earendil-works/chord";
import type { TSchema } from "@earendil-works/pi-ai";
import type { JsonObject } from "@earendil-works/pi-durable";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { askedSecretNames, type AuthorizeContext, type JapaExtension, secretDescription } from "../kernel/extension.ts";
import { message } from "../kernel/loader.ts";
import { settingsSchema } from "../kernel/settings-tools.ts";
import { readUserSettings, saveSettings, setPath, validateExtensionSettings } from "../kernel/settings.ts";
import { interactionFor, openInBrowser, quittable } from "./auth-interaction.ts";
import type { SetupContext } from "./context.ts";
import { Cancelled, type Choice, type Prompter } from "./prompt.ts";

export type ConfigureOptions = {
  /** Opens a sign-in link in the user's browser, when there is one to open it in. */
  openUrl?: (url: string) => void;
};

type ObjectSchema = { properties?: Record<string, TSchema>; required?: string[] };
type PropSchema = {
  type?: string;
  description?: string;
  default?: unknown;
  enum?: unknown[];
  anyOf?: { const?: unknown }[];
};

const propertiesOf = (schema: TSchema | undefined): Record<string, TSchema> =>
  (schema as ObjectSchema | undefined)?.properties ?? {};

/**
 * The settings properties `japa setup` asks for: the required ones without a default. Everything optional has a
 * default (or works unset), so it needs no setup; the user can still change it by asking japa.
 */
function askedProperties(e: JapaExtension): Record<string, TSchema> {
  const schema = settingsSchema(e) as ObjectSchema | undefined;
  const required = new Set(schema?.required ?? []);
  const properties = propertiesOf(schema);
  return Object.fromEntries(
    Object.entries(properties).filter(([prop, s]) => required.has(prop) && (s as PropSchema).default === undefined),
  );
}

/** The extensions that need the user for something: a secret they don't generate, a required setting, or signing
 * in. An extension whose settings all have defaults -- like the desktop -- works without any setup. */
export function configurable(extensions: JapaExtension[]): JapaExtension[] {
  return extensions.filter(
    (e) =>
      e.authorize !== undefined || askedSecretNames(e).length > 0 || Object.keys(askedProperties(e)).length > 0,
  );
}

/** What `e`'s authorize hook sees in setup: its saved settings and the secrets store, no daemon needed. */
export function authorizeContext(ctx: SetupContext, e: JapaExtension): AuthorizeContext {
  return {
    home: ctx.home,
    settings: () => (readUserSettings(ctx.home).extensions as Record<string, JsonObject> | undefined)?.[e.name] ?? {},
    secret: (name) => ctx.secrets.get(name),
    setSecret: (name, value) => ctx.secrets.set(name, value),
  };
}

/** Whether `e` is set up: every secret setup asks for is set, every required setting is saved, and it's signed in
 * when it has an authorize hook. */
export async function isConfigured(ctx: SetupContext, e: JapaExtension): Promise<boolean> {
  for (const name of askedSecretNames(e)) {
    if ((await ctx.secrets.get(name)) === undefined) return false;
  }
  const extensions = readUserSettings(ctx.home).extensions as Record<string, Record<string, unknown>> | undefined;
  if (!Object.keys(askedProperties(e)).every((prop) => extensions?.[e.name]?.[prop] !== undefined)) return false;
  return e.authorize === undefined || (await e.authorize.connected(authorizeContext(ctx, e)));
}

/** "secret:<name>" for each secret setup asks for, then "setting:<prop>" for each setting it asks for: what
 * `markOffered` records and `unseen` compares against, so `japa update` only announces things needing the user. */
export function offerKeys(e: JapaExtension): string[] {
  const props = Object.keys(askedProperties(e));
  return [...askedSecretNames(e).map((name) => `secret:${name}`), ...props.map((prop) => `setting:${prop}`)];
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

/** Records `extensions` and every one of their `offerKeys` as offered in `<home>/setup.json` -- an extension with
 * nothing to configure under no keys, so it's still known as seen -- merging with (never dropping) what was
 * already there, for other extensions or more keys of the same one. */
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
 * What `setup.json` hasn't recorded as offered (design spec §5.2): a brand new extension (`isNew`: no entry for it
 * at all), even one with nothing to configure, or new secrets/settings on one already offered.
 */
export async function unseen(ctx: SetupContext): Promise<Unseen[]> {
  const { offered } = readSetupFile(ctx.home);
  const result: Unseen[] = [];
  for (const e of ctx.extensions) {
    const already = offered[e.name];
    const keys = offerKeys(e).filter((key) => !already?.includes(key));
    if (already === undefined || keys.length > 0) result.push({ extension: e, keys, isNew: already === undefined });
  }
  return result;
}

/** The literal values of an `enum` or a union of literal `const`s; undefined for anything else. */
function enumValues(schema: PropSchema): unknown[] | undefined {
  if (Array.isArray(schema.enum)) return schema.enum;
  if (Array.isArray(schema.anyOf) && schema.anyOf.every((s) => "const" in s)) return schema.anyOf.map((s) => s.const);
  return undefined;
}

/** Whether `promptProperty` can actually prompt for this property: string/number/integer/boolean, or an
 * enum/union of literals -- the only branches that await a new answer. Everything else (objects, arrays, ...)
 * falls to its "edit settings.json" note without awaiting input, so the validate-and-reprompt loop below must
 * not retry on those: it would never make progress. */
function promptable(schema: PropSchema): boolean {
  return enumValues(schema) !== undefined || ["string", "number", "integer", "boolean"].includes(schema.type ?? "");
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
  // The description says what it is in words; the property name is for settings.json.
  const question = schema.description ?? prop;
  const before = next[prop];
  const initial = before ?? (schema.default as JsonValue | undefined);
  const prefill = initial === undefined ? undefined : String(initial);

  const values = enumValues(schema);
  if (values !== undefined) {
    const choices: Choice<JsonValue>[] = values.map((value) => ({ label: String(value), value: value as JsonValue }));
    const value = await p.select(question, choices, initial);
    next[prop] = value;
    return value !== before;
  }
  const help = before === undefined ? "Enter skips" : "clear it to unset";

  switch (schema.type) {
    case "string": {
      const text = await p.text(question, { initial: prefill, help });
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
        const text = await p.text(question, { initial: prefill, help });
        if (text === "") {
          if (before === undefined) return false;
          delete next[prop];
          return true;
        }
        const n = Number(text);
        if (Number.isNaN(n)) {
          p.warn(`${question}: enter a number`);
          continue;
        }
        next[prop] = n;
        return n !== before;
      }
    case "boolean": {
      const value = await p.select(question, YES_NO, initial as boolean | undefined);
      next[prop] = value;
      return value !== before;
    }
    default:
      p.note(`To change "${question}", ask japa, or edit extensions.${extensionName}.${prop} in settings.json.`);
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
 * Offers to sign in to `e` (design spec §3.2): again (default No) when it's connected, else now (default Yes); not
 * while a secret setup asks for is unset (the sign-in needs it), saying so instead. The flow runs through the
 * terminal; a failure says why and asks whether to try again. Quitting at one of its prompts aborts the flow (and
 * its loopback listener) and rethrows `Cancelled`. Returns whether it signed in.
 */
async function signIn(
  ctx: SetupContext,
  p: Prompter,
  e: JapaExtension,
  openUrl: (url: string) => void,
): Promise<boolean> {
  for (const name of askedSecretNames(e)) {
    if ((await ctx.secrets.get(name)) === undefined) {
      p.note(`Sign in to ${e.name} once its secrets are set: rerun japa setup or ask japa.`);
      return false;
    }
  }
  const authorize = e.authorize!;
  const actx = authorizeContext(ctx, e);
  const yes = (await authorize.connected(actx))
    ? await p.confirm("Sign in again?", false)
    : await p.confirm("Sign in now?", true);
  if (!yes) return false;

  for (;;) {
    const { asking, signal, quit } = quittable(p);
    try {
      p.note(await authorize.run(actx, interactionFor(asking, openUrl, signal)));
      return true;
    } catch (error) {
      if (quit()) throw new Cancelled();
      p.warn(`Couldn't sign in: ${message(error)}`);
    }
    if (!(await p.confirm("Try signing in again?", true))) return false;
  }
}

/**
 * Prompts for what `e` needs from the user: each secret it doesn't generate, as masked input under its
 * description (blank leaves it as is), then signing in when it has an authorize hook, then each required setting
 * by type. The resulting `extensions.<name>` is validated; on failure the wizard shows the error and re-prompts
 * the failing property. If that property can't be prompted for (an object, array, or other non-primitive type),
 * the wizard notes the edit-by-hand hint instead and returns without saving -- it never re-validates the same
 * value without having awaited a new answer. Returns whether anything was actually written (or signed in).
 */
export async function configureExtension(
  ctx: SetupContext,
  p: Prompter,
  e: JapaExtension,
  opts: ConfigureOptions = {},
): Promise<boolean> {
  const { openUrl = openInBrowser } = opts;
  let saved = false;

  for (const name of askedSecretNames(e)) {
    const stored = (await ctx.secrets.get(name)) !== undefined;
    const value = await p.secret(secretDescription(e, name) ?? name, {
      help: stored ? "Enter keeps the current one" : "Enter skips",
    });
    if (value === "") continue;
    await ctx.secrets.set(name, value);
    saved = true;
  }

  if (e.authorize !== undefined && (await signIn(ctx, p, e, openUrl))) saved = true;

  const schema = settingsSchema(e);
  if (schema === undefined) return saved;

  const properties = propertiesOf(schema);
  const asked = askedProperties(e);
  if (Object.keys(asked).length === 0) return saved;
  const user = readUserSettings(ctx.home);
  const extensions = (user.extensions as Record<string, JsonObject> | undefined) ?? {};
  const next: JsonObject = { ...(extensions[e.name] ?? {}) };

  let changed = false;
  for (const prop of Object.keys(asked)) {
    if (await promptProperty(p, e.name, next, prop, asked[prop]!)) changed = true;
  }

  let valid: JsonObject;
  for (;;) {
    try {
      valid = validateExtensionSettings(e.name, schema, next);
      break;
    } catch (error) {
      const text = message(error);
      p.warn(text);
      const prop = failingProperty(text, e.name);
      const propSchema = properties[prop]!;
      if (!promptable(propSchema)) {
        await promptProperty(p, e.name, next, prop, propSchema); // notes the edit-by-hand hint; can't fix this here
        return saved;
      }
      if (await promptProperty(p, e.name, next, prop, propSchema)) changed = true;
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
 * The integrations step: offers every configurable extension (default) or just `only`, in name order, as one
 * multi-select -- nothing preselected, so Enter skips them all -- and configures each one picked. Afterwards
 * records every extension as offered (design spec §5.2), whether or not the user configured it. Returns whether
 * anything was saved.
 */
export async function configureStep(
  ctx: SetupContext,
  p: Prompter,
  only?: JapaExtension[],
  opts: ConfigureOptions = {},
): Promise<boolean> {
  const extensions = (only ?? configurable(ctx.extensions)).toSorted((a, b) => a.name.localeCompare(b.name));
  let saved = false;

  if (extensions.length > 0) {
    const choices: Choice<JapaExtension>[] = [];
    for (const e of extensions) {
      const configured = await isConfigured(ctx, e);
      choices.push({ label: e.name, value: e, hint: `${e.summary}${configured ? " (set up)" : ""}` });
    }
    const chosen = await p.multiselect("Set up any integrations now? You can also do it later, or ask japa", choices, []);
    for (const e of chosen) {
      p.note(`${e.name}: ${e.summary}`);
      if (await configureExtension(ctx, p, e, opts)) saved = true;
    }
  }

  markOffered(ctx.home, ctx.extensions);
  return saved;
}
