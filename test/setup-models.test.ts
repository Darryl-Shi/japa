import { fauxProvider, type MutableModels, type OAuthCredential, type ProviderAuthInteraction } from "@earendil-works/pi-ai";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { openSetupContext, type SetupContext } from "../src/cli/context.ts";
import { chooseModels } from "../src/cli/models-step.ts";
import { Cancelled, type Choice } from "../src/cli/prompt.ts";
import { echo, REPO_EXTENSIONS, tempHome } from "./helpers.ts";
import { ENTER, scripted } from "./prompt-helpers.ts";

const readSettings = (home: string) => JSON.parse(readFileSync(join(home, "settings.json"), "utf8"));
const keyFile = (home: string, provider: string) => join(home, "secrets", `${provider}.apiKey`);
const credentialFile = (home: string, provider: string) => join(home, "secrets", `${provider}.credential`);
const first = (choices: Choice<unknown>[]) => choices[0]!.value;
const pick = (label: string) => (choices: Choice<unknown>[]) => {
  const choice = choices.find((c) => c.label.startsWith(label));
  if (choice === undefined) throw new Error(`no "${label}" among ${choices.map((c) => c.label).join(", ")}`);
  return choice.value;
};
const noBrowser = { openUrl: () => {} };

function storeKey(home: string, provider: string, key: string) {
  mkdirSync(join(home, "secrets"), { recursive: true });
  writeFileSync(keyFile(home, provider), key);
}

test("first run: provider, an API key through pi-ai's login, model; saves models.cos and the key", async () => {
  const home = tempHome();
  const ctx = await openSetupContext(home, [REPO_EXTENSIONS]);
  const firstModel = ctx.models.getModels("anthropic")[0]!.id;
  const p = scripted([
    ["Which AI provider should japa use?", "anthropic"],
    ["How should japa connect to Anthropic?", pick("Enter Anthropic API key")],
    ["Anthropic API key", "  sk-1\n"],
    ["Which model should japa use?", first],
    ["for background jobs and memory upkeep too?", true],
  ]);

  const saved = await chooseModels(ctx, p, { env: {}, ...noBrowser });

  expect(saved).toBe(true);
  p.done();
  expect(readSettings(home).models).toEqual({ cos: { provider: "anthropic", modelId: firstModel } });
  expect(readFileSync(keyFile(home, "anthropic"), "utf8")).toBe("sk-1"); // trimmed
});

test("providers are listed by name, the common ones first, with sign-in shown where it's offered", async () => {
  const ctx = await openSetupContext(tempHome(), [REPO_EXTENSIONS]);
  let offered: Choice<unknown>[] = [];
  const p = scripted([
    ["Which AI provider", (choices: Choice<unknown>[]) => ((offered = choices), "cancel")],
  ]);

  await expect(chooseModels(ctx, p, { env: {}, ...noBrowser })).rejects.toThrow();

  expect(offered.slice(0, 2).map((c) => c.label)).toEqual(["Anthropic", "OpenAI"]);
  expect(offered[0]!.hint).toBe("sign in or API key");
});

test("an existing key is kept on Enter", async () => {
  const home = tempHome();
  storeKey(home, "anthropic", "sk-existing");
  const ctx = await openSetupContext(home, [REPO_EXTENSIONS]);
  const p = scripted([
    ["Which AI provider", "anthropic"],
    ["How should japa connect", ENTER],
    ["Which model", first],
    ["too?", true],
  ]);

  await chooseModels(ctx, p, { env: {}, ...noBrowser });

  p.done();
  expect(readFileSync(keyFile(home, "anthropic"), "utf8")).toBe("sk-existing");
});

test("a key in the shell's environment can be saved for the background service", async () => {
  const home = tempHome();
  const ctx = await openSetupContext(home, [REPO_EXTENSIONS]);
  const p = scripted([
    ["Which AI provider", "anthropic"],
    ["How should japa connect", pick("Use ANTHROPIC_API_KEY from this shell")],
    ["Which model", first],
    ["too?", true],
  ]);

  await chooseModels(ctx, p, { env: { ANTHROPIC_API_KEY: " sk-env " }, ...noBrowser });

  p.done();
  expect(readFileSync(keyFile(home, "anthropic"), "utf8")).toBe("sk-env");
});

/** A setup context with a `sub` provider whose only login is OAuth, running `login`. */
async function oauthContext(
  home: string,
  login: (interaction: ProviderAuthInteraction) => Promise<OAuthCredential>,
): Promise<SetupContext> {
  const ctx = await openSetupContext(home, [REPO_EXTENSIONS]);
  const faux = fauxProvider({ provider: "sub", models: [{ id: "sub-large", name: "Sub Large" }] });
  (ctx.models as MutableModels).setProvider({
    ...faux.provider,
    name: "Sub",
    auth: {
      oauth: {
        name: "Sub (subscription)",
        isSubscription: true,
        login,
        refresh: async (c) => c,
        toAuth: async (c) => ({ apiKey: c.access }),
      },
    },
  });
  return ctx;
}

test("signing in runs the provider's OAuth flow: the link is shown and opened, the pasted code completes it", async () => {
  const home = tempHome();
  const ctx = await oauthContext(home, async (interaction) => {
    interaction.notify({ type: "auth_url", url: "https://sub.example/authorize?x=1", instructions: "Sign in to Sub." });
    const code = await interaction.prompt({ type: "manual_code", message: "Paste the code" });
    interaction.notify({ type: "progress", message: "Exchanging code" });
    return { type: "oauth", access: `access-for-${code}`, refresh: "r", expires: Date.now() + 3_600_000 };
  });
  const opened: string[] = [];
  const p = scripted([
    ["Which AI provider", "sub"],
    ["How should japa connect to Sub?", pick("Sign in with Sub (subscription)")],
    ["Paste the code", "abc"],
    ["Which model", "sub-large"],
    ["too?", true],
  ]);

  await chooseModels(ctx, p, { env: {}, openUrl: (url) => opened.push(url) });

  p.done();
  expect(opened).toEqual(["https://sub.example/authorize?x=1"]);
  expect(p.notes).toEqual(
    expect.arrayContaining(["Sign in to Sub.", "https://sub.example/authorize?x=1", "Connected to Sub."]),
  );
  expect(JSON.parse(readFileSync(credentialFile(home, "sub"), "utf8"))).toMatchObject({
    type: "oauth",
    access: "access-for-abc",
  });
  expect((await ctx.models.getAuth("sub"))?.auth.apiKey).toBe("access-for-abc");
  expect(readSettings(home).models.cos).toEqual({ provider: "sub", modelId: "sub-large" });
});

test("a failed sign-in says why and asks again; Skip leaves japa unconnected", async () => {
  const home = tempHome();
  const ctx = await oauthContext(home, async () => {
    throw new Error("token exchange failed", { cause: new Error("invalid_grant") });
  });
  const p = scripted([
    ["Which AI provider", "sub"],
    ["How should japa connect", pick("Sign in")],
    ["How should japa connect", pick("Skip for now")],
    ["Which model", "sub-large"],
    ["too?", true],
  ]);

  await chooseModels(ctx, p, { env: {}, ...noBrowser });

  p.done();
  expect(p.notes).toContain("Couldn't connect to Sub: token exchange failed: invalid_grant");
  expect(existsSync(credentialFile(home, "sub"))).toBe(false);
});

test("quitting in the middle of a sign-in stops the flow and quits setup", async () => {
  let aborted = false;
  const ctx = await oauthContext(tempHome(), async (interaction) => {
    interaction.signal.addEventListener("abort", () => (aborted = true));
    await interaction.prompt({ type: "manual_code", message: "Paste the code" });
    throw new Error("unreachable");
  });
  const p = scripted([
    ["Which AI provider", "sub"],
    ["How should japa connect", pick("Sign in")],
    ["Paste the code", "cancel"],
  ]);

  await expect(chooseModels(ctx, p, { env: {}, ...noBrowser })).rejects.toBeInstanceOf(Cancelled);
  expect(aborted).toBe(true);
  expect(existsSync(join(ctx.home, "settings.json"))).toBe(false);
});

test("jobs and memory on the same provider don't ask to connect again", async () => {
  const home = tempHome();
  const ctx = await openSetupContext(home, [REPO_EXTENSIONS]);
  const firstModel = ctx.models.getModels("anthropic")[0]!.id;
  const p = scripted([
    ["Which AI provider should japa use?", "anthropic"],
    ["How should japa connect", pick("Enter Anthropic API key")],
    ["Anthropic API key", "sk-1"],
    ["Which model should japa use?", first],
    ["too?", false],
    ["Which provider for background jobs?", "anthropic"],
    ["Which model for background jobs?", first],
    ["Which provider for memory upkeep?", "anthropic"],
    ["Which model for memory upkeep?", first],
  ]);

  await chooseModels(ctx, p, { env: {}, ...noBrowser });

  p.done();
  expect(readSettings(home).models).toEqual({
    cos: { provider: "anthropic", modelId: firstModel },
    worker: { provider: "anthropic", modelId: firstModel },
    consolidation: { provider: "anthropic", modelId: firstModel },
  });
});

test("a rerun with Enter everywhere keeps custom job and memory models", async () => {
  const probe = await openSetupContext(tempHome(), [REPO_EXTENSIONS]);
  const [a, b] = probe.models.getModels("anthropic");
  const models = {
    cos: { provider: "anthropic", modelId: a!.id },
    worker: { provider: "anthropic", modelId: b!.id },
    consolidation: { provider: "anthropic", modelId: b!.id },
  };
  const home = tempHome({ models });
  storeKey(home, "anthropic", "sk-1");
  const ctx = await openSetupContext(home, [REPO_EXTENSIONS]);
  const p = scripted([
    ["Which AI provider should japa use?", ENTER],
    ["How should japa connect", ENTER],
    ["Which model should japa use?", ENTER],
    ["too?", ENTER],
    ["Which provider for background jobs?", ENTER],
    ["Which model for background jobs?", ENTER],
    ["Which provider for memory upkeep?", ENTER],
    ["Which model for memory upkeep?", ENTER],
  ]);

  await chooseModels(ctx, p, { env: {}, ...noBrowser });

  p.done();
  expect(readSettings(home).models).toEqual(models);
});

test("a rerun with only a custom job model keeps memory on the CoS model on Enter", async () => {
  const probe = await openSetupContext(tempHome(), [REPO_EXTENSIONS]);
  const [, b, c] = probe.models.getModels("anthropic");
  const cos = { provider: "anthropic", modelId: b!.id };
  const worker = { provider: "anthropic", modelId: c!.id };
  const home = tempHome({ models: { cos, worker } });
  storeKey(home, "anthropic", "sk-1");
  const ctx = await openSetupContext(home, [REPO_EXTENSIONS]);
  const p = scripted([
    ["Which AI provider should japa use?", ENTER],
    ["How should japa connect", ENTER],
    ["Which model should japa use?", ENTER],
    ["too?", ENTER],
    ["Which provider for background jobs?", ENTER],
    ["Which model for background jobs?", ENTER],
    ["Which provider for memory upkeep?", ENTER],
    ["Which model for memory upkeep?", ENTER],
  ]);

  await chooseModels(ctx, p, { env: {}, ...noBrowser });

  p.done();
  expect(readSettings(home).models).toEqual({ cos, worker, consolidation: cos });
});

test("Enter on a first run uses the CoS model for every role, and keeps other settings", async () => {
  const home = tempHome({ jobs: { maxConcurrent: 2 } });
  storeKey(home, "anthropic", "sk-1");
  const ctx = await openSetupContext(home, [REPO_EXTENSIONS]);
  const p = scripted([
    ["Which AI provider", "anthropic"],
    ["How should japa connect", ENTER],
    ["Which model", first],
    ["too?", ENTER],
  ]);

  await chooseModels(ctx, p, { env: {}, ...noBrowser });

  p.done();
  const settings = readSettings(home);
  expect(Object.keys(settings.models)).toEqual(["cos"]);
  expect(settings.jobs).toEqual({ maxConcurrent: 2 });
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
