import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { JsonObject, ModelRef } from "@earendil-works/pi-durable";

/** Resolves the japa home directory: `$JAPA_HOME`, or `~/.japa` by default. */
export function japaHome(): string {
  return process.env.JAPA_HOME ?? join(homedir(), ".japa");
}

export type Settings = {
  models: { cos?: ModelRef; worker?: ModelRef };
  storage: { adapter: string } & JsonObject;
  secrets: { adapter: string } & JsonObject;
  jobs: { maxConcurrent: number };
  extensions: Record<string, JsonObject>;
};

export const DEFAULT_SETTINGS: Settings = {
  models: {},
  storage: { adapter: "sqlite" },
  secrets: { adapter: "file" },
  jobs: { maxConcurrent: 4 },
  extensions: {},
};

/** Reads `<home>/settings.json` merged over the defaults per top-level key; `storage`, `secrets` and `jobs` one level deep. */
export function loadSettings(home: string): Settings {
  const path = join(home, "settings.json");
  const user = existsSync(path) ? parseJson(path) : {};
  return {
    ...DEFAULT_SETTINGS,
    ...user,
    storage: { ...DEFAULT_SETTINGS.storage, ...user.storage },
    secrets: { ...DEFAULT_SETTINGS.secrets, ...user.secrets },
    jobs: { ...DEFAULT_SETTINGS.jobs, ...user.jobs },
  };
}

function parseJson(path: string): Partial<Settings> {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid ${path}: ${message}`);
  }
}
