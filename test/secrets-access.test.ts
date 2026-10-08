import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createModels, type Credential, fauxProvider } from "@earendil-works/pi-ai";
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
  const secrets = memorySecrets({ "faux.apiKey": "sk-1\n", "other.token": "t" });
  const store = secretsCredentialStore(secrets);
  expect(await store.read("faux")).toEqual({ type: "api_key", key: "sk-1" });
  expect(await store.read("nope")).toBeUndefined();
  expect(await store.list()).toEqual([{ providerId: "faux", type: "api_key" }]);
  await store.modify("x", async () => ({ type: "api_key", key: "sk-2" }));
  expect(await secrets.get("x.apiKey")).toBe("sk-2");
  await store.delete("x");
  expect(await secrets.get("x.apiKey")).toBeUndefined();
});

test("an OAuth login, or a key with provider settings, is kept as <provider>.credential and replaces the key", async () => {
  const secrets = memorySecrets({ "x.apiKey": "sk-old" });
  const store = secretsCredentialStore(secrets);
  const oauth = { type: "oauth", refresh: "r", access: "a", expires: 1 } as Credential;
  await store.modify("x", async () => oauth);
  expect(await secrets.get("x.apiKey")).toBeUndefined();
  expect(JSON.parse((await secrets.get("x.credential"))!)).toEqual(oauth);
  expect(await store.read("x")).toEqual(oauth);
  expect(await store.list()).toEqual([{ providerId: "x", type: "oauth" }]);

  const withEnv = { type: "api_key", key: "k", env: { ACCOUNT: "acc" } } as Credential;
  await store.modify("cf", async () => withEnv);
  expect(await store.read("cf")).toEqual(withEnv);

  await store.modify("x", async () => ({ type: "api_key", key: "sk-new" })); // back to a plain key
  expect(await secrets.get("x.credential")).toBeUndefined();
  expect(await store.read("x")).toEqual({ type: "api_key", key: "sk-new" });
  await store.delete("cf");
  expect(await secrets.list()).toEqual(["x.apiKey"]);
});

test("models refresh an expired OAuth login once, even when asked concurrently, and keep the new tokens", async () => {
  const secrets = memorySecrets();
  let refreshes = 0;
  const provider = {
    ...fauxProvider().provider,
    id: "sub",
    auth: {
      oauth: {
        name: "Sub",
        login: async () => ({ type: "oauth" as const, refresh: "r1", access: "a1", expires: 0 }),
        refresh: async (c: { refresh: string }) => {
          refreshes++;
          await new Promise((resolve) => setTimeout(resolve, 10));
          return { type: "oauth" as const, refresh: `${c.refresh}+`, access: `a${refreshes + 1}`, expires: Date.now() + 3_600_000 };
        },
        toAuth: async (c: { access: string }) => ({ apiKey: c.access }),
      },
    },
  };
  const models = createModels({ credentials: secretsCredentialStore(secrets) });
  models.setProvider(provider);
  await models.login("sub", "oauth", { prompt: async () => "", notify: () => {} });
  const [first, second] = await Promise.all([models.getAuth("sub"), models.getAuth("sub")]);
  expect(refreshes).toBe(1);
  expect(first?.auth.apiKey).toBe("a2");
  expect(second?.auth.apiKey).toBe("a2");
  expect(JSON.parse((await secrets.get("sub.credential"))!)).toMatchObject({ refresh: "r1+", access: "a2" });
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
