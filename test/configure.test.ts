import type { AuthInteraction } from "@earendil-works/pi-ai";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { openSetupContext } from "../src/cli/context.ts";
import {
  configurable,
  configureExtension,
  configureStep,
  isConfigured,
  markOffered,
  offerKeys,
  unseen,
} from "../src/cli/configure.ts";
import { Cancelled } from "../src/cli/prompt.ts";
import type { Authorize, JapaExtension } from "../src/kernel/extension.ts";
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
 * it plus the packaged extensions (so `brave`, `google`, `parallel`, `telegram`, `web`, `desktop`, `sqlite` are also discovered). */
async function demoContext(home: string) {
  mkdirSync(join(home, "extensions", "demo"), { recursive: true });
  writeFileSync(join(home, "extensions", "demo", "index.ts"), DEMO_SOURCE);
  return openSetupContext(home, [REPO_EXTENSIONS, join(home, "extensions")]);
}

const readSettings = (home: string) => JSON.parse(readFileSync(join(home, "settings.json"), "utf8"));
const readSetup = (home: string) => JSON.parse(readFileSync(join(home, "setup.json"), "utf8"));

test("configurable lists what needs the user -- brave, google, parallel, telegram, demo -- and not web (no key), the desktop (all defaults) or sqlite", async () => {
  const ctx = await demoContext(tempHome());

  const names = configurable(ctx.extensions)
    .map((e) => e.name)
    .sort();

  expect(names).toEqual(["brave", "demo", "google", "parallel", "telegram"]);
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

/** An inline extension that signs in: it shows a link, takes the pasted address and stores it as `signin.tok`.
 * The first `failures` runs throw "denied" after the paste; `runs` counts calls, `io` keeps the last. */
function signinExtension(failures = 0) {
  const state = { runs: 0, io: undefined as AuthInteraction | undefined };
  const authorize: Authorize = {
    async run(ctx, io) {
      state.runs++;
      state.io = io;
      io.notify({ type: "auth_url", url: "https://example.test/auth" });
      const value = await io.prompt({ type: "manual_code", message: "Paste the address" });
      if (failures-- > 0) throw new Error("denied");
      await ctx.setSecret("signin.tok", value);
      return "Connected as a@b.c";
    },
    connected: async (ctx) => !!(await ctx.secret("signin.tok")),
  };
  const signin: JapaExtension = {
    name: "signin",
    summary: "S",
    secrets: [{ name: "signin.id", description: "Client id" }],
    authorize,
  };
  return { signin, state };
}

test("configuring an extension with authorize signs in after its secrets", async () => {
  const home = tempHome();
  const ctx = await openSetupContext(home, [REPO_EXTENSIONS]);
  const { signin, state } = signinExtension();
  const opened: string[] = [];
  const p = scripted([
    ["Client id", "id-1"],
    ["Sign in now?", ENTER],
    ["Paste the address", "code-1"],
  ]);

  const saved = await configureExtension(ctx, p, signin, { openUrl: (url) => opened.push(url) });

  expect(saved).toBe(true);
  p.done();
  expect(state.runs).toBe(1);
  expect(p.notes).toContain("https://example.test/auth");
  expect(p.notes).toContain("Connected as a@b.c");
  expect(opened).toEqual(["https://example.test/auth"]);
  expect(readFileSync(join(home, "secrets", "signin.tok"), "utf8")).toBe("code-1");
});

test("an extension already signed in asks to sign in again, default no", async () => {
  const ctx = await openSetupContext(tempHome(), [REPO_EXTENSIONS]);
  await ctx.secrets.set("signin.id", "id-1");
  await ctx.secrets.set("signin.tok", "old");
  const { signin, state } = signinExtension();
  const p = scripted([
    ["Client id", ENTER],
    ["Sign in again?", ENTER],
  ]);

  const saved = await configureExtension(ctx, p, signin, { openUrl: () => {} });

  expect(saved).toBe(false);
  p.done();
  expect(state.runs).toBe(0);
});

test("with a secret still unset, setup says to sign in later instead of offering it", async () => {
  const ctx = await openSetupContext(tempHome(), [REPO_EXTENSIONS]);
  const { signin, state } = signinExtension();
  const p = scripted([["Client id", ENTER]]);

  expect(await configureExtension(ctx, p, signin, { openUrl: () => {} })).toBe(false);

  p.done();
  expect(state.runs).toBe(0);
  expect(p.notes).toContain("Sign in to signin once its secrets are set: rerun japa setup or ask japa.");
});

test("a failed sign-in says why and offers to try again", async () => {
  const home = tempHome();
  const ctx = await openSetupContext(home, [REPO_EXTENSIONS]);
  const { signin, state } = signinExtension(1);
  const p = scripted([
    ["Client id", "id-1"],
    ["Sign in now?", true],
    ["Paste the address", "x"],
    ["Try signing in again?", false],
  ]);

  await configureExtension(ctx, p, signin, { openUrl: () => {} });

  p.done();
  expect(state.runs).toBe(1);
  expect(p.notes).toContain("Couldn't sign in: denied");
  expect(existsSync(join(home, "secrets", "signin.tok"))).toBe(false);
});

test("trying again after a failed sign-in runs the flow again", async () => {
  const home = tempHome();
  const ctx = await openSetupContext(home, [REPO_EXTENSIONS]);
  const { signin, state } = signinExtension(1);
  const p = scripted([
    ["Client id", "id-1"],
    ["Sign in now?", true],
    ["Paste the address", "x"],
    ["Try signing in again?", true],
    ["Paste the address", "code-2"],
  ]);

  expect(await configureExtension(ctx, p, signin, { openUrl: () => {} })).toBe(true);

  p.done();
  expect(state.runs).toBe(2);
  expect(readFileSync(join(home, "secrets", "signin.tok"), "utf8")).toBe("code-2");
});

test("quitting at a sign-in prompt stops the flow and the wizard", async () => {
  const ctx = await openSetupContext(tempHome(), [REPO_EXTENSIONS]);
  const { signin, state } = signinExtension();
  const p = scripted([
    ["Client id", "id-1"],
    ["Sign in now?", true],
    ["Paste the address", "cancel"],
  ]);

  await expect(configureExtension(ctx, p, signin, { openUrl: () => {} })).rejects.toBeInstanceOf(Cancelled);

  expect(state.io?.signal?.aborted).toBe(true);
  expect(p.notes.filter((n) => n.startsWith("Couldn't sign in"))).toEqual([]);
});

test("an extension with authorize is configurable, and set up only once signed in", async () => {
  const ctx = await openSetupContext(tempHome(), [REPO_EXTENSIONS]);
  const { signin } = signinExtension();
  const bare: JapaExtension = { name: "bare", summary: "B", authorize: signin.authorize };

  expect(configurable([signin, bare])).toEqual([signin, bare]);
  await ctx.secrets.set("signin.id", "id-1");
  expect(await isConfigured(ctx, signin)).toBe(false);
  await ctx.secrets.set("signin.tok", "tok");
  expect(await isConfigured(ctx, signin)).toBe(true);
});

test("setup.json is ignored by the workspace git", () => {
  const home = tempHome();

  ensureWorkspace(home);

  expect(readFileSync(join(home, ".gitignore"), "utf8")).toContain("setup.json");
});
