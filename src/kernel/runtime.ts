import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import {
  type Conversation,
  defineExtension,
  type Extension,
  type Registry,
  type ToolRegistration,
} from "@earendil-works/pi-durable";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import type { Models } from "@earendil-works/pi-ai";
import { dirname, join } from "node:path";
import { capabilities } from "./capabilities.ts";
import { ACTIVATION_ORDER, type Contract, type Dispose, type EnvironmentAdapter, type KernelContext } from "./contracts.ts";
import type { JapaExtension } from "./extension.ts";
import { jobsExtension, type JobsOptions, reconfigureJobs } from "./jobs/cos.ts";
import { discoverExtensions, type LoadError, loadExtensions, message } from "./loader.ts";
import type { Settings } from "./settings.ts";
import { loadSkills, type Skill, skillsExtension } from "./skills.ts";
import { loadWorkers, type WorkerProfile } from "./workers.ts";
import { dirHash } from "./workspace.ts";

export type Runtime = ReturnType<typeof createRuntime>;

/**
 * The daemon's live extension state: the loaded extensions, their activations and built Pi Durable extensions, the
 * skills, worker profiles, root selection and capabilities text; `start` activates extensions, `reconcile` reloads
 * the workspace extensions in `<home>/extensions` that changed on disk, and the skills and worker profiles.
 */
export function createRuntime(input: {
  home: string;
  packageRoot: string;
  settings: Settings;
  contracts: Map<string, Contract>;
  extensions: JapaExtension[];
  errors: LoadError[];
  sources: Map<string, string>; // the directory of each extension loaded from disk, by name
  hashes: Map<string, string>; // the `dirHash` of each workspace extension when it was loaded, by name
  models: Models;
  environments: Map<string, EnvironmentAdapter>;
  registry: Registry;
  selection: Extension[]; // the root's, filled by `start`
  cos: Extension;
  kernel: (extension: string) => KernelContext;
}) {
  const { home, packageRoot, settings, contracts, sources, hashes, models, environments, registry, selection } = input;
  const activations: { extension: string; contract: string; dispose: Dispose }[] = []; // in activation order
  const built = new Map<string, Extension>();
  let jobsOptions: JobsOptions | undefined;

  const runtime = {
    extensions: input.extensions,
    errors: input.errors,
    capabilities: "",
    /** The contract activation order, with the extension-defined contracts after tools. */
    order: () => {
      const defined = runtime.extensions.flatMap((e) => e.contracts ?? []).map((c) => c.name);
      return ACTIVATION_ORDER.flatMap((name) => (name === "tool" ? [name, ...defined] : name));
    },
    refreshCapabilities: () => {
      runtime.capabilities = capabilities({
        extensions: runtime.extensions,
        contracts: contracts.values(),
        profiles: jobsOptions!.profiles,
        models: settings.models,
      });
    },
    start,
    reconcile,
    /** Disposes the activations of every contract `which` names, newest first. */
    dispose: (which: (contract: string) => boolean) => dispose((a) => which(a.contract)),
  };

  /**
   * Activates `extensions`' contributions to each of `names` in turn, reloading the content after tools; returns the
   * activation errors, which are also recorded.
   */
  async function start(extensions: JapaExtension[], names: string[]): Promise<LoadError[]> {
    const errors: LoadError[] = [];
    for (const name of names) {
      for (const e of extensions) {
        if (name === "tool") {
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
            const dispose = await contracts.get(name)!.activate?.(c, input.kernel(e.name));
            if (dispose) activations.push({ extension: e.name, contract: name, dispose });
          } catch (err) {
            errors.push({ name: e.name, error: `${name}: ${message(err)}` });
          }
        }
      }
      if (name === "tool") reloadContent();
    }
    runtime.errors.push(...errors);
    return errors;
  }

  /** Reloads skills and worker profiles, installs `japa-skills` and `japa-jobs`, and resets the root selection. */
  function reloadContent() {
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
    const skillsExt = skillsExtension(skills.skills);
    jobsOptions = { profiles: workers.profiles, settings, extensions: built, skills: skillsExt };
    const jobs = jobsExtension(jobsOptions);
    registry.install(skillsExt);
    registry.install(jobs);
    selection.splice(0, selection.length, input.cos, jobs, skillsExt, ...built.values());
    runtime.refreshCapabilities();
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

  /** Reloads the workspace extensions that were added, changed or removed, then the content; packaged ones never. */
  async function reconcile(root: Conversation): Promise<{ errors: LoadError[]; notices: string[] }> {
    const found = discoverExtensions([join(home, "extensions")]).map((f) => ({ ...f, hash: dirHash(dirname(f.file)) }));
    const changed = found.filter((f) => hashes.get(f.name) !== f.hash);
    const removed = [...hashes.keys()].filter((name) => !found.some((f) => f.name === name));
    const names = new Set([...changed.map((f) => f.name), ...removed]);

    for (const name of names) {
      await dispose((a) => a.extension === name);
      const extension = built.get(name);
      if (extension) registry.uninstall(extension);
      built.delete(name);
      sources.delete(name);
      hashes.delete(name);
      for (const c of runtime.extensions.find((e) => e.name === name)?.contracts ?? []) contracts.delete(c.name);
    }
    runtime.extensions = runtime.extensions.filter((e) => !names.has(e.name));

    const loadErrors: LoadError[] = [];
    const loaded: JapaExtension[] = [];
    for (const f of changed) {
      const result = await loadExtensions([f], contracts, f.hash);
      hashes.set(f.name, f.hash);
      loadErrors.push(...result.errors);
      for (const e of result.extensions) {
        loaded.push(e);
        sources.set(e.name, dirname(f.file));
        for (const c of e.contracts ?? []) contracts.set(c.name, c);
      }
    }
    runtime.extensions = [...runtime.extensions, ...loaded];
    const notices = loaded
      .filter((e) => Object.keys(e.provides ?? {}).some((name) => contracts.get(name)?.phase === "boot"))
      .map((e) => `${e.name}: storage/secrets changes apply after a restart`);

    replaceErrors((e) => names.has(e.name), loadErrors);
    const errors = [...loadErrors, ...(await start(loaded, runtime.order()))];
    await root.commit((tx) => reconfigureJobs(tx, jobsOptions!), ctx);
    return { errors, notices };
  }

  return runtime;
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
