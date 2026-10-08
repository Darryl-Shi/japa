import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { envApiKeyAuth, fauxAssistantMessage, fauxText, getSystemMessageText } from "@earendil-works/pi-ai";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { boot } from "../src/kernel/boot.ts";
import { statusText } from "../src/kernel/status.ts";
import { bootTest, REPO_EXTENSIONS, tempHome, testKit } from "./helpers.ts";

test("the CoS answers in the root conversation", async () => {
  const { daemon, faux } = await bootTest();
  faux.setResponses([fauxAssistantMessage([fauxText("Hello!")])]);
  const settled = await (await daemon.root.submit({ type: "input", content: "hi" }, ctx)).wait(ctx);
  expect(settled.status).toBe("done");
  await daemon.close();
});

test("the identity section reaches the model", async () => {
  const { daemon, faux } = await bootTest();
  let systemPrompt = "";
  faux.setResponses([
    (context) => {
      // pi-ai carries the prompt in system messages, which Pi Durable places positionally in the transcript
      systemPrompt = context.messages.map((m) => (m.role === "system" ? getSystemMessageText(m) : "")).join("\n");
      return fauxAssistantMessage([fauxText("ok")]);
    },
  ]);
  await (await daemon.root.submit({ type: "input", content: "hi" }, ctx)).wait(ctx);
  expect(systemPrompt).toContain("chief of staff");
  await daemon.close();
});

test("missing models.cos is one clear error", async () => {
  await expect(boot({ home: tempHome({}) })).rejects.toThrow(/^Set models\.cos in .*settings\.json/);
});

test("unknown model is one clear error", async () => {
  await expect(bootTest({ models: { cos: { provider: "faux", modelId: "nope" } } })).rejects.toThrow(
    "Unknown model faux/nope",
  );
});

test("unknown consolidation model is one clear error", async () => {
  const kit = testKit();
  const models = { cos: kit.model, consolidation: { provider: "faux", modelId: "nope" } };
  const home = tempHome({ storage: { adapter: "memory" }, models });
  await expect(boot({ home, extensions: [kit.extension] })).rejects.toThrow("Unknown model faux/nope");
});

test("missing adapters are clear errors", async () => {
  const kit = testKit();
  const extensions = [kit.extension];
  await expect(boot({ home: tempHome({ storage: { adapter: "nope" } }), extensions })).rejects.toThrow(
    'No storage adapter "nope" is installed',
  );
  await expect(boot({ home: tempHome({ secrets: { adapter: "nope" } }), extensions })).rejects.toThrow(
    'No secrets adapter "nope" is installed',
  );
});

test("boot releases the lock when it fails", async () => {
  const home = tempHome({});
  await expect(boot({ home })).rejects.toThrow();
  expect(existsSync(join(home, "daemon.lock"))).toBe(false);
});

test("status lists the model and the extensions", async () => {
  const { daemon } = await bootTest();
  const status = daemon.status();
  expect(status.model).toEqual({ provider: "faux", modelId: "faux-1" });
  expect(status.extensions).toContainEqual({
    name: "test-kit",
    summary: "Faux models and in-memory storage for tests",
    provides: ["storage", "provider"],
  });
  expect(status.extensions.map((e) => e.name)).toContain("providers");
  expect(status.errors).toEqual([]);
  await daemon.close();
});

test("an extension's status line is shown under it, read each time", async () => {
  let line = "starting";
  const { daemon } = await bootTest({}, [{ name: "lit", summary: "Lit", status: () => line }]);
  expect(daemon.status().extensions).toContainEqual({ name: "lit", summary: "Lit", provides: [], status: "starting" });
  line = "ready";
  expect(statusText(daemon.status())).toContain("  lit — Lit\n    ready");
  await daemon.close();
});

test("workspace extensions load from <home>/extensions; a broken one is reported", async () => {
  const kit = testKit();
  const home = tempHome({ storage: { adapter: "memory" }, models: { cos: kit.model } });
  const write = (name: string, body: string) => {
    mkdirSync(join(home, "extensions", name), { recursive: true });
    writeFileSync(join(home, "extensions", name, "index.ts"), body);
  };
  write(
    "ws-good",
    `import { defineJapaExtension } from "japa/sdk";\n` +
      `export default defineJapaExtension({ name: "ws-good", summary: "Good" });\n`,
  );
  write("ws-broken", `throw new Error("boom");\n`);
  const daemon = await boot({ home, extensions: [kit.extension] });
  expect(daemon.status().extensions.map((e) => e.name)).toContain("ws-good");
  expect(daemon.status().errors.map((e) => e.name)).toEqual(["ws-broken"]);
  await daemon.close();
});

test("history survives a restart on sqlite", async () => {
  const kit = testKit();
  const home = tempHome({ models: { cos: kit.model } }); // default storage: sqlite
  let d = await boot({ home, extensions: [kit.extension] });
  kit.faux.setResponses([fauxAssistantMessage([fauxText("first")])]);
  await (await d.root.submit({ type: "input", content: "remember me" }, ctx)).wait(ctx);
  await d.close();
  d = await boot({ home, extensions: [kit.extension] });
  const page = await d.root.entries({}, 100, undefined, ctx);
  expect(JSON.stringify(page.items)).toContain("remember me");
  await d.close();
});

test("a CoS model whose provider has no key is reported, naming the env var and the secrets file", async () => {
  const kit = testKit();
  const provider = { ...kit.faux.provider, auth: { apiKey: envApiKeyAuth("Test", ["JAPA_TEST_API_KEY"]) } };
  const home = tempHome({ storage: { adapter: "memory" }, models: { cos: kit.model } });
  const extension = { ...kit.extension, provides: { ...kit.extension.provides, provider: [provider] } };
  const daemon = await boot({ home, extensionDirs: [REPO_EXTENSIONS], extensions: [extension] });
  const file = join(home, "secrets", `${kit.model.provider}.apiKey`);
  expect(daemon.status().errors).toEqual([
    { name: "models", error: `No API key for ${kit.model.provider}. Set JAPA_TEST_API_KEY or write it to ${file}, then restart.` },
  ]);
  await daemon.close();
});
