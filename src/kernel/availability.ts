// Extension availability (design spec §2.1): an extension is configured when every secret `japa setup` asks for
// is stored and every required setting is saved, and available ("on") when it is configured and not turned off
// with `settings.extensions.<name>.enabled: false`.
import type { TSchema } from "@earendil-works/pi-ai";
import type { JsonObject } from "@earendil-works/pi-durable";
import { askedSecretNames, type JapaExtension } from "./extension.ts";
import { settingsSchema } from "./settings-tools.ts";

export type ExtensionState = "on" | "off" | "not set up";

/** Reads a stored secret; undefined when it is not set. */
export type SecretReader = { get(name: string): Promise<string | undefined> };

type ObjectSchema = { properties?: Record<string, TSchema>; required?: string[] };

/**
 * The settings properties `japa setup` asks for: the required ones without a default. Everything optional has a
 * default (or works unset), so it needs no setup; the user can still change it by asking japa.
 */
export function askedProperties(e: JapaExtension): Record<string, TSchema> {
  const schema = settingsSchema(e) as ObjectSchema;
  const required = new Set(schema.required ?? []);
  return Object.fromEntries(
    Object.entries(schema.properties ?? {}).filter(
      ([prop, s]) => required.has(prop) && (s as { default?: unknown }).default === undefined,
    ),
  );
}

/** Whether the secret `name` is stored; a reader that throws counts as not set. */
async function stored(secrets: SecretReader, name: string): Promise<boolean> {
  try {
    return (await secrets.get(name)) !== undefined;
  } catch {
    return false;
  }
}

/**
 * Whether `e` is set up: every secret setup asks for is stored in `secrets` and every required setting is saved in
 * `extensionSettings` (the user's `settings.extensions`).
 */
export async function isConfigured(
  e: JapaExtension,
  secrets: SecretReader,
  extensionSettings: Record<string, JsonObject | undefined>,
): Promise<boolean> {
  for (const name of askedSecretNames(e)) if (!(await stored(secrets, name))) return false;
  const own = extensionSettings[e.name];
  return Object.keys(askedProperties(e)).every((prop) => own?.[prop] !== undefined);
}

/** `e`'s state: "not set up" until configured, then "off" when its `enabled` setting is false, else "on". */
export async function extensionState(
  e: JapaExtension,
  secrets: SecretReader,
  extensionSettings: Record<string, JsonObject | undefined>,
): Promise<ExtensionState> {
  if (!(await isConfigured(e, secrets, extensionSettings))) return "not set up";
  return extensionSettings[e.name]?.enabled === false ? "off" : "on";
}
