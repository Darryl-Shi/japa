import { access } from "node:fs/promises";
import { homedir } from "node:os";
import type { CredentialStore } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import type { ModelProvider } from "../core/contracts.ts";
import type { Extension } from "../core/host.ts";

export function modelsExtension(provider: ModelProvider): Extension {
  return { name: "japa.models", adapters: { models: () => provider } };
}

/** Auth reads this environment, not global process.env, including for library callers. */
export function createNativeModels(
  env: NodeJS.ProcessEnv = process.env,
  credentials?: CredentialStore,
) {
  const models = createModels({
    credentials,
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
  models.setProvider(openaiProvider());
  models.setProvider(anthropicProvider());
  return models;
}

export function modelRolesFromEnvironment(
  env: NodeJS.ProcessEnv = process.env,
  saved?: Pick<ModelProvider, "root" | "worker">,
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
          root.provider === "anthropic"
            ? "anthropic/claude-sonnet-4-6"
            : "openai/gpt-5.4-mini",
        ));
  return { root, worker };
}

export function modelsFromEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): ModelProvider {
  return { models: createNativeModels(env), ...modelRolesFromEnvironment(env) };
}
