import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import {
  type AgentEvent,
  type Conversation,
  createRegistry,
  defineExtension,
  type EntryId,
  type Extension,
  Harness,
  LiveDoc,
  type ModelRef,
  ROOT_CONVERSATION_ID,
  type Storage,
  type ToolRegistration,
  watchEvents,
} from "@earendil-works/pi-durable";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { createModels, type Models } from "@earendil-works/pi-ai";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ChangesDoc } from "./changes.ts";
import {
  ACTIVATION_ORDER,
  CORE_CONTRACTS,
  type Dispose,
  type EnvironmentAdapter,
  type KernelContext,
  type SecretsAdapter,
  type Status,
  type StorageAdapter,
} from "./contracts.ts";
import { cosExtension, ensureRoot } from "./cos.ts";
import { createEnvDispatcher } from "./env.ts";
import type { JapaExtension } from "./extension.ts";
import { jobsExtension } from "./jobs/cos.ts";
import { byId, JobsDoc } from "./jobs/state.ts";
import { WorkerExtension } from "./jobs/worker.ts";
import { consolidation } from "./memory/consolidate.ts";
import { estimateTokens, MemoryDoc } from "./memory/state.ts";
import { shouldConsolidate } from "./memory/trigger.ts";
import { discoverExtensions, linkSdk, loadExtensions, message } from "./loader.ts";
import { acquireLock } from "./lock.ts";
import { settingsTools } from "./settings-tools.ts";
import { checkModel, loadSettings, type Settings } from "./settings.ts";
import { loadSkills, type Skill, skillsExtension } from "./skills.ts";
import { loadWorkers, type WorkerProfile } from "./workers.ts";

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
  close(): Promise<void>;
};

/** Boots japa in `home`: opens storage, activates contracts, ensures the CoS root conversation, resumes work. */
export async function boot(options: BootOptions): Promise<Daemon> {
  const { home } = options;
  mkdirSync(home, { recursive: true });
  const release = acquireLock(home);
  const activations: Dispose[] = []; // provider and environment: disposed after the harness closes
  const runtime: Dispose[] = []; // the other contracts: disposed before it closes
  let storage: Storage | undefined;
  let harness: Harness | undefined;

  try {
    const settings = loadSettings(home);
    linkSdk(home, packageRoot);

    const contracts = new Map(CORE_CONTRACTS.map((c) => [c.name, c]));
    const dirs = options.extensionDirs ?? [join(packageRoot, "extensions"), join(home, "extensions")];
    const found = discoverExtensions(dirs);
    const loaded = await loadExtensions(found, contracts);
    const extensions = withOverrides(loaded.extensions, options.extensions ?? []);
    // Skill dirs: packaged, then each loaded extension's own (when loaded from disk), then home.
    const skills = loadSkills([
      join(packageRoot, "skills"),
      ...found
        .filter((f) => extensions.some((e) => e.name === f.name && loaded.extensions.includes(e)))
        .map((f) => join(dirname(f.file), "skills")),
      join(home, "skills"),
    ]);
    const defined = extensions.flatMap((e) => e.contracts ?? []);
    for (const c of defined) contracts.set(c.name, c);
    const order = ACTIVATION_ORDER.flatMap((name) => (name === "tool" ? [name, ...defined.map((c) => c.name)] : name));

    await adapter<SecretsAdapter>(extensions, "secrets", settings.secrets.adapter).open(settings.secrets, { home });
    storage = await adapter<StorageAdapter>(extensions, "storage", settings.storage.adapter).open(settings.storage, {
      home,
    });

    const models = createModels();
    const environments = new Map<string, EnvironmentAdapter>();
    const errors = [...loaded.errors, ...skills.errors];
    const status = (): Status => ({
      model,
      extensions: extensions.map((e) => ({
        name: e.name,
        summary: e.summary,
        provides: Object.keys(e.provides ?? {}),
      })),
      errors,
    });
    // `root` and `opened` are set before any surface or trigger starts.
    const kernel = (extension: string): KernelContext => ({
      home,
      extension,
      settings: () => settings.extensions[extension] ?? {},
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
    const activate = async (name: string) => {
      const contract = contracts.get(name)!;
      const disposers = name === "provider" || name === "environment" ? activations : runtime;
      for (const e of extensions) {
        for (const c of e.provides?.[name] ?? []) {
          try {
            const dispose = await contract.activate?.(c, kernel(e.name));
            if (dispose) disposers.push(dispose);
          } catch (err) {
            errors.push({ name: e.name, error: `${name}: ${message(err)}` });
          }
        }
      }
    };

    await activate("provider");
    const model = resolveCosModel(settings, models, home);
    if (settings.models.worker !== undefined) checkModel(models, settings.models.worker);
    if (settings.models.consolidation !== undefined) checkModel(models, settings.models.consolidation);

    const registry = createRegistry();
    // The root's extension selection: filled once `japa-jobs` is installed, before any work runs.
    const selection: Extension[] = [];
    const env = createEnvDispatcher(environments);
    harness = await Harness.open(storage, { models, registry, env, settings: { extensions: selection } }, ctx);
    const opened = harness;
    const { Consolidate, startConsolidation } = consolidation({ models, settings });
    const cos = cosExtension(settings, [Consolidate], settingsTools(home, settings, models, extensions));
    registry.install(cos);
    const built = new Map<string, Extension>();
    for (const e of extensions) {
      if (e.provides?.tool || e.durable) {
        const tools = e.provides?.tool as ToolRegistration[] | undefined;
        try {
          const extension = defineExtension({ name: e.name, tools, ...e.durable });
          registry.install(extension);
          built.set(e.name, extension);
        } catch (err) {
          errors.push({ name: e.name, error: `tool: ${message(err)}` });
        }
      }
    }
    const root = await ensureRoot(harness, model, ctx);
    await root.commit(async (tx) => {
      await tx.doc(JobsDoc, root.id);
      await tx.doc(MemoryDoc, root.id);
      await tx.doc(ChangesDoc, root.id);
    }, ctx);
    // Profiles need the activated environments; pending job tasks resume once `japa-jobs` is installed.
    const installJobs = () => {
      const workers = loadWorkers([join(packageRoot, "workers"), join(home, "workers")]);
      errors.push(...workers.errors);
      for (const profile of workers.profiles.values()) {
        const error = profileError(profile, models, environments, built, skills.skills);
        if (error === undefined) continue;
        errors.push({ name: `worker:${profile.name}`, error });
        workers.profiles.delete(profile.name);
      }
      const skillsExt = skillsExtension(skills.skills);
      const jobs = jobsExtension({ profiles: workers.profiles, settings, extensions: built, skills: skillsExt });
      registry.install(WorkerExtension);
      registry.install(CodingTools);
      registry.install(skillsExt);
      registry.install(jobs);
      selection.push(cos, jobs, skillsExt, ...built.values());
    };
    for (const name of order) {
      if (name !== "provider") await activate(name);
      if (name === "environment") installJobs();
    }
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
      close: async () => {
        clearInterval(timer);
        try {
          await disposeAll(runtime);
          await opened.close(ctx);
          await disposeAll(activations);
        } finally {
          release();
        }
      },
    };
  } catch (error) {
    await disposeAll(activations).catch(() => {});
    await (harness ?? storage)?.close(ctx).catch(() => {});
    release();
    throw error;
  }
}

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

/** Why `profile` cannot run here: an unknown model, environment, built-in tool, extension or skill. */
function profileError(
  profile: WorkerProfile,
  models: Models,
  environments: ReadonlyMap<string, EnvironmentAdapter>,
  extensions: ReadonlyMap<string, Extension>,
  skills: ReadonlyMap<string, Skill>,
): string | undefined {
  if (profile.model && models.getModel(profile.model.provider, profile.model.modelId) === undefined) {
    return `unknown model "${profile.model.provider}/${profile.model.modelId}"`;
  }
  if (!environments.has(profile.environment)) return `unknown environment "${profile.environment}"`;
  const tool = profile.tools.find((t) => !CodingTools.tools!.some((builtin) => builtin.name === t));
  if (tool !== undefined) return `unknown tool "${tool}"`;
  const extension = profile.extensions?.find((e) => !extensions.has(e));
  if (extension !== undefined) return `unknown extension "${extension}"`;
  const skill = profile.skills?.find((s) => !skills.has(s));
  if (skill !== undefined) return `unknown skill "${skill}"`;
  return undefined;
}

/** Runs the disposers in reverse activation order and empties the list. */
async function disposeAll(activations: Dispose[]): Promise<void> {
  for (const dispose of activations.splice(0).reverse()) await dispose();
}
