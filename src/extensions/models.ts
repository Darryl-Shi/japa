import { access } from "node:fs/promises";
import { homedir } from "node:os";
import type {
  CredentialStore,
  Models,
  ModelsStore,
} from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import type { ModelProvider } from "../core/contracts.ts";
import type { Extension } from "../core/host.ts";

export function modelsExtension(provider: ModelProvider): Extension {
  return { name: "japa.models", adapters: { models: () => provider } };
}

/** Auth reads this environment, not global process.env, including for library callers. */
export function createNativeModels(
  env: NodeJS.ProcessEnv = process.env,
  credentials?: CredentialStore,
  modelsStore?: ModelsStore,
) {
  return builtinModels({
    credentials,
    modelsStore,
    authContext: {
      async env(name) {
        const value = env[name];
        return value?.trim() ? value : undefined;
      },
      async fileExists(path) {
        try {
          await access(path.startsWith("~") ? homedir() + path.slice(1) : path);
          return true;
        } catch {
          return false;
        }
      },
    },
  });
}

/** Restore through native publication first; fetch only this selected provider when needed. */
export async function prepareProviderModels(
  models: Models,
  id: string,
  options: {
    signal?: AbortSignal;
    modelIds?: readonly string[];
    refresh?: boolean;
    allowNetwork?: boolean;
  } = {},
): Promise<void> {
  const provider = models.getProvider(id);
  if (!provider) throw new Error("Unknown model provider.");
  options.signal?.throwIfAborted();
  if (!provider.refreshModels) return;
  const usable = () =>
    options.modelIds?.length
      ? options.modelIds.every((modelId) => models.getModel(id, modelId))
      : models.getModels(id).length > 0;
  let result = await models.refresh({
    providers: [id],
    allowNetwork: false,
    signal: options.signal,
  });
  options.signal?.throwIfAborted();
  if (options.allowNetwork !== false && (options.refresh || !usable())) {
    result = await models.refresh({
      providers: [id],
      signal: options.signal,
      force: options.refresh,
    });
    options.signal?.throwIfAborted();
  }
  // Native providers retain the published cache on failure. Never echo upstream errors:
  // they may include request headers, tokens, or response bodies.
  if ((result.errors.size || result.aborted) && !usable()) {
    throw new Error(
      `Unable to load the model catalog for ${provider.name}. Check provider credentials and network access, then retry.`,
    );
  }
}

export function modelRolesFromEnvironment(
  env: NodeJS.ProcessEnv = process.env,
  saved?: Pick<ModelProvider, "root" | "worker">,
  models: Models = createNativeModels(env),
): Pick<ModelProvider, "root" | "worker"> {
  const anthropic =
    !env.OPENAI_API_KEY &&
    Boolean(
      env.ANTHROPIC_API_KEY ||
        env.ANTHROPIC_OAUTH_TOKEN ||
        env.ANTHROPIC_AUTH_TOKEN,
    );
  const parse = (value: string) => {
    const slash = value.indexOf("/");
    if (slash <= 0 || slash === value.length - 1)
      throw new Error(`Expected provider/model, received '${value}'`);
    return { provider: value.slice(0, slash), modelId: value.slice(slash + 1) };
  };
  const root =
    env.JAPA_MODEL !== undefined
      ? parse(env.JAPA_MODEL)
      : (saved?.root ??
        parse(anthropic ? "anthropic/claude-sonnet-4-6" : "openai/gpt-5.4"));
  const worker =
    env.JAPA_WORKER_MODEL !== undefined
      ? parse(env.JAPA_WORKER_MODEL)
      : (saved?.worker ??
        parse(
          anthropic ? "anthropic/claude-sonnet-4-6" : "openai/gpt-5.4-mini",
        ));
  for (const ref of [root, worker]) {
    if (!models.getProvider(ref.provider))
      throw new Error("Unknown model provider.");
  }
  return { root, worker };
}

/** Synchronous static defaults; configureModels also discovers credential-available defaults/cache. */
export function modelsFromEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): ModelProvider {
  const models = createNativeModels(env);
  const roles = modelRolesFromEnvironment(env, undefined, models);
  for (const [role, ref] of Object.entries(roles)) {
    if (
      !models.getProvider(ref.provider)?.refreshModels &&
      !models.getModel(ref.provider, ref.modelId)
    )
      throw new Error(
        `Unknown ${role} model '${ref.provider}/${ref.modelId}'.`,
      );
  }
  return { models, ...roles };
}
