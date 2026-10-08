import type { AgentEvent, JsonObject, ModelRef, Storage } from "@earendil-works/pi-durable";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import type { MutableModels, Provider } from "@earendil-works/pi-ai";
import type { Job } from "./jobs/state.ts";
import type { SecretRequest } from "./secret-requests.ts";

/** Releases what an `activate()` set up. */
export type Dispose = () => void | Promise<void>;

/** Given to boot-phase adapters (`storage`, `secrets`) when they open. */
export type BootContext = { home: string };

export type StorageAdapter = { name: string; open(config: JsonObject, ctx: BootContext): Promise<Storage> };

export type SecretsStore = {
  get(name: string): Promise<string | undefined>;
  set(name: string, value: string): Promise<void>;
  delete(name: string): Promise<void>;
  list(): Promise<string[]>;
};

export type SecretsAdapter = { name: string; open(config: JsonObject, ctx: BootContext): Promise<SecretsStore> };

export type EnvironmentAdapter = {
  name: string;
  create(input: { conversationId: string; cwd?: string }): ExecutionEnv;
};

/** What `japa status` shows. */
export type Status = {
  model?: ModelRef;
  extensions: { name: string; summary: string; provides: string[] }[];
  errors: { name: string; error: string }[];
};

export type SurfaceContext = {
  home: string;
  root: {
    submit(text: string, mode?: "steer" | "followUp"): Promise<void>;
    abort(): Promise<void>;
    /** Delivers the current snapshot as the first event, then live events. */
    events(listener: (events: readonly AgentEvent[]) => void): Promise<{ stop(): Promise<void> }>;
  };
  /** Delivers the current jobs first, then every change, in id order. */
  jobs(listener: (jobs: Job[]) => void): Promise<{ stop(): Promise<void> }>;
  secrets: {
    /** Delivers the pending secret requests first, then every change. */
    pending(listener: (pending: SecretRequest[]) => void): Promise<{ stop(): Promise<void> }>;
    /** Stores `value` as the requested secret and tells the CoS; throws for an unknown request. */
    fulfil(requestId: string, value: string): Promise<void>;
  };
  status(): Status;
};

export type Surface = { name: string; start(ctx: SurfaceContext): Promise<Dispose> };

export type TriggerContext = { home: string; emit(event: { key: string; text: string }): Promise<void> };

export type Trigger = { name: string; start(ctx: TriggerContext): Promise<Dispose> };

export type KernelContext = {
  home: string;
  extension: string;
  /** The live `settings.extensions.<extension>`; read it when used, as `settings_set` changes it. */
  settings(): JsonObject;
  /** Reads a secret named in the extension's manifest `secrets`; throws for any other name. */
  secret(name: string): Promise<string | undefined>;
  models: MutableModels;
  environments: Map<string, EnvironmentAdapter>;
  surface: SurfaceContext;
  trigger: TriggerContext;
};

/** A named seam with a contribution type, agent-facing docs, a validator, and an activation lifecycle. */
export type Contract<C = unknown> = {
  name: string;
  docs: string; // one paragraph, agent-facing
  phase: "boot" | "runtime";
  cardinality: "one" | "many";
  validate(c: unknown): string | undefined; // error message, or undefined if valid
  activate?(c: C, ctx: KernelContext): Promise<Dispose>;
};

/** Checks that `c` is an object whose named fields have the given `typeof`. */
function requireFields(c: unknown, fields: Record<string, "string" | "function" | "object">): string | undefined {
  if (typeof c !== "object" || c === null) return "must be an object";
  const o = c as Record<string, unknown>;
  for (const [field, type] of Object.entries(fields)) {
    const value = o[field];
    const article = type === "object" ? "an" : "a";
    if (typeof value !== type || (type === "object" && value === null)) return `${field} must be ${article} ${type}`;
  }
  return undefined;
}

export const CORE_CONTRACTS: Contract[] = [
  {
    name: "provider",
    docs: "Registers a pi-ai model provider, making its models selectable in settings and worker profiles.",
    phase: "runtime",
    cardinality: "many",
    validate: (c) => requireFields(c, { id: "string" }),
    activate: async (c, ctx) => {
      const provider = c as Provider;
      ctx.models.setProvider(provider);
      return () => {
        ctx.models.deleteProvider(provider.id);
      };
    },
  },
  {
    name: "surface",
    docs: "Starts a place the user talks to the CoS, such as a chat client or a notification channel.",
    phase: "runtime",
    cardinality: "many",
    validate: (c) => requireFields(c, { name: "string", start: "function" }),
    activate: async (c, ctx) => (c as Surface).start(ctx.surface),
  },
  {
    name: "trigger",
    docs: "Starts a source of events that wake the CoS, such as a schedule or a webhook.",
    phase: "runtime",
    cardinality: "many",
    validate: (c) => requireFields(c, { name: "string", start: "function" }),
    activate: async (c, ctx) => (c as Trigger).start(ctx.trigger),
  },
  {
    name: "tool",
    docs: "A Pi Durable tool the CoS or a worker can call.",
    phase: "runtime",
    cardinality: "many",
    validate: (c) =>
      requireFields(c, { name: "string", description: "string", parameters: "object", execute: "function" }),
  },
  {
    name: "environment",
    docs: "Where tool execution runs, such as the local file system or a container.",
    phase: "runtime",
    cardinality: "many",
    validate: (c) => requireFields(c, { name: "string", create: "function" }),
    activate: async (c, ctx) => {
      const environment = c as EnvironmentAdapter;
      ctx.environments.set(environment.name, environment);
      return () => {
        ctx.environments.delete(environment.name);
      };
    },
  },
  {
    name: "storage",
    docs: "Where durable state lives, opened once at boot.",
    phase: "boot",
    cardinality: "one",
    validate: (c) => requireFields(c, { name: "string", open: "function" }),
  },
  {
    name: "secrets",
    docs: "Where credentials live, opened once at boot.",
    phase: "boot",
    cardinality: "one",
    validate: (c) => requireFields(c, { name: "string", open: "function" }),
  },
];

export const CONTRACTS: ReadonlyMap<string, Contract> = new Map(CORE_CONTRACTS.map((c) => [c.name, c]));

/** Contract activation order at boot. */
export const ACTIVATION_ORDER = ["provider", "environment", "tool", "trigger", "surface"];
