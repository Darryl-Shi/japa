import {
  type AssistantMessage,
  type FauxProviderHandle,
  fauxAssistantMessage,
  type FauxResponseFactory,
  fauxToolCall,
  getSystemMessageText,
} from "@earendil-works/pi-ai";
import { expect, test } from "vitest";
import { capabilities } from "../src/kernel/capabilities.ts";
import { bootTest, testKit } from "./helpers.ts";
import { ask, call, say, textOf } from "./jobs-helpers.ts";

test("capabilities have no Workers section", () => {
  const text = capabilities({
    extensions: [
      { name: "gateway", summary: "Lets you chat from the terminal", provides: { surface: [{ name: "gateway" }] } },
      { name: "notes", summary: "Keeps notes" },
      { name: "fake", summary: "Fake chat", provides: { messaging: [{ name: "fake" }] } },
    ],
    models: { cos: { provider: "anthropic", modelId: "big" }, consolidation: { provider: "openai", modelId: "small" } },
  });
  expect(text).toBe(
    [
      "Extensions:",
      "- gateway: Lets you chat from the terminal",
      "- notes: Keeps notes",
      "- fake: Fake chat",
      "Models: cos anthropic/big, worker same as cos, consolidation openai/small",
      "Surfaces: gateway, fake",
    ].join("\n"),
  );
});

/** Answers each request with `respond(text)` of its last non-system message, or "ok"; returns each request's system text. */
function run(faux: FauxProviderHandle, respond: (text: string) => AssistantMessage | undefined) {
  const systems: string[] = [];
  const step: FauxResponseFactory = ({ messages }) => {
    systems.push(messages.flatMap((m) => (m.role === "system" ? [getSystemMessageText(m)] : [])).join("\n"));
    return respond(textOf(messages.findLast((m) => m.role !== "system")!)) ?? say("ok");
  };
  faux.setResponses(Array.from({ length: 20 }, () => step));
  return systems;
}

test("the capabilities section sits between identity and about-you and names extensions", async () => {
  const notes = { name: "notes", summary: "Keeps the user's notes" };
  const { daemon, faux } = await bootTest({}, [notes]);
  const systems = run(faux, (text) => (text === "remember" ? call("memory_remember", { text: "Dana likes tea" }) : undefined));
  await ask(daemon, "remember");
  const prompt = systems.at(-1)!;
  const at = (s: string) => prompt.indexOf(s);
  expect(at("chief of staff")).toBeGreaterThanOrEqual(0);
  expect(at("chief of staff")).toBeLessThan(at("Extensions:"));
  expect(at("Extensions:")).toBeLessThan(at("Dana likes tea"));
  expect(prompt).toContain("- notes: Keeps the user's notes");
  expect(prompt).not.toContain("Workers:");
  await daemon.close();
});

test("after settings_set of models.worker the next request shows the new worker model", async () => {
  const kit = testKit({ models: [{ id: "one" }, { id: "two" }] });
  const { daemon, faux } = await bootTest({}, [], kit);
  const worker = { provider: kit.model.provider, modelId: "two" };
  const systems = run(faux, (text) =>
    text === "switch"
      ? fauxAssistantMessage([fauxToolCall("settings_set", { path: "models.worker", value: worker })], {
          stopReason: "toolUse",
        })
      : undefined,
  );
  await ask(daemon, "hi");
  expect(systems.at(-1)!).toContain("worker same as cos");
  await ask(daemon, "switch"); // its last request follows the tool result
  expect(systems.at(-1)!).toContain(`worker ${kit.model.provider}/two`);
  await daemon.close();
});
