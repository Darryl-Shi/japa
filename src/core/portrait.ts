// Memory: a portrait of the user — a few simple facts and, mostly, the nuances. One markdown file in the home
// repo that the user can read and edit; the agent records into it when something is worth keeping.
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export class Portrait {
	readonly path: string;
	private readonly home: string;

	constructor(home: string) {
		this.home = home;
		this.path = join(home, "memory.md");
	}

	read(): string {
		return existsSync(this.path) ? readFileSync(this.path, "utf8").trim() : "";
	}

	/** Add a line, or replace an existing passage with a corrected one (an empty note forgets it). */
	remember(note: string, replaces?: string): string {
		const current = this.read();
		let next: string;
		if (replaces !== undefined && replaces.trim() !== "") {
			if (!current.includes(replaces)) throw new Error(`Not in memory: ${replaces}`);
			next = current.replace(replaces, note.trim());
		} else {
			next = current === "" ? `- ${note.trim()}` : `${current}\n- ${note.trim()}`;
		}
		next = next.replace(/^- *$\n?/gm, "").trim();
		mkdirSync(dirname(this.path), { recursive: true });
		writeFileSync(this.path, `${next}\n`);
		this.commit(replaces === undefined ? `remember: ${note}` : `correct: ${note || "(forget)"}`);
		return next;
	}

	/** Best effort: when the home directory is a git repo, every change is a commit the user can read or revert. */
	private commit(message: string): void {
		if (!existsSync(join(this.home, ".git"))) return;
		execFile("git", ["-C", this.home, "add", "memory.md"], (error) => {
			if (error === null) execFile("git", ["-C", this.home, "commit", "-q", "-m", message.slice(0, 200)], () => {});
		});
	}
}
