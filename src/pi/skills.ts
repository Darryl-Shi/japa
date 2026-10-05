// Skills and context files, as pi has them, read fresh each turn so what's added applies from the next message. A
// skill is a directory with a SKILL.md (name and description in its frontmatter), listed in the prompt and read when a
// task needs it; they're in pi's places in the agent's home (~/.pi/agent/skills, ~/.agents/skills), in japa's own
// skills/, and wherever an extension's resources_discover says. A context file is pi's AGENTS.md (or CLAUDE.md) in
// ~/.pi/agent: standing instructions, in every prompt. Both are the agent's own, in its home, so it can add them itself.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { defineExtension, type Extension, section } from "@earendil-works/pi-durable";

type Skill = { name: string; description: string; location: string };

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

/** Every SKILL.md under `dir` (a skill's own directory stops the search there), and, at its top, plain .md files. */
function skillsIn(dir: string, top = true): Skill[] {
	if (!existsSync(dir) || !statSync(dir).isDirectory()) return [];
	if (existsSync(join(dir, "SKILL.md"))) return [skillAt(join(dir, "SKILL.md"))].filter((skill) => skill !== undefined);
	return readdirSync(dir, { withFileTypes: true })
		.sort((a, b) => a.name.localeCompare(b.name))
		.flatMap((entry) => {
			if (entry.name.startsWith(".") || entry.name === "node_modules") return [];
			if (entry.isDirectory()) return skillsIn(join(dir, entry.name), false);
			const found = top && entry.name.endsWith(".md") ? skillAt(join(dir, entry.name)) : undefined;
			return found === undefined ? [] : [found];
		});
}

function skillAt(path: string): Skill | undefined {
	const meta = frontmatter(readFileSync(path, "utf8"));
	if (meta.description === undefined || meta.description === "") return undefined;
	return { name: meta.name || (basename(path) === "SKILL.md" ? basename(dirname(path)) : basename(path, ".md")), description: meta.description, location: path };
}

const escape = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function skillsExtension(options: { home: string; builtIn: string; discovered: () => Promise<string[]> }): Extension {
	const agentDir = join(options.home, ".pi", "agent");
	return defineExtension({
		name: "jarvis.skills",
		sections: [
			section(
				"context",
				() => {
					const file = ["AGENTS.md", "CLAUDE.md"].map((name) => join(agentDir, name)).find((path) => existsSync(path));
					const text = file === undefined ? "" : readFileSync(file, "utf8").trim();
					return text === "" ? undefined : `Standing instructions (${file}):\n${text}`;
				},
				{ tag: false },
			),
			section(
				"skills",
				async () => {
					const dirs = [join(agentDir, "skills"), join(options.home, ".agents", "skills"), options.builtIn, ...(await options.discovered())];
					const seen = new Set<string>();
					const skills = dirs.flatMap((dir) => skillsIn(dir)).filter((skill) => !seen.has(skill.name) && seen.add(skill.name));
					if (skills.length === 0) return undefined;
					return [
						"The following skills provide specialized instructions for specific tasks.",
						"Use the read tool to load a skill's file when the task matches its description.",
						"When a skill file references a relative path, resolve it against the skill's directory.",
						"",
						"<available_skills>",
						...skills.map((skill) => `  <skill>\n    <name>${escape(skill.name)}</name>\n    <description>${escape(skill.description)}</description>\n    <location>${escape(skill.location)}</location>\n  </skill>`),
						"</available_skills>",
					].join("\n");
				},
				{ tag: false },
			),
		],
	});
}
