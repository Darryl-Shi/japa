import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import {
  type AgentEvent,
  type Conversation,
  createRegistry,
  type EntryId,
  type Extension,
  Harness,
  LiveDoc,
  type ModelRef,
  ROOT_CONVERSATION_ID,
  type Storage,
  watchEvents,
} from "@earendil-works/pi-durable";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { createModels, type Models } from "@earendil-works/pi-ai";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ChangesDoc } from "./changes.ts";
import {
  CORE_CONTRACTS,
  type EnvironmentAdapter,
  type KernelContext,
  type SecretsAdapter,
  type Status,
  type StorageAdapter,
} from "./contracts.ts";
import { cosExtension, ensureRoot } from "./cos.ts";
import { secretsCredentialStore } from "./credentials.ts";
import { createEnvDispatcher } from "./env.ts";
import type { JapaExtension } from "./extension.ts";
import { byId, JobsDoc } from "./jobs/state.ts";
import { WorkerExtension } from "./jobs/worker.ts";
import { consolidation } from "./memory/consolidate.ts";
import { estimateTokens, MemoryDoc } from "./memory/state.ts";
import { shouldConsolidate } from "./memory/trigger.ts";
import { discoverExtensions, type LoadError, linkSdk, loadExtensions } from "./loader.ts";
import { acquireLock } from "./lock.ts";
import { fulfilSecret, SecretRequestsDoc } from "./secret-requests.ts";
import { settingsTools } from "./settings-tools.ts";
import { createRuntime, type Runtime } from "./runtime.ts";
import { checkModel, loadSettings, type Settings } from "./settings.ts";
import { dirHash, ensureWorkspace } from "./workspace.ts";

const packageRoot = fileURLToPath(new URL("../..", import.meta.url));

export type BootOptions = {
  home: string;
  /** Default: `[<packageRoot>/extensions, <home>/extensions]`. */
  extensionDirs?: string[];
  /** Added after the discovered extensions, replacing any with the same name. */
  extensions?: JapaExtension[];
};

export type Daemon = {
  harness: Harness;
  root: Conversation;
  status(): Status;
  /** Consolidates the CoS's context and waits for it. */
  consolidate(): Promise<void>;
  /** Consolidates when the CoS is idle and its live window is full or stale. */
  checkConsolidation(now?: number): Promise<void>;
  /** Reloads the changed workspace extensions, skills and worker profiles; its errors also go to `status()`. */
  reconcile(): Promise<{ errors: LoadError[]; notices: string[] }>;
  close(): Promise<void>;
};

/** Boots japa in `home`: opens storage, activates contracts, ensures the CoS root conversation, resumes work. */
export async function boot(options: BootOptions): Promise<Daemon> {
  const { home } = options;
  mkdirSync(home, { recursive: true });
  const release = acquireLock(home);
  let runtime: Runtime | undefined;
  let storage: Storage | undefined;
  let harness: Harness | undefined;

  try {
    const settings = loadSettings(home);
    linkSdk(home, packageRoot);
    ensureWorkspace(home);

    const contracts = new Map(CORE_CONTRACTS.map((c) => [c.name, c]));
    const workspace = join(home, "extensions");
    const found = discoverExtensions(options.extensionDirs ?? [join(packageRoot, "extensions"), workspace]);
    const loaded = await loadExtensions(found, contracts);
    const extensions = withOverrides(loaded.extensions, options.extensions ?? []);
    for (const c of extensions.flatMap((e) => e.contracts ?? [])) contracts.set(c.name, c);
    const fromDisk = found.filter((f) => extensions.some((e) => e.name === f.name && loaded.extensions.includes(e)));
    const sources = new Map(fromDisk.map((f) => [f.name, dirname(f.file)]));
    const hashes = new Map(
      found.filter((f) => dirname(dirname(f.file)) === workspace).map((f) => [f.name, dirHash(dirname(f.file))]),
    );

    const secrets = await adapter<SecretsAdapter>(extensions, "secrets", settings.secrets.adapter).open(
      settings.secrets,
      { home },
    );
    storage = await adapter<StorageAdapter>(extensions, "storage", settings.storage.adapter).open(settings.storage, {
      home,
    });

    const models = createModels({ credentials: secretsCredentialStore(secrets) });
    const environments = new Map<string, EnvironmentAdapter>();
    const status = (): Status => ({
      model: settings.models.cos!,
      extensions: rt.extensions.map((e) => ({
        name: e.name,
        summary: e.summary,
        provides: Object.keys(e.provides ?? {}),
      })),
      errors: rt.errors,
    });
    // `root` and `opened` are set before any surface or trigger starts.
    const kernel = (extension: string): KernelContext => ({
      home,
      extension,
      settings: () => settings.extensions[extension] ?? {},
      secret: async (name) => {
        if (!rt.extensions.find((e) => e.name === extension)?.secrets?.includes(name)) {
          throw new Error(`Extension ${extension} did not declare secret "${name}"`);
        }
        return secrets.get(name);
      },
      models,
      environments,
      surface: {
        home,
        root: {
          submit: async (text, mode) => {
            await root.submit({ type: "input", content: text, whenBusy: mode ?? "followUp" }, ctx);
          },
          abort: () => root.abort(ctx),
          events: async (listener) => {
            // A snapshot holds only the active context, whose range starts at its head marker's `head`:
            // prepend the stored history before that range.
            const withHistory = async (e: AgentEvent): Promise<AgentEvent> => {
              const first = e.type === "snapshot" ? e.entries[0] : undefined;
              if (e.type !== "snapshot" || first === undefined) return e;
              const maxEntryId = ((first.head ?? first.id) - 1) as EntryId;
              const page = await root.entries({ maxEntryId }, 200, undefined, ctx);
              return { ...e, entries: [...page.items.toReversed(), ...e.entries] };
            };
            const stream = await watchEvents(opened, ROOT_CONVERSATION_ID, ctx);
            listener([await withHistory(stream.snapshot)]);
            stream.start(async (events) => listener(await Promise.all(events.map(withHistory))));
            return {
              stop: async () => {
                await stream.stop();
              },
            };
          },
        },
        jobs: async (listener) => {
          const watch = (await opened.watchDoc(JobsDoc, ROOT_CONVERSATION_ID, ctx))!;
          listener(byId(watch.value!.jobs));
          watch.start(async (doc) => listener(byId(doc!.jobs)));
          return {
            stop: async () => {
              await watch.stop();
            },
          };
        },
        secrets: {
          pending: async (listener) => {
            const watch = (await opened.watchDoc(SecretRequestsDoc, ROOT_CONVERSATION_ID, ctx))!;
            listener(watch.value!.pending);
            watch.start(async (doc) => listener(doc!.pending));
            return {
              stop: async () => {
                await watch.stop();
              },
            };
          },
          fulfil: (requestId, value) => fulfilSecret(opened, root, secrets, requestId, value, ctx),
        },
        status,
      },
      trigger: {
        home,
        emit: async ({ key, text }) => {
          const requestId = `trigger:${extension}:${key}`;
          await root.submit({ type: "input", content: `[${extension}] ${text}`, requestId }, ctx);
        },
      },
    });
    const registry = createRegistry();
    // The root's extension selection: filled once `japa-jobs` is installed, before any work runs.
    const selection: Extension[] = [];
    const { Consolidate, startConsolidation } = consolidation({ models, settings });
    const tools = settingsTools(home, settings, models, extensions, () => rt.refreshCapabilities());
    const cos = cosExtension(settings, [Consolidate], tools, () => rt.capabilities);
    const rt = createRuntime({
      home,
      packageRoot,
      settings,
      contracts,
      extensions,
      errors: [...loaded.errors],
      sources,
      hashes,
      models,
      environments,
      registry,
      selection,
      cos,
      kernel,
    });
    runtime = rt;

    await rt.start(extensions, ["provider"]);
    const model = resolveCosModel(settings, models, home);
    if (settings.models.worker !== undefined) checkModel(models, settings.models.worker);
    if (settings.models.consolidation !== undefined) checkModel(models, settings.models.consolidation);

    const { dir } = settings.secrets;
    const env = createEnvDispatcher(environments, [
      join(home, "secrets"),
      ...(typeof dir === "string" ? [dir.replace(/^~/, homedir())] : []),
    ]);
    harness = await Harness.open(storage, { models, registry, env, settings: { extensions: selection } }, ctx);
    const opened = harness;
    registry.install(cos);
    registry.install(WorkerExtension);
    registry.install(CodingTools);
    const root = await ensureRoot(harness, model, ctx);
    await root.commit(async (tx) => {
      await tx.doc(JobsDoc, root.id);
      await tx.doc(MemoryDoc, root.id);
      await tx.doc(ChangesDoc, root.id);
      await tx.doc(SecretRequestsDoc, root.id);
    }, ctx);
    // The rest of the contracts; `japa-jobs` is installed after tools, so pending job tasks resume with it.
    await rt.start(extensions, rt.order().slice(1));
    harness.resume();

    const consolidate = async () => {
      await opened.waitForTask(await startConsolidation(root), ctx);
    };
    const checkConsolidation = async (now = Date.now()) => {
      const busy = (await opened.snapshot(LiveDoc, root.id, ctx))?.run !== undefined;
      const { messages } = await root.context(ctx);
      const window = messages.filter((m) => m.role !== "system");
      const windowTokens = estimateTokens(window.map((m) => JSON.stringify(m.content)).join("\n"));
      // The reset's handoff is not the user speaking.
      const resetAt = (await opened.snapshot(MemoryDoc, root.id, ctx))?.lastResetAt ?? -1;
      const lastUserAt = window.findLast((m) => m.role === "user" && m.timestamp > resetAt)?.timestamp;
      if (shouldConsolidate({ busy, windowTokens, lastUserAt, now }, settings.context)) await consolidate();
    };
    const timer = setInterval(() => checkConsolidation().catch(() => {}), 60_000).unref();

    return {
      harness: opened,
      root,
      status,
      consolidate,
      checkConsolidation,
      reconcile: () => rt.reconcile(root),
      close: async () => {
        clearInterval(timer);
        try {
          await rt.dispose((c) => !isAdapter(c));
          await opened.close(ctx);
          await rt.dispose(isAdapter);
        } finally {
          release();
        }
      },
    };
  } catch (error) {
    await runtime?.dispose(isAdapter).catch(() => {});
    await (harness ?? storage)?.close(ctx).catch(() => {});
    release();
    throw error;
  }
}

/** Provider and environment activations are disposed after the harness closes, the others before. */
const isAdapter = (contract: string) => contract === "provider" || contract === "environment";

/** `discovered` with each of `added` appended, replacing a discovered extension of the same name. */
function withOverrides(discovered: JapaExtension[], added: JapaExtension[]): JapaExtension[] {
  const names = new Set(added.map((e) => e.name));
  return [...discovered.filter((e) => !names.has(e.name)), ...added];
}

/** The boot-phase adapter named `name` among the extensions' `contract` contributions; the last one wins. */
function adapter<T extends { name: string }>(extensions: JapaExtension[], contract: string, name: string): T {
  const found = extensions.flatMap((e) => (e.provides?.[contract] ?? []) as T[]).findLast((a) => a.name === name);
  if (found === undefined) throw new Error(`No ${contract} adapter "${name}" is installed`);
  return found;
}

function resolveCosModel(settings: Settings, models: Models, home: string): ModelRef {
  const ref = settings.models.cos;
  if (ref === undefined) {
    throw new Error(
      `Set models.cos in ${join(home, "settings.json")}, for example ` +
        `{"models":{"cos":{"provider":"anthropic","modelId":"<model>"}}}`,
    );
  }
  checkModel(models, ref);
  return ref;
}
