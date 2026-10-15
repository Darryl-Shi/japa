import type { AuthInteraction, CredentialStore, Models } from "@earendil-works/pi-ai";
import type { JsonObject } from "@earendil-works/pi-durable";
import type { AdminContext, MessagingContext, ProviderInfo } from "./contracts.ts";
import { byFeatured, describe, deviceId } from "./credentials.ts";
import type { AuthorizeContext, JapaExtension } from "./extension.ts";

export type AdminDeps = {
  home: string;
  /** The live merged settings. */
  settings: () => JsonObject;
  models: Models;
  /** The store `models` keeps its credentials in. */
  credentials: CredentialStore;
  /** The settings operations `AdminContext` shares with the Telegram menu. */
  messaging: MessagingContext;
  extensions: () => JapaExtension[];
  context: (extension: string) => AuthorizeContext;
  refreshAvailability: () => Promise<void>;
  /** The extensions with a sign-in running, shared with the `connect` tool's flows. */
  signingIn: Set<string>;
};

/** The `AdminContext` packaged surfaces get, built on the messaging context's code paths. */
export function createAdmin(deps: AdminDeps): AdminContext {
  const { messaging, models } = deps;
  const loggingIn = new Set<string>();
  const { check, current, start, state } = messaging.update;
  const provider = (id: string) => {
    const found = models.getProvider(id);
    if (found === undefined) throw new Error(`No provider ${id}.`);
    return found;
  };

  return {
    settings: () => structuredClone(deps.settings()),
    setSetting: (path, value) => messaging.setSetting(path, value),
    extensions: () => messaging.extensions(),
    setSecret: (extension, name, value) => messaging.setSecret(extension, name, value),
    rollback: (extension) => messaging.rollback(extension),
    changes: () => messaging.changes(),
    undoChange: (id) => messaging.undoChange(id),
    clearFinishedJobs: () => messaging.clearFinishedJobs(),
    tool: async (name, args) => (name.startsWith("schedule_") ? messaging.tool(name, args) : undefined),
    update: { check, current, start, state },
    providers: async () => {
      const providers = byFeatured(models.getProviders().filter((p) => models.getModels(p.id).length > 0));
      return Promise.all(
        providers.map(async ({ id, name, auth }): Promise<ProviderInfo> => {
          const credential = (await deps.credentials.read(id).catch(() => undefined))?.type;
          const connected = await models.checkAuth(id).then((a) => a !== undefined, () => false);
          return {
            id,
            name,
            ...(credential !== undefined && { credential }),
            connected,
            ...(auth.oauth && {
              signIn: {
                label: auth.oauth.loginLabel ?? `Sign in with ${auth.oauth.name}`,
                subscription: !!auth.oauth.isSubscription,
              },
            }),
            ...(auth.apiKey?.login && { apiKey: { label: auth.apiKey.name } }),
          };
        }),
      );
    },
    models: async (id) => {
      if (provider(id).refreshModels) await models.refresh({ providers: [id] }).catch(() => {});
      const available = await models.getAvailable(id).catch(() => []);
      const list = available.length > 0 ? available : models.getModels(id);
      return list.map((m) => ({ id: m.id, name: m.name }));
    },
    login: async (id, type, interaction) => {
      const { name } = provider(id);
      if (loggingIn.has(id)) throw new Error(`Already signing in to ${name}.`);
      loggingIn.add(id);
      try {
        await models.login(id, type, interaction, { getDeviceId: () => deviceId(deps.home) });
      } catch (error) {
        throw new Error(`Couldn't connect to ${name}: ${describe(error)}`, { cause: error });
      } finally {
        loggingIn.delete(id);
      }
      await deps.refreshAvailability();
    },
    authorize: async (extension, interaction: AuthInteraction) => {
      const authorize = deps.extensions().find((e) => e.name === extension)?.authorize;
      if (authorize === undefined) throw new Error(`${extension} has no sign-in.`);
      if (deps.signingIn.has(extension)) throw new Error(`Already signing in to ${extension}.`);
      deps.signingIn.add(extension);
      try {
        const outcome = await authorize.run(deps.context(extension), interaction);
        await deps.refreshAvailability();
        return outcome;
      } finally {
        deps.signingIn.delete(extension);
      }
    },
  };
}
