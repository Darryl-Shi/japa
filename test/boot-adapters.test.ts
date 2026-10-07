import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { createModels } from "@earendil-works/pi-ai";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, expect, test } from "vitest";
import fileSecrets from "../extensions/file-secrets/index.ts";
import sqlite from "../extensions/sqlite/index.ts";
import { CORE_CONTRACTS, type SecretsAdapter, type StorageAdapter } from "../src/sdk.ts";
import { type JapaExtension, validateExtension } from "../src/kernel/extension.ts";
import { tempHome } from "./helpers.ts";

/** The first contribution an extension provides to `contract`, typed as `T`. */
function provided<T>(e: JapaExtension, contract: string): T {
  return e.provides![contract]![0] as T;
}

let home: string;
beforeEach(() => {
  home = tempHome();
});

test("both manifests are valid", () => {
  const contracts = new Map(CORE_CONTRACTS.map((c) => [c.name, c]));
  expect(validateExtension(sqlite, contracts)).toEqual([]);
  expect(validateExtension(fileSecrets, contracts)).toEqual([]);
});

test("file secrets round-trip with private permissions", async () => {
  const store = await provided<SecretsAdapter>(fileSecrets, "secrets").open({}, { home });
  await store.set("openai.apiKey", "sk-1");
  expect(await store.get("openai.apiKey")).toBe("sk-1");
  expect(await store.list()).toEqual(["openai.apiKey"]);
  expect(statSync(join(home, "secrets")).mode & 0o777).toBe(0o700);
  expect(statSync(join(home, "secrets/openai.apiKey")).mode & 0o777).toBe(0o600);
  await store.delete("openai.apiKey");
  expect(await store.get("openai.apiKey")).toBeUndefined();
});

test("file secrets honor config.dir", async () => {
  const dir = join(home, "elsewhere");
  const store = await provided<SecretsAdapter>(fileSecrets, "secrets").open({ dir }, { home });
  await store.set("k", "v");
  expect(existsSync(join(dir, "k"))).toBe(true);
});

test("secret names cannot escape the directory", async () => {
  const store = await provided<SecretsAdapter>(fileSecrets, "secrets").open({}, { home });
  await expect(store.set("../x", "v")).rejects.toThrow(/Invalid secret name/);
  await expect(store.get("a/b")).rejects.toThrow(/Invalid secret name/);
  await expect(store.get("..")).rejects.toThrow(/Invalid secret name/);
});

test("sqlite storage opens at <home>/state.db", async () => {
  const storage = await provided<StorageAdapter>(sqlite, "storage").open({}, { home });
  const harness = await Harness.open(storage, { models: createModels(), registry: createRegistry() }, ctx);
  await harness.close(ctx);
  expect(existsSync(join(home, "state.db"))).toBe(true);
});

test("sqlite storage honors config.file", async () => {
  const file = join(home, "nested/other.db");
  const storage = await provided<StorageAdapter>(sqlite, "storage").open({ file }, { home });
  const harness = await Harness.open(storage, { models: createModels(), registry: createRegistry() }, ctx);
  await harness.close(ctx);
  expect(existsSync(file)).toBe(true);
});
