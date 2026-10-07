import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { JsonObject, ModelRef } from "@earendil-works/pi-durable";

/** Resolves the japa home directory: `$JAPA_HOME`, or `~/.japa` by default. */
export function japaHome(): string {
  return process.env.JAPA_HOME ?? join(homedir(), ".japa");
}

export type Settings = {
  models: { cos?: ModelRef; worker?: ModelRef; consolidation?: ModelRef };
  storage: { adapter: string } & JsonObject;
  secrets: { adapter: string } & JsonObject;
  jobs: { maxConcurrent: number };
  context: { resetTokens: number; idleResetHours: number; toolResultTokens: number };
  memory: { maxFacts: number; maxTokens: number };
  extensions: Record<string, JsonObject>;
};

export const DEFAULT_SETTINGS: Settings = {
  models: {},
  storage: { adapter: "sqlite" },
  secrets: { adapter: "file" },
  jobs: { maxConcurrent: 4 },
  context: { resetTokens: 20000, idleResetHours: 2, toolResultTokens: 2000 },
  memory: { maxFacts: 30, maxTokens: 1500 },
  extensions: {},
};

/** Reads `<home>/settings.json` merged over the defaults per top-level key; object-valued keys one level deep. */
export function loadSettings(home: string): Settings {
  const path = join(home, "settings.json");
  const user: Record<string, unknown> = existsSync(path) ? parseJson(path) : {};
  const merged: Record<string, unknown> = { ...DEFAULT_SETTINGS, ...user };
  for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
    merged[key] = { ...value, ...(user[key] as object) };
  }
  return merged as Settings;
}

function parseJson(path: string): Partial<Settings> {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid ${path}: ${message}`);
  }
}
