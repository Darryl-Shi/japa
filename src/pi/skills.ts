// Skills and context files, as pi has them, read fresh each turn so what's added applies from the next message. A
// skill is a directory with a SKILL.md (name and description in its frontmatter), listed in the prompt one line each
// (its description) and read when a task needs it. The agent's own are in pi's places in its home on its computer
// (~/.pi/agent/skills, ~/.agents/skills), so it can add them itself; japa's own (skills/) and an extension's
// (resources_discover) are on the machine japa runs on. The skill tool reads one by name, wherever it is. A context
// file is pi's AGENTS.md (or CLAUDE.md) in ~/.pi/agent on its computer: standing instructions, in every prompt.
import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool, type Extension, section } from "@earendil-works/pi-durable";
import type { FileSystem } from "@earendil-works/pi-durable/env";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";

type Skill = { name: string; description: string; location: string; fs: FileSystem };

/** Prompt sections get no context of their own: their reads finish on their own. */
const CONTEXT = BACKGROUND_CONTEXT;

/** The frontmatter's name and description (one line each). */
function frontmatter(source: string): Record<string, string> {
	const block = /^---\r?\n([\s\S]*?)\r?\n---/.exec(source)?.[1] ?? "";
	return Object.fromEntries(
		block.split(/\r?\n/).flatMap((line) => {
			const match = /^(\w[\w-]*):\s*(.*)$/.exec(line);
			return match === null ? [] : [[match[1]!, match[2]!.trim().replace(/^(["'])(.*)\1$/, "$2")]];
		}),
	);
}

const base = (path: string) => path.replace(/\/+$/, "").split("/").at(-1) ?? path;
const parent = (path: string) => path.replace(/\/+$/, "").split("/").slice(0, -1).join("/");

async function skillAt(fs: FileSystem, path: string, context: Context): Promise<Skill | undefined> {
	const source = await fs.readTextFile(path, context);
	if (!source.ok) return undefined;
	const meta = frontmatter(source.value);
	if (meta.description === undefined || meta.description === "") return undefined;
	return { name: meta.name || (base(path) === "SKILL.md" ? base(parent(path)) : base(path).replace(/\.md$/, "")), description: meta.description, location: path, fs };
}

/** Every SKILL.md under `dir` (a skill's own directory stops the search there), and, at its top, plain .md files. */
async function skillsIn(fs: FileSystem, dir: string, context: Context, top = true): Promise<Skill[]> {
	const absolute = await fs.absolutePath(dir, context);
	if (!absolute.ok) return [];
	const info = await fs.fileInfo(absolute.value, context);
	if (!info.ok || info.value.kind !== "directory") return [];
	const own = await fs.joinPath([absolute.value, "SKILL.md"], context);
	const hasOwn = own.ok ? await fs.exists(own.value, context) : undefined;
	if (own.ok && hasOwn?.ok === true && hasOwn.value) return [await skillAt(fs, own.value, context)].filter((skill) => skill !== undefined);
	const listed = await fs.listDir(absolute.value, context);
	if (!listed.ok) return [];
	const found: Skill[] = [];
	for (const entry of [...listed.value].sort((a, b) => a.name.localeCompare(b.name))) {
		if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
		if (entry.kind === "directory") found.push(...(await skillsIn(fs, entry.path, context, false)));
		else if (top && entry.name.endsWith(".md")) {
			const skill = await skillAt(fs, entry.path, context);
			if (skill !== undefined) found.push(skill);
		}
	}
	return found;
}

/**
 * `builtIn`: japa's own skills; `discovered`: extensions' skill directories. Both are on the machine japa runs on; the
 * agent's own are on its computer (the environment in use).
 */
export function skillsExtension(options: { builtIn: string; discovered: () => Promise<string[]> }): Extension {
	const here = new NodeExecutionEnv({ cwd: options.builtIn });
	const all = async (computer: FileSystem | undefined, context: Context): Promise<Skill[]> => {
		const sources: Array<[FileSystem, string]> = [
			...(computer === undefined ? [] : ([".pi/agent/skills", ".agents/skills"].map((dir) => [computer, dir]) as Array<[FileSystem, string]>)),
			[here, options.builtIn],
			...(await options.discovered()).map((dir): [FileSystem, string] => [here, dir]),
		];
		const seen = new Set<string>();
		const found: Skill[] = [];
		for (const [fs, dir] of sources) for (const skill of await skillsIn(fs, dir, context)) if (!seen.has(skill.name) && seen.add(skill.name)) found.push(skill);
		return found;
	};
	return defineExtension({
		name: "japa.skills",
		sections: [
			section(
				"context",
				async (input) => {
					if (input.env === undefined) return undefined;
					for (const name of ["AGENTS.md", "CLAUDE.md"]) {
						const path = await input.env.absolutePath(`.pi/agent/${name}`, CONTEXT);
						if (!path.ok) continue;
						const read = await input.env.readTextFile(path.value, CONTEXT);
						if (read.ok && read.value.trim() !== "") return `Standing instructions (${path.value}):\n${read.value.trim()}`;
					}
					return undefined;
				},
				{ tag: false },
			),
			section(
				"skills",
				async (input) => {
					const skills = await all(input.env, CONTEXT);
					if (skills.length === 0) return undefined;
					// One line each: what it's for, and where it is. The rest is read only when the agent chooses to.
					return ["Skills: when a task matches one, read it (the skill tool, by name).", ...skills.map((skill) => `- ${skill.name}: ${skill.description.replace(/\s+/g, " ")} (${skill.location})`)].join("\n");
				},
				{ tag: false },
			),
		],
		tools: [
			defineTool({
				name: "skill",
				description: "Read a skill (its SKILL.md), by name, wherever it is.",
				parameters: Type.Object({ name: Type.String() }),
				replay: "safe",
				execute: async (args, api, context) => {
					const skill = (await all(api.env, context)).find((each) => each.name === args.name);
					if (skill === undefined) return { content: [{ type: "text", text: `No skill called ${args.name}.` }], isError: true };
					const read = await skill.fs.readTextFile(skill.location, context);
					return { content: [{ type: "text", text: read.ok ? `${skill.location}\n\n${read.value}` : `Couldn't read ${skill.location}: ${read.error.message}` }], ...(read.ok ? {} : { isError: true }) };
				},
			}),
		],
	});
}
