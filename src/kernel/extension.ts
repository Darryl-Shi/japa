import type { AnyTask, HookRegistration, PromptSection, Wrap } from "@earendil-works/pi-durable";
import type { Contract } from "./contracts.ts";

/** An extension's manifest: identity, descriptive fields for routing, and its contributions. */
export type JapaExtension = {
  name: string; // kebab-case, equals its directory name
  summary: string;
  examples?: string[];
  docs?: string;
  provides?: Record<string, unknown[]>; // keyed by contract name
  contracts?: Contract[]; // contracts this extension defines
  durable?: { sections?: PromptSection[]; hooks?: HookRegistration[]; wraps?: Wrap[]; tasks?: AnyTask[] };
  secrets?: string[];
};

/** Identity function that types an extension manifest. */
export function defineJapaExtension(e: JapaExtension): JapaExtension {
  return e;
}

const KEBAB_CASE = /^[a-z][a-z0-9-]*$/;

/** Validates a manifest against the core contracts plus any the extension itself defines; `[]` when valid. */
export function validateExtension(e: JapaExtension, contracts: ReadonlyMap<string, Contract>): string[] {
  const errors: string[] = [];

  if (typeof e.name !== "string" || !KEBAB_CASE.test(e.name)) errors.push("name must be kebab-case");
  if (!e.summary) errors.push("summary is required");

  const tools = e.provides?.tool;
  if (tools && tools.length > 0) {
    if (!e.examples || e.examples.length === 0) errors.push("examples are required when providing tools");
    if (!e.docs) errors.push("docs are required when providing tools");
  }

  for (const [name, contributions] of Object.entries(e.provides ?? {})) {
    const contract = contracts.get(name);
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
