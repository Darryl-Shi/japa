import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { type Models, type TSchema, Type, validateToolArguments } from "@earendil-works/pi-ai";
import type { JsonObject, ModelRef } from "@earendil-works/pi-durable";
import { message } from "./loader.ts";

/** Resolves the japa home directory: `$JAPA_HOME`, or `~/.japa` by default. */
export function japaHome(): string {
  return process.env.JAPA_HOME ?? join(homedir(), ".japa");
}

export type Settings = {
  models: { cos?: ModelRef; worker?: ModelRef; consolidation?: ModelRef };
  storage: { adapter: string } & JsonObject;
  secrets: { adapter: string } & JsonObject;
  jobs: { maxConcurrent: number; keepFinishedDays: number };
  context: { toolResultTokens: number };
  memory: { maxFacts: number; maxTokens: number };
  safety: { toolErrorThreshold: number; goodAfterMinutes: number };
  extensions: Record<string, JsonObject>;
};

export const DEFAULT_SETTINGS: Settings = {
  models: {},
  storage: { adapter: "sqlite" },
  secrets: { adapter: "file" },
  jobs: { maxConcurrent: 4, keepFinishedDays: 7 },
  context: { toolResultTokens: 2000 },
  memory: { maxFacts: 30, maxTokens: 1500 },
  safety: { toolErrorThreshold: 5, goodAfterMinutes: 10 },
  extensions: {},
};

/** The kernel keys' schema; `extensions.<name>` is checked against that extension's own schema. */
const Ref = Type.Object({ provider: Type.String(), modelId: Type.String() });
const settingsSchema = Type.Object({
  models: Type.Object({ cos: Ref, worker: Type.Optional(Ref), consolidation: Type.Optional(Ref) }),
  storage: Type.Object({ adapter: Type.String() }),
  secrets: Type.Object({ adapter: Type.String() }),
  jobs: Type.Object({ maxConcurrent: Type.Integer({ minimum: 1 }), keepFinishedDays: Type.Integer({ minimum: 1 }) }),
  context: Type.Record(Type.String(), Type.Number({ exclusiveMinimum: 0 })),
  memory: Type.Record(Type.String(), Type.Integer({ minimum: 1 })),
  safety: Type.Object({
    toolErrorThreshold: Type.Integer({ minimum: 1 }),
    goodAfterMinutes: Type.Number({ exclusiveMinimum: 0 }),
  }),
  extensions: Type.Record(Type.String(), Type.Object({})),
});

/** Reads `<home>/settings.json` merged over the defaults per top-level key; object-valued keys one level deep. */
export function loadSettings(home: string): Settings {
  return mergeSettings(readUserSettings(home));
}

/** The keys the user set in `<home>/settings.json`. */
export function readUserSettings(home: string): JsonObject {
  const path = join(home, "settings.json");
  return existsSync(path) ? parseJson(path) : {};
}

/** Writes the user's keys to `<home>/settings.json`. */
export function saveSettings(home: string, user: JsonObject): void {
  writeFileSync(join(home, "settings.json"), `${JSON.stringify(user, null, 2)}\n`);
}

export function mergeSettings(user: JsonObject): Settings {
  const merged: Record<string, unknown> = { ...DEFAULT_SETTINGS, ...user };
  for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
    merged[key] = { ...value, ...(user[key] as object) };
  }
  return merged as Settings;
}

/**
 * A validated copy of `settings`, with values converted where the schema allows ("2" to 2); throws listing the
 * invalid paths. `schemas` holds the extensions' settings schemas, by name.
 */
export function validateSettings(settings: Settings, schemas: Record<string, TSchema>): Settings {
  const valid: Settings = check(settingsSchema, settings, "");
  for (const [name, schema] of Object.entries(schemas)) {
    const value = valid.extensions[name];
    if (value !== undefined) valid.extensions[name] = check(schema, value, `extensions.${name}.`);
  }
  return valid;
}

/**
 * A validated copy of `value` against `schema` alone, for `extensions.<name>` (unlike `validateSettings`, this
 * does not require the kernel settings to be complete, e.g. `models.cos` set); throws listing the invalid paths,
 * each prefixed `extensions.<name>.`.
 */
export function validateExtensionSettings(name: string, schema: TSchema, value: JsonObject): JsonObject {
  return check(schema, value, `extensions.${name}.`);
}

function check(schema: TSchema, value: object, prefix: string) {
  try {
    const tool = { name: "settings", description: "", parameters: schema };
    return validateToolArguments(tool, { type: "toolCall", id: "", name: "settings", arguments: { ...value } });
  } catch (error) {
    // Keep only its "  - <path>: <problem>" lines, if any.
    const lines = message(error).split("\n").filter((l) => l.startsWith("  - "));
    throw new Error(lines.length ? lines.map((l) => prefix + l.slice(4)).join("; ") : message(error));
  }
}

/** Throws `Unknown model <provider>/<modelId>` if `models` lacks `ref`. */
export function checkModel(models: Models, ref: ModelRef): void {
  if (models.getModel(ref.provider, ref.modelId) === undefined) {
    throw new Error(`Unknown model ${ref.provider}/${ref.modelId}`);
  }
}

export function getPath(obj: object, path: string): unknown {
  return path.split(".").reduce<any>((o, key) => o?.[key], obj);
}

/** Sets the value at dotted `path`, creating objects on the way; `undefined` deletes the key. */
export function setPath(obj: object, path: string, value: unknown): void {
  const keys = path.split(".");
  if (keys.some((k) => ["__proto__", "constructor", "prototype"].includes(k))) throw new Error("invalid path");
  const last = keys.pop()!;
  const parent = keys.reduce<any>((o, key) => (o[key] ??= {}), obj);
  if (value === undefined) delete parent[last];
  else parent[last] = value;
}

function parseJson(path: string): JsonObject {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid ${path}: ${message}`);
  }
}
