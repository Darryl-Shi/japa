import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { openSetupContext } from "../src/cli/context.ts";
import { chooseModels } from "../src/cli/models-step.ts";
import type { Choice } from "../src/cli/prompt.ts";
import { echo, REPO_EXTENSIONS, tempHome } from "./helpers.ts";
import { ENTER, scripted } from "./prompt-helpers.ts";

const readSettings = (home: string) => JSON.parse(readFileSync(join(home, "settings.json"), "utf8"));
const keyFile = (home: string, provider: string) => join(home, "secrets", `${provider}.apiKey`);
const first = (choices: Choice<unknown>[]) => choices[0]!.value;

test("first run writes models.cos and the key", async () => {
  const home = tempHome();
  const ctx = await openSetupContext(home, [REPO_EXTENSIONS]);
  const firstModel = ctx.models.getModels("anthropic")[0]!.id;
  const p = scripted([
    ["CoS provider", "anthropic"],
    ["CoS model", first],
    ["API key", "sk-1"],
    ["Use the CoS model", true],
  ]);

  const saved = await chooseModels(ctx, p, {});

  expect(saved).toBe(true);
  p.done();
  expect(readSettings(home).models).toEqual({ cos: { provider: "anthropic", modelId: firstModel } });
  expect(readFileSync(keyFile(home, "anthropic"), "utf8")).toBe("sk-1");
});

test("a pasted key is stored trimmed", async () => {
  const home = tempHome();
  const ctx = await openSetupContext(home, [REPO_EXTENSIONS]);
  const p = scripted([
    ["CoS provider", "anthropic"],
    ["CoS model", first],
    ["API key", "  sk-1\n"],
    ["Use the CoS model", true],
  ]);

  await chooseModels(ctx, p, {});

  p.done();
  expect(readFileSync(keyFile(home, "anthropic"), "utf8")).toBe("sk-1");
});

test("Enter keeps an existing key", async () => {
  const home = tempHome();
  mkdirSync(join(home, "secrets"), { recursive: true });
  writeFileSync(keyFile(home, "anthropic"), "sk-existing");
  const ctx = await openSetupContext(home, [REPO_EXTENSIONS]);
  const p = scripted([
    ["CoS provider", "anthropic"],
    ["CoS model", first],
    ["API key", ""],
    ["Use the CoS model", true],
  ]);

  await chooseModels(ctx, p, {});

  p.done();
  expect(readFileSync(keyFile(home, "anthropic"), "utf8")).toBe("sk-existing");
});

test("an env key is noted", async () => {
  const home = tempHome();
  const ctx = await openSetupContext(home, [REPO_EXTENSIONS]);
  const p = scripted([
    ["CoS provider", "anthropic"],
    ["CoS model", first],
    ["API key", "sk-1"],
    ["Use the CoS model", true],
  ]);

  await chooseModels(ctx, p, { ANTHROPIC_API_KEY: "x" });

  p.done();
  expect(p.notes[0]).toContain("ANTHROPIC_API_KEY is set in this shell");
});

test("a worker on the same provider asks for no second key", async () => {
  const home = tempHome();
  const ctx = await openSetupContext(home, [REPO_EXTENSIONS]);
  const firstModel = ctx.models.getModels("anthropic")[0]!.id;
  const p = scripted([
    ["CoS provider", "anthropic"],
    ["CoS model", first],
    ["API key", "sk-1"],
    ["Use the CoS model", false],
    ["Worker provider", "anthropic"],
    ["Worker model", first],
    ["Consolidation provider", "anthropic"],
    ["Consolidation model", first],
  ]);

  await chooseModels(ctx, p, {});

  p.done(); // no leftover "API key" step: a second and third prompt would have failed to match
  expect(readSettings(home).models).toEqual({
    cos: { provider: "anthropic", modelId: firstModel },
    worker: { provider: "anthropic", modelId: firstModel },
    consolidation: { provider: "anthropic", modelId: firstModel },
  });
  expect(existsSync(keyFile(home, "anthropic"))).toBe(true);
});

test("a rerun with Enter everywhere keeps custom worker and consolidation models", async () => {
  const probe = await openSetupContext(tempHome(), [REPO_EXTENSIONS]);
  const [a, b] = probe.models.getModels("anthropic");
  const models = {
    cos: { provider: "anthropic", modelId: a!.id },
    worker: { provider: "anthropic", modelId: b!.id },
    consolidation: { provider: "anthropic", modelId: b!.id },
  };
  const home = tempHome({ models });
  const ctx = await openSetupContext(home, [REPO_EXTENSIONS]);
  const p = scripted([
    ["CoS provider", ENTER],
    ["CoS model", ENTER],
    ["API key", ENTER],
    ["Use the CoS model", ENTER],
    ["Worker provider", ENTER],
    ["Worker model", ENTER],
    ["Consolidation provider", ENTER],
    ["Consolidation model", ENTER],
  ]);

  await chooseModels(ctx, p, {});

  p.done();
  expect(readSettings(home).models).toEqual(models);
});

test("a rerun with only a custom worker model keeps consolidation on the CoS model on Enter", async () => {
  const probe = await openSetupContext(tempHome(), [REPO_EXTENSIONS]);
  const [, b, c] = probe.models.getModels("anthropic");
  const cos = { provider: "anthropic", modelId: b!.id };
  const worker = { provider: "anthropic", modelId: c!.id };
  const home = tempHome({ models: { cos, worker } });
  const ctx = await openSetupContext(home, [REPO_EXTENSIONS]);
  const p = scripted([
    ["CoS provider", ENTER],
    ["CoS model", ENTER],
    ["API key", ENTER],
    ["Use the CoS model", ENTER],
    ["Worker provider", ENTER],
    ["Worker model", ENTER],
    ["Consolidation provider", ENTER],
    ["Consolidation model", ENTER],
  ]);

  await chooseModels(ctx, p, {});

  p.done();
  expect(readSettings(home).models).toEqual({ cos, worker, consolidation: cos });
});

test("Enter on a first run uses the CoS model for every role", async () => {
  const home = tempHome();
  const ctx = await openSetupContext(home, [REPO_EXTENSIONS]);
  const p = scripted([
    ["CoS provider", "anthropic"],
    ["CoS model", first],
    ["API key", "sk-1"],
    ["Use the CoS model", ENTER],
  ]);

  await chooseModels(ctx, p, {});

  p.done();
  expect(Object.keys(readSettings(home).models)).toEqual(["cos"]);
});

test("other user settings are kept", async () => {
  const home = tempHome({ jobs: { maxConcurrent: 2 } });
  const ctx = await openSetupContext(home, [REPO_EXTENSIONS]);
  const p = scripted([
    ["CoS provider", "anthropic"],
    ["CoS model", first],
    ["API key", "sk-1"],
    ["Use the CoS model", true],
  ]);

  await chooseModels(ctx, p, {});

  p.done();
  const settings = readSettings(home);
  expect(settings.jobs).toEqual({ maxConcurrent: 2 });
  expect(settings.models.cos).toEqual({ provider: "anthropic", modelId: ctx.models.getModels("anthropic")[0]!.id });
});

test("setup creates a missing home", async () => {
  const home = join(tempHome(), "nope");

  const ctx = await openSetupContext(home);

  expect(existsSync(join(home, ".git"))).toBe(true);
  expect(ctx.extensions.map((e) => e.name)).toContain("providers");
});

test("a workspace extension importing japa/sdk is loaded", async () => {
  const home = tempHome();
  mkdirSync(join(home, "extensions", "echo"), { recursive: true });
  writeFileSync(join(home, "extensions", "echo", "index.ts"), echo("hi"));

  const ctx = await openSetupContext(home);

  expect(ctx.extensions.map((e) => e.name)).toContain("echo");
});
