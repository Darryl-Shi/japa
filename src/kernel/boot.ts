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
  type RegistryReader,
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
  ACTIVATION_ORDER,
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
import { installTool, rollbackTool } from "./install.ts";
import { byId, JobsDoc } from "./jobs/state.ts";
import { WorkerExtension } from "./jobs/worker.ts";
import { consolidation } from "./memory/consolidate.ts";
import { estimateTokens, MemoryDoc } from "./memory/state.ts";
import { shouldConsolidate } from "./memory/trigger.ts";
import { discoverExtensions, type LoadError, linkSdk, loadExtensions, message } from "./loader.ts";
import { acquireLock } from "./lock.ts";
import { fulfilSecret, SecretRequestsDoc } from "./secret-requests.ts";
import { clearBoots, crashLooping, createSafety, enterSafeMode, recordBoot } from "./safety.ts";
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
  /** The installed Pi Durable extensions and their tools. */
  registry: RegistryReader;
  status(): Status;
  /** The CoS's current capabilities text. */
  capabilities(): string;
  /** Consolidates the CoS's context and waits for it. */
  consolidate(): Promise<void>;
  /** Consolidates when the CoS is idle and its live window is full or stale. */
  checkConsolidation(now?: number): Promise<void>;
  /** Reloads the changed workspace extensions, skills and worker profiles; its errors also go to `status()`. */
  reconcile(): Promise<{ errors: LoadError[]; notices: string[] }>;
  /** Tags the workspace's HEAD as last known good. */
  markGood(): void;
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
    linkSdk(home, packageRoot);
    ensureWorkspace(home);
    const safeMode = crashLooping(home) ? enterSafeMode(home, { defaultAdapters: false }) : undefined;
    recordBoot(home);
    const settings = loadSettings(home);

    const workspace = join(home, "extensions");
    const dirs = options.extensionDirs ?? [join(packageRoot, "extensions"), workspace];
    const found = discoverExtensions(dirs);
    const loaded = await loadExtensions(found);
    const extensions = withOverrides(loaded.extensions, options.extensions ?? []);
    const fromDisk = found.filter((f) => extensions.some((e) => e.name === f.name && loaded.extensions.includes(e)));
    const sources = new Map(fromDisk.map((f) => [f.name, dirname(f.file)]));
    const hashes = new Map(
      found.filter((f) => dirname(dirname(f.file)) === workspace).map((f) => [f.name, dirHash(dirname(f.file))]),
    );

    const secrets = await withSafeModeHint(() =>
      adapter<SecretsAdapter>(extensions, "secrets", settings.secrets.adapter).open(settings.secrets, { home }),
    );
    storage = await withSafeModeHint(() =>
      adapter<StorageAdapter>(extensions, "storage", settings.storage.adapter).open(settings.storage, { home }),
    );

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
    const reconcile = () => rt.reconcile(root);
    const report = (error: string) => rt.errors.push({ name: "japa-safety", error });
    const safety = createSafety({ home, settings, built: () => rt.built, reconcile, root: () => root, report });
    // After an undo's commits are reverted.
    const undone = async () => {
      await reconcile();
      safety.scheduleGood();
    };
    const tools = [
      ...settingsTools(home, settings, models, () => rt.extensions, () => rt.refreshCapabilities(), undone),
      installTool(
        home,
        reconcile,
        (kind, name) => (kind === "skill" ? rt.skills : rt.profiles).has(name),
        safety.scheduleGood,
      ),
      rollbackTool(home, reconcile),
    ];
    const cos = cosExtension(settings, [Consolidate], tools, () => rt.capabilities);
    const rt = createRuntime({
      home,
      packageRoot,
      packaged: dirs.filter((d) => d !== workspace),
      settings,
      extensions,
      errors: [...loaded.errors],
      sources,
      hashes,
      models,
      environments,
      registry,
      selection,
      cos,
      safety: safety.extension,
      kernel,
    });
    runtime = rt;

    await rt.start(extensions, ["provider"]);
    const model = resolveCosModel(settings, models, home);
    if (settings.models.worker !== undefined) checkModel(models, settings.models.worker);
    if (settings.models.consolidation !== undefined) checkModel(models, settings.models.consolidation);

    const { dir } = settings.secrets;
    const secretsDirs = [join(home, "secrets"), ...(typeof dir === "string" ? [dir.replace(/^~/, homedir())] : [])];
    const keyError = await missingKey(models, model.provider, secretsDirs.at(-1)!);
    if (keyError !== undefined) rt.errors.push({ name: "models", error: keyError });
    const env = createEnvDispatcher(environments, secretsDirs);
    harness = await Harness.open(storage, { models, registry, env, settings: { extensions: selection } }, ctx);
    const opened = harness;
    registry.install(cos);
    registry.install(safety.extension);
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
    await rt.start(extensions, ACTIVATION_ORDER.slice(1));
    harness.resume();
    if (safeMode !== undefined) {
      const content =
        "[japa] I restarted in safe mode after repeated crashes and restored the last working setup.";
      await root.submit({ type: "input", content, requestId: `safe-mode:${safeMode}` }, ctx);
    }

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
    const stayedUp = setTimeout(() => clearBoots(home), 5 * 60_000).unref();
    safety.scheduleGood(); // a pending tag doesn't survive a restart

    return {
      harness: opened,
      root,
      registry,
      status,
      capabilities: () => rt.capabilities,
      consolidate,
      checkConsolidation,
      reconcile,
      markGood: safety.markGood,
      close: async () => {
        clearInterval(timer);
        clearTimeout(stayedUp);
        safety.close();
        try {
          await rt.dispose((c) => !isAdapter(c));
          await opened.close(ctx);
          await rt.dispose(isAdapter);
          clearBoots(home);
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

/** `open()`, its error naming `japa safe-mode --default-adapters`. */
async function withSafeModeHint<T>(open: () => Promise<T>): Promise<T> {
  try {
    return await open();
  } catch (error) {
    throw new Error(`${message(error)} — run "japa safe-mode --default-adapters" to restore the defaults.`, { cause: error });
  }
}

/**
 * The error for a `provider` without credentials, naming its API key env var (the first `*_API_KEY` its auth
 * looks up) and its file in `secretsDir`; undefined when it has credentials.
 */
export async function missingKey(models: Models, provider: string, secretsDir: string): Promise<string | undefined> {
  if ((await models.checkAuth(provider)) !== undefined) return undefined;
  const asked: string[] = [];
  const ctx = { env: async (name: string) => void asked.push(name), fileExists: async () => false };
  await models.getProvider(provider)?.auth.apiKey?.resolve({ ctx, signal: new AbortController().signal }).catch(() => {});
  const envVar = asked.find((name) => name.endsWith("_API_KEY"));
  const file = join(secretsDir, `${provider}.apiKey`);
  return `No API key for ${provider}. ${envVar === undefined ? "Write it" : `Set ${envVar} or write it`} to ${file}, then restart.`;
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
