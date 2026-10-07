import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool, type Extension, section } from "@earendil-works/pi-durable";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { parseFrontmatter } from "./frontmatter.ts";
import { JobDoc } from "./jobs/state.ts";

export type Skill = { name: string; description: string; dir: string; file: string /* SKILL.md path */ };

/** Loads `<dir>/<name>/SKILL.md` skills; later dirs replace earlier ones by name, bad skills are reported and skipped. */
export function loadSkills(dirs: string[]): {
  skills: Map<string, Skill>;
  errors: { name: string; error: string }[];
} {
  const skills = new Map<string, Skill>();
  const errors: { name: string; error: string }[] = [];
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const file = join(dir, entry.name, "SKILL.md");
      if (!entry.isDirectory() || !existsSync(file)) continue;
      try {
        const { name, description } = parseFrontmatter(readFileSync(file, "utf8")).data;
        if (typeof name !== "string" || !name) throw new Error("name is required");
        if (typeof description !== "string" || !description) throw new Error("description is required");
        skills.set(name, { name, description, dir: join(dir, entry.name), file });
      } catch (error) {
        errors.push({ name: `skill:${entry.name}`, error: error instanceof Error ? error.message : String(error) });
      }
    }
  }
  return { skills, errors };
}

const reply = (text: string) => ({ content: [{ type: "text" as const, text }] });

/** The skills section (all skills, or a job's own) and `skill_read`, which reads skill files on the kernel side. */
export function skillsExtension(skills: ReadonlyMap<string, Skill>): Extension {
  const skillRead = defineTool({
    name: "skill_read",
    description: "Read a skill's instructions, or one of its files by a path relative to the skill.",
    parameters: Type.Object({ name: Type.String(), file: Type.Optional(Type.String()) }),
    execute: async ({ name, file }) => {
      const skill = skills.get(name);
      if (skill === undefined) return reply(`No skill "${name}". Skills: ${[...skills.keys()].join(", ")}.`);
      if (file === undefined) return reply(parseFrontmatter(readFileSync(skill.file, "utf8")).body);
      const path = resolve(skill.dir, file);
      if (relative(skill.dir, path).startsWith("..")) return reply(`Not part of skill ${name}.`);
      return reply(readFileSync(path, "utf8"));
    },
  });

  return defineExtension({
    name: "japa-skills",
    tools: [skillRead],
    sections: [
      section("skills", async ({ conversationId, read }, context) => {
        const only = (await read.snapshot(JobDoc, conversationId, context))?.skills;
        const shown = [...skills.values()].filter((s) => only === undefined || only.includes(s.name));
        if (shown.length === 0) return undefined;
        return [...shown.map((s) => `- ${s.name}: ${s.description}`), "Load one with skill_read when it applies."].join(
          "\n",
        );
      }),
    ],
  });
}
