import { expect, test } from "vitest";
import type { KernelContext } from "../src/kernel/contracts.ts";
import { type JapaExtension, secretDescription, secretNames, validateExtension } from "../src/kernel/extension.ts";
import { discoverExtensions, loadExtensions } from "../src/kernel/loader.ts";
import { settingsSchema } from "../src/kernel/settings-tools.ts";
import { bootErrors, bootTest, REPO_EXTENSIONS } from "./helpers.ts";

test("secretNames accepts strings and described entries", () => {
  const e = { name: "x", summary: "x", secrets: ["a.key", { name: "b.key", description: "B" }] };
  expect(secretNames(e)).toEqual(["a.key", "b.key"]);
  expect(secretDescription(e, "b.key")).toBe("B");
  expect(secretDescription(e, "a.key")).toBeUndefined();
});

test("validateExtension rejects a secret entry without a name", () => {
  expect(validateExtension({ name: "x", summary: "x", secrets: [{ description: "d" } as never] })).toContain(
    "secrets[0]: must be a name or { name, description }",
  );
});

test("a described secret can be read by its extension", async () => {
  let kernel: KernelContext | undefined;
  const extension: JapaExtension = {
    name: "probe-ext",
    summary: "Test",
    secrets: [{ name: "x.key", description: "d" }],
    setup: async (ctx) => {
      kernel = ctx;
      await ctx.secret("x.key");
    },
  };
  const { daemon } = await bootTest({}, [extension]);
  expect(bootErrors(daemon)).toEqual([]);
  expect(kernel).toBeDefined();
  await daemon.close();
});

test("the messaging owner property is described", () => {
  const schema = settingsSchema({ name: "telegram", summary: "t", provides: { messaging: [{}] } }) as any;
  expect(schema.properties.owner.description).toBe(
    "Your telegram user id. Leave blank, message the bot, and it replies with your id.",
  );
});

test("every packaged secret has a description", async () => {
  const { extensions } = await loadExtensions(discoverExtensions([REPO_EXTENSIONS]));
  for (const e of extensions) for (const n of secretNames(e)) expect(secretDescription(e, n), n).toBeTruthy();
});
