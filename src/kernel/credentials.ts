import type { Credential, CredentialStore } from "@earendil-works/pi-ai";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SecretsStore } from "./contracts.ts";
import { message } from "./loader.ts";

/** Providers listed first, in this order (setup, Settings); the others follow by name. */
export const FEATURED = ["anthropic", "openai", "google", "openrouter", "github-copilot", "xai", "zai", "deepseek", "mistral"];

/** Sorts providers as setup lists them: `FEATURED` first, in order, then by name. */
export function byFeatured<P extends { id: string; name: string }>(providers: readonly P[]): P[] {
  const rank = (id: string) => (FEATURED.includes(id) ? FEATURED.indexOf(id) : FEATURED.length);
  return providers.toSorted((a, b) => rank(a.id) - rank(b.id) || a.name.localeCompare(b.name));
}

/** This install's stable id, for sign-in flows that register the device (`<home>/device-id`). */
export function deviceId(home: string): string {
  const file = join(home, "device-id");
  if (existsSync(file)) return readFileSync(file, "utf8").trim();
  const id = randomUUID();
  writeFileSync(file, `${id}\n`);
  return id;
}

/** An error's message followed by its causes': pi-ai wraps the provider's own error. */
export function describe(error: unknown): string {
  const parts: string[] = [];
  for (let e: unknown = error; e !== undefined && parts.length < 4; e = (e as { cause?: unknown }).cause) {
    const text = message(e);
    if (text && !parts.includes(text)) parts.push(text);
    if (!(e instanceof Error)) break;
  }
  return parts.join(": ");
}

const API_KEY = ".apiKey";
const CREDENTIAL = ".credential";

/** A plain API key, nothing else: kept as the bare key in `<provider>.apiKey`, the file users write by hand. */
const isPlainKey = (c: Credential): c is { type: "api_key"; key: string } =>
  c.type === "api_key" && typeof c.key === "string" && (c.env === undefined || Object.keys(c.env).length === 0);

/**
 * pi-ai credentials kept in `store`, one per provider:
 * - a plain API key is the secret `<provider>.apiKey` (just the key);
 * - anything else -- an OAuth login (access and refresh tokens), or an API key with provider settings such as a
 *   Cloudflare account id -- is the secret `<provider>.credential`, the credential as JSON.
 *
 * Writing one removes the other, so a provider has one credential. `modify` is serialized per provider within
 * this process, which is what pi-ai's OAuth refresh relies on: a refresh token is rotated exactly once.
 */
export function secretsCredentialStore(store: SecretsStore): CredentialStore {
  const chains = new Map<string, Promise<unknown>>();
  /** Runs `task` after every earlier task for `providerId` settles. */
  const serialized = <T>(providerId: string, task: () => Promise<T>): Promise<T> => {
    const run = (chains.get(providerId) ?? Promise.resolve()).then(task, task);
    const settled = run.catch(() => {});
    chains.set(providerId, settled);
    void settled.then(() => chains.get(providerId) === settled && chains.delete(providerId));
    return run;
  };

  const read = async (providerId: string): Promise<Credential | undefined> => {
    const json = await store.get(providerId + CREDENTIAL);
    if (json !== undefined) {
      try {
        return JSON.parse(json) as Credential;
      } catch {
        throw new Error(`The secret ${providerId}${CREDENTIAL} isn't valid JSON; run japa setup to sign in again`);
      }
    }
    const key = (await store.get(providerId + API_KEY))?.trim();
    return key ? { type: "api_key", key } : undefined;
  };

  const write = async (providerId: string, credential: Credential): Promise<void> => {
    if (isPlainKey(credential)) {
      await store.set(providerId + API_KEY, credential.key.trim());
      await store.delete(providerId + CREDENTIAL);
    } else {
      await store.set(providerId + CREDENTIAL, JSON.stringify(credential));
      await store.delete(providerId + API_KEY);
    }
  };

  return {
    read: (providerId) => read(providerId),
    list: async () => {
      const ids = new Map<string, Credential["type"]>();
      for (const name of await store.list()) {
        if (name.endsWith(API_KEY)) ids.set(name.slice(0, -API_KEY.length), "api_key");
      }
      for (const name of await store.list()) {
        if (!name.endsWith(CREDENTIAL)) continue;
        const providerId = name.slice(0, -CREDENTIAL.length);
        const credential = await read(providerId).catch(() => undefined);
        if (credential !== undefined) ids.set(providerId, credential.type);
      }
      return [...ids].map(([providerId, type]) => ({ providerId, type }));
    },
    modify: (providerId, fn) =>
      serialized(providerId, async () => {
        const current = await read(providerId);
        const next = await fn(current);
        if (next === undefined) return current;
        await write(providerId, next);
        return next;
      }),
    delete: (providerId) =>
      serialized(providerId, async () => {
        await store.delete(providerId + API_KEY);
        await store.delete(providerId + CREDENTIAL);
      }),
  };
}
