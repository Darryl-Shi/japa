import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createModels, type Credential } from "@earendil-works/pi-ai";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import type { KernelContext, SecretsStore } from "../src/kernel/contracts.ts";
import { secretsCredentialStore } from "../src/kernel/credentials.ts";
import type { JapaExtension } from "../src/kernel/extension.ts";
import { defineTool, Type } from "../src/sdk.ts";
import { bootTest } from "./helpers.ts";
import { call, script, texts } from "./jobs-helpers.ts";

/** An in-memory `SecretsStore`. */
function memorySecrets(initial: Record<string, string> = {}): SecretsStore {
  const values = new Map(Object.entries(initial));
  return {
    get: async (name) => values.get(name),
    set: async (name, value) => void values.set(name, value),
    delete: async (name) => void values.delete(name),
    list: async () => [...values.keys()].sort(),
  };
}

test("the credential store reads, lists, writes and deletes API keys as <provider>.apiKey secrets", async () => {
  const secrets = memorySecrets({ "faux.apiKey": "sk-1", "other.token": "t" });
  const store = secretsCredentialStore(secrets);
  expect(await store.read("faux")).toEqual({ type: "api_key", key: "sk-1" });
  expect(await store.read("nope")).toBeUndefined();
  expect(await store.list()).toEqual([{ providerId: "faux", type: "api_key" }]);
  await store.modify("x", async () => ({ type: "api_key", key: "sk-2" }));
  expect(await secrets.get("x.apiKey")).toBe("sk-2");
  const oauth = { type: "oauth", refresh: "r", access: "a", expires: 0 } as Credential;
  await expect(store.modify("x", async () => oauth)).rejects.toThrow("Only API keys are supported");
  await store.delete("x");
  expect(await secrets.get("x.apiKey")).toBeUndefined();
});

test("models resolve a provider's API key from the secrets store", async () => {
  const models = createModels({ credentials: secretsCredentialStore(memorySecrets({ "anthropic.apiKey": "sk-a" })) });
  for (const provider of builtinProviders()) models.setProvider(provider);
  expect((await models.getAuth("anthropic"))?.auth.apiKey).toBe("sk-a");
});

test("secret() returns a declared secret and refuses an undeclared one", async () => {
  let kernel: KernelContext | undefined;
  const extension: JapaExtension = {
    name: "probe-ext",
    summary: "Test",
    secrets: ["probe.token"],
    setup: (ctx) => {
      kernel = ctx;
    },
  };
  const { daemon, home } = await bootTest({}, [extension]);
  writeFileSync(join(home, "secrets/probe.token"), "t-1");
  expect(await kernel!.secret("probe.token")).toBe("t-1");
  await expect(kernel!.secret("other.token")).rejects.toThrow('Extension probe-ext did not declare secret "other.token"');
  await daemon.close();
});

test("a tool reads its extension's secret through the KernelContext given to setup", async () => {
  let kernel: KernelContext | undefined;
  const length = defineTool({
    name: "token_length",
    description: "Test.",
    parameters: Type.Object({}),
    execute: async () => ({ content: [{ type: "text", text: String((await kernel!.secret("probe.token"))?.length) }] }),
  });
  const extension: JapaExtension = {
    name: "probe-ext",
    summary: "Test",
    examples: ["test"],
    docs: "Test.",
    provides: { tool: [length] },
    secrets: ["probe.token"],
    setup: (ctx) => {
      kernel = ctx;
    },
  };
  const { daemon, home } = await bootTest({}, [extension]);
  writeFileSync(join(home, "secrets/probe.token"), "t-123");
  expect((await length.execute({}, {} as never, {} as never)).content).toEqual([{ type: "text", text: "5" }]);
  await daemon.close();
});

test("the CoS's read of a file under the secrets directory is denied", async () => {
  const { daemon, faux, home } = await bootTest();
  const path = join(home, "secrets/x");
  writeFileSync(path, "sk-secret");
  script(faux, (role, text) => (role === "user" && text === "go" ? call("read", { path }) : undefined));
  await (await daemon.root.submit({ type: "input", content: "go" }, ctx)).wait(ctx);
  const results = await texts(daemon.root, "toolResult");
  expect(results).toHaveLength(1);
  expect(results[0]).toContain("Secrets are not readable here.");
  expect(results[0]).not.toContain("sk-secret");
  await daemon.close();
});
