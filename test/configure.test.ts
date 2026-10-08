import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { openSetupContext } from "../src/cli/context.ts";
import { configurable, configureExtension, configureStep, markOffered, offerKeys, unseen } from "../src/cli/configure.ts";
import type { JapaExtension } from "../src/kernel/extension.ts";
import { ensureWorkspace } from "../src/kernel/workspace.ts";
import { REPO_EXTENSIONS, tempHome } from "./helpers.ts";
import { ENTER, scripted } from "./prompt-helpers.ts";

/** A secret `demo.key`, a generated secret `demo.salt`, required settings `{ count: integer, mode: "a"|"b",
 * on: boolean }`, and optional ones `{ tags?: string[], level?: integer }`, which setup never asks about. */
const DEMO_SOURCE = `import { defineJapaExtension, Type } from "japa/sdk";

export default defineJapaExtension({
  name: "demo",
  summary: "Demo extension for configure tests",
  secrets: [
    { name: "demo.key", description: "Demo key description" },
    { name: "demo.salt", description: "Made up when unset", generated: true },
  ],
  settings: Type.Object({
    count: Type.Integer({ description: "How many" }),
    mode: Type.Union([Type.Literal("a"), Type.Literal("b")], { description: "Mode" }),
    on: Type.Boolean({ description: "Toggle" }),
    tags: Type.Optional(Type.Array(Type.String(), { description: "Tags" })),
    level: Type.Optional(Type.Integer({ description: "Level (default 1)" })),
  }),
});
`;

/** A temp home with the `demo` fixture extension (above) under `extensions/`, and the setup context opened over
 * it plus the packaged extensions (so `brave`, `parallel`, `telegram`, `web`, `desktop`, `sqlite` are also discovered). */
async function demoContext(home: string) {
  mkdirSync(join(home, "extensions", "demo"), { recursive: true });
  writeFileSync(join(home, "extensions", "demo", "index.ts"), DEMO_SOURCE);
  return openSetupContext(home, [REPO_EXTENSIONS, join(home, "extensions")]);
}

const readSettings = (home: string) => JSON.parse(readFileSync(join(home, "settings.json"), "utf8"));
const readSetup = (home: string) => JSON.parse(readFileSync(join(home, "setup.json"), "utf8"));

test("configurable lists what needs the user -- brave, parallel, telegram, demo -- and not web (no key), the desktop (all defaults) or sqlite", async () => {
  const ctx = await demoContext(tempHome());

  const names = configurable(ctx.extensions)
    .map((e) => e.name)
    .sort();

  expect(names).toEqual(["brave", "demo", "parallel", "telegram"]);
});

test("configuring demo writes its secret and typed settings", async () => {
  const home = tempHome();
  const ctx = await demoContext(home);
  const demo = ctx.extensions.find((e) => e.name === "demo")!;
  const p = scripted([
    ["Demo key description", "secret-value"],
    ["How many", "3"],
    ["Mode", "b"],
    ["Toggle", true],
  ]);

  const saved = await configureExtension(ctx, p, demo);

  expect(saved).toBe(true);
  p.done(); // nothing asked about the generated secret or the optional settings
  expect(readSettings(home).extensions.demo).toEqual({ count: 3, mode: "b", on: true });
  expect(readFileSync(join(home, "secrets", "demo.key"), "utf8")).toBe("secret-value");
});

test("a non-number re-prompts", async () => {
  const home = tempHome();
  const ctx = await demoContext(home);
  const demo = ctx.extensions.find((e) => e.name === "demo")!;
  const p = scripted([
    ["Demo key description", ""],
    ["How many", "nope"],
    ["How many", "4"],
    ["Mode", "a"],
    ["Toggle", false],
  ]);

  await configureExtension(ctx, p, demo);

  p.done();
  expect(p.notes).toContain("How many: enter a number");
  expect(readSettings(home).extensions.demo.count).toBe(4);
});

test("an invalid answer for a promptable property re-prompts, then a valid one saves", async () => {
  const home = tempHome();
  const ctx = await demoContext(home);
  const demo = ctx.extensions.find((e) => e.name === "demo")!;
  const p = scripted([
    ["Demo key description", ""],
    ["How many", "Infinity"],
    ["Mode", "a"],
    ["Toggle", false],
    ["How many", "3"],
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
      ["Demo key description", ""],
      ["How many", "3"],
      ["Mode", "a"],
      ["Toggle", false],
    ]);

    const saved = await configureExtension(ctx, p, demo);

    expect(saved).toBe(false);
    p.done();
    expect(p.notes.some((n) => n.startsWith("extensions.demo.tags"))).toBe(true);
    expect(p.notes).toContain('To change "Tags", ask japa, or edit extensions.demo.tags in settings.json.');
    expect(readFileSync(join(home, "settings.json"), "utf8")).toBe(before);
  },
  2000,
);

test("declining leaves everything unchanged but marks it offered", async () => {
  const home = tempHome();
  const ctx = await demoContext(home);
  const demo = ctx.extensions.find((e) => e.name === "demo")!;
  const p = scripted([["Set up any integrations now?", []]]);

  const saved = await configureStep(ctx, p, [demo]);

  expect(saved).toBe(false);
  p.done();
  expect(p.notes).toEqual([]);
  expect(existsSync(join(home, "settings.json"))).toBe(false);
  expect(existsSync(join(home, "secrets", "demo.key"))).toBe(false);
  expect(readSetup(home).offered.demo.sort()).toEqual(offerKeys(demo).sort());
});

test("telegram asks only for its bot token: the owner is optional, it replies with your id", async () => {
  const home = tempHome();
  const ctx = await openSetupContext(home, [REPO_EXTENSIONS]);
  const telegram = ctx.extensions.find((e) => e.name === "telegram")!;
  const p = scripted([["Bot token from @BotFather", "tok-1"]]);

  await configureExtension(ctx, p, telegram);

  p.done();
  expect(readFileSync(join(home, "secrets", "telegram.botToken"), "utf8")).toBe("tok-1");
  expect(existsSync(join(home, "settings.json"))).toBe(false);
});

test("offerKeys covers only what setup asks for", async () => {
  const ctx = await demoContext(tempHome());
  const keys = (name: string) => offerKeys(ctx.extensions.find((e) => e.name === name)!);
  expect(keys("demo")).toEqual(["secret:demo.key", "setting:count", "setting:mode", "setting:on"]);
  expect(keys("desktop")).toEqual([]);
});

test("unseen reports a new extension, then a new secret on an existing one, then nothing", async () => {
  const home = tempHome();
  const ctx = await demoContext(home);
  const demo = ctx.extensions.find((e) => e.name === "demo")!;

  const first = await unseen(ctx);
  const demoFirst = first.find((u) => u.extension.name === "demo")!;
  expect(demoFirst.isNew).toBe(true);
  expect(demoFirst.keys.sort()).toEqual(offerKeys(demo).sort());

  markOffered(home, ctx.extensions);

  const withExtra: JapaExtension = {
    ...demo,
    secrets: [...(demo.secrets ?? []), { name: "demo.extra", description: "Extra" }],
  };
  const ctx2 = { ...ctx, extensions: ctx.extensions.map((e) => (e.name === "demo" ? withExtra : e)) };

  const second = await unseen(ctx2);
  expect(second).toEqual([{ extension: withExtra, keys: ["secret:demo.extra"], isNew: false }]);

  markOffered(home, ctx2.extensions);

  expect(await unseen(ctx2)).toEqual([]);
});

test("unseen reports a new extension with nothing to configure, with no keys, once", async () => {
  const home = tempHome();
  const ctx = await demoContext(home);
  const sqlite = ctx.extensions.find((e) => e.name === "sqlite")!;
  markOffered(home, ctx.extensions.filter((e) => e !== sqlite));

  expect(await unseen(ctx)).toEqual([{ extension: sqlite, keys: [], isNew: true }]);

  markOffered(home, [sqlite]);

  expect(readSetup(home).offered.sqlite).toEqual([]);
  expect(await unseen(ctx)).toEqual([]);
});

test("the extensions step records every extension as offered, configurable or not", async () => {
  const home = tempHome();
  const ctx = await demoContext(home);
  const demo = ctx.extensions.find((e) => e.name === "demo")!;

  await configureStep(ctx, scripted([["Set up any integrations now?", ENTER]]), [demo]);

  expect(Object.keys(readSetup(home).offered).sort()).toEqual(ctx.extensions.map((e) => e.name).sort());
});

test("setup.json is ignored by the workspace git", () => {
  const home = tempHome();

  ensureWorkspace(home);

  expect(readFileSync(join(home, ".gitignore"), "utf8")).toContain("setup.json");
});
