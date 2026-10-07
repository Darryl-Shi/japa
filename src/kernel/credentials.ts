import type { CredentialStore } from "@earendil-works/pi-ai";
import type { SecretsStore } from "./contracts.ts";

const SUFFIX = ".apiKey";

/** pi-ai credentials kept in `store`: a provider's API key is the secret `<provider>.apiKey`. */
export function secretsCredentialStore(store: SecretsStore): CredentialStore {
  const read = async (providerId: string) => {
    const key = await store.get(providerId + SUFFIX);
    return key === undefined ? undefined : { type: "api_key" as const, key };
  };
  return {
    read,
    list: async () =>
      (await store.list())
        .filter((name) => name.endsWith(SUFFIX))
        .map((name) => ({ providerId: name.slice(0, -SUFFIX.length), type: "api_key" as const })),
    modify: async (providerId, fn) => {
      const next = await fn(await read(providerId));
      if (next === undefined) return read(providerId);
      if (next.type !== "api_key" || next.key === undefined) throw new Error("Only API keys are supported");
      await store.set(providerId + SUFFIX, next.key);
      return next;
    },
    delete: async (providerId) => store.delete(providerId + SUFFIX),
  };
}
