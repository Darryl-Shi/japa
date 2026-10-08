import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { openSetupContext } from "../src/cli/context.ts";
import { configurable, configureExtension, configureStep, markOffered, offerKeys, unseen } from "../src/cli/configure.ts";
import type { JapaExtension } from "../src/kernel/extension.ts";
import { ensureWorkspace } from "../src/kernel/workspace.ts";
import { REPO_EXTENSIONS, tempHome } from "./helpers.ts";
import { scripted } from "./prompt-helpers.ts";

/** A secret `demo.key` and settings `{ count?: integer, mode?: "a"|"b", on?: boolean, tags?: string[] }`. */
const DEMO_SOURCE = `import { defineJapaExtension, Type } from "japa/sdk";

export default defineJapaExtension({
  name: "demo",
  summary: "Demo extension for configure tests",
  secrets: [{ name: "demo.key", description: "Demo key description" }],
  settings: Type.Object({
    count: Type.Optional(Type.Integer({ description: "How many" })),
    mode: Type.Optional(Type.Union([Type.Literal("a"), Type.Literal("b")], { description: "Mode" })),
    on: Type.Optional(Type.Boolean({ description: "Toggle" })),
    tags: Type.Optional(Type.Array(Type.String(), { description: "Tags" })),
  }),
});
`;

/** A temp home with the `demo` fixture extension (above) under `extensions/`, and the setup context opened over
 * it plus the packaged extensions (so `telegram`, `web`, `desktop`, `sqlite` are also discovered). */
async function demoContext(home: string) {
  mkdirSync(join(home, "extensions", "demo"), { recursive: true });
  writeFileSync(join(home, "extensions", "demo", "index.ts"), DEMO_SOURCE);
  return openSetupContext(home, [REPO_EXTENSIONS, join(home, "extensions")]);
}

const readSettings = (home: string) => JSON.parse(readFileSync(join(home, "settings.json"), "utf8"));
const readSetup = (home: string) => JSON.parse(readFileSync(join(home, "setup.json"), "utf8"));

test("configurable lists telegram, web, desktop, demo and not sqlite", async () => {
  const ctx = await demoContext(tempHome());

  const names = configurable(ctx.extensions)
    .map((e) => e.name)
    .sort();

  expect(names).toEqual(["demo", "desktop", "telegram", "web"]);
});

test("configuring demo writes its secret and typed settings", async () => {
  const home = tempHome();
  const ctx = await demoContext(home);
  const demo = ctx.extensions.find((e) => e.name === "demo")!;
  const p = scripted([
    ["demo.key", "secret-value"],
    ["count", "3"],
    ["mode", "b"],
    ["on", true],
  ]);

  const saved = await configureExtension(ctx, p, demo);

  expect(saved).toBe(true);
  p.done();
  expect(p.notes).toContain("edit extensions.demo.tags in settings.json or ask the CoS");
  expect(readSettings(home).extensions.demo).toEqual({ count: 3, mode: "b", on: true });
  expect(readFileSync(join(home, "secrets", "demo.key"), "utf8")).toBe("secret-value");
});

test("a non-number re-prompts", async () => {
  const home = tempHome();
  const ctx = await demoContext(home);
  const demo = ctx.extensions.find((e) => e.name === "demo")!;
  const p = scripted([
    ["demo.key", ""],
    ["count", "nope"],
    ["count", "4"],
    ["mode", "a"],
    ["on", false],
  ]);

  await configureExtension(ctx, p, demo);

  p.done();
  expect(p.notes).toContain("count must be a number");
  expect(readSettings(home).extensions.demo.count).toBe(4);
});

test("an invalid answer for a promptable property re-prompts, then a valid one saves", async () => {
  const home = tempHome();
  const ctx = await demoContext(home);
  const demo = ctx.extensions.find((e) => e.name === "demo")!;
  const p = scripted([
    ["demo.key", ""],
    ["count", "Infinity"],
    ["mode", "a"],
    ["on", false],
    ["count", "3"],
  ]);

  const saved = await configureExtension(ctx, p, demo);

  expect(saved).toBe(true);
  p.done();
  expect(p.notes).toContain("extensions.demo.count: must be integer");
  expect(readSettings(home).extensions.demo).toEqual({ count: 3, mode: "a", on: false });
});

test(
  "a pre-existing invalid object value for a non-promptable property does not hang",
  async () => {
    const home = tempHome({ extensions: { demo: { tags: { foo: "bar" } } } });
    const before = readFileSync(join(home, "settings.json"), "utf8");
    const ctx = await demoContext(home);
    const demo = ctx.extensions.find((e) => e.name === "demo")!;
    const p = scripted([
      ["demo.key", ""],
      ["count", "3"],
      ["mode", "a"],
      ["on", false],
    ]);

    const saved = await configureExtension(ctx, p, demo);

    expect(saved).toBe(false);
    p.done();
    expect(p.notes.some((n) => n.startsWith("extensions.demo.tags"))).toBe(true);
    expect(p.notes).toContain("edit extensions.demo.tags in settings.json or ask the CoS");
    expect(readFileSync(join(home, "settings.json"), "utf8")).toBe(before);
  },
  2000,
);

test("declining leaves everything unchanged but marks it offered", async () => {
  const home = tempHome();
  const ctx = await demoContext(home);
  const demo = ctx.extensions.find((e) => e.name === "demo")!;
  const p = scripted([["Configure demo?", false]]);

  const saved = await configureStep(ctx, p, [demo]);

  expect(saved).toBe(false);
  p.done();
  expect(p.notes).toEqual(["demo: Demo extension for configure tests"]);
  expect(existsSync(join(home, "settings.json"))).toBe(false);
  expect(existsSync(join(home, "secrets", "demo.key"))).toBe(false);
  expect(readSetup(home).offered.demo.sort()).toEqual(offerKeys(demo).sort());
});

test("telegram owner is prompted with its description", async () => {
  const home = tempHome();
  const ctx = await openSetupContext(home, [REPO_EXTENSIONS]);
  const telegram = ctx.extensions.find((e) => e.name === "telegram")!;
  const p = scripted([
    ["telegram.botToken", "tok-1"],
    ["owner", "98765"],
  ]);

  await configureExtension(ctx, p, telegram);

  p.done();
  expect(p.asked.some((q) => q.includes("owner"))).toBe(true);
});

test("unseen reports a new extension, then a new secret on an existing one, then nothing", async () => {
  const home = tempHome();
  const ctx = await demoContext(home);
  const demo = ctx.extensions.find((e) => e.name === "demo")!;

  const first = await unseen(ctx);
  const demoFirst = first.find((u) => u.extension.name === "demo")!;
  expect(demoFirst.isNew).toBe(true);
  expect(demoFirst.keys.sort()).toEqual(offerKeys(demo).sort());

  markOffered(home, configurable(ctx.extensions));

  const withExtra: JapaExtension = {
    ...demo,
    secrets: [...(demo.secrets ?? []), { name: "demo.extra", description: "Extra" }],
  };
  const ctx2 = { ...ctx, extensions: ctx.extensions.map((e) => (e.name === "demo" ? withExtra : e)) };

  const second = await unseen(ctx2);
  expect(second).toEqual([{ extension: withExtra, keys: ["secret:demo.extra"], isNew: false }]);

  markOffered(home, configurable(ctx2.extensions));

  expect(await unseen(ctx2)).toEqual([]);
});

test("setup.json is ignored by the workspace git", () => {
  const home = tempHome();

  ensureWorkspace(home);

  expect(readFileSync(join(home, ".gitignore"), "utf8")).toContain("setup.json");
});
