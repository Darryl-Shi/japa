import type { AuthInteraction, TSchema } from "@earendil-works/pi-ai";
import type { AnyTask, HookRegistration, JsonObject, PromptSection, Wrap } from "@earendil-works/pi-durable";
import { CONTRACTS, type Dispose, type KernelContext } from "./contracts.ts";

/**
 * A secret an extension may read: its name, or a name with a description shown to the user in `japa setup`.
 * `generated`: the extension makes its own value when none is set, so setup never asks for it.
 */
export type SecretSpec = string | { name: string; description: string; generated?: boolean };

/** What an authorize hook may use; `KernelContext` satisfies it, and so does setup (no daemon needed). */
export type AuthorizeContext = {
  home: string;
  settings(): JsonObject;
  secret(name: string): Promise<string | undefined>;
  setSecret(name: string, value: string): Promise<void>;
};

/** Signing in to the user's account, from `japa setup` or the chat `connect` tool. */
export type Authorize = {
  /** Signs in through `io` and stores what it gets with `setSecret`; a short line for the user, e.g.
   *  "Connected as you@gmail.com". Throws with a user-facing message on failure. */
  run(ctx: AuthorizeContext, io: AuthInteraction): Promise<string>;
  /** Whether it's signed in now. */
  connected(ctx: AuthorizeContext): Promise<boolean>;
};

/** An extension's manifest: identity, descriptive fields for routing, and its contributions. */
export type JapaExtension = {
  name: string; // kebab-case, equals its directory name
  summary: string;
  examples?: string[];
  docs?: string;
  provides?: Record<string, unknown[]>; // keyed by contract name
  durable?: { sections?: PromptSection[]; hooks?: HookRegistration[]; wraps?: Wrap[]; tasks?: AnyTask[] };
  secrets?: SecretSpec[];
  settings?: TSchema; // schema for settings.extensions.<name>
  setup?(ctx: KernelContext): void | Dispose | Promise<void | Dispose>; // called before its tools are installed
  status?: () => string | undefined; // a short line shown under it in `japa status`, read on every status()
  authorize?: Authorize; // signs in to the user's account
};

/** Identity function that types an extension manifest. */
export function defineJapaExtension(e: JapaExtension): JapaExtension {
  return e;
}

export const KEBAB_CASE = /^[a-z][a-z0-9-]*$/;

/** Validates a manifest against the core contracts; `[]` when valid. */
export function validateExtension(e: JapaExtension): string[] {
  const errors: string[] = [];

  if (typeof e.name !== "string" || !KEBAB_CASE.test(e.name)) errors.push("name must be kebab-case");
  if (!e.summary) errors.push("summary is required");
  if (e.setup !== undefined && typeof e.setup !== "function") errors.push("setup must be a function");
  if (e.authorize !== undefined) {
    if (typeof e.authorize !== "object" || e.authorize === null) {
      errors.push("authorize must be an object with run and connected functions");
    } else {
      if (typeof e.authorize.run !== "function") errors.push("authorize.run must be a function");
      if (typeof e.authorize.connected !== "function") errors.push("authorize.connected must be a function");
    }
  }

  (e.secrets ?? []).forEach((s, i) => {
    const described = typeof s === "object" && s !== null && typeof s.name === "string" && typeof s.description === "string";
    if (typeof s !== "string" && !described) errors.push(`secrets[${i}]: must be a name or { name, description }`);
  });

  const tools = e.provides?.tool;
  if (tools && tools.length > 0) {
    if (!e.examples || e.examples.length === 0) errors.push("examples are required when providing tools");
    if (!e.docs) errors.push("docs are required when providing tools");
  }

  for (const [name, contributions] of Object.entries(e.provides ?? {})) {
    const contract = CONTRACTS.get(name);
    if (!contract) {
      errors.push(`unknown contract "${name}"`);
      continue;
    }
    if (!Array.isArray(contributions)) {
      errors.push(`${name}: must be an array`);
      continue;
    }
    contributions.forEach((c, i) => {
      const error = contract.validate(c);
      if (error) errors.push(`${name}[${i}]: ${error}`);
    });
  }

  return errors;
}

/** The names of the secrets an extension may read, whether declared as a string or `{ name, description }`. */
export function secretNames(e: JapaExtension): string[] {
  return (e.secrets ?? []).map((s) => (typeof s === "string" ? s : s.name));
}

/** The secrets `japa setup` asks the user for: every declared one but those the extension generates itself. */
export function askedSecretNames(e: JapaExtension): string[] {
  return (e.secrets ?? []).flatMap((s) => (typeof s === "string" ? [s] : s.generated ? [] : [s.name]));
}

/** The description given for one of an extension's secrets; undefined for a plain string or an unknown name. */
export function secretDescription(e: JapaExtension, name: string): string | undefined {
  const spec = (e.secrets ?? []).find((s) => (typeof s === "string" ? s : s.name) === name);
  return typeof spec === "object" ? spec.description : undefined;
}
