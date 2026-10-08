// The models step of `japa setup` (design spec §4.2 step 1-3): CoS provider/model/key, then whether workers and
// memory consolidation share it.
import type { ModelRef } from "@earendil-works/pi-durable";
import { envKeyName } from "../kernel/boot.ts";
import { checkModel, loadSettings, readUserSettings, saveSettings, setPath } from "../kernel/settings.ts";
import type { SetupContext } from "./context.ts";
import type { Choice, Prompter } from "./prompt.ts";

/** Picks a provider (among those with at least one model) then one of its models, preselecting `current`. */
async function chooseRole(
  ctx: SetupContext,
  p: Prompter,
  label: string,
  current: ModelRef | undefined,
  fallbackProvider?: string,
): Promise<ModelRef> {
  const providers = ctx.models.getProviders().filter((pr) => ctx.models.getModels(pr.id).length > 0);
  const providerChoices: Choice<string>[] = providers.map((pr) => ({ label: pr.id, value: pr.id, hint: pr.name }));
  const provider = await p.select(`${label} provider`, providerChoices, current?.provider ?? fallbackProvider);

  const modelChoices: Choice<string>[] = ctx.models
    .getModels(provider)
    .map((m) => ({ label: m.id, value: m.id, hint: m.name }));
  const modelId = await p.select(`${label} model`, modelChoices, current?.modelId);

  return { provider, modelId };
}

/** Prompts for `provider`'s API key; Enter keeps the stored one (or skips when there is none). */
async function apiKey(ctx: SetupContext, p: Prompter, env: NodeJS.ProcessEnv, provider: string): Promise<void> {
  const envVar = await envKeyName(ctx.models, provider);
  if (envVar !== undefined && env[envVar]) {
    p.note(`${envVar} is set in this shell, but the background service won't see it; store the key too.`);
  }

  const name = `${provider}.apiKey`;
  const stored = await ctx.secrets.get(name);
  const help = stored === undefined ? "Enter skips" : "Enter keeps the current key";
  const value = await p.secret(`API key for ${provider}`, help);
  if (value !== "") await ctx.secrets.set(name, value);
}

/**
 * Chooses `models.cos`, and either reuses it for `models.worker`/`models.consolidation` or chooses those too;
 * asks for an API key per provider (never twice for the same one). Always saves; returns true.
 */
export async function chooseModels(ctx: SetupContext, p: Prompter, env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  const current = loadSettings(ctx.home).models;

  const cos = await chooseRole(ctx, p, "CoS", current.cos, "anthropic");
  await apiKey(ctx, p, env, cos.provider);
  const asked = new Set([cos.provider]);

  // Preselect what's there (design spec §4.3): a rerun with custom worker/consolidation models keeps them on Enter.
  const shared = current.worker === undefined && current.consolidation === undefined;
  const sameForAll = await p.confirm("Use the CoS model for workers and memory consolidation?", shared);
  let worker: ModelRef | undefined;
  let consolidation: ModelRef | undefined;
  if (!sameForAll) {
    const maybeApiKey = async (provider: string) => {
      if (asked.has(provider) || (await ctx.secrets.get(`${provider}.apiKey`)) !== undefined) return;
      await apiKey(ctx, p, env, provider);
      asked.add(provider);
    };
    // Unset means the CoS model, so Enter keeps whichever model each role runs on now.
    worker = await chooseRole(ctx, p, "Worker", current.worker ?? cos);
    await maybeApiKey(worker.provider);
    consolidation = await chooseRole(ctx, p, "Consolidation", current.consolidation ?? cos);
    await maybeApiKey(consolidation.provider);
  }

  for (const ref of [cos, worker, consolidation]) if (ref !== undefined) checkModel(ctx.models, ref);

  const user = readUserSettings(ctx.home);
  setPath(user, "models.cos", cos);
  setPath(user, "models.worker", worker);
  setPath(user, "models.consolidation", consolidation);
  saveSettings(ctx.home, user);

  return true;
}
