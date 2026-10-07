import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { Context } from "@earendil-works/chord";
import {
  awaitWithContext,
  withAbortSignal,
  withoutAbortSignal,
} from "@earendil-works/chord/context";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import type {
  AuthEvent,
  AuthInteraction,
  AuthOperationOptions,
  Credential,
  CredentialStore,
  Models,
} from "@earendil-works/pi-ai";
import type { ModelProvider } from "../core/contracts.ts";
import type { SettingsPrompt, SettingsUI } from "../core/settings.ts";
import { createNativeModels, modelRolesFromEnvironment } from "./models.ts";

const providers = ["openai", "anthropic"] as const;
type ProviderId = (typeof providers)[number];
type Selection = Pick<ModelProvider, "root" | "worker"> & {
  provider: ProviderId;
};
type Settings = {
  version: 1;
  deviceId: string;
  disconnected?: true;
} & Partial<Selection>;

class SetupCancelled extends Error {
  constructor() {
    super(
      "Model setup cancelled; no usable previous configuration is available.",
    );
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readJson(filename: string): Promise<unknown> {
  let text: string;
  try {
    text = await readFile(filename, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  try {
    return JSON.parse(text);
  } catch {
    // Never include a JSON parser's snippet: the file may contain credentials.
    throw new Error(`Invalid JSON in ${filename}; refusing to overwrite it.`);
  }
}

async function writeJson(filename: string, value: unknown): Promise<void> {
  await mkdir(dirname(filename), { recursive: true, mode: 0o700 });
  const temporary = `${filename}.${randomUUID()}.tmp`;
  try {
    const file = await open(temporary, "wx", 0o600);
    try {
      await file.chmod(0o600);
      await file.writeFile(JSON.stringify(value, null, 2) + "\n", "utf8");
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, filename);
  } finally {
    await rm(temporary, { force: true });
  }
}

function credential(value: unknown): value is Credential {
  if (!record(value)) return false;
  if (value.type === "api_key") {
    return (
      (value.key === undefined ||
        (typeof value.key === "string" && !!value.key.trim())) &&
      (value.env === undefined ||
        (record(value.env) &&
          Object.values(value.env).every((v) => typeof v === "string")))
    );
  }
  return (
    value.type === "oauth" &&
    typeof value.access === "string" &&
    !!value.access.trim() &&
    typeof value.refresh === "string" &&
    typeof value.expires === "number" &&
    Number.isFinite(value.expires)
  );
}

async function readCredentials(
  filename: string,
): Promise<Record<string, Credential>> {
  const data = await readJson(filename);
  if (data === undefined) return {};
  if (
    !record(data) ||
    Object.entries(data).some(
      ([id, value]) => !/^[a-z][a-z0-9-]*$/.test(id) || !credential(value),
    )
  ) {
    throw new Error(
      `Invalid credentials in ${filename}; refusing to overwrite them.`,
    );
  }
  return data as Record<string, Credential>;
}

// File-wide serialization also prevents different providers from losing each other's writes.
// Shared across store instances in this process. The caller MUST hold the CLI's home lock:
// this store assumes one owning process, not cross-process or external-editor coordination.
const writes = new Map<string, Promise<void>>();
function serial<T>(
  filename: string,
  options: AuthOperationOptions | undefined,
  work: () => Promise<T>,
): Promise<T> {
  const result = (writes.get(filename) ?? Promise.resolve()).then(() => {
    options?.signal?.throwIfAborted();
    return work();
  });
  const settled = result.then(
    () => {},
    () => {},
  );
  writes.set(filename, settled);
  void settled.then(() => {
    if (writes.get(filename) === settled) writes.delete(filename);
  });
  return result;
}

/** Persistent pi-ai credentials; complete OAuth objects survive login and native refresh. */
export function createCredentialStore(home: string): CredentialStore {
  const filename = resolve(home, "credentials.json");
  return {
    async read(id, options) {
      options?.signal?.throwIfAborted();
      const data = await readCredentials(filename);
      options?.signal?.throwIfAborted();
      return Object.hasOwn(data, id) ? data[id] : undefined;
    },
    async list(options) {
      options?.signal?.throwIfAborted();
      const data = await readCredentials(filename);
      options?.signal?.throwIfAborted();
      return Object.entries(data).map(([providerId, value]) => ({
        providerId,
        type: value.type,
      }));
    },
    modify(id, fn, options) {
      return serial(filename, options, async () => {
        if (!/^[a-z][a-z0-9-]*$/.test(id))
          throw new Error("Invalid credential provider ID");
        const data = await readCredentials(filename);
        options?.signal?.throwIfAborted();
        const current = Object.hasOwn(data, id) ? data[id] : undefined;
        const next = await fn(structuredClone(current));
        // Once fn starts, finish persistence even on cancellation: it may have rotated a token.
        if (next === undefined) return current;
        if (!credential(next)) throw new Error("Invalid provider credential");
        data[id] = next;
        await writeJson(filename, data);
        return structuredClone(next);
      });
    },
    delete(id, options) {
      return serial(filename, options, async () => {
        const data = await readCredentials(filename);
        options?.signal?.throwIfAborted();
        if (!Object.hasOwn(data, id)) return;
        delete data[id];
        await writeJson(filename, data);
      });
    },
  };
}

function providerId(value: unknown): value is ProviderId {
  return value === "openai" || value === "anthropic";
}

function modelRef(value: unknown): value is ModelProvider["root"] {
  return (
    record(value) &&
    Object.keys(value).every(
      (key) => key === "provider" || key === "modelId",
    ) &&
    providerId(value.provider) &&
    typeof value.modelId === "string" &&
    !!value.modelId.trim()
  );
}

async function readSettings(filename: string): Promise<Settings | undefined> {
  const value = await readJson(filename);
  if (value === undefined) return undefined;
  const valid =
    record(value) &&
    value.version === 1 &&
    typeof value.deviceId === "string" &&
    /^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i.test(value.deviceId) &&
    Object.keys(value).every((key) =>
      [
        "version",
        "deviceId",
        "provider",
        "root",
        "worker",
        "disconnected",
      ].includes(key),
    ) &&
    (value.disconnected === undefined ||
      (value.disconnected === true && providerId(value.provider))) &&
    ((value.provider === undefined &&
      value.root === undefined &&
      value.worker === undefined) ||
      (providerId(value.provider) &&
        modelRef(value.root) &&
        modelRef(value.worker) &&
        value.provider === value.root.provider));
  if (!valid)
    throw new Error(
      `Invalid model settings in ${filename}; refusing to overwrite them.`,
    );
  return value as Settings;
}

function selectionOf(settings: Settings | undefined): Selection | undefined {
  if (!settings?.provider || !settings.root || !settings.worker)
    return undefined;
  return {
    provider: settings.provider,
    root: settings.root,
    worker: settings.worker,
  };
}

function verifyModels(models: Models, selection: Selection): void {
  for (const role of ["root", "worker"] as const) {
    const ref = selection[role];
    if (
      !providerId(ref.provider) ||
      !models.getModel(ref.provider, ref.modelId)
    ) {
      throw new Error(
        `Unknown ${role} model '${ref.provider}/${ref.modelId}'.`,
      );
    }
  }
}

async function configured(
  models: Models,
  selection: Selection,
  context: Context,
): Promise<boolean> {
  verifyModels(models, selection);
  for (const id of new Set([
    selection.root.provider,
    selection.worker.provider,
  ])) {
    const available = await models.getAvailable(id, {
      signal: context.abortSignal,
    });
    for (const ref of [selection.root, selection.worker]) {
      if (
        ref.provider === id &&
        !available.some((model) => model.id === ref.modelId)
      )
        return false;
    }
  }
  // Credential-filtered availability is local configuration, not live entitlement verification.
  return true;
}

async function prompt(
  ui: SettingsUI,
  request: SettingsPrompt,
  context: Context,
): Promise<string> {
  context.abortSignal?.throwIfAborted();
  const answer = await awaitWithContext(
    Promise.resolve().then(() => ui.prompt(request, context)),
    context,
  );
  context.abortSignal?.throwIfAborted();
  if (answer === undefined) throw new SetupCancelled();
  if (
    request.kind === "choice" &&
    !request.choices.some((choice) => choice.value === answer)
  ) {
    throw new Error("Invalid settings choice");
  }
  return answer;
}

async function notify(
  ui: SettingsUI,
  message: string,
  context: Context,
): Promise<void> {
  context.abortSignal?.throwIfAborted();
  await awaitWithContext(
    Promise.resolve().then(() => ui.notify(message, context)),
    context,
  );
}

function eventText(event: AuthEvent): string {
  switch (event.type) {
    case "auth_url":
      return [event.url, event.instructions].filter(Boolean).join("\n");
    case "device_code":
      return `Open ${event.verificationUri}\nEnter code: ${event.userCode}`;
    case "info":
      return [
        event.message,
        ...(event.links ?? []).map(
          (link) => `${link.label ?? "More information"}: ${link.url}`,
        ),
      ].join("\n");
    case "progress":
      return event.message;
  }
}

/** Bridge native login to channel UI; synchronous notify callbacks own every async rejection. */
export async function runAuthInteraction<T>(
  ui: SettingsUI,
  context: Context,
  run: (interaction: AuthInteraction) => Promise<T>,
): Promise<T> {
  const abort = new AbortController();
  const flow = withAbortSignal(abort.signal, context);
  let notifications = Promise.resolve();
  let failure: Error | undefined;
  let active = true;
  const interaction: AuthInteraction = {
    signal: flow.abortSignal,
    notify(event) {
      if (!active) return;
      notifications = notifications
        .then(async () => {
          flow.abortSignal?.throwIfAborted();
          await awaitWithContext(
            Promise.resolve().then(() => ui.notify(eventText(event), flow)),
            flow,
          );
        })
        .catch((error: unknown) => {
          failure ??=
            error instanceof Error
              ? error
              : new Error("Unable to display login progress");
          abort.abort(failure);
        });
    },
    async prompt(request) {
      const child = request.signal
        ? withAbortSignal(request.signal, flow)
        : flow;
      child.abortSignal?.throwIfAborted();
      await awaitWithContext(notifications, child);
      if (failure) throw failure;
      try {
        return await prompt(
          ui,
          request.type === "select"
            ? {
                kind: "choice",
                title: request.message,
                choices: request.options.map((option) => ({
                  value: option.id,
                  label: option.label,
                })),
              }
            : {
                kind: "text",
                title: request.message,
                secret:
                  request.type === "secret" || request.type === "manual_code",
              },
          child,
        );
      } catch (error) {
        // Callback victory aborts just its manual prompt, never the successful login.
        if (!request.signal?.aborted && error instanceof SetupCancelled)
          abort.abort(error);
        throw error;
      }
    },
  };
  try {
    flow.abortSignal?.throwIfAborted();
    const result = await awaitWithContext(
      Promise.resolve().then(() => run(interaction)),
      flow,
    );
    await notifications;
    if (failure) throw failure;
    return result;
  } catch (error) {
    if (failure) throw failure;
    if (abort.signal.reason instanceof SetupCancelled)
      throw abort.signal.reason;
    throw error;
  } finally {
    active = false;
    abort.abort();
  }
}

async function chooseProvider(
  ui: SettingsUI,
  context: Context,
  current = "openai",
): Promise<ProviderId> {
  return (await prompt(
    ui,
    {
      kind: "choice",
      title: "Model provider",
      defaultValue: current,
      choices: [
        { value: "openai", label: "OpenAI" },
        { value: "anthropic", label: "Anthropic" },
      ],
    },
    context,
  )) as ProviderId;
}

/** Native credential-filtered defaults; only /settings supplies UI to show model pickers. */
export async function chooseModels(
  models: Models,
  id: ProviderId,
  ui: SettingsUI | undefined,
  context: Context,
  previous?: Selection,
): Promise<Selection> {
  const defaults =
    id === "anthropic"
      ? { root: "claude-sonnet-4-6", worker: "claude-sonnet-4-6" }
      : { root: "gpt-5.4", worker: "gpt-5.4-mini" };
  const choices = (
    await models.getAvailable(id, { signal: context.abortSignal })
  ).map((model) => ({
    value: model.id,
    label: `${model.name} (${model.id})`,
  }));
  if (!choices.length)
    throw new Error(`No configured models are available for ${id}.`);
  const choose = async (role: "root" | "worker") => {
    const preferred =
      previous?.[role].provider === id
        ? previous[role].modelId
        : defaults[role];
    const defaultValue =
      choices.find((choice) => choice.value === preferred)?.value ??
      choices.find((choice) => choice.value === defaults[role])?.value ??
      choices[0]!.value;
    return ui
      ? prompt(
          ui,
          {
            kind: "choice",
            title: role === "root" ? "Main model" : "Worker model",
            choices,
            defaultValue,
          },
          context,
        )
      : defaultValue;
  };
  return {
    provider: id,
    root: { provider: id, modelId: await choose("root") },
    worker: { provider: id, modelId: await choose("worker") },
  };
}

/**
 * Called with the home lock held and no running Host; setup never enters a conversation.
 * undefined means an explicitly saved logout left the configuration disconnected.
 */
export async function configureModels(
  home: string,
  ui: SettingsUI,
  context: Context,
  options: { force?: boolean; env?: NodeJS.ProcessEnv } = {},
): Promise<ModelProvider | undefined> {
  const env = options.env ?? process.env;
  const filename = join(home, "settings.json");
  let settings = await readSettings(filename);
  const credentials = createCredentialStore(home);
  const original = new Map<string, Credential>();
  for (const { providerId: id } of await credentials.list()) {
    original.set(id, (await credentials.read(id))!);
  }
  const models = createNativeModels(env, credentials);
  const saved = selectionOf(settings);
  if (saved) verifyModels(models, saved);
  const defaults = modelRolesFromEnvironment({
    ...env,
    JAPA_MODEL: undefined,
    JAPA_WORKER_MODEL: undefined,
  });
  const base: Selection = saved ?? {
    provider: defaults.root.provider as ProviderId,
    ...defaults,
  };
  const effective = (selection: Selection): Selection => {
    const roles = modelRolesFromEnvironment(env, selection);
    return { provider: roles.root.provider as ProviderId, ...roles };
  };
  const environment = effective(base);
  // Explicit role overrides win independently; API-key presence never replaces saved roles.
  verifyModels(models, environment);
  const deviceId = settings?.deviceId ?? randomUUID();
  let previous: Selection | undefined;
  try {
    if (await configured(models, environment, context)) previous = environment;
    if (previous && !options.force) {
      // Environment role overrides are transient, including on the first ambient-key startup.
      if (!saved) await writeJson(filename, { version: 1, deviceId, ...base });
      return { models, root: previous.root, worker: previous.worker };
    }

    // Native Models.login writes here until Save. Cancelling cannot replace an old credential.
    const staged = new InMemoryCredentialStore();
    for (const [id, value] of original)
      await staged.modify(id, async () => structuredClone(value));
    const editing = createNativeModels(env, staged);
    let selection = base;
    let loggedOut = false;
    const login = async (id: ProviderId) => {
      const auth = editing.getProvider(id)!.auth;
      const choices = [
        { value: "oauth", label: auth.oauth!.loginLabel ?? auth.oauth!.name },
        { value: "api_key", label: "Enter API key" },
      ];
      if (await editing.checkAuth(id, { signal: context.abortSignal })) {
        choices.unshift({
          value: "existing",
          label: "Keep configured credentials (stored or environment)",
        });
      }
      const type = await prompt(
        ui,
        {
          kind: "choice",
          title: "Authentication",
          choices,
          defaultValue: choices[0]!.value,
        },
        context,
      );
      if (type === "existing") return;
      if (type === "oauth" && !settings) {
        // Persist installation identity even if the first OAuth attempt is later cancelled.
        settings = { version: 1, deviceId };
        await writeJson(filename, settings);
      }
      await runAuthInteraction(ui, context, (interaction) =>
        editing.login(id, type as "oauth" | "api_key", interaction, {
          getDeviceId: () => deviceId,
        }),
      );
      if (!credential(await staged.read(id)))
        throw new Error("The provider returned an invalid credential");
    };
    const save = async (): Promise<ModelProvider | undefined> => {
      const active = effective(selection);
      const ready = await configured(editing, active, context);
      if (!ready && !loggedOut) {
        throw new Error(
          "Both main and worker models need configured provider credentials.",
        );
      }
      if (!ready) {
        await notify(
          ui,
          "Saving disconnected settings and exiting without starting a conversation. Start Japa again to log in; your model selections are retained.",
          context,
        );
      }
      context.abortSignal?.throwIfAborted();
      // From here, complete the commit even if cancelled. Each file is atomic, not a two-file transaction.
      for (const id of providers) {
        const next = await staged.read(id);
        if (JSON.stringify(next) === JSON.stringify(original.get(id))) continue;
        if (next) await credentials.modify(id, async () => next);
        else await credentials.delete(id);
      }
      await writeJson(filename, {
        version: 1,
        deviceId,
        ...selection,
        ...(!ready ? { disconnected: true } : {}),
      });
      return ready
        ? { models, root: active.root, worker: active.worker }
        : undefined;
    };

    if (!options.force) {
      const id = await chooseProvider(
        ui,
        context,
        selection?.provider ?? environment.provider,
      );
      await login(id);
      selection = await chooseModels(
        editing,
        id,
        undefined,
        context,
        selection,
      );
      return await save();
    }
    while (true) {
      const action = await prompt(
        ui,
        {
          kind: "choice",
          title: "Model settings",
          defaultValue: previous ? "save" : "login",
          choices: [
            { value: "save", label: "Save and return" },
            { value: "login", label: "Log in / change provider" },
            { value: "models", label: "Change main and worker models" },
            { value: "logout", label: "Log out a provider" },
            { value: "cancel", label: "Cancel changes" },
          ],
        },
        context,
      );
      if (action === "cancel") throw new SetupCancelled();
      if (action === "save") {
        if (
          loggedOut ||
          (await configured(editing, effective(selection), context))
        )
          return await save();
        await notify(
          ui,
          "Both roles need configured credentials. Log in, select another provider, or cancel.",
          context,
        );
        continue;
      }
      const id = await chooseProvider(
        ui,
        context,
        selection?.provider ?? environment.provider,
      );
      if (action === "logout") {
        await editing.logout(id, { signal: context.abortSignal });
        loggedOut = true;
        await notify(
          ui,
          "Stored login removed from pending settings. Environment credentials, if present, still apply. Save to apply, or cancel to keep the previous login.",
          context,
        );
      } else {
        if (action === "login") await login(id);
        selection = await chooseModels(editing, id, ui, context, selection);
      }
    }
  } catch (error) {
    if (!(error instanceof SetupCancelled) && !context.abortSignal?.aborted)
      throw error;
    if (previous)
      return { models, root: previous.root, worker: previous.worker };
    // Cancellation may have arrived during the initial auth checks. Restoring the
    // old configuration is cleanup, and must not use the already-aborted signal.
    if (await configured(models, environment, withoutAbortSignal(context))) {
      return { models, root: environment.root, worker: environment.worker };
    }
    if (settings?.disconnected) return undefined;
    throw new SetupCancelled();
  }
}
