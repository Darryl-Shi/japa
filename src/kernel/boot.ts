import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import {
  type AgentEvent,
  type Conversation,
  createRegistry,
  type EntryId,
  type Extension,
  Harness,
  type ModelRef,
  type RegistryReader,
  ROOT_CONVERSATION_ID,
  type Storage,
  type ToolExecutionApi,
  watchEvents,
} from "@earendil-works/pi-durable";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { createModels, type Models } from "@earendil-works/pi-ai";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ChangesDoc, type Commit } from "./changes.ts";
import {
  ACTIVATION_ORDER,
  type EnvironmentAdapter,
  type KernelContext,
  type MessagingContext,
  type SecretsAdapter,
  type Status,
  type StorageAdapter,
} from "./contracts.ts";
import { AUTHORIZE_SUFFIX, connectTool } from "./authorize.ts";
import { cosExtension, ensureRoot } from "./cos.ts";
import { secretsCredentialStore } from "./credentials.ts";
import { createEnvDispatcher } from "./env.ts";
import { type JapaExtension, secretNames } from "./extension.ts";
import { installTool, rollBackAndLog, rollbackTool } from "./install.ts";
import { byId, DAY, JobsDoc, prune } from "./jobs/state.ts";
import { WorkerExtension } from "./jobs/worker.ts";
import { reflectDelay, reflection, unreflectedTurns, upgradeMemory } from "./memory/reflect.ts";
import { MemoryDoc } from "./memory/state.ts";
import { discoverExtensions, type LoadError, linkSdk, loadExtensions, message } from "./loader.ts";
import { acquireLock } from "./lock.ts";
import { MessagingDoc } from "./messaging/surface.ts";
import { requestIdFor } from "./origin.ts";
import { watchReplies } from "./replies.ts";
import { watchResets } from "./reset.ts";
import { addSecretRequest, fulfilSecret, removeSecretRequest, SecretRequestsDoc } from "./secret-requests.ts";
import { clearBoots, crashLooping, createSafety, enterSafeMode, recordBoot } from "./safety.ts";
import { setSetting, settingsTools } from "./settings-tools.ts";
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
  /** Runs `Reflect` on the stored transcript and waits for it. */
  reflect(): Promise<void>;
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
      findAdapter<SecretsAdapter>(extensions, "secrets", settings.secrets.adapter).open(settings.secrets, { home }),
    );
    storage = await withSafeModeHint(() =>
      findAdapter<StorageAdapter>(extensions, "storage", settings.storage.adapter).open(settings.storage, { home }),
    );

    const store = storage;
    const models = createModels({ credentials: secretsCredentialStore(secrets) });
    const environments = new Map<string, EnvironmentAdapter>();
    const status = (): Status => ({
      model: settings.models.cos!,
      extensions: rt.extensions.map((e) => ({
        name: e.name,
        summary: e.summary,
        provides: Object.keys(e.provides ?? {}),
        ...(e.status && { status: statusLine(e.status) }),
        ...(rt.states.has(e.name) && { state: rt.states.get(e.name) }),
      })),
      errors: rt.errors,
    });
    const settingsDeps = {
      home,
      settings,
      models,
      extensions: () => rt.extensions,
      changed: async () => {
        rt.refreshCapabilities();
        await refreshAvailability();
      },
    };
    // Which extensions are available changes as secrets and settings do; the tool phase's `start` computes it too.
    let rootReady = false;
    const refreshAvailability = () => (rootReady ? rt.refreshAvailability(root) : Promise.resolve());
    // `root` and `opened` are set before any surface or trigger starts.
    const commit: Commit = (change) => root.commit(change, ctx);
    // Finished jobs updated before `before` leave the jobs list; their conversations stay in storage.
    const pruneJobs = (before: number) =>
      root.commit(async (tx) => prune((await tx.doc(JobsDoc, root.id)).jobs, before), ctx);
    const pruneOld = () => pruneJobs(Date.now() - settings.jobs.keepFinishedDays * DAY);
    const messaging: MessagingContext = {
      cursor: async (adapter) => (await opened.snapshot(MessagingDoc, root.id, ctx))?.cursors[adapter],
      saveCursor: (adapter, cursor) =>
        root.commit(async (tx) => {
          (await tx.doc(MessagingDoc, root.id)).cursors[adapter] = cursor;
        }, ctx),
      secretFulfilledBy: async () => (await opened.snapshot(SecretRequestsDoc, root.id, ctx))!.fulfilledBy,
      setSetting: (path, value) => setSetting(settingsDeps, path, value, commit),
      rollback: (name) => rollBackAndLog(home, "extension", name, undefined, reconcile, commit),
      tool: async (name, args) => {
        const api = { commit: root.commit.bind(root), snapshot: opened.snapshot.bind(opened) };
        const found = registry.snapshot().tools().find((t) => t.tool.name === name);
        return found?.tool.execute(args, api as unknown as ToolExecutionApi, ctx);
      },
      clearFinishedJobs: () => pruneJobs(Infinity),
    };
    // Resolved by the surfaces' `fulfil`, by secret name.
    const waiters = new Map<string, ((value: string) => void)[]>();
    const declared = (extension: string, name: string) => {
      const ext = rt.extensions.find((e) => e.name === extension);
      if (!ext || !secretNames(ext).includes(name)) {
        throw new Error(`Extension ${extension} did not declare secret "${name}"`);
      }
    };
    const provided = (name: string) =>
      new Promise<string>((resolve) => waiters.set(name, [...(waiters.get(name) ?? []), resolve]));
    const kernel = (extension: string): KernelContext => ({
      home,
      extension,
      settings: () => settings.extensions[extension] ?? {},
      secret: async (name) => {
        declared(extension, name);
        return secrets.get(name);
      },
      setSecret: async (name, value) => {
        declared(extension, name);
        await secrets.set(name, value);
        await refreshAvailability();
      },
      secretProvided: async (name) => {
        declared(extension, name);
        return provided(name);
      },
      requestSecret: async (name, why) => {
        declared(extension, name);
        const value = provided(name);
        await root.commit((tx) => addSecretRequest(tx, name, why), ctx);
        return value;
      },
      models,
      environments,
      surface: {
        home,
        root: {
          submit: async (input, mode, origin) => {
            const requestId = origin && { requestId: requestIdFor(origin) };
            await root.submit({ type: "input", content: input, whenBusy: mode ?? "followUp", ...requestId }, ctx);
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
          replies: (listener, after) => watchReplies(opened, store, root, listener, after),
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
          fulfil: async (requestId, value, by) => {
            const name = await fulfilSecret(opened, root, secrets, requestId, value, ctx, by);
            for (const resolve of waiters.get(name) ?? []) resolve(value);
            waiters.delete(name);
            await refreshAvailability();
          },
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
    const { Reflect, startReflect } = reflection({ models, settings });
    const reconcile = async () => {
      const result = await rt.reconcile(root);
      await refreshAvailability();
      return result;
    };
    const report = (error: string) => rt.errors.push({ name: "japa-safety", error });
    const safety = createSafety({ home, settings, built: () => rt.built, reconcile, root: () => root, report });
    // After an undo's commits are reverted.
    const undone = async () => {
      await reconcile();
      safety.scheduleGood();
    };
    // Aborted by `close`: cancels the pending chat sign-ins.
    const closing = new AbortController();
    const tools = [
      ...settingsTools(settingsDeps, undone),
      installTool(
        home,
        reconcile,
        (kind, name) => (kind === "skill" ? rt.skills : rt.profiles).has(name),
        safety.scheduleGood,
      ),
      rollbackTool(home, reconcile),
      // Its `<extension>.authorize` requests need no `secrets` declaration.
      connectTool({
        extensions: () => rt.extensions,
        context: kernel,
        ask: async (name, why) => {
          const value = provided(name);
          await root.commit((tx) => addSecretRequest(tx, name, why), ctx);
          return value;
        },
        withdraw: async (name) => {
          await root.commit((tx) => removeSecretRequest(tx, name), ctx);
        },
        forget: (name) => secrets.delete(name),
        report: async (content, requestId) => {
          await root.submit({ type: "input", content, requestId }, ctx);
        },
        signal: closing.signal,
      }),
    ];
    const cos = cosExtension(settings, [Reflect], tools, () => rt.capabilities);
    const rt = createRuntime({
      home,
      packageRoot,
      packaged: dirs.filter((d) => d !== workspace),
      settings,
      secrets,
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
      messaging,
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
    rootReady = true;
    await root.commit(async (tx) => {
      await tx.doc(JobsDoc, root.id);
      await tx.doc(MemoryDoc, root.id);
      await tx.doc(ChangesDoc, root.id);
      // A chat sign-in doesn't survive a restart: its request goes too.
      const requests = await tx.doc(SecretRequestsDoc, root.id);
      requests.pending = requests.pending.filter((r) => !r.name.endsWith(AUTHORIZE_SUFFIX));
    }, ctx);
    await pruneOld();
    const droppedLoops = await upgradeMemory(root);
    if (droppedLoops.length > 0) {
      const content =
        "[japa] Open loops are no longer kept for you; your context is cleared after every reply. If any of " +
        `these still matter, back it with a schedule or a job:\n${droppedLoops.map((l) => `- ${l}`).join("\n")}`;
      await root.submit({ type: "input", content, requestId: "memory:v2-loops" }, ctx);
    }
    // The rest of the contracts; `japa-jobs` is installed after tools, so pending job tasks resume with it.
    await rt.start(extensions, ACTIVATION_ORDER.slice(1));
    harness.resume();
    if (safeMode !== undefined) {
      const content =
        "[japa] I restarted in safe mode after repeated crashes and restored the last working setup.";
      await root.submit({ type: "input", content, requestId: `safe-mode:${safeMode}` }, ctx);
    }

    const reflect = async () => {
      await opened.waitForTask(await startReflect(root), ctx);
    };
    // Reflection follows the resets: now once enough turns are unreflected, otherwise after 15 quiet minutes.
    let quiet: ReturnType<typeof setTimeout> | undefined;
    const afterReset = async () => {
      clearTimeout(quiet);
      const delay = reflectDelay(await unreflectedTurns(opened, root));
      if (delay === 0) void reflect().catch(() => {});
      else if (delay !== undefined) quiet = setTimeout(() => void reflect().catch(() => {}), delay).unref();
    };
    const resets = await watchResets(opened, root, afterReset);
    // At boot, reflect at once on whatever the last run left unreflected.
    if ((await unreflectedTurns(opened, root)) > 0) void reflect().catch(() => {});
    const stayedUp = setTimeout(() => clearBoots(home), 5 * 60_000).unref();
    const pruning = setInterval(() => void pruneOld().catch(() => {}), 3_600_000).unref();
    safety.scheduleGood(); // a pending tag doesn't survive a restart

    return {
      harness: opened,
      root,
      registry,
      status,
      capabilities: () => rt.capabilities,
      reflect,
      reconcile,
      markGood: safety.markGood,
      close: async () => {
        closing.abort();
        clearTimeout(stayedUp);
        clearInterval(pruning);
        clearTimeout(quiet);
        await resets.stop();
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
export function findAdapter<T extends { name: string }>(extensions: JapaExtension[], contract: string, name: string): T {
  const found = extensions.flatMap((e) => (e.provides?.[contract] ?? []) as T[]).findLast((a) => a.name === name);
  if (found === undefined) throw new Error(`No ${contract} adapter "${name}" is installed`);
  return found;
}

/** An extension's status line; `status: <message>` when it throws. */
function statusLine(status: () => string | undefined): string | undefined {
  try {
    return status();
  } catch (error) {
    return `status: ${message(error)}`;
  }
}

/** `open()`, its error naming `japa safe-mode --default-adapters`. */
async function withSafeModeHint<T>(open: () => Promise<T>): Promise<T> {
  try {
    return await open();
  } catch (error) {
    throw new Error(`${message(error)} — run "japa safe-mode --default-adapters" to restore the defaults.`, { cause: error });
  }
}

/** The `*_API_KEY` environment variable `provider`'s auth resolution looks up, if any (the first one asked). */
export async function envKeyName(models: Models, provider: string): Promise<string | undefined> {
  const asked: string[] = [];
  const ctx = { env: async (name: string) => void asked.push(name), fileExists: async () => false };
  await models.getProvider(provider)?.auth.apiKey?.resolve({ ctx, signal: new AbortController().signal }).catch(() => {});
  return asked.find((name) => name.endsWith("_API_KEY"));
}

/**
 * The error for a `provider` without credentials: run `japa setup`, or use its API key env var (the first `*_API_KEY` its auth
 * looks up) and its file in `secretsDir`; undefined when it has credentials.
 */
export async function missingKey(models: Models, provider: string, secretsDir: string): Promise<string | undefined> {
  if ((await models.checkAuth(provider)) !== undefined) return undefined;
  const envVar = await envKeyName(models, provider);
  const file = join(secretsDir, `${provider}.apiKey`);
  return (
    `No credentials for ${provider}. Run japa setup to sign in or add an API key` +
    `${envVar === undefined ? ", or write the key" : `, or set ${envVar} or write the key`} to ${file}, then restart.`
  );
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
