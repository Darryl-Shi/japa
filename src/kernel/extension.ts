import type { TSchema } from "@earendil-works/pi-ai";
import type { AnyTask, HookRegistration, PromptSection, Wrap } from "@earendil-works/pi-durable";
import { CONTRACTS, type Dispose, type KernelContext } from "./contracts.ts";

/** A secret an extension may read: its name, or a name with a description shown to the user in `japa setup`. */
export type SecretSpec = string | { name: string; description: string };

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

/** The description given for one of an extension's secrets; undefined for a plain string or an unknown name. */
export function secretDescription(e: JapaExtension, name: string): string | undefined {
  const spec = (e.secrets ?? []).find((s) => (typeof s === "string" ? s : s.name) === name);
  return typeof spec === "object" ? spec.description : undefined;
}
