import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxText, getSystemMessageText } from "@earendil-works/pi-ai";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { boot } from "../src/kernel/boot.ts";
import { bootTest, tempHome, testKit } from "./helpers.ts";

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
