import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ModelRef } from "@earendil-works/pi-durable";
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

/** Loads `<dir>/*.md` worker profiles; later dirs replace earlier ones by name, bad files are reported and skipped. */
export function loadWorkers(dirs: string[]): {
  profiles: Map<string, WorkerProfile>;
  errors: { name: string; error: string }[];
} {
  const profiles = new Map<string, WorkerProfile>();
  const errors: { name: string; error: string }[] = [];
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    for (const file of readdirSync(dir).filter((f) => f.endsWith(".md"))) {
      try {
        const profile = toProfile(parseFrontmatter(readFileSync(join(dir, file), "utf8")));
        profiles.set(profile.name, profile);
      } catch (error) {
        errors.push({ name: `worker:${file}`, error: error instanceof Error ? error.message : String(error) });
      }
    }
  }
  return { profiles, errors };
}

function toProfile({ data, body }: { data: Record<string, FrontmatterValue>; body: string }): WorkerProfile {
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
    ...(cwd !== undefined && { cwd: (cwd as string).replace(/^~/, homedir()) }),
    instructions: body,
  };
}
