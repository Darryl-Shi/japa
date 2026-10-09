import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import {
  type AgentEvent,
  type Conversation,
  type ConversationId,
  createRegistry,
  type EntryId,
  type Extension,
  Harness,
  type JsonObject,
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
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ChangesDoc, type Commit, logChange } from "./changes.ts";
import {
  ACTIVATION_ORDER,
  type EnvironmentAdapter,
  type ExtensionInfo,
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
import { askedSecretNames, type JapaExtension, secretDescription, secretNames } from "./extension.ts";
import { jobLife, pruneClones, pruneJobRefs } from "./jobs/clone.ts";
import { createPublisher, reportingFailures, sandboxCheck } from "./jobs/publish.ts";
import { unstickPublishing } from "./jobs/run.ts";
import { byId, DAY, goingLive, JobDoc, JobsDoc, prune } from "./jobs/state.ts";
import { WorkerExtension } from "./jobs/worker.ts";
import { reflectDelay, reflection, unreflectedTurns, upgradeMemory } from "./memory/reflect.ts";
import { MemoryDoc } from "./memory/state.ts";
import { discoverExtensions, type LoadError, linkSdk, loadExtensions, message } from "./loader.ts";
import { acquireLock } from "./lock.ts";
import { PROMPT_HISTORY } from "./messaging/prompts.ts";
import { MessagingDoc } from "./messaging/surface.ts";
import { alreadyRunning } from "./messaging/update-report.ts";
import { requestIdFor } from "./origin.ts";
import { watchReplies } from "./replies.ts";
import { watchResets } from "./reset.ts";
import { rollBackAndLog, rollbackTool } from "./rollback.ts";
import {
  addSecretRequest,
  declineSecret,
  fulfilSecret,
  removeSecretRequest,
  SecretRequestsDoc,
} from "./secret-requests.ts";
import { clearBoots, crashLooping, createSafety, enterSafeMode, recordBoot } from "./safety.ts";
import { setSetting, settingsSchema, settingsTools } from "./settings-tools.ts";
import { createRuntime, type Runtime } from "./runtime.ts";
import {
  createJobSandboxes,
  hiddenPaths,
  type JobSandboxes,
  narrowPath,
  narrowRequire,
  sandboxRefusal,
} from "./sandbox/jobs.ts";
import { checkModel, loadSettings, type Settings } from "./settings.ts";
import { skillAt } from "./skills.ts";
import {
  liveness,
  patchUpdateState,
  readUpdateState,
  type Updater,
  writeUpdateState,
} from "./update-state.ts";
import { createWorkspaceLock } from "./workspace-lock.ts";
import { dirHash, ensureWorkspace, tidyWorkspace } from "./workspace.ts";

const packageRoot = fileURLToPath(new URL("../..", import.meta.url));

export type BootOptions = {
  home: string;
  /** Default: `[<packageRoot>/extensions, <home>/extensions]`. */
  extensionDirs?: string[];
  /** Added after the discovered extensions, replacing any with the same name. */
  extensions?: JapaExtension[];
  /** Checks for and launches updates from chat; `japa daemon` gives one. */
  updater?: Updater;
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
  /** Reloads the changed workspace extensions and the skills; its errors also go to `status()`. */
  reconcile(): Promise<{ errors: LoadError[]; notices: string[] }>;
  /** Tags the workspace's HEAD as last known good, under the workspace lock. */
  markGood(): Promise<void>;
  close(): Promise<void>;
};

/** Boots japa in `home`: opens storage, activates contracts, ensures the CoS root conversation, resumes work. */
export async function boot(options: BootOptions): Promise<Daemon> {
  const { home } = options;
  // First, before the daemon runs any program: jobs keep the environment it started with. Nor does it load code from
  // the global folders jobs can write.
  const jobEnv = narrowPath();
  narrowRequire();
  mkdirSync(home, { recursive: true });
  const release = acquireLock(home);
  let runtime: Runtime | undefined;
  let storage: Storage | undefined;
  let harness: Harness | undefined;
  let sandboxes: JobSandboxes | undefined;

  try {
    linkSdk(home, packageRoot);
    ensureWorkspace(home);
    // Spec §6.1: before anything loads, the workspace's extensions and skills are as committed.
    const { adopted, errors: tidyErrors } = tidyWorkspace(home);
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
    // Spec §4.4: everything that changes the real repo takes it, one at a time.
    const lock = createWorkspaceLock();
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
    // Then the clones and leftover refs of the jobs no longer active (see `pruneClones`).
    const pruneOld = async () => {
      await pruneJobs(Date.now() - settings.jobs.keepFinishedDays * DAY);
      const life = jobLife((await opened.snapshot(JobsDoc, root.id, ctx))!.jobs);
      pruneClones(home, life);
      await lock(async () => {
        // Read again under the lock: a job may have started going live meanwhile.
        pruneJobRefs(home, jobLife((await opened.snapshot(JobsDoc, root.id, ctx))!.jobs));
      });
    };
    const runTool: MessagingContext["tool"] = async (name, args) => {
      const api = { commit: root.commit.bind(root), snapshot: opened.snapshot.bind(opened) };
      const found = registry.snapshot().tools().find((t) => t.tool.name === name);
      return found?.tool.execute(args, api as unknown as ToolExecutionApi, ctx);
    };
    /** The text reply of tool `name`, `No tool <name>.` without one. */
    const toolText = async (name: string, args: JsonObject) => {
      const result = await runTool(name, args);
      if (result === undefined) return `No tool ${name}.`;
      return (result.content?.[0] as { text?: string } | undefined)?.text ?? "";
    };
    const messaging: MessagingContext = {
      cursor: async (adapter) => (await opened.snapshot(MessagingDoc, root.id, ctx))?.cursors[adapter],
      saveCursor: (adapter, cursor) =>
        root.commit(async (tx) => {
          (await tx.doc(MessagingDoc, root.id)).cursors[adapter] = cursor;
        }, ctx),
      secretFulfilledBy: async () => (await opened.snapshot(SecretRequestsDoc, root.id, ctx))!.fulfilledBy,
      recordSecretMessage: (by) =>
        root.commit(async (tx) => {
          (await tx.doc(SecretRequestsDoc, root.id)).fulfilledBy = by;
        }, ctx),
      secretInput: async (adapter) => (await opened.snapshot(MessagingDoc, root.id, ctx))?.secretInput?.[adapter],
      saveSecretInput: (adapter, at) =>
        root.commit(async (tx) => {
          const doc = await tx.doc(MessagingDoc, root.id);
          if (at !== undefined) doc.secretInput = { ...doc.secretInput, [adapter]: at };
          else if (doc.secretInput !== undefined) delete doc.secretInput[adapter];
        }, ctx),
      promptState: async (adapter) => {
        const doc = await opened.snapshot(MessagingDoc, root.id, ctx);
        return { prompts: doc?.prompts?.[adapter] ?? [], history: doc?.promptHistory?.[adapter] ?? [] };
      },
      savePromptState: (adapter, { prompts, history }) =>
        root.commit(async (tx) => {
          const doc = await tx.doc(MessagingDoc, root.id);
          doc.prompts = { ...doc.prompts, [adapter]: structuredClone(prompts) };
          doc.promptHistory = { ...doc.promptHistory, [adapter]: history.slice(-PROMPT_HISTORY) };
        }, ctx),
      setSetting: (path, value) => setSetting(settingsDeps, path, value, commit),
      rollback: (name) => rollBackAndLog(home, "extension", name, undefined, reconcile, commit, lock),
      tool: runTool,
      clearFinishedJobs: () => pruneJobs(Infinity),
      changes: async () => ((await opened.snapshot(ChangesDoc, root.id, ctx))?.changes ?? []).toReversed(),
      undoChange: async (id) => {
        const change = (await opened.snapshot(ChangesDoc, root.id, ctx))?.changes.find((c) => c.id === id);
        const call = change?.undo.call;
        if (call === undefined) return toolText("change_undo", { id });
        const reply = await toolText(call.tool, call.args);
        if (/^Not? /.test(reply)) return reply;
        // Undone: no longer listed, so it can't be undone twice.
        await root.commit(async (tx) => {
          const doc = await tx.doc(ChangesDoc, root.id);
          doc.changes = doc.changes.filter((c) => c.id !== id);
        }, ctx);
        return reply;
      },
      extensions: async () => {
        const inWorkspace = new Set(discoverExtensions([workspace]).map((f) => f.name));
        const errorOf = (name: string) => {
          const errors = rt.errors.filter((e) => e.name === name).map((e) => e.error);
          return errors.length > 0 ? { error: errors.join("; ") } : {};
        };
        const isSet = async (name: string) => {
          try {
            return (await secrets.get(name)) !== undefined;
          } catch {
            return false; // as `isConfigured` counts it
          }
        };
        const loaded = await Promise.all(
          rt.extensions.map(async (e): Promise<ExtensionInfo> => {
            const line = e.status && statusLine(e.status);
            const asked = askedSecretNames(e).map(async (name) => {
              const description = secretDescription(e, name);
              return { name, ...(description !== undefined && { description }), set: await isSet(name) };
            });
            return {
              name: e.name,
              summary: e.summary,
              state: rt.states.get(e.name) ?? "not set up",
              ...errorOf(e.name),
              ...(line !== undefined && { status: line }),
              workspace: inWorkspace.has(e.name),
              loaded: true,
              secrets: await Promise.all(asked),
              schema: settingsSchema(e),
              values: structuredClone(settings.extensions[e.name] ?? {}),
            };
          }),
        );
        const failed = [...inWorkspace]
          .filter((name) => !rt.extensions.some((e) => e.name === name))
          .map((name): ExtensionInfo => ({
            name,
            state: "not set up",
            ...errorOf(name),
            workspace: true,
            loaded: false,
            secrets: [],
            values: {},
          }));
        return [...loaded, ...failed].sort((a, b) => a.name.localeCompare(b.name));
      },
      setSecret: async (extension, name, value, by) => {
        const ext = rt.extensions.find((e) => e.name === extension);
        if (ext === undefined) return `Not changed: no extension ${extension}`;
        if (!secretNames(ext).includes(name)) return `Not changed: ${extension} doesn't use ${name}`;
        const request = (await opened.snapshot(SecretRequestsDoc, root.id, ctx))!.pending.find((r) => r.name === name);
        // A request fulfilled meanwhile by another path throws: then the value is stored as if none was pending.
        const fulfilled = request !== undefined && (await fulfil(request.id, value, by).then(() => true, () => false));
        if (!fulfilled) {
          await secrets.set(name, value);
          if (by !== undefined) await messaging.recordSecretMessage(by);
          resolveWaiters(name, value);
          await refreshAvailability();
        }
        return `Set ${name}.`;
      },
      update: chatUpdates(home, options.updater),
    };
    // Resolved by the surfaces' `fulfil` and the menu's `setSecret`, by secret name; a rejectable one (a sign-in's) is
    // rejected by a decline.
    type Waiter = { resolve: (value: string) => void; reject?: (error: Error) => void };
    const waiters = new Map<string, Waiter[]>();
    const resolveWaiters = (name: string, value: string) => {
      for (const { resolve } of waiters.get(name) ?? []) resolve(value);
      waiters.delete(name);
    };
    /** Rejects `name`'s rejectable waiters with `error`; the rest keep waiting. */
    const rejectWaiters = (name: string, error: Error) => {
      const kept: Waiter[] = [];
      for (const waiter of waiters.get(name) ?? []) {
        if (waiter.reject) waiter.reject(error);
        else kept.push(waiter);
      }
      if (kept.length > 0) waiters.set(name, kept);
      else waiters.delete(name);
    };
    /** Fulfils pending secret request `requestId` (see `fulfilSecret`), resolves its waiters and recomputes availability. */
    const fulfil = async (requestId: string, value: string, by?: string) => {
      const name = await fulfilSecret(opened, root, secrets, requestId, value, ctx, by);
      resolveWaiters(name, value);
      await refreshAvailability();
    };
    /** Declines pending secret request `requestId` (see `declineSecret`); a sign-in's ends its `connect` flow. */
    const decline = async (requestId: string) => {
      const request = await declineSecret(opened, root, requestId, ctx);
      if (request.name.endsWith(AUTHORIZE_SUFFIX)) rejectWaiters(request.name, new Error("The sign-in was declined"));
    };
    const declared = (extension: string, name: string) => {
      const ext = rt.extensions.find((e) => e.name === extension);
      if (!ext || !secretNames(ext).includes(name)) {
        throw new Error(`Extension ${extension} did not declare secret "${name}"`);
      }
    };
    /** The next value provided for `name`; when `rejectable`, a decline rejects it. */
    const provided = (name: string, rejectable = false) =>
      new Promise<string>((resolve, reject) =>
        waiters.set(name, [...(waiters.get(name) ?? []), { resolve, ...(rejectable && { reject }) }]),
      );
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
          fulfil,
          decline,
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
    const safety = createSafety({ home, settings, built: () => rt.built, reconcile, root: () => root, report, lock });
    // After an undo's commits are reverted.
    const undone = async () => {
      await reconcile();
      safety.scheduleGood();
    };
    // Aborted by `close`: cancels the pending chat sign-ins.
    const closing = new AbortController();
    const tools = [
      ...settingsTools(settingsDeps, undone, lock),
      rollbackTool(home, reconcile, lock),
      // Its `<extension>.authorize` requests need no `secrets` declaration.
      connectTool({
        extensions: () => rt.extensions,
        context: kernel,
        ask: async (name, why) => {
          const value = provided(name, true);
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
    const { dir } = settings.secrets;
    const secretsDirs = [join(home, "secrets"), ...(typeof dir === "string" ? [dir.replace(/^~/, homedir())] : [])];
    // The clone mounted over the home hides a secrets dir inside it; one outside it, by real path, is masked. So is
    // a storage database outside it.
    const { file } = settings.storage;
    const db = typeof file === "string" ? [resolve(file.replace(/^~/, homedir()))] : [];
    // One that holds the home can't be: its mask would cover the clone.
    const dbFiles = db.flatMap((f) => [f, `${f}-wal`, `${f}-shm`]);
    const { hidden, holdingHome } = hiddenPaths(home, [...secretsDirs, ...dbFiles]);
    const jobs = createJobSandboxes({
      home,
      packageRoot,
      hidden,
      env: jobEnv,
      // A job going live: its clone is being published (see run.ts).
      refuse: async (jobId) => {
        const job = (await opened.snapshot(JobsDoc, ROOT_CONVERSATION_ID, ctx))?.jobs[jobId];
        return job?.publishing === undefined ? undefined : goingLive(jobId);
      },
    });
    sandboxes = jobs;
    const sandboxError = [
      ...(jobs.problem === undefined ? [] : [sandboxRefusal(jobs.problem)]),
      ...holdingHome.map(
        (path) => `Jobs can read ${path}: it is or holds the japa home, so their sandboxes can't hide it`,
      ),
    ].map((error) => ({ name: "sandbox", error }));
    // A completed job's changes go live from its clone (spec §4.3), checked and committed in its sandbox.
    const publish = reportingFailures(
      home,
      createPublisher({
        home,
        packageRoot,
        lock,
        spec: jobs.spec,
        check: sandboxCheck(jobs.spec, home, packageRoot),
        reconcile,
        // A workspace skill by its folder: its frontmatter name keys it, and may differ.
        loaded: (kind, name) =>
          kind === "skill"
            ? skillAt(rt.skills, join(home, "skills", name)) !== undefined
            : rt.extensions.some((e) => e.name === name),
        logChange: (change) => commit((tx) => logChange(tx, change)),
        scheduleGood: () => safety.scheduleGood(),
      }),
    );
    const cos = cosExtension(settings, [Reflect], tools, () => rt.capabilities);
    const rt = createRuntime({
      home,
      packageRoot,
      packaged: dirs.filter((d) => d !== workspace),
      settings,
      secrets,
      extensions,
      errors: [...loaded.errors, ...sandboxError, ...tidyErrors.map((error) => ({ name: "workspace", error }))],
      sources,
      hashes,
      models,
      registry,
      selection,
      cos,
      safety: safety.extension,
      sandboxProblem: () => jobs.problem,
      publish,
      closeSandbox: jobs.close,
      kernel,
      messaging,
    });
    runtime = rt;

    await rt.start(extensions, ["provider"]);
    const model = resolveCosModel(settings, models, home);
    if (settings.models.worker !== undefined) checkModel(models, settings.models.worker);
    if (settings.models.consolidation !== undefined) checkModel(models, settings.models.consolidation);

    const keyError = await missingKey(models, model.provider, secretsDirs.at(-1)!);
    if (keyError !== undefined) rt.errors.push({ name: "models", error: keyError });
    // The CoS reads through the `local` environment, installed with the environment contracts.
    const local: EnvironmentAdapter = {
      name: "local",
      create: (input) => {
        const adapter = environments.get("local");
        if (adapter === undefined) throw new Error('No environment "local" is installed');
        return adapter.create(input);
      },
    };
    // What jobs don't see, the CoS can't read either: a secrets dir by its real path too.
    const deny = [...secretsDirs, ...hidden];
    const env = createEnvDispatcher(local, deny, async (conversationId: ConversationId, context) => {
      const jobId = (await opened.snapshot(JobDoc, conversationId, context))?.jobId;
      if (!jobId) throw new Error(`No job runs in conversation ${conversationId}`);
      return jobs.env(String(conversationId), jobId);
    });
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
      if (adopted !== undefined) {
        await logChange(tx, { title: "Edits made outside japa", howToUse: "", undo: { commits: [adopted] } });
      }
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
    // Which extensions are available may have changed while japa was down.
    await rt.reconfigure(root);
    harness.resume();
    // A job whose publishing run faulted would otherwise stay going live, its sandbox refused, for good.
    await root.commit((tx) => unstickPublishing(tx), ctx);
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
          jobs.closeAll();
          release();
        }
      },
    };
  } catch (error) {
    await runtime?.dispose(isAdapter).catch(() => {});
    await (harness ?? storage)?.close(ctx).catch(() => {});
    sandboxes?.closeAll();
    release();
    throw error;
  }
}

/** `MessagingContext.update`: `updater`'s check and launch, with the run recorded in `<home>/update.json`. */
function chatUpdates(home: string, updater: Updater | undefined): MessagingContext["update"] {
  const need = () => {
    if (updater === undefined) throw new Error("Updating from chat isn't available: japa wasn't started as a daemon.");
    return updater;
  };
  return {
    check: async () => need().check(),
    current: async () => need().current(),
    start: async (chat, from, to, rollback) => {
      const launcher = need();
      // No await until the new state is written: a second start, meanwhile, must see it.
      const now = Date.now();
      const earlier = readUpdateState(home);
      if (earlier !== undefined) {
        const live = liveness(earlier, now);
        if (live === "running") throw new Error(alreadyRunning(earlier, now));
        // The new run replaces an interrupted one, which needs no report then.
        if (live === "interrupted") patchUpdateState(home, { reported: true });
      }
      writeUpdateState(home, { state: "running", started: now, chat, from, to, rollback, reported: false });
      try {
        await launcher.launch(to, rollback);
      } catch (error) {
        try {
          // Reported already: whoever called `start` shows its error.
          patchUpdateState(home, { state: "failed", summary: message(error), finished: Date.now(), reported: true });
        } catch {
          // Unrecorded, the run reads as interrupted once its 60 s to start are up; the launch's error is the one to see.
        }
        throw error;
      }
    },
    state: async () => readUpdateState(home),
    markReported: async (started) => {
      // Only the run that was reported: one started meanwhile still needs its report.
      const state = readUpdateState(home);
      if (state?.started === started) writeUpdateState(home, { ...state, reported: true });
    },
  };
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
