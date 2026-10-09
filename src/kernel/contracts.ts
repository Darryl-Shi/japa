import type {
  AgentEvent,
  JsonObject,
  ModelRef,
  Storage,
  ToolExecutionResult,
  UserInput,
} from "@earendil-works/pi-durable";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import type { MutableModels, Provider, TSchema } from "@earendil-works/pi-ai";
import type { ExtensionState } from "./availability.ts";
import type { Change } from "./changes.ts";
import type { Job } from "./jobs/state.ts";
import { type SecretPrompt, startMessaging } from "./messaging/surface.ts";
import type { SecretRequest } from "./secret-requests.ts";
import { schemaProblems } from "./tool-schema.ts";
import type { UpdateCheck, UpdateState } from "./update-state.ts";

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
  extensions: { name: string; summary: string; provides: string[]; status?: string; state?: ExtensionState }[];
  errors: { name: string; error: string }[];
};

/** Where an input came from: a surface and chat, or the kernel on its own (`"proactive"`). */
export type Origin = { surface: string; chat?: string } | "proactive";

/** A finished assistant message's text, its turn's origin, and the cursor to resume `replies` after it. */
export type Reply = { cursor: string; origin: Origin; text: string };

export type SurfaceContext = {
  home: string;
  root: {
    /** With an `origin`, the input's requestId encodes it; an `id` makes a resubmission a no-op. */
    submit(
      input: UserInput,
      mode?: "steer" | "followUp",
      origin?: { surface: string; chat?: string; id?: string },
    ): Promise<void>;
    abort(): Promise<void>;
    /** Delivers the current snapshot as the first event, then live events. */
    events(listener: (events: readonly AgentEvent[]) => void): Promise<{ stop(): Promise<void> }>;
    /**
     * Delivers each finished assistant message with text, in order, one at a time (awaiting a returned promise);
     * after the cursor `after`, or from now when absent. `stop()` waits for the delivery in progress.
     */
    replies(listener: (r: Reply) => void | Promise<void>, after?: string): Promise<{ stop(): Promise<void> }>;
  };
  /** Delivers the current jobs first, then every change, in id order. */
  jobs(listener: (jobs: Job[]) => void): Promise<{ stop(): Promise<void> }>;
  secrets: {
    /** Delivers the pending secret requests first, then every change. */
    pending(listener: (pending: SecretRequest[]) => void): Promise<{ stop(): Promise<void> }>;
    /**
     * Stores `value` as the requested secret and tells the CoS; throws for an unknown request. `by` (`<adapter>:<id>`)
     * records the chat message that carried it.
     */
    fulfil(requestId: string, value: string, by?: string): Promise<void>;
    /**
     * Removes the request and tells the CoS it was declined, without a value; throws for an unknown request. A
     * sign-in's request instead ends its `connect` flow, which reports the decline. Waiters for the secret's value
     * keep waiting.
     */
    decline(requestId: string): Promise<void>;
  };
  status(): Status;
};

export type Surface = { name: string; start(ctx: SurfaceContext): Promise<Dispose> };

export interface MessagingAdapter {
  name: string; // "telegram"; also the surface name in origins
  maxMessageChars: number; // outgoing limit per message (Telegram: 4096); inputs are not capped
  start(ctx: MessagingAdapterContext): Promise<Dispose>;
  send(chat: string, m: OutgoingMessage): Promise<string>; // returns the message id
  edit(chat: string, messageId: string, m: OutgoingMessage): Promise<void>;
  delete(chat: string, messageId: string): Promise<void>;
  typing(chat: string): Promise<void>; // shows "typing…" for a few seconds
  commands(list: { name: string; description: string }[]): Promise<void>; // registers slash commands
}

export interface MessagingAdapterContext {
  receive(m: Incoming): Promise<void>; // the adapter calls this for each incoming message or button press
}

export type Incoming = {
  chat: string;
  user: string;
  messageId: string;
  id: string; // platform-unique, used for dedup
  text?: string;
  images?: { data: Uint8Array; mimeType: string }[];
  command?: string; // "jobs" for "/jobs"
  action?: string; // a pressed button's action
  replyTo?: string; // the id of the message this one replies to
};

export type OutgoingMessage = {
  markdown: string;
  buttons?: { label: string; action: string }[][];
  /** Show this message with the platform's reply input, `placeholder` as its hint; ignored without such a UI. */
  input?: { placeholder: string };
};

export type TriggerContext = { home: string; emit(event: { key: string; text: string }): Promise<void> };

export type Trigger = { name: string; start(ctx: TriggerContext): Promise<Dispose> };

/**
 * An extension as the settings menu shows it: a loaded one, or a workspace one that failed to load (`loaded` false,
 * "not set up"). `secrets` are those setup asks for, each `set` or not (never its value); `schema` is its settings
 * schema, as `settingsSchema`, and `values` its current `settings.extensions.<name>`.
 */
export type ExtensionInfo = {
  name: string;
  summary?: string;
  state: ExtensionState;
  error?: string;
  status?: string;
  workspace: boolean;
  loaded: boolean;
  secrets: { name: string; description?: string; set: boolean }[];
  schema?: TSchema;
  values: JsonObject;
};

/**
 * Kernel-internal, given only to the messaging surface: each adapter's reply cursor, and the settings menu's changes,
 * made through the same code paths as the CoS's tools.
 */
export type MessagingContext = {
  cursor(adapter: string): Promise<string | undefined>;
  saveCursor(adapter: string, cursor: string): Promise<void>;
  /** The `by` of the latest secret fulfilled from a chat. */
  secretFulfilledBy(): Promise<string | undefined>;
  /** Records `by` (`<adapter>:<id>`) as the chat message that carried the latest secret, as `secretFulfilledBy`. */
  recordSecretMessage(by: string): Promise<void>;
  /** When the menu screen waiting for a secret in `adapter`'s chat opened; it may be from before a restart. */
  secretInput(adapter: string): Promise<number | undefined>;
  /** Saves `opened` as `adapter`'s `secretInput`, or clears it when undefined. */
  saveSecretInput(adapter: string, opened: number | undefined): Promise<void>;
  /** `adapter`'s saved secret prompts, and the ids of the latest prompts and decline messages it sent, oldest first. */
  promptState(adapter: string): Promise<{ prompts: SecretPrompt[]; history: string[] }>;
  /** Saves `adapter`'s secret prompts and their message ids, keeping the last `PROMPT_HISTORY` ids. */
  savePromptState(adapter: string, state: { prompts: SecretPrompt[]; history: string[] }): Promise<void>;
  /** As `settings_set`; its reply. */
  setSetting(path: string, value: unknown): Promise<string>;
  /** Rolls a workspace extension back to its last known good version, as the `rollback` tool; its reply. */
  rollback(extension: string): Promise<string>;
  /** Runs the registered tool `name`, which may use only `api.commit` and `api.snapshot`; undefined without one. */
  tool(name: string, args: JsonObject): Promise<ToolExecutionResult | undefined>;
  /** Removes every done, failed and cancelled job from the jobs list; returns how many. */
  clearFinishedJobs(): Promise<number>;
  /** The logged changes, newest first. */
  changes(): Promise<Change[]>;
  /**
   * Undoes change `id`: as `change_undo`, or, for a change undone by a tool call, makes that call and, when it
   * succeeds (its reply doesn't start `No ` or `Not `), drops the change from the log; the reply.
   */
  undoChange(id: string): Promise<string>;
  /** The loaded extensions and the workspace ones that failed to load, sorted by name. */
  extensions(): Promise<ExtensionInfo[]>;
  /**
   * Stores `value` as `extension`'s secret `name` (`Not changed: …` when it doesn't declare it): fulfilling a pending
   * request for it, as `SurfaceContext.secrets.fulfil`, else storing it and resolving `secretProvided` waiters, with
   * `by` recorded as `recordSecretMessage`; then recomputes availability. Its reply, `Set <name>.`.
   */
  setSecret(extension: string, name: string, value: string, by?: string): Promise<string>;
  /** Updating japa from chat (design doc §4.3), through the `Updater` the CLI gave `boot`, and its `update.json`. */
  update: {
    /** What an update would bring in. Throws `Updating from chat isn't available: japa wasn't started as a daemon.`
     * without an updater, as `start` does. */
    check(): Promise<UpdateCheck>;
    /** The full sha japa's checkout is on, without fetching; throws as `check` does without an updater. */
    current(): Promise<string>;
    /**
     * Records an update to `to` (from `from`, asked in `chat`) as running, then launches it. Refuses (throws `An update
     * is already running (started <ago> ago).`) while one runs; a launch that throws leaves it failed, its error the
     * summary, and reported (the caller shows that error), and rethrows.
     */
    start(chat: { adapter: string; chat: string }, from: string, to: string, rollback: boolean): Promise<void>;
    /** The recorded update, if any. */
    state(): Promise<UpdateState | undefined>;
    /** Marks the recorded update reported if it is the one `started` then: a report can't mark a newer run's. */
    markReported(started: number): Promise<void>;
  };
};

export type KernelContext = {
  home: string;
  extension: string;
  /** The live `settings.extensions.<extension>`; read it when used, as `settings_set` changes it. */
  settings(): JsonObject;
  /** Reads a secret named in the extension's manifest `secrets`; throws for any other name. */
  secret(name: string): Promise<string | undefined>;
  /** Stores a secret named in the extension's manifest `secrets`; throws as `secret`. */
  setSecret(name: string, value: string): Promise<void>;
  /** Resolves with the value the next time a request for `name` is fulfilled; throws as `secret`. */
  secretProvided(name: string): Promise<string>;
  /** Asks the user for `name` (as `secret_request`), then resolves as `secretProvided`. */
  requestSecret(name: string, why: string): Promise<string>;
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
  activate?(c: C, ctx: KernelContext, messaging: MessagingContext): Promise<Dispose>;
};

/** Checks that `c` is an object whose named fields have the given `typeof`. */
function requireFields(
  c: unknown,
  fields: Record<string, "string" | "number" | "function" | "object">,
): string | undefined {
  if (typeof c !== "object" || c === null) return "must be an object";
  const o = c as Record<string, unknown>;
  for (const [field, type] of Object.entries(fields)) {
    const value = o[field];
    const article = type === "object" ? "an" : "a";
    if (typeof value !== type || (type === "object" && value === null)) return `${field} must be ${article} ${type}`;
  }
  return undefined;
}

const CORE_CONTRACTS: Contract[] = [
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
    name: "messaging",
    docs:
      "A chat platform the user talks to the CoS through. Implement only transport; japa provides commands, " +
      "settings, secrets, routing and images.",
    phase: "runtime",
    cardinality: "many",
    validate: (c) =>
      requireFields(c, {
        name: "string",
        maxMessageChars: "number",
        start: "function",
        send: "function",
        edit: "function",
        delete: "function",
        typing: "function",
        commands: "function",
      }),
    activate: (c, ctx, messaging) => startMessaging(c as MessagingAdapter, ctx, messaging),
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
      requireFields(c, { name: "string", description: "string", parameters: "object", execute: "function" }) ??
      (schemaProblems((c as { parameters: unknown }).parameters).join("; ") || undefined),
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
export const ACTIVATION_ORDER = ["provider", "environment", "tool", "trigger", "surface", "messaging"];
