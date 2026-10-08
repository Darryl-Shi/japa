import type { JsonObject } from "@earendil-works/pi-durable";
import { expect, test } from "vitest";
import { extensionState, isConfigured, type SecretReader } from "../src/kernel/availability.ts";
import type { JapaExtension } from "../src/kernel/extension.ts";
import { Type } from "../src/sdk.ts";

/** A secrets reader over `values`. */
const reader = (values: Record<string, string> = {}): SecretReader => ({ get: async (name) => values[name] });

const keyed: JapaExtension = { name: "x", summary: "X", secrets: ["x.key"] };

test("an extension whose secret is not stored is not set up", async () => {
  expect(await extensionState(keyed, reader(), {})).toBe("not set up");
  expect(await isConfigured(keyed, reader(), {})).toBe(false);
});

test("an extension whose secret is stored is on", async () => {
  expect(await extensionState(keyed, reader({ "x.key": "k" }), {})).toBe("on");
  expect(await isConfigured(keyed, reader({ "x.key": "k" }), {})).toBe(true);
});

test("a configured extension with enabled false is off", async () => {
  const settings: Record<string, JsonObject | undefined> = { x: { enabled: false } };
  expect(await extensionState(keyed, reader({ "x.key": "k" }), settings)).toBe("off");
  expect(await extensionState(keyed, reader({ "x.key": "k" }), { x: { enabled: true } })).toBe("on");
});

test("an unconfigured extension with enabled false is not set up", async () => {
  expect(await extensionState(keyed, reader(), { x: { enabled: false } })).toBe("not set up");
});

test("an extension whose only secret is generated is on", async () => {
  const e: JapaExtension = { name: "g", summary: "G", secrets: [{ name: "g.token", description: "G token", generated: true }] };
  expect(await extensionState(e, reader(), {})).toBe("on");
});

test("a required setting without a default must be saved", async () => {
  const e: JapaExtension = {
    name: "s",
    summary: "S",
    settings: Type.Object({
      region: Type.String(),
      size: Type.Integer({ default: 3 }),
      note: Type.Optional(Type.String()),
    }),
  };
  expect(await extensionState(e, reader(), {})).toBe("not set up");
  expect(await extensionState(e, reader(), { s: {} })).toBe("not set up");
  expect(await extensionState(e, reader(), { s: { region: "eu" } })).toBe("on");
});

test("a secrets reader that throws counts as not set", async () => {
  const failing: SecretReader = {
    get: async () => {
      throw new Error("locked");
    },
  };
  expect(await extensionState(keyed, failing, {})).toBe("not set up");
});
