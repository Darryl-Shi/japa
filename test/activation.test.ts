import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { expect, test } from "vitest";
import { type Contract, defineJapaExtension, defineTool, type TriggerContext, Type } from "../src/sdk.ts";
import { bootTest } from "./helpers.ts";

test("an extension tool is offered to the CoS", async () => {
  const echo = defineTool({
    name: "echo",
    description: "Echo",
    parameters: Type.Object({ text: Type.String() }),
    execute: async (a) => ({ content: [{ type: "text", text: a.text }] }),
  });
  const ext = defineJapaExtension({
    name: "echo",
    summary: "Echoes",
    examples: ["echo hi"],
    docs: "Echo text.",
    provides: { tool: [echo] },
  });
  const { daemon, faux } = await bootTest({}, [ext]);
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall("echo", { text: "pong" })], { stopReason: "toolUse" }),
    fauxAssistantMessage([fauxText("done")]),
  ]);
  await (await daemon.root.submit({ type: "input", content: "echo pong" }, ctx)).wait(ctx);
  const page = await daemon.root.entries({}, 100, undefined, ctx);
  const result = page.items.find((e) => e.kind === "pi.tool-result");
  expect(result?.model).toMatchObject([{ toolName: "echo", content: [{ type: "text", text: "pong" }] }]);
  await daemon.close();
});

test("trigger events are delivered once per key", async () => {
  let emit!: TriggerContext["emit"];
  const ext = defineJapaExtension({
    name: "tick",
    summary: "Ticks",
    provides: {
      trigger: [
        {
          name: "tick",
          start: async (c: TriggerContext) => {
            emit = c.emit;
            return () => {};
          },
        },
      ],
    },
  });
  const { daemon, faux } = await bootTest({}, [ext]);
  faux.setResponses([fauxAssistantMessage([fauxText("noted")])]);
  await emit({ key: "k1", text: "wake up" });
  await emit({ key: "k1", text: "wake up" });
  await daemon.root.waitForIdle(ctx);
  const page = await daemon.root.entries({}, 100, undefined, ctx);
  expect(JSON.stringify(page.items).match(/\[tick\] wake up/g)).toHaveLength(1);
  await daemon.close();
});

test("a failing surface is reported and boot continues", async () => {
  const ext = defineJapaExtension({
    name: "bad-ui",
    summary: "Breaks",
    provides: {
      surface: [
        {
          name: "bad",
          start: async () => {
            throw new Error("no tty");
          },
        },
      ],
    },
  });
  const { daemon } = await bootTest({}, [ext]);
  expect(daemon.status().errors).toContainEqual({ name: "bad-ui", error: "surface: no tty" });
  await daemon.close();
});

test("a failing tool install is reported and boot continues", async () => {
  const echo = defineTool({
    name: "echo",
    description: "Echo",
    parameters: Type.Object({}),
    execute: async () => ({ content: [] }),
  });
  const ext = defineJapaExtension({ name: "dup", summary: "Duplicates", provides: { tool: [echo, echo] } });
  const { daemon } = await bootTest({}, [ext]);
  expect(daemon.status().errors).toContainEqual({ name: "dup", error: expect.stringMatching(/^tool: /) });
  await daemon.close();
});

test("a throwing setup is reported and its extension's tools are not installed", async () => {
  const echo = defineTool({
    name: "broken_echo",
    description: "Echo",
    parameters: Type.Object({}),
    execute: async () => ({ content: [] }),
  });
  const ext = defineJapaExtension({
    name: "broken",
    summary: "Breaks",
    examples: ["echo"],
    docs: "Echo.",
    provides: { tool: [echo] },
    setup: () => {
      throw new Error("no key");
    },
  });
  const { daemon } = await bootTest({}, [ext]);
  expect(daemon.status().errors).toContainEqual({ name: "broken", error: "setup: no key" });
  expect(daemon.registry.snapshot().tools().map((t) => t.tool.name)).not.toContain("broken_echo");
  await daemon.close();
});

test("extension-defined contracts activate between tools and triggers", async () => {
  const order: string[] = [];
  const probe: Contract = {
    name: "probe",
    docs: "Test seam.",
    phase: "runtime",
    cardinality: "many",
    validate: () => undefined,
    activate: async () => {
      order.push("probe");
      return () => {};
    },
  };
  const ext = defineJapaExtension({
    name: "recorder",
    summary: "Records",
    contracts: [probe],
    provides: {
      probe: [{}],
      trigger: [
        {
          name: "t",
          start: async () => {
            order.push("trigger");
            return () => {};
          },
        },
      ],
      surface: [
        {
          name: "s",
          start: async () => {
            order.push("surface");
            return () => {};
          },
        },
      ],
    },
  });
  const { daemon } = await bootTest({}, [ext]);
  expect(order).toEqual(["probe", "trigger", "surface"]);
  await daemon.close();
});
