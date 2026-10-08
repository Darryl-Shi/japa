import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import {
  type Conversation,
  defineExtension,
  type Extension,
  type Registry,
  type ToolRegistration,
} from "@earendil-works/pi-durable";
import type { Models } from "@earendil-works/pi-ai";
import { dirname, join } from "node:path";
import { capabilities } from "./capabilities.ts";
import {
  ACTIVATION_ORDER,
  CONTRACTS,
  type Dispose,
  type EnvironmentAdapter,
  type KernelContext,
  type MessagingContext,
} from "./contracts.ts";
import type { JapaExtension } from "./extension.ts";
import { jobsExtension, type JobsOptions, reconfigureJobs } from "./jobs/cos.ts";
import { discoverExtensions, type LoadError, loadExtensions, message } from "./loader.ts";
import type { Settings } from "./settings.ts";
import { loadSkills, type Skill, skillsExtension } from "./skills.ts";
import { loadWorkers, profileError, type WorkerProfile } from "./workers.ts";
import { cachedCopy, dirHash } from "./workspace.ts";

export type Runtime = ReturnType<typeof createRuntime>;

/**
 * The daemon's live extension state: the loaded extensions, their activations and built Pi Durable extensions, the
 * skills, worker profiles, root selection and capabilities text; `start` activates extensions, `reconcile` reloads
 * the workspace extensions in `<home>/extensions` that changed on disk, and the skills and worker profiles.
 */
export function createRuntime(input: {
  home: string;
  packageRoot: string;
  packaged: string[]; // the packaged extension dirs, whose extensions a workspace one can override
  settings: Settings;
  extensions: JapaExtension[];
  errors: LoadError[];
  sources: Map<string, string>; // the directory of each extension loaded from disk, by name
  hashes: Map<string, string>; // the `dirHash` of each workspace extension when it was loaded, by name
  models: Models;
  environments: Map<string, EnvironmentAdapter>;
  registry: Registry;
  selection: Extension[]; // the root's, filled by `start`
  cos: Extension;
  safety: Extension; // selected by the root and every job
  kernel: (extension: string) => KernelContext;
  messaging: MessagingContext; // kernel-internal, given to contract activations only
}) {
  const { home, packageRoot, packaged, settings, sources, hashes, models, environments, registry, selection } = input;
  const activations: { extension: string; contract: string; dispose: Dispose }[] = []; // in activation order
  const built = new Map<string, Extension>();
  let jobsOptions: JobsOptions | undefined;
  let reconciling: Promise<unknown> = Promise.resolve();

  const runtime = {
    extensions: input.extensions,
    errors: input.errors,
    /** The extension-built Pi Durable extensions, by japa extension name. */
    built: built as ReadonlyMap<string, Extension>,
    capabilities: "",
    /** The loaded skills and worker profiles, by name. */
    skills: new Map<string, Skill>() as ReadonlyMap<string, Skill>,
    profiles: new Map<string, WorkerProfile>() as ReadonlyMap<string, WorkerProfile>,
    refreshCapabilities: () => {
      runtime.capabilities = capabilities({
        extensions: runtime.extensions,
        profiles: jobsOptions!.profiles,
        models: settings.models,
      });
    },
    start,
    /** `reconcile`, one at a time. */
    reconcile: (root: Conversation) => {
      const run = reconciling.then(() => reconcile(root));
      reconciling = run.catch(() => {});
      return run;
    },
    /** Disposes the activations of every contract `which` names, newest first. */
    dispose: (which: (contract: string) => boolean) => dispose((a) => which(a.contract)),
  };

  /**
   * Activates `extensions`' contributions to each of `names` in turn, reloading the content after tools; returns the
   * activation errors, which are also recorded, and the content errors.
   */
  async function start(extensions: JapaExtension[], names: string[]): Promise<LoadError[]> {
    const errors: LoadError[] = [];
    let content: LoadError[] = [];
    for (const name of names) {
      for (const e of extensions) {
        if (name === "tool") {
          try {
            const dispose = await e.setup?.(input.kernel(e.name));
            if (dispose) activations.push({ extension: e.name, contract: "setup", dispose });
          } catch (err) {
            errors.push({ name: e.name, error: `setup: ${message(err)}` });
            continue;
          }
          if (e.provides?.tool || e.durable) {
            try {
              const extension = defineExtension({
                name: e.name,
                tools: e.provides?.tool as ToolRegistration[] | undefined,
                ...e.durable,
              });
              registry.install(extension);
              built.set(e.name, extension);
            } catch (err) {
              errors.push({ name: e.name, error: `tool: ${message(err)}` });
            }
          }
          continue;
        }
        for (const c of e.provides?.[name] ?? []) {
          try {
            const dispose = await CONTRACTS.get(name)!.activate?.(c, input.kernel(e.name), input.messaging);
            if (dispose) activations.push({ extension: e.name, contract: name, dispose });
          } catch (err) {
            errors.push({ name: e.name, error: `${name}: ${message(err)}` });
          }
        }
      }
      if (name === "tool") content = reloadContent();
    }
    runtime.errors.push(...errors);
    return [...errors, ...content];
  }

  /**
   * Reloads skills and worker profiles, installs `japa-skills` and `japa-jobs`, and resets the root selection; returns
   * the skill and worker errors.
   */
  function reloadContent(): LoadError[] {
    const skills = loadSkills([
      join(packageRoot, "skills"),
      ...[...sources.values()].map((dir) => join(dir, "skills")),
      join(home, "skills"),
    ]);
    const workers = loadWorkers([join(packageRoot, "workers"), join(home, "workers")], home);
    const errors = [...skills.errors, ...workers.errors];
    for (const profile of workers.profiles.values()) {
      const error = profileError(profile, models, environments, built, skills.skills);
      if (error === undefined) continue;
      errors.push({ name: `worker:${profile.name}`, error });
      workers.profiles.delete(profile.name);
    }
    replaceErrors((e) => /^(skill|worker):/.test(e.name), errors);
    runtime.skills = skills.skills;
    runtime.profiles = workers.profiles;
    const skillsExt = skillsExtension(skills.skills);
    jobsOptions = { profiles: workers.profiles, settings, extensions: built, skills: skillsExt, safety: input.safety };
    const jobs = jobsExtension(jobsOptions);
    registry.install(skillsExt);
    registry.install(jobs);
    selection.splice(0, selection.length, input.cos, input.safety, jobs, skillsExt, ...built.values());
    runtime.refreshCapabilities();
    return errors;
  }

  async function dispose(which: (a: (typeof activations)[number]) => boolean) {
    const picked = activations.filter(which);
    activations.splice(0, activations.length, ...activations.filter((a) => !which(a)));
    for (const a of picked.reverse()) await a.dispose();
  }

  /** Replaces the errors matching `stale` with `fresh`. */
  function replaceErrors(stale: (e: LoadError) => boolean, fresh: LoadError[]) {
    runtime.errors.splice(0, runtime.errors.length, ...runtime.errors.filter((e) => !stale(e)), ...fresh);
  }

  /**
   * Reloads the workspace extensions that were added, changed or removed, then the content; packaged ones never, except
   * that removing a workspace override loads the packaged extension again. A changed extension is imported from a copy
   * at `<home>/.cache/extensions/<name>-<hash>`, so its own modules are imported afresh.
   */
  async function reconcile(root: Conversation): Promise<{ errors: LoadError[]; notices: string[] }> {
    const workspace = join(home, "extensions");
    const all = discoverExtensions([...packaged, workspace]);
    const found = all
      .filter((f) => dirname(dirname(f.file)) === workspace)
      .map((f) => ({ ...f, hash: dirHash(dirname(f.file)) }));
    const changed = found.filter((f) => hashes.get(f.name) !== f.hash);
    const removed = [...hashes.keys()].filter((name) => !found.some((f) => f.name === name));
    const restored = all.filter((f) => removed.includes(f.name));
    const names = new Set([...changed.map((f) => f.name), ...removed]);

    for (const name of names) {
      await dispose((a) => a.extension === name);
      const extension = built.get(name);
      if (extension) registry.uninstall(extension);
      built.delete(name);
      sources.delete(name);
      hashes.delete(name);
    }
    runtime.extensions = runtime.extensions.filter((e) => !names.has(e.name));

    const copies = changed.map((f) => {
      const copy = cachedCopy(home, dirname(f.file));
      hashes.set(f.name, f.hash);
      return { name: f.name, file: join(copy, "index.ts") };
    });
    const { extensions: loaded, errors: loadErrors } = await loadExtensions([...copies, ...restored]);
    for (const e of loaded) sources.set(e.name, dirname([...changed, ...restored].find((f) => f.name === e.name)!.file));
    runtime.extensions = [...runtime.extensions, ...loaded];
    const notices = loaded
      .filter((e) => Object.keys(e.provides ?? {}).some((name) => CONTRACTS.get(name)?.phase === "boot"))
      .map((e) => `${e.name}: storage/secrets changes apply after a restart`);

    replaceErrors((e) => names.has(e.name), loadErrors);
    const errors = [...loadErrors, ...(await start(loaded, ACTIVATION_ORDER))];
    await root.commit((tx) => reconfigureJobs(tx, jobsOptions!), ctx);
    return { errors, notices };
  }

  return runtime;
}
