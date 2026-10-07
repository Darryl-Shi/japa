import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { ModelsStore, ModelsStoreEntry } from "@earendil-works/pi-ai";

/** Shared private-file helpers; parser errors must never include file contents. */
export async function readJson(filename: string): Promise<unknown> {
  let text: string;
  try {
    text = await readFile(filename, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Invalid JSON in ${filename}; refusing to overwrite it.`);
  }
}

export async function writeJson(
  filename: string,
  value: unknown,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  await mkdir(dirname(filename), { recursive: true, mode: 0o700 });
  const temporary = `${filename}.${randomUUID()}.tmp`;
  try {
    const file = await open(temporary, "wx", 0o600);
    try {
      await file.chmod(0o600);
      await file.writeFile(JSON.stringify(value, null, 2) + "\n", "utf8");
      await file.sync();
    } finally {
      await file.close();
    }
    signal?.throwIfAborted();
    await rename(temporary, filename);
  } finally {
    await rm(temporary, { force: true });
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validEntry(
  value: unknown,
  provider: string,
): value is ModelsStoreEntry {
  const number = (v: unknown) =>
    typeof v === "number" && Number.isFinite(v) && v >= 0;
  return (
    record(value) &&
    (value.etag === undefined || typeof value.etag === "string") &&
    (value.checkedAt === undefined || number(value.checkedAt)) &&
    (value.lastModified === undefined || number(value.lastModified)) &&
    Array.isArray(value.models) &&
    value.models.every((model: unknown) => {
      if (!record(model)) return false;
      const cost = model.cost;
      return (
        model.provider === provider &&
        [model.id, model.name, model.api].every(
          (v) => typeof v === "string" && !!v.trim(),
        ) &&
        typeof model.baseUrl === "string" &&
        Array.isArray(model.input) &&
        model.input.every((v) => typeof v === "string") &&
        record(cost) &&
        ["input", "output", "cacheRead", "cacheWrite"].every((k) =>
          number(cost[k]),
        ) &&
        ((model.type !== undefined && model.type !== "chat") ||
          (typeof model.reasoning === "boolean" &&
            number(model.contextWindow) &&
            number(model.maxTokens)))
      );
    })
  );
}

// Native Models owns generations/publication; the store only serializes atomic disk mutations.
// Like credentials, the enclosing application owns the cross-process home lock.
const mutations = new Map<string, Promise<void>>();
function mutate(
  filename: string,
  signal: AbortSignal | undefined,
  work: () => Promise<void>,
) {
  const result = (mutations.get(filename) ?? Promise.resolve()).then(() => {
    signal?.throwIfAborted();
    return work();
  });
  const settled = result.catch(() => {});
  mutations.set(filename, settled);
  void settled.then(() => {
    if (mutations.get(filename) === settled) mutations.delete(filename);
  });
  return result;
}

/** Native provider-owned catalogs, including validators; no second registry. */
export function createModelsStore(home: string): ModelsStore {
  const filename = (id: string) => {
    if (!/^[a-z][a-z0-9-]*$/.test(id))
      throw new Error("Invalid model catalog provider ID");
    return resolve(home, "models", `${id}.json`);
  };
  return {
    async read(id, options) {
      options?.signal?.throwIfAborted();
      const value = await readJson(filename(id));
      options?.signal?.throwIfAborted();
      if (value === undefined) return undefined;
      if (!validEntry(value, id))
        throw new Error(
          `Invalid model cache for ${id}; remove its file in the home models directory and retry.`,
        );
      return value;
    },
    write(id, entry, options) {
      const path = filename(id);
      if (!validEntry(entry, id))
        throw new Error(`Invalid model catalog for ${id}.`);
      const snapshot = structuredClone(entry);
      return mutate(path, options?.signal, () =>
        writeJson(path, snapshot, options?.signal),
      );
    },
    delete(id, options) {
      const path = filename(id);
      return mutate(path, options?.signal, () => rm(path, { force: true }));
    },
  };
}
