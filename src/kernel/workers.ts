import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ModelRef } from "@earendil-works/pi-durable";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import type { Models } from "@earendil-works/pi-ai";
import { KEBAB_CASE } from "./extension.ts";
import { parseFrontmatter, type FrontmatterValue } from "./frontmatter.ts";

export type WorkerProfile = {
  name: string;
  description: string;
  model?: ModelRef;
  thinking?: string;
  environment: string;
  tools: string[];
  extensions?: string[]; // undefined = all
  skills?: string[]; // undefined = all
  cwd?: string;
  instructions: string;
};

/**
 * Loads `<dir>/*.md` worker profiles; later dirs replace earlier ones by name, bad files are reported and skipped.
 * A profile `cwd` may start with `~` or `$JAPA_HOME` (expanded to `home`).
 */
export function loadWorkers(dirs: string[], home: string): {
  profiles: Map<string, WorkerProfile>;
  errors: { name: string; error: string }[];
} {
  const profiles = new Map<string, WorkerProfile>();
  const errors: { name: string; error: string }[] = [];
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    for (const file of readdirSync(dir).filter((f) => f.endsWith(".md"))) {
      try {
        const profile = readProfile(join(dir, file), home);
        profiles.set(profile.name, profile);
      } catch (error) {
        errors.push({ name: `worker:${file}`, error: error instanceof Error ? error.message : String(error) });
      }
    }
  }
  return { profiles, errors };
}

/** Reads and validates the worker profile in `file`; throws when it is invalid. */
export function readProfile(file: string, home: string): WorkerProfile {
  return toProfile(parseFrontmatter(readFileSync(file, "utf8")), home);
}

function toProfile({ data, body }: { data: Record<string, FrontmatterValue>; body: string }, home: string): WorkerProfile {
  const { name, description, model, thinking, environment, tools, extensions, skills, cwd } = data;
  if (typeof name !== "string" || !KEBAB_CASE.test(name)) throw new Error("name must be kebab-case");
  if (typeof description !== "string" || !description) throw new Error("description is required");
  if (model !== undefined && (typeof model !== "object" || Array.isArray(model) || !model.provider || !model.modelId)) {
    throw new Error("model must be { provider, modelId }");
  }
  for (const [key, value] of Object.entries({ tools, extensions, skills })) {
    if (value !== undefined && !Array.isArray(value)) throw new Error(`${key} must be a list`);
  }
  return {
    name,
    description,
    ...(model && { model: { provider: model.provider, modelId: model.modelId } }),
    ...(thinking !== undefined && { thinking: thinking as string }),
    environment: (environment as string | undefined) ?? "local",
    tools: (tools as string[] | undefined) ?? [],
    ...(extensions && { extensions: extensions as string[] }),
    ...(skills && { skills: skills as string[] }),
    ...(cwd !== undefined && { cwd: (cwd as string).replace(/^~/, homedir()).replace(/^\$JAPA_HOME/, home) }),
    instructions: body,
  };
}

/** Why `profile` cannot run here: an unknown model, environment, built-in tool, extension or skill. */
export function profileError(
  profile: WorkerProfile,
  models: Models,
  environments: ReadonlyMap<string, unknown>,
  extensions: ReadonlyMap<string, unknown>,
  skills: ReadonlyMap<string, unknown>,
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
